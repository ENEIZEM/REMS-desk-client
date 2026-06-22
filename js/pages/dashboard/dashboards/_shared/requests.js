/* ═══════════════════════════════════════════════════════════════
   Requests orchestrator — общий для owner и employee.
   Владеет лентой заявок, 3-шаговой модалкой создания/редактирования,
   дорожной картой (rail статусов + история со scroll-spy), переходами
   жизненного цикла (take/start/finish/close/cancel) и live-синком.

   Рендерит во все контейнеры [data-requests-list] (у каждого свой
   data-rq-filter: free | current | all). Кнопки «Создать заявку» —
   [data-rq-create]. Открытие карты — [data-rq-open].
   ═══════════════════════════════════════════════════════════════ */
import { requests as reqApi, equipment as eqApi, contracts as contractsApi, media } from '../../../../api.js';
import { toast, errorMessage } from '../../../../auth.js';
import { t, getLang, applyTranslations, onLangChange } from '../../../../i18n.js';
import {
  openModal, closeModal, setLoading,
  setFieldError, clearFieldErrorById, showAlertText, hideAlertById,
} from '../../ui-helpers.js';
import { on as socketOn } from '../../../../socket.js';
import { refreshCharCounters } from '../../../../lib/char-counter.js';
import { openMediaViewer } from '../../../../lib/media-viewer.js';
import { wireDocPreview } from '../../../../lib/doc-preview.js';
import {
  requestListHTML, requestCardHTML, historyHTML,
  statusLabel, escapeHTML, slaRemainingMs, setRequestViewer, setRequestUnseenChecker,
} from './requests-ui.js';
import { hasUnseenForRequest, markRequestSeenLocal } from '../../notifications.js';

let _requests = [];
let _profile = null, _selfId = null, _myOrgId = null, _isOwner = false;

/* ── Внешний доступ к данным и фильтрам ─────────────────────────────
   Вкладки (employee/requests, owner/overview) фильтруют ленту по своим
   pickers и считают статистику. Чтобы не дублировать загрузку:
     registerListFilter(name, fn) — кастомный фильтр для контейнера с
       data-rq-filter="<name>". fn(request, ctx) → boolean, где ctx =
       { selfId, myOrgId }. Перерегистрация с тем же именем заменяет fn.
     getRequests()                — текущий кэш заявок.
     onRequestsUpdated(key, cb)   — колбэк после каждой перерисовки
       (загрузка, socket-синк, смена языка). Ключ делает подписку
       идемпотентной — ремоунт вкладки не плодит дубликаты.            */
const _filterRegistry  = new Map();
const _updateListeners = new Map();

export function registerListFilter(name, fn) { _filterRegistry.set(name, fn); }
export function getRequests() { return _requests; }
export function onRequestsUpdated(key, cb) { _updateListeners.set(key, cb); }

/** Начало периода для фильтров/статистики; null = без ограничения. */
export function periodStart(period) {
  const d = new Date();
  if (period === 'week')  { d.setDate(d.getDate() - 7);        return d; }
  if (period === 'month') { d.setMonth(d.getMonth() - 1);      return d; }
  if (period === 'year')  { d.setFullYear(d.getFullYear() - 1); return d; }
  return null; // 'all'
}
let _eqCache = null, _contractCache = null;
let _editId = null;
let _roadmapId = null;        // открытая в дорожной карте заявка
let _reloadTimer = null;      // debounce для socket-перезагрузки ленты
let _finishFiles = [];        // [{file, mediaId}] — вложения при завершении
let _createFiles = [];        // [{file, mediaId}] — вложения при создании
let _priority = 'medium';     // выбранный приоритет (pill)
let _step = 1;                // активный шаг модалки создания (1 | 2)
let _ratingVal = 0;
let _createDoc = null, _finishDoc = null;   // doc-preview контроллеры вложений
const _imgCache = new Map();

// ── Mount ──────────────────────────────────────────────────────────
export async function mountRequests(profile) {
  _profile = profile;
  _selfId  = profile?.user?.id ?? null;
  _myOrgId = profile?.organization?.id ?? profile?.user?.organization_id ?? null;
  _isOwner = (profile?.user?.org_role || profile?.user?.role) === 'owner';
  setRequestViewer(_selfId);
  // Чип «обновлено» считается из уведомлений (per-user, серверные).
  setRequestUnseenChecker(hasUnseenForRequest);
  wireOnce();
  // Deep-link/возврат на #overview/<id> | #requests/<id> — подсветим
  // карточку после загрузки (лента у owner на Обзоре, у employee на Заявках).
  const m = (location.hash || '').match(/#(?:overview|requests)\/(\d+)/);
  if (m) _pendingFocusId = Number(m[1]);
  await loadRequests();
}

async function loadRequests() {
  try {
    const resp = await reqApi.list();
    _requests = resp.data?.requests || [];
  } catch (err) { console.warn('[requests load]', err?.message); _requests = []; }
  renderAll();
}

function filterFor(name) {
  // Кастомные фильтры вкладок имеют приоритет над встроенными.
  const custom = _filterRegistry.get(name);
  if (custom) {
    const ctx = { selfId: Number(_selfId), myOrgId: Number(_myOrgId) };
    try { return _requests.filter(r => custom(r, ctx)); }
    catch (e) { console.warn('[requests filter]', name, e); return _requests; }
  }
  if (name === 'free')    return _requests.filter(r => r.status === 'new' && Number(r.contractor_org_id) === Number(_myOrgId));
  if (name === 'current') return _requests.filter(r => Number(r.assigned_to_id) === Number(_selfId) && ['assigned', 'in_progress'].includes(r.status));
  if (name === 'mine')    return _requests.filter(r => Number(r.author_id) === Number(_selfId));
  return _requests; // all
}

// Подсветка целевой карточки при переходе из уведомления (#requests/<id>).
// Одноразовый pending-id: ставится переходом, гасится после применения —
// чтобы не мигать на каждом socket-ре-рендере.
let _pendingFocusId = null;
export function focusRequest(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return;
  _pendingFocusId = n;
  applyFocus();
}
function applyFocus() {
  if (_pendingFocusId == null) return;
  const card = document.querySelector(`.request-card[data-rq-open="${_pendingFocusId}"]`);
  if (!card) return; // ещё не отрендерено — применим в следующем renderAll
  card.closest('details')?.setAttribute('open', ''); // раскрыть свёрнутую секцию (Архив)
  const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  card.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
  card.classList.remove('rq-flash'); void card.offsetWidth; card.classList.add('rq-flash');
  setTimeout(() => card.classList.remove('rq-flash'), 2200);
  _pendingFocusId = null;
}

// Состав команды для панели нагрузки (workload). Передаёт owner-оркестратор
// после загрузки участников (setRequestTeam); если не задан — выводим из
// самих заявок (assignee_name). Только для руководителя.
let _members = [];
export function setRequestTeam(members) { _members = Array.isArray(members) ? members : []; renderAll(); }

export function renderAll() {
  const ctx = { selfId: Number(_selfId), myOrgId: Number(_myOrgId), isOwner: _isOwner };

  // Сегментированные ленты: плитки и «Команда» рендерятся в ОТДЕЛЬНЫЕ
  // контейнеры (data-rq-tiles / data-rq-team), связанные по имени фильтра.
  // Состояние на самой ленте: data-rq-quick (плитка), data-rq-team-emp (сотрудник).
  document.querySelectorAll('[data-requests-list][data-rq-segmented]').forEach(feed => {
    const name    = feed.dataset.rqFilter || 'all';
    const quick   = feed.dataset.rqQuick || 'all';
    const scope   = feed.dataset.rqScope || 'all';   // тип: all|internal|partner
    // Линза «сотрудник» — МНОЖЕСТВЕННЫЙ выбор (csv id в data-rq-team-emp);
    // пусто = все. Скоупит ВСЁ: и плитки, и ленту.
    const teamSet = new Set((feed.dataset.rqTeamEmp || '').split(',').filter(Boolean));
    const periodBase = [...filterFor(name)];                      // период (registered filter)
    const scopedBase = scope === 'all' ? periodBase
      : periodBase.filter(r => scope === 'internal' ? r.is_internal : !r.is_internal);
    const teamBase = teamSet.size
      ? scopedBase.filter(r => teamSet.has(String(r.assigned_to_id)) || teamSet.has(String(r.author_id)))
      : scopedBase;
    // Сохраняем раскрытость секций (<details>) между перерисовками — иначе
    // открытие дорожной карты (renderAll) сворачивало вручную раскрытый
    // «Архив» и т.п. Снимаем состояние ДО перерисовки, восстанавливаем ПОСЛЕ.
    const openState = {};
    feed.querySelectorAll('details[data-rq-section]').forEach(d => { openState[d.dataset.rqSection] = d.open; });
    feed.innerHTML = segmentedHTML(applyQuickFilter(teamBase, ctx, quick), ctx);
    feed.querySelectorAll('details[data-rq-section]').forEach(d => {
      if (Object.prototype.hasOwnProperty.call(openState, d.dataset.rqSection)) d.open = openState[d.dataset.rqSection];
    });
    loadAttachmentThumbs(feed);
    const scopeEl = document.querySelector(`[data-rq-scope="${name}"]`);
    if (scopeEl) scopeEl.innerHTML = scopeBarHTML(periodBase, scope);
    const tilesEl = document.querySelector(`[data-rq-tiles="${name}"]`);
    if (tilesEl) tilesEl.innerHTML = tilesHTML(teamBase, ctx, quick);
    const teamEl = document.querySelector(`[data-rq-team="${name}"]`);
    if (teamEl) teamEl.innerHTML = teamHTML(scopedBase, teamSet);
    const cnt = feed.closest('.card')?.querySelector('[data-requests-count]');
    if (cnt) cnt.textContent = String(teamBase.length);
  });

  // Плоские (несегментированные) ленты — прежнее поведение.
  document.querySelectorAll('[data-requests-list]:not([data-rq-segmented])').forEach(el => {
    const base = [...filterFor(el.dataset.rqFilter || 'all')];
    const isTerminal = (r) => (r.status === 'closed' || r.status === 'cancelled') ? 1 : 0;
    el.innerHTML = requestListHTML([...base].sort((a, b) => isTerminal(a) - isTerminal(b)));
    loadAttachmentThumbs(el);
    const cnt = el.closest('.card')?.querySelector('[data-requests-count]');
    if (cnt) cnt.textContent = String(base.length);
  });

  // Подписчики (статистика на overview-вкладках и т.п.).
  _updateListeners.forEach((cb) => { try { cb(_requests); } catch (e) { console.warn('[requests listener]', e); } });
  // Применить отложенную подсветку целевой карточки (если ждали рендера).
  applyFocus();
}

/**
 * Панель «Команда» (workload) для руководителя: по каждому сотруднику —
 * активные назначенные + просроченные, клик = фильтр ленты по сотруднику.
 * Источник имён: переданный состав (_members) ∪ исполнители из заявок.
 * scopeBase — заявки после охвата/периода (но ДО линзы сотрудника).
 */
function teamHTML(scopeBase, activeSet) {
  const terminal = (r) => r.status === 'closed' || r.status === 'cancelled';
  const stat = new Map(); // empId → { name, active, overdue }
  const ensure = (id, name) => {
    const k = String(id);
    if (!stat.has(k)) stat.set(k, { id: k, name: name || ('#' + k), active: 0, overdue: 0 });
    const s = stat.get(k); if (name && s.name.startsWith('#')) s.name = name; return s;
  };
  for (const m of _members) if (m && m.id != null) ensure(m.id, m.full_name || m.name);
  for (const r of scopeBase) {
    if (r.assigned_to_id == null || terminal(r)) continue;
    if (r.status !== 'assigned' && r.status !== 'in_progress') continue;
    const s = ensure(r.assigned_to_id, r.assignee_name);
    s.active++;
    if (slaRemainingMs(r) < 0) s.overdue++;
  }
  const rows = [...stat.values()].sort((a, b) => b.active - a.active);
  const chip = (id, label, active, overdue, isActive) => `
    <button type="button" class="rq-team-chip${isActive ? ' is-active' : ''}" data-rq-team-pick="${id}">
      <span class="rq-team-name">${escapeHTML(label)}</span>
      <span class="rq-team-load">${active}</span>
      ${overdue ? `<span class="rq-team-over" title="${escapeHTML(t('requests.tile.overdue'))}">${overdue}</span>` : ''}
    </button>`;
  const allChip = chip('', t('requests.tile.all'), scopeBase.filter(r => !terminal(r)).length, 0, activeSet.size === 0);
  const empChips = rows.map(s => chip(s.id, s.name, s.active, s.overdue, activeSet.has(s.id))).join('');
  return `<div class="rq-team-strip">${allChip}${empChips}</div>`;
}

/** Сегмент «Тип заявки» со счётчиками (Все/Внутренние/Партнёрские).
 *  active — текущий тип. Считается по периодному набору (до фильтра типа). */
function scopeBarHTML(periodBase, active) {
  let internal = 0, partner = 0;
  for (const r of periodBase) r.is_internal ? internal++ : partner++;
  const chip = (id, key, count) => `
    <button type="button" class="rq-scope-chip${active === id ? ' is-active' : ''}" data-rq-scope-pick="${id}">
      <span data-i18n="${key}">${escapeHTML(t(key))}</span>
      <span class="rq-scope-count">${count}</span>
    </button>`;
  return `<div class="rq-scope-seg">
    ${chip('all', 'employee.req_scope_all', periodBase.length)}
    ${chip('internal', 'employee.req_scope_internal', internal)}
    ${chip('partner', 'employee.req_scope_partner', partner)}
  </div>`;
}

/**
 * Сегментированная лента (редизайн 2026-06): вместо плоской кучи —
 * сворачиваемые секции в порядке приоритета внимания. Чистая функция
 * (list + ctx), без состояния модуля — тестируется отдельно.
 *
 *   1. Требуют действия — назначенные мне активные (исполнитель) + готовые
 *      к приёмке мной (автор / владелец-заказчик). Сортировка по срочности.
 *   2. Свободный пул — new в моей орг-исполнителе (можно взять).
 *   3. В работе — прочие активные.
 *   4. Архив — закрытые/отменённые (свёрнут по умолчанию).
 *
 * Заодно чинит «фокус при взятии»: взятая заявка не исчезает, а переезжает
 * из «Свободного пула» в «Требуют действия» — остаётся на виду.
 */
// Классификация заявки в секцию (общая для ленты, плиток и быстрых
// фильтров): 'action' | 'free' | 'wip' | 'archive'.
export function classifyRequest(r, ctx) {
  if (r.status === 'closed' || r.status === 'cancelled') return 'archive';
  const mineAssignee = Number(r.assigned_to_id) === ctx.selfId;
  const mineAuthor   = Number(r.author_id) === ctx.selfId;
  const awaitingMe = r.status === 'done' && (mineAuthor || (ctx.isOwner && Number(r.client_org_id) === ctx.myOrgId));
  const myActive   = mineAssignee && (r.status === 'assigned' || r.status === 'in_progress');
  if (awaitingMe || myActive) return 'action';
  if (r.status === 'new' && Number(r.contractor_org_id) === ctx.myOrgId) return 'free';
  return 'wip';
}

export function segmentedHTML(list, ctx) {
  const action = [], free = [], wip = [], archive = [];
  for (const r of list) {
    const c = classifyRequest(r, ctx);
    (c === 'action' ? action : c === 'free' ? free : c === 'archive' ? archive : wip).push(r);
  }
  const byUrgency = (a, b) => slaRemainingMs(a) - slaRemainingMs(b);
  action.sort(byUrgency); free.sort(byUrgency); wip.sort(byUrgency);

  const section = (key, items, open) => items.length
    ? `<details class="rq-section" data-rq-section="${key}" ${open ? 'open' : ''}>
         <summary class="rq-section-head">
           <i class="ph ph-caret-right rq-section-caret"></i>
           <span data-i18n="requests.section.${key}">${escapeHTML(t('requests.section.' + key))}</span>
           <span class="rq-section-count">${items.length}</span>
         </summary>
         <div class="rq-section-body">${items.map(requestCardHTML).join('')}</div>
       </details>`
    : '';

  const html = [
    section('action',  action,  true),
    section('free',    free,    true),
    section('wip',     wip,     true),
    section('archive', archive, true),
  ].join('');
  return html || requestListHTML([]); // пустой список → общий empty-state
}

/**
 * Плитки-KPI над лентой: ключевые счётчики (видны сразу, без прокрутки) и
 * одновременно быстрые фильтры. Считаются по ПОЛНОМУ списку (не зависят от
 * активного фильтра). «Просрочено» — кросс-срез, которого секции не дают.
 */
export function tilesHTML(base, ctx, active) {
  let action = 0, free = 0, archive = 0, overdue = 0;
  // Оценки: руководителю — работа орг (исполнитель = его орг), сотруднику —
  // его собственная (исполнитель = он). Раздельно внутренние / по контрактам.
  let sumI = 0, cntI = 0, sumP = 0, cntP = 0;
  const ratedToViewer = (r) => ctx.isOwner
    ? Number(r.contractor_org_id) === ctx.myOrgId
    : Number(r.assigned_to_id) === ctx.selfId;
  for (const r of base) {
    const c = classifyRequest(r, ctx);
    if (c === 'action') action++; else if (c === 'free') free++; else if (c === 'archive') archive++;
    if (slaRemainingMs(r) < 0) overdue++;
    if (r.status === 'closed' && r.rating != null && ratedToViewer(r)) {
      if (r.is_internal) { sumI += Number(r.rating); cntI++; }
      else               { sumP += Number(r.rating); cntP++; }
    }
  }
  const avg = (s, n) => n ? (s / n).toFixed(1) : null;
  const tile = (id, count, danger) => `
    <button type="button" class="rq-tile${active === id ? ' is-active' : ''}${danger ? ' rq-tile--danger' : ''}" data-rq-tile="${id}">
      <span class="rq-tile-count">${count}</span>
      <span class="rq-tile-label" data-i18n="requests.tile.${id}">${escapeHTML(t('requests.tile.' + id))}</span>
    </button>`;
  // Метрика-плитка (НЕ фильтр: без data-rq-tile → клик не ловится).
  const metric = (id, val) => `
    <div class="rq-tile rq-tile--metric">
      <span class="rq-tile-count">${val != null ? `${escapeHTML(val)}<i class="ph-fill ph-star rq-tile-star" aria-hidden="true"></i>` : '—'}</span>
      <span class="rq-tile-label" data-i18n="requests.tile.${id}">${escapeHTML(t('requests.tile.' + id))}</span>
    </div>`;
  return `<div class="rq-tiles">
    ${tile('all', base.length, false)}
    ${tile('action', action, false)}
    ${tile('free', free, false)}
    ${tile('overdue', overdue, true)}
    ${tile('archive', archive, false)}
    ${metric('rating_internal', avg(sumI, cntI))}
    ${metric('rating_partner', avg(sumP, cntP))}
  </div>`;
}

/** Быстрый фильтр (плитка) — сужает список ПЕРЕД сегментацией. */
function applyQuickFilter(base, ctx, active) {
  if (active === 'overdue') return base.filter(r => slaRemainingMs(r) < 0);
  if (active === 'action' || active === 'free' || active === 'archive') {
    return base.filter(r => classifyRequest(r, ctx) === active);
  }
  return base; // 'all'
}

/* ── Caches for the create modal ───────────────────────────────── */
async function ensureEquipment() {
  if (_eqCache) return _eqCache;
  try { _eqCache = (await eqApi.list()).data?.equipment || []; } catch { _eqCache = []; }
  return _eqCache;
}
async function ensureContracts() {
  if (_contractCache) return _contractCache;
  try {
    const data = (await contractsApi.list()).data || {};
    _contractCache = (data.current || []).filter(c => c.status === 'active' && c.my_role === 'client');
  } catch { _contractCache = []; }
  return _contractCache;
}

/* ── Create / edit modal (2 шага; навигация только кнопками) ─────── */
async function openCreateModal(prefillEquipmentId) {
  _editId = null;
  // Свежие списки на каждое открытие — только что заключённый контракт /
  // заведённая техника должны быть доступны сразу, без перезагрузки страницы.
  _contractCache = null; _eqCache = null;
  await Promise.all([ensureEquipment(), ensureContracts()]);
  resetRqModal();
  setRqTitle('requests.create_title');
  setSubmitLabel('requests.create_confirm');
  if (prefillEquipmentId) populateEquipmentSelect(prefillEquipmentId);
  refreshGuards();
  openModal('request-modal');
  refreshCharCounters(document.querySelector('#request-modal'));
}

async function openEditModal(id) {
  const r = _requests.find(x => Number(x.id) === Number(id));
  if (!r) return;
  _editId = id;
  _contractCache = null; _eqCache = null;
  await Promise.all([ensureEquipment(), ensureContracts()]);
  resetRqModal();
  setRqTitle('requests.edit_title');
  setSubmitLabel('common.save');
  selectType(r.is_internal ? 'internal' : 'contract');
  setPriority(r.priority);
  populateEquipmentSelect(r.equipment?.id ?? '');
  document.querySelector('#rq-desc').value = r.description || '';
  refreshGuards();
  openModal('request-modal');
  refreshCharCounters(document.querySelector('#request-modal'));
}

function setRqTitle(key) {
  const el = document.querySelector('#rq-modal-title');
  if (el) { el.setAttribute('data-i18n', key); el.textContent = t(key); }
}
function setSubmitLabel(key) {
  const el = document.querySelector('#rq-submit-label');
  if (el) { el.setAttribute('data-i18n', key); el.textContent = t(key); }
}

function resetRqModal() {
  selectType('internal');
  populateContractSelect();
  populateEquipmentSelect('');
  _priority = null;          // приоритет не выбран — пользователь кликает SLA-плашку
  renderSlaGrid();
  _createFiles = [];
  renderCreateAttachList();
  const d = document.querySelector('#rq-desc'); if (d) d.value = '';
  clearFieldErrorById('err-rq-desc');
  clearFieldErrorById('err-rq-equipment');
  clearFieldErrorById('err-rq-priority');
  hideAlertById('err-rq');
  goToStep(1);
}

// ── Шаги модалки ────────────────────────────────────────────────────
// Визуально шаги не подписаны: переключаем только видимость блоков и
// набора кнопок в подвале (Далее/Отмена ↔ Создать заявку/Назад).
function goToStep(n) {
  _step = n;
  const show = (sel, on) => { const el = document.querySelector(sel); if (el) el.style.display = on ? '' : 'none'; };
  show('#rq-step-1', n === 1);
  show('#rq-step-2', n === 2);
  show('#btn-rq-next', n === 1);
  show('#btn-rq-cancel', n === 1);
  show('#btn-rq-submit', n === 2);
  show('#btn-rq-back', n === 2);
  hideAlertById('err-rq');
  refreshGuards();
}

// ── Приоритет = выбор SLA-плашки (цвет + часы реакции) ──────────────
function setPriority(p) {
  _priority = p;
  document.querySelectorAll('#rq-sla-grid [data-rq-prio]').forEach(el => {
    el.classList.toggle('is-on', el.dataset.rqPrio === p);
  });
  clearFieldErrorById('err-rq-priority');
  refreshGuards();
}

// SLA-источник: контракт (по контракту) или внутренние SLA орг (внутренняя).
// В обоих случаях отдаём ПАРУ часов на приоритет: реакция (*_h) + устранение
// (*_resolution_h). Для внутренней реакция берётся из internal_response_sla_*
// (раньше ошибочно показывался resolution-набор internal_sla_*).
function slaSource() {
  if (curType() === 'contract') {
    const id = Number(document.querySelector('#rq-contract')?.value);
    const c = (_contractCache || []).find(x => Number(x.id) === id);
    return c?.sla ? { title: t('requests.sla_contract_title'), sla: c.sla } : null;
  }
  const lim = _profile?.organization?.limits;
  if (!lim) return null;
  return {
    title: t('requests.sla_internal_title'),
    sla: {
      // реакция (response)
      critical_h: lim.internal_response_sla_critical_h, high_h: lim.internal_response_sla_high_h,
      medium_h:   lim.internal_response_sla_medium_h,   low_h:  lim.internal_response_sla_low_h,
      // устранение (resolution)
      critical_resolution_h: lim.internal_sla_critical_h, high_resolution_h: lim.internal_sla_high_h,
      medium_resolution_h:   lim.internal_sla_medium_h,   low_resolution_h:  lim.internal_sla_low_h,
    },
  };
}

// 4 кликабельные SLA-плашки = выбор приоритета. В каждой — час РЕАКЦИИ (⚡)
// и час УСТРАНЕНИЯ (🔧) из источника (контракт / внутренние SLA орг).
function renderSlaGrid() {
  const grid = document.querySelector('#rq-sla-grid');
  const srcEl = document.querySelector('#rq-sla-source');
  if (!grid) return;
  const src = slaSource();
  const h = escapeHTML(t('profile.hours_short'));
  const respT  = escapeHTML(t('profile.sla_col_response'));
  const resolT = escapeHTML(t('profile.sla_col_resolution'));
  const order = [
    ['critical', 'critical_h', 'critical_resolution_h'], ['high', 'high_h', 'high_resolution_h'],
    ['medium', 'medium_h', 'medium_resolution_h'],       ['low', 'low_h', 'low_resolution_h'],
  ];
  grid.innerHTML = order.map(([p, rk, rsk]) => {
    const resp  = src?.sla?.[rk];
    const resol = src?.sla?.[rsk];
    return `<button type="button" class="rq-sla-cell rq-prio-${p}${_priority === p ? ' is-on' : ''}" data-rq-prio="${p}">
      <span class="rq-sla-cell-label">${escapeHTML(t('requests.priority.' + p))}</span>
      <span class="rq-sla-cell-vals">
        <span class="rq-sla-cell-val" title="${respT}"><i class="ph ph-lightning"></i>${resp != null ? `${resp}${h}` : '—'}</span>
        ${resol != null ? `<span class="rq-sla-cell-val" title="${resolT}"><i class="ph ph-wrench"></i>${resol}${h}</span>` : ''}
      </span>
    </button>`;
  }).join('');
  if (srcEl) srcEl.textContent = src ? src.title : '';
}

// Дата гарантии в локали пользователя (без времени).
function fmtWarranty(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ru-RU'); }
  catch { return String(iso); }
}

// Одна кликабельная строка техники в кастомном списке выбора. Показываем
// фото (или иконку категории), бренд+модель, категорию · инвентарный ·
// место · дату гарантии и бейдж статуса. Без описания и прогресс-бара.
function equipmentRowHTML(eq, selected) {
  const catIcon = eq.category_icon || 'ph-desktop';
  const catName = eq.category_name ? t(eq.category_name) : t('equipment.categories.other.name');
  const title   = (eq.brand && eq.brand.trim()) ? eq.brand : (eq.model || eq.inventory_number);
  const thumb = eq.photo?.id
    ? `<img data-rq-eq-photo="${eq.photo.id}" alt="">`
    : `<i class="ph-duotone ${catIcon}"></i>`;
  const meta = [
    `<span><i class="ph ${catIcon}"></i> ${escapeHTML(catName)}</span>`,
    `<span>${escapeHTML(t('equipment.inventory_short'))}: ${escapeHTML(eq.inventory_number)}</span>`,
    eq.location ? `<span><i class="ph ph-map-pin"></i> ${escapeHTML(eq.location)}</span>` : '',
    eq.warranty_until ? `<span><i class="ph ph-shield-check"></i> ${escapeHTML(fmtWarranty(eq.warranty_until))}</span>` : '',
  ].filter(Boolean).join('<span class="rq-eq-dot">·</span>');
  return `
    <div class="rq-eq-row${selected ? ' is-selected' : ''}" data-rq-eq="${eq.id}" role="radio" aria-checked="${selected ? 'true' : 'false'}" tabindex="0">
      <div class="rq-eq-thumb">${thumb}</div>
      <div class="rq-eq-info">
        <div class="rq-eq-title">${escapeHTML(title)}</div>
        ${eq.model ? `<div class="rq-eq-model">${escapeHTML(eq.model)}</div>` : ''}
        <div class="rq-eq-meta">${meta}</div>
      </div>
    </div>`;
}

// Кастомный список техники + скрытый #rq-equipment как источник значения
// (его читают step2Valid/submit). selectedId — предвыбор (edit / с карточки).
function populateEquipmentSelect(selectedId) {
  const hidden = document.querySelector('#rq-equipment');
  const wrap   = document.querySelector('#rq-equipment-list');
  if (hidden) hidden.value = selectedId ? String(selectedId) : '';
  if (!wrap) return;
  // Техника с уже активной (не закрытой) заявкой исключается из выбора —
  // нельзя завести вторую заявку на ту же единицу. Исключение: техника,
  // уже выбранная в этой заявке (режим редактирования) — её оставляем.
  const selStr = selectedId ? String(selectedId) : '';
  const list = (_eqCache || []).filter(e => !e.has_active_request || String(e.id) === selStr);
  if (!list.length) {
    wrap.innerHTML = `<div class="empty-state empty-state--inline"><i class="ph ph-desktop-tower"></i><span class="empty-state-text">${escapeHTML(t('equipment.empty'))}</span></div>`;
    return;
  }
  wrap.innerHTML = list.map(e => equipmentRowHTML(e, String(e.id) === String(selectedId))).join('');
  loadEquipmentThumbs(wrap);
}

// Приватные миниатюры фото техники (как вложения в дорожной карте).
function loadEquipmentThumbs(scope) {
  scope.querySelectorAll('img[data-rq-eq-photo]').forEach(async (img) => {
    const id = Number(img.getAttribute('data-rq-eq-photo'));
    if (!id) return;
    if (_imgCache.has(id)) { img.src = _imgCache.get(id); return; }
    try { const url = await media.loadPrivateImage(id); _imgCache.set(id, url); img.src = url; } catch {}
  });
}

// Выбор строки техники: помечаем её, пишем id в скрытый input, чистим ошибку.
function selectEquipment(id) {
  const hidden = document.querySelector('#rq-equipment');
  if (hidden) hidden.value = String(id);
  document.querySelectorAll('#rq-equipment-list .rq-eq-row').forEach(row => {
    const on = row.dataset.rqEq === String(id);
    row.classList.toggle('is-selected', on);
    row.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  clearFieldErrorById('err-rq-equipment');
  refreshGuards();
}

function selectType(type) {
  document.querySelectorAll('[data-rq-type]').forEach(card => {
    const on = card.dataset.rqType === type;
    card.classList.toggle('selected', on);
    const inp = card.querySelector('input[type="radio"]');
    if (inp) inp.checked = on;
  });
  const grp = document.querySelector('#rq-contract-group');
  if (grp) grp.style.display = type === 'contract' ? '' : 'none';
  renderSlaGrid();          // источник SLA зависит от типа/контракта
  refreshGuards();
}

function populateContractSelect() {
  const sel = document.querySelector('#rq-contract');
  const note = document.querySelector('#rq-no-contracts');
  const contractCard = document.querySelector('[data-rq-type="contract"]');
  if (!sel) return;
  const list = _contractCache || [];
  sel.innerHTML = list.map(c => `<option value="${c.id}">${escapeHTML(c.name)} — ${escapeHTML(c.partner?.name || '')}</option>`).join('');
  const none = list.length === 0;
  if (note) note.style.display = none ? '' : 'none';
  // Если контрактов нет — блокируем выбор «по контракту».
  if (contractCard) contractCard.classList.toggle('is-disabled', none);
}

function curType() {
  return document.querySelector('input[name="rq-type"]:checked')?.value || 'internal';
}

// Шаг 1 заполнен? (тип + контракт + приоритет/SLA)
function step1Valid() {
  if (curType() === 'contract' && !document.querySelector('#rq-contract')?.value) return false;
  if (!_priority) return false;
  return true;
}
// Шаг 2 заполнен? (оборудование + описание)
function step2Valid() {
  if (!document.querySelector('#rq-equipment')?.value) return false;
  if (!(document.querySelector('#rq-desc')?.value || '').trim()) return false;
  return true;
}
function formValid() { return step1Valid() && step2Valid(); }

// Серые CTA-кнопки, пока обязательные поля их шага пусты.
function refreshGuards() {
  const next = document.querySelector('#btn-rq-next');
  if (next) next.classList.toggle('is-pending', !step1Valid());
  const sub = document.querySelector('#btn-rq-submit');
  if (sub) sub.classList.toggle('is-pending', !step2Valid());
}

// Подсветить незаполненные обязательные поля шага 1 (клик по серой «Далее»).
function highlightStep1() {
  if (curType() === 'contract' && !document.querySelector('#rq-contract')?.value)
    showAlertText('err-rq', 'err-rq-text', t('errors.requests.contract_required'));
  if (!_priority) setFieldError('err-rq-priority', t('errors.required'));
}
// Подсветить незаполненные обязательные поля шага 2 (клик по серой кнопке).
function highlightStep2() {
  if (!document.querySelector('#rq-equipment')?.value) setFieldError('err-rq-equipment', t('errors.required'));
  if (!(document.querySelector('#rq-desc')?.value || '').trim()) setFieldError('err-rq-desc', t('errors.required'));
}

async function submitRequest() {
  // Шаг 1 уже провалидирован переходом «Далее»; на всякий случай вернёмся.
  if (!step1Valid()) { goToStep(1); highlightStep1(); return; }
  if (!step2Valid()) { highlightStep2(); return; }   // серая кнопка → подсветить
  const description = (document.querySelector('#rq-desc')?.value || '').trim();
  const payload = {
    request_type: _editId ? undefined : curType(),
    contract_id: (!_editId && curType() === 'contract') ? Number(document.querySelector('#rq-contract')?.value) : undefined,
    equipment_id: document.querySelector('#rq-equipment')?.value || undefined,
    priority: _priority,
    description,
    attachment_media_ids: _editId ? undefined : _createFiles.map(f => f.mediaId).filter(Boolean),
  };
  const btn = document.querySelector('#btn-rq-submit');
  setLoading(btn, true);
  try {
    if (_editId) await reqApi.update(_editId, payload);
    else         await reqApi.create(payload);
    closeModal('request-modal');
    toast(t(_editId ? 'requests.updated_toast' : 'requests.created_toast'), 'ok');
    await loadRequests();
  } catch (err) {
    showAlertText('err-rq', 'err-rq-text', errorMessage(err));
  } finally { setLoading(btn, false); }
}

/* ── Roadmap (detail) ──────────────────────────────────────────── */
async function openRoadmap(id) {
  _roadmapId = id;
  const histEl = document.querySelector('#rrm-history');
  const sumEl  = document.querySelector('#rrm-summary');
  if (histEl) histEl.innerHTML = `<div class="empty-state empty-state--inline"><i class="ph ph-spinner"></i></div>`;
  if (sumEl) sumEl.innerHTML = '';
  document.querySelector('#rrm-actions').innerHTML = '';
  openModal('request-roadmap-modal');
  try {
    const resp = await reqApi.get(id);
    renderRoadmap(resp.data);
  } catch (err) {
    if (histEl) histEl.innerHTML = `<div class="empty-state empty-state--inline"><i class="ph ph-warning-circle"></i><span class="empty-state-text">${escapeHTML(errorMessage(err))}</span></div>`;
  }
}

// Динамический цвет полосы по доле ОСТАВШЕГОСЯ бюджета времени:
// 1 → зелёный, 0.5 → жёлтый, 0 → красный (плавная интерполяция).
function barColor(frac) {
  frac = Math.max(0, Math.min(1, frac));
  const lerp = (a, b, k) => Math.round(a + (b - a) * k);
  const G = [34, 197, 94], Y = [245, 158, 11], R = [239, 68, 68];
  let c;
  if (frac >= 0.5) { const k = (frac - 0.5) / 0.5; c = [lerp(Y[0], G[0], k), lerp(Y[1], G[1], k), lerp(Y[2], G[2], k)]; }
  else             { const k = frac / 0.5;         c = [lerp(R[0], Y[0], k), lerp(R[1], Y[1], k), lerp(R[2], Y[2], k)]; }
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

// Длительность между двумя моментами в человекочитаемом виде («1ч 20м»).
function fmtDur(ms) {
  if (ms == null || ms < 0) return null;
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${Math.max(totalMin, 1)}${t('requests.sla.u_m')}`;
  const h = Math.floor(ms / 3600000);
  if (h < 48) {
    const rm = Math.round((ms % 3600000) / 60000);
    return rm ? `${h}${t('requests.sla.u_h')} ${rm}${t('requests.sla.u_m')}` : `${h}${t('requests.sla.u_h')}`;
  }
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? `${d}${t('requests.sla.u_d')} ${rh}${t('requests.sla.u_h')}` : `${d}${t('requests.sla.u_d')}`;
}

function renderRoadmap(data) {
  const r = data.request;
  _requests = _requests.map(x => Number(x.id) === Number(r.id) ? r : x); // keep cache fresh
  // Открыли карту → заявка «просмотрена»: локально гасим чип «обновлено»
  // (data.request_seen на уведомлениях этой заявки). Серверный персист —
  // в detail.get (reqApi.get выше). renderAll перерисует ленту без чипа.
  markRequestSeenLocal(r.id);
  renderAll();
  const numEl = document.querySelector('#rrm-number'); if (numEl) numEl.textContent = r.request_number;
  // Подзаголовок = стороны заявки текстом: «Внутренняя · org» либо
  // «По контракту · org1 → org2».
  const subEl = document.querySelector('#rrm-sub');
  if (subEl) {
    subEl.classList.remove('rrm-sub-chips');
    subEl.innerHTML = r.is_internal
      ? `<i class="ph ph-buildings"></i> ${escapeHTML(t('requests.type_internal'))} · ${escapeHTML(r.client_org_name || '—')}`
      : `<i class="ph ph-handshake"></i> ${escapeHTML(t('requests.type_contract'))} · ${escapeHTML(r.client_org_name || '—')} <i class="ph ph-arrow-right rq-parties-arrow"></i> ${escapeHTML(r.contractor_org_name || '—')}`;
  }
  // Угловой чип времени больше не нужен — всё несут бары ниже.
  const chipsEl = document.querySelector('#rrm-head-chips');
  if (chipsEl) chipsEl.innerHTML = '';

  // ── SLA как ОБРАТНЫЕ прогресс-бары: длина = доля ОСТАВШЕГОСЯ бюджета
  //    времени, цвет динамический (зелёный→жёлтый→красный). Сделано быстро →
  //    длинный зелёный; на пределе → короткий красный; просрочено → красный
  //    во всю ширину. Реакция: created→response_due (готова при взятии);
  //    Устранение: assigned→due_date (готово при выполнении/закрытии).
  const termEvt = (data.history || []).filter(h => ['done', 'closed', 'cancelled'].includes(h.new_status)).pop();
  const termAt  = r.closed_at || termEvt?.changed_at || null;
  const reactionDoneAt   = r.assigned_at || termAt;
  const resolutionDoneAt = r.closed_at || (r.assigned_at ? termAt : null);
  const phaseBar = ({ labelKey, start, deadline, doneAt, doneKey, muted }) => {
    const given = (start && deadline) ? (new Date(deadline).getTime() - new Date(start).getTime()) : null;
    if (given == null || given <= 0) {
      return `<div class="rrm-bar rrm-bar--idle">
        <div class="rrm-bar-head"><span class="rrm-bar-label">${escapeHTML(t(labelKey))}</span>
        <span class="rrm-bar-nums">${escapeHTML(t('requests.sla_pending'))}</span></div>
        <div class="rrm-bar-track"></div></div>`;
    }
    const g = escapeHTML(t('requests.sla_given'));
    let frac, over, primary;
    if (doneAt) {
      const actual = new Date(doneAt).getTime() - new Date(start).getTime();
      over = actual > given;
      frac = Math.max(0, Math.min(1, (given - actual) / given));  // остаток бюджета на момент завершения
      primary = escapeHTML(t(doneKey, { t: fmtDur(actual) }));    // «взято за …» / «закрыто за …»
    } else {
      const remaining = new Date(deadline).getTime() - Date.now();
      over = remaining <= 0;
      frac = Math.max(0, Math.min(1, remaining / given));
      primary = over
        ? escapeHTML(t('requests.sla.overdue', { t: fmtDur(-remaining) }))
        : escapeHTML(t('requests.sla_remaining', { t: fmtDur(remaining) }));
    }
    const width = over ? 100 : Math.max(4, Math.round(frac * 100));
    const color = over ? 'var(--clr-error, #ef4444)' : barColor(frac);
    return `<div class="rrm-bar${over ? ' rrm-bar--over' : ''}${muted ? ' rrm-bar--muted' : ''}">
      <div class="rrm-bar-head"><span class="rrm-bar-label">${escapeHTML(t(labelKey))}</span>
        <span class="rrm-bar-nums"><b>${primary}</b> · ${g}: ${fmtDur(given)}</span></div>
      <div class="rrm-bar-track"><div class="rrm-bar-fill" data-w="${width}" style="width:0;background:${color}"></div></div></div>`;
  };
  // Реакция — всегда; когда заявка взята, фаза реакции завершена → приглушаем,
  // чтобы внимание было на устранении. Бар устранения показываем ТОЛЬКО после
  // взятия (до этого окно устранения ещё не стартовало — не путаем юзера).
  const taken = !!r.assigned_at;
  const barsHTML = `
    ${phaseBar({ labelKey: 'profile.sla_col_response', start: r.created_at, deadline: r.response_due, doneAt: reactionDoneAt, doneKey: 'requests.sla_taken_in', muted: taken })}
    ${taken ? phaseBar({ labelKey: 'profile.sla_col_resolution', start: r.assigned_at, deadline: r.due_date, doneAt: resolutionDoneAt, doneKey: r.status === 'closed' ? 'requests.sla_closed_short' : 'requests.sla_done_short' }) : ''}`;

  // ── Полный блок техники (+ фото) ──
  let equipBlock;
  if (r.equipment) {
    const e = r.equipment;
    const title = [e.brand, e.model].filter(Boolean).join(' ') || e.inventory_number || t('requests.no_equipment');
    const cat = e.category_name ? t(e.category_name) : null;
    const warranty = e.warranty_until
      ? new Date(e.warranty_until).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ru-RU') : null;
    const row = (lblKey, val) => val
      ? `<div class="rrm-eq-row"><span class="rrm-eq-lbl">${escapeHTML(t(lblKey))}</span><span class="rrm-eq-val">${escapeHTML(val)}</span></div>` : '';
    // Фото техники — приватное, грузится через loadEquipmentThumbs; клик
    // открывает просмотрщик (делегированный обработчик data-rq-att-view).
    const photoHTML = e.photo?.id
      ? `<div class="rrm-eq-photo" data-rq-att-view="${e.photo.id}" role="button" tabindex="0" title="${escapeHTML(t('equipment.photo_view') || '')}"><img data-rq-eq-photo="${e.photo.id}" alt=""></div>`
      : '';
    equipBlock = `<div class="rrm-eq${photoHTML ? ' rrm-eq--haspic' : ''}">
      ${photoHTML}
      <div class="rrm-eq-main">
        <div class="rrm-eq-title"><i class="ph ${e.category_icon || 'ph-desktop'}"></i> ${escapeHTML(title)}</div>
        <div class="rrm-eq-grid">
          ${row('equipment.inventory_short', e.inventory_number)}
          ${row('equipment.serial_short', e.serial_number)}
          ${row('equipment.category_label', cat)}
          ${row('equipment.location_label', e.location)}
          ${row('equipment.responsible_label', e.responsible_name)}
          ${row('equipment.warranty_label', warranty)}
        </div>
      </div></div>`;
  } else {
    equipBlock = `<div class="rrm-eq rrm-eq--none"><i class="ph ph-desktop-slash"></i> ${escapeHTML(t('requests.no_equipment'))}</div>`;
  }

  const ratingVal = r.rating
    ? `<span class="rrm-sum-stars">${'<i class="ph-fill ph-star"></i>'.repeat(r.rating)}${'<i class="ph ph-star"></i>'.repeat(5 - r.rating)}</span>`
    : '';

  // Срок хранения вложений: у закрытой/отменённой заявки медиа удаляются через
  // closed_request_media_retention_days после терминального события.
  const retDays = Number(_profile?.organization?.limits?.closed_request_media_retention_days) || 0;
  const hasAtt = (data.attachments || []).length || (data.history || []).some(h => (h.attachments || []).length);
  let retentionNote = '';
  if ((r.status === 'closed' || r.status === 'cancelled') && termAt && hasAtt && retDays > 0) {
    const delDate = new Date(new Date(termAt).getTime() + retDays * 86400000);
    const daysLeft = Math.max(0, Math.ceil((delDate.getTime() - Date.now()) / 86400000));
    retentionNote = `<div class="rrm-att-retention"><i class="ph ph-trash"></i> ${escapeHTML(t('requests.media_retention', { date: delDate.toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ru-RU'), days: daysLeft }))}</div>`;
  }

  const sumEl = document.querySelector('#rrm-summary');
  sumEl.innerHTML = `
    <div class="rrm-bars">${barsHTML}</div>
    ${equipBlock}
    ${ratingVal ? `<div class="rrm-rating-row"><span class="rrm-rating-lbl">${escapeHTML(t('requests.sum_rating'))}</span> ${ratingVal}</div>` : ''}
    ${retentionNote}`;
  // Приватное фото техники + плавная заливка баров (0 → цель).
  loadEquipmentThumbs(sumEl);
  requestAnimationFrame(() => sumEl.querySelectorAll('.rrm-bar-fill[data-w]').forEach(f => { f.style.width = f.dataset.w + '%'; }));

  // Описание заявки = сообщение автора при создании. Показываем его как
  // комментарий события «Заявка создана» (new→new), если у того ещё нет
  // собственного комментария. Не мутируем исходные данные — копия.
  const history = (data.history || []).map(h => {
    if (h.old_status === h.new_status && !h.comment && r.description) {
      return { ...h, comment: r.description };
    }
    return h;
  });
  const histEl = document.querySelector('#rrm-history');
  histEl.innerHTML = historyHTML(history, { author: r.author_name, assignee: r.assignee_name });
  loadAttachmentThumbs(histEl);

  renderRoadmapActions(r);
}

/* Футер дорожной карты — у каждой кнопки своё место:
     • слева — деструктивное «Отменить заявку» (ghost);
     • справа — переходы статуса (primary) и «Редактировать» (secondary);
     • если действий нет вообще (закрытая/отменённая или нет прав) —
       одна кнопка «Закрыть» на всю ширину. При наличии действий
       отдельной «Закрыть» нет — есть × в шапке модалки.              */
function renderRoadmapActions(r) {
  const wrap = document.querySelector('#rrm-actions');
  if (!wrap) return;
  const isAssignee = Number(r.assigned_to_id) === Number(_selfId);
  const isContractor = Number(r.contractor_org_id) === Number(_myOrgId);
  const isAuthor = Number(r.author_id) === Number(_selfId);
  const isAuthorOrOwner = isAuthor || (_isOwner && Number(r.client_org_id) === Number(_myOrgId));
  const b = (action, key, cls = 'btn-primary', icon = 'ph-arrow-right') =>
    `<button class="btn ${cls}" data-rq-act="${action}" data-rq-id="${r.id}"><i class="ph ${icon}"></i> <span>${escapeHTML(t(key))}</span></button>`;

  const actions = [];
  // Автор не может взять собственную заявку (backend тоже запрещает).
  if (r.status === 'new' && isContractor && !isAuthor) actions.push(b('take', 'requests.act_take', 'btn-primary', 'ph-hand-grabbing'));
  if (r.status === 'assigned' && isAssignee)           actions.push(b('start', 'requests.act_start', 'btn-primary', 'ph-play'));
  if (r.status === 'in_progress' && isAssignee)        actions.push(b('finish', 'requests.act_finish', 'btn-primary', 'ph-check'));
  // Закрыть+оценить может заказчик (автор/владелец), но НЕ исполнитель:
  // нельзя оценивать собственную работу. Для внутренних заявок владелец
  // может оказаться и исполнителем (взял заявку сам) — тогда оценивает
  // автор, а не он. Backend дублирует этот запрет (cannot_rate_own_work).
  if (r.status === 'done' && isAuthorOrOwner && !isAssignee) actions.push(b('close', 'requests.act_close', 'btn-primary', 'ph-star'));
  if (r.status === 'new' && isAuthor)                  actions.push(b('edit', 'requests.act_edit', 'btn-secondary', 'ph-pencil-simple'));
  const danger = (!['closed', 'cancelled'].includes(r.status) && isAuthorOrOwner)
    ? b('cancel', 'requests.act_cancel', 'btn-danger-ghost', 'ph-x-circle')
    : '';

  if (!actions.length && !danger) {
    wrap.innerHTML = `<button class="btn btn-secondary" data-close-modal="request-roadmap-modal" data-i18n="common.close">${escapeHTML(t('common.close'))}</button>`;
    return;
  }
  // danger первым в DOM → margin-right:auto в CSS прижимает его влево.
  wrap.innerHTML = danger + actions.join('');
}

// Приватные миниатюры вложений.
function loadAttachmentThumbs(scope) {
  scope.querySelectorAll('img[data-rq-att-id]').forEach(async (img) => {
    const id = Number(img.getAttribute('data-rq-att-id'));
    if (!id) return;
    try { const url = await media.loadPrivateImage(id); _imgCache.set(id, url); img.src = url; } catch {}
  });
}

/* ── Lifecycle actions ─────────────────────────────────────────── */
async function doAction(action, id) {
  if (action === 'edit')   { closeModal('request-roadmap-modal'); return openEditModal(id); }
  if (action === 'finish') return openFinishModal(id);
  if (action === 'close')  return openCloseModal(id);
  if (action === 'cancel') return openCancelModal(id);
  // take / start — без доп. ввода.
  try {
    await reqApi.status(id, action);
    toast(t('requests.action_done'), 'ok');
    await loadRequests();
    const fresh = await reqApi.get(id);
    renderRoadmap(fresh.data);
  } catch (err) { toast(errorMessage(err), 'error'); }
}

/* finish */
function openFinishModal(id) {
  _roadmapId = id; _finishFiles = [];
  const ta = document.querySelector('#rq-resolution'); if (ta) ta.value = '';
  renderAttachList();                 // сетка вложений с квадратом «+» (без этого блок был пустым)
  refreshFinishGuard();               // «Завершить» серая, пока нет описания
  clearFieldErrorById('err-rq-resolution'); hideAlertById('err-rq-finish');
  openModal('request-finish-modal');
  refreshCharCounters(document.querySelector('#request-finish-modal'));
}
// Серая «Завершить», пока поле «Что сделано» пустое.
function refreshFinishGuard() {
  const btn = document.querySelector('#btn-rq-finish-confirm');
  if (btn) btn.classList.toggle('is-pending', !(document.querySelector('#rq-resolution')?.value || '').trim());
}
// Превью-тайлы вложений (миниатюра изображения / иконка PDF + имя + удалить).
// Клик по тайлу (кроме «удалить») — повторный полный предпросмотр через
// doc-preview (как у документа контракта).
// Лимит на одну запись статуса берётся из лимитов организации
// (max_photo_per_request + max_document_per_request), а НЕ хардкодится —
// фронт должен соответствовать ограничениям БД/бэка. Бэкенд при confirm
// дополнительно проверяет лимиты по каждому типу отдельно.
function attachMax() {
  const l = _profile?.organization?.limits;
  if (!l) return 4;
  const n = (Number(l.max_photo_per_request) || 0) + (Number(l.max_document_per_request) || 0);
  return n > 0 ? n : 4;
}
function attachTilesHTML(files, prefix) {
  const tiles = files.map((f, i) => {
    const isImg = f.file.type.startsWith('image/');
    const thumb = isImg && f.previewUrl
      ? `<img src="${f.previewUrl}" alt="">`
      : `<i class="ph-duotone ph-file-pdf"></i>`;
    return `<div class="rq-attach-sq" data-${prefix}-view="${i}" role="button" tabindex="0" title="${escapeHTML(f.file.name)}">
      ${thumb}
      <button class="rq-attach-x" data-${prefix}-remove="${i}" aria-label="x"><i class="ph ph-x"></i></button>
    </div>`;
  });
  // Квадрат «+» — пока не достигнут лимит организации.
  if (files.length < attachMax()) {
    tiles.push(`<button type="button" class="rq-attach-sq rq-attach-sq--add" data-${prefix}-add aria-label="+"><i class="ph ph-plus"></i></button>`);
  }
  return tiles.join('');
}
function renderAttachList() {
  const wrap = document.querySelector('#rq-attach-list');
  if (wrap) wrap.innerHTML = attachTilesHTML(_finishFiles, 'rq-att');
}
function renderCreateAttachList() {
  const wrap = document.querySelector('#rq-c-attach-list');
  if (wrap) wrap.innerHTML = attachTilesHTML(_createFiles, 'rq-c-att');
}

async function confirmFinish() {
  const resolution = (document.querySelector('#rq-resolution')?.value || '').trim();
  if (!resolution) { setFieldError('err-rq-resolution', t('errors.required')); return; }
  const btn = document.querySelector('#btn-rq-finish-confirm');
  setLoading(btn, true);
  try {
    const ids = _finishFiles.map(f => f.mediaId).filter(Boolean);
    await reqApi.status(_roadmapId, 'finish', { resolution_text: resolution, attachment_media_ids: ids });
    closeModal('request-finish-modal');
    toast(t('requests.finished_toast'), 'ok');
    await loadRequests();
    const fresh = await reqApi.get(_roadmapId); renderRoadmap(fresh.data);
  } catch (err) {
    showAlertText('err-rq-finish', 'err-rq-finish-text', errorMessage(err));
  } finally { setLoading(btn, false); }
}

/* close + rating */
function openCloseModal(id) {
  _roadmapId = id; _ratingVal = 0;
  syncStars();
  const c = document.querySelector('#rq-rating-comment'); if (c) c.value = '';
  clearFieldErrorById('err-rq-rating');
  openModal('request-close-modal');
}
function syncStars() {
  document.querySelectorAll('#rq-rating [data-star]').forEach(st => {
    const v = Number(st.dataset.star);
    st.classList.toggle('ph-fill', v <= _ratingVal);
    st.classList.toggle('ph', v > _ratingVal);
    st.classList.toggle('is-on', v <= _ratingVal);
  });
  // «Закрыть заявку» серая, пока не выбрана оценка (как у прочих модалок).
  const btn = document.querySelector('#btn-rq-close-confirm');
  if (btn) btn.classList.toggle('is-pending', _ratingVal < 1);
}
async function confirmClose() {
  if (_ratingVal < 1) { setFieldError('err-rq-rating', t('requests.rating_required_msg')); return; }
  const btn = document.querySelector('#btn-rq-close-confirm');
  setLoading(btn, true);
  try {
    await reqApi.status(_roadmapId, 'close', {
      rating: _ratingVal,
      rating_comment: (document.querySelector('#rq-rating-comment')?.value || '').trim() || undefined,
    });
    closeModal('request-close-modal');
    toast(t('requests.closed_toast'), 'ok');
    await loadRequests();
    const fresh = await reqApi.get(_roadmapId); renderRoadmap(fresh.data);
  } catch (err) { toast(errorMessage(err), 'error'); }
  finally { setLoading(btn, false); }
}

/* cancel */
function openCancelModal(id) {
  _roadmapId = id;
  const c = document.querySelector('#rq-cancel-comment'); if (c) c.value = '';
  openModal('request-cancel-modal');
}
async function confirmCancel() {
  const btn = document.querySelector('#btn-rq-cancel-confirm');
  setLoading(btn, true);
  try {
    await reqApi.status(_roadmapId, 'cancel', { comment: (document.querySelector('#rq-cancel-comment')?.value || '').trim() || undefined });
    closeModal('request-cancel-modal');
    toast(t('requests.cancelled_toast'), 'ok');
    await loadRequests();
    const fresh = await reqApi.get(_roadmapId); renderRoadmap(fresh.data);
  } catch (err) { toast(errorMessage(err), 'error'); }
  finally { setLoading(btn, false); }
}

/* ── Wiring (once) ─────────────────────────────────────────────── */
function wireOnce() {
  if (window.__remsRequestsWired) return;
  window.__remsRequestsWired = true;

  // Переход из уведомления о заявке (#requests/<id>) → подсветить карточку.
  document.addEventListener('rems:focus-request', (e) => focusRequest(e.detail?.id));

  // Тип заявки (radio cards).
  document.querySelectorAll('[data-rq-type]').forEach(card => {
    card.addEventListener('click', () => { if (!card.classList.contains('is-disabled')) selectType(card.dataset.rqType); });
  });
  document.querySelector('#rq-contract')?.addEventListener('change', () => { renderSlaGrid(); refreshGuards(); });
  // Кастомный список техники — выбор строки (клик или Enter/Space).
  const eqListEl = document.querySelector('#rq-equipment-list');
  eqListEl?.addEventListener('click', (e) => {
    const row = e.target.closest('[data-rq-eq]'); if (!row) return;
    selectEquipment(row.dataset.rqEq);
  });
  eqListEl?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('[data-rq-eq]'); if (!row) return;
    e.preventDefault();
    selectEquipment(row.dataset.rqEq);
  });
  document.querySelector('#rq-desc')?.addEventListener('input', refreshGuards);
  // SLA-плашки = выбор приоритета.
  document.querySelector('#rq-sla-grid')?.addEventListener('click', (e) => {
    const cell = e.target.closest('[data-rq-prio]'); if (!cell) return;
    setPriority(cell.dataset.rqPrio);
  });

  // Вложения при создании — doc-preview (ограничения → превью → имя;
  // Сохранить / Выбрать другое / Отмена). Список — сетка квадратов + «+».
  _createDoc = wireDocPreview({
    entityType: 'request_attachments',
    titleKey: 'requests.attach_title', hintKey: 'requests.attach_hint',
    onSave: ({ mediaFileId, file }) => {
      _createFiles.push({ mediaId: mediaFileId, file, previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null });
      renderCreateAttachList();
    },
  });
  document.querySelector('#rq-c-attach-list')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-rq-c-att-add]')) { _createDoc.openPicker(); return; }
    const rm = e.target.closest('[data-rq-c-att-remove]');
    if (rm) { e.stopPropagation(); _createFiles.splice(Number(rm.dataset.rqCAttRemove), 1); renderCreateAttachList(); return; }
    const view = e.target.closest('[data-rq-c-att-view]');
    if (view) { const f = _createFiles[Number(view.dataset.rqCAttView)]; if (f) _createDoc.reopenPreview(f.file); }
  });

  // Навигация по шагам. «Далее» проверяет шаг 1; «Назад» возвращает.
  document.querySelector('#btn-rq-next')?.addEventListener('click', () => {
    if (!step1Valid()) { highlightStep1(); return; }
    goToStep(2);
  });
  document.querySelector('#btn-rq-back')?.addEventListener('click', () => goToStep(1));
  document.querySelector('#btn-rq-submit')?.addEventListener('click', submitRequest);

  // Открытие модалки новой заявки с предвыбранным оборудованием
  // (диспатчит equipment.js по кнопке на карточке техники).
  window.addEventListener('rems:new-request', (e) => openCreateModal(e.detail?.equipmentId));
  // Открытие дорожной карты заявки по id (кнопка «Перейти к заявке» в
  // карточке техники). Модалка глобальная — работает с любой вкладки.
  window.addEventListener('rems:open-request', (e) => { const id = Number(e.detail?.requestId); if (id) openRoadmap(id); });

  // Finish modal — вложения через doc-preview (сетка квадратов).
  _finishDoc = wireDocPreview({
    entityType: 'request_attachments',
    titleKey: 'requests.attach_title', hintKey: 'requests.attach_hint',
    onSave: ({ mediaFileId, file }) => {
      _finishFiles.push({ mediaId: mediaFileId, file, previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null });
      renderAttachList();
    },
  });
  document.querySelector('#rq-attach-list')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-rq-att-add]')) { _finishDoc.openPicker(); return; }
    const rm = e.target.closest('[data-rq-att-remove]');
    if (rm) { e.stopPropagation(); _finishFiles.splice(Number(rm.dataset.rqAttRemove), 1); renderAttachList(); return; }
    const view = e.target.closest('[data-rq-att-view]');
    if (view) { const f = _finishFiles[Number(view.dataset.rqAttView)]; if (f) _finishDoc.reopenPreview(f.file); }
  });
  document.querySelector('#rq-resolution')?.addEventListener('input', refreshFinishGuard);
  document.querySelector('#btn-rq-finish-confirm')?.addEventListener('click', confirmFinish);

  // Rating stars.
  document.querySelector('#rq-rating')?.addEventListener('click', (e) => {
    const st = e.target.closest('[data-star]'); if (!st) return;
    _ratingVal = Number(st.dataset.star); syncStars(); clearFieldErrorById('err-rq-rating');
  });
  document.querySelector('#btn-rq-close-confirm')?.addEventListener('click', confirmClose);
  document.querySelector('#btn-rq-cancel-confirm')?.addEventListener('click', confirmCancel);

  // Делегированные клики (контейнеры/карта пересоздаются).
  // ВАЖНО: вложения проверяем ДО data-rq-open — мини-превью лежат внутри
  // кликабельной карточки, и closest('[data-rq-open]') иначе перехватил
  // бы клик и открыл дорожную карту вместо просмотрщика.
  document.addEventListener('click', (e) => {
    // Плитка-фильтр: тоггл быстрого фильтра связанной ленты. Плитки лежат в
    // отдельном контейнере [data-rq-tiles="<name>"], лента — [data-rq-filter].
    const tile = e.target.closest?.('[data-rq-tile]');
    if (tile) {
      const name = tile.closest('[data-rq-tiles]')?.dataset.rqTiles;
      const feed = name ? document.querySelector(`[data-requests-list][data-rq-filter="${name}"]`) : null;
      if (feed) { const id = tile.dataset.rqTile; feed.dataset.rqQuick = (feed.dataset.rqQuick === id ? 'all' : id); renderAll(); }
      return;
    }
    // Сегмент «Тип заявки» (Все/Внутренние/Партнёрские).
    const scopePick = e.target.closest?.('[data-rq-scope-pick]');
    if (scopePick) {
      const name = scopePick.closest('[data-rq-scope]')?.dataset.rqScope;
      const feed = name ? document.querySelector(`[data-requests-list][data-rq-filter="${name}"]`) : null;
      if (feed) { feed.dataset.rqScope = scopePick.dataset.rqScopePick; renderAll(); }
      return;
    }
    // Чип «Команда»: МНОЖЕСТВЕННЫЙ выбор сотрудников; «Все» (пустой id) сбрасывает.
    const teamPick = e.target.closest?.('[data-rq-team-pick]');
    if (teamPick) {
      const name = teamPick.closest('[data-rq-team]')?.dataset.rqTeam;
      const feed = name ? document.querySelector(`[data-requests-list][data-rq-filter="${name}"]`) : null;
      if (feed) {
        const id = teamPick.dataset.rqTeamPick;
        if (!id) { feed.dataset.rqTeamEmp = ''; }            // «Все» → сброс
        else {
          const set = new Set((feed.dataset.rqTeamEmp || '').split(',').filter(Boolean));
          set.has(id) ? set.delete(id) : set.add(id);
          feed.dataset.rqTeamEmp = [...set].join(',');
        }
        renderAll();
      }
      return;
    }
    const attView = e.target.closest?.('[data-rq-att-view]');
    if (attView) { openMediaViewer(Number(attView.dataset.rqAttView), { name: `attachment-${attView.dataset.rqAttView}` }); return; }
    const attOpen = e.target.closest?.('[data-rq-att-open]');
    if (attOpen) { openMediaViewer(Number(attOpen.dataset.rqAttOpen), { name: `attachment-${attOpen.dataset.rqAttOpen}` }); return; }
    const create = e.target.closest?.('[data-rq-create]');
    if (create) { openCreateModal(); return; }
    const open = e.target.closest?.('[data-rq-open]');
    if (open) { openRoadmap(Number(open.dataset.rqOpen)); return; }
    const act = e.target.closest?.('#rrm-actions [data-rq-act]');
    if (act) { doAction(act.dataset.rqAct, Number(act.dataset.rqId)); return; }
    // Кнопка «Закрыть» в футере дорожной карты рендерится динамически —
    // статический [data-close-modal]-байндинг из index.js её не покрывает.
    const rrmClose = e.target.closest?.('#rrm-actions [data-close-modal]');
    if (rrmClose) { closeModal(rrmClose.dataset.closeModal); return; }
  });

  // Карточка заявки кликабельна целиком (role="button") — поддержим
  // клавиатурную активацию Enter/Space.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest?.('.request-card[data-rq-open]');
    if (!card) return;
    e.preventDefault();
    openRoadmap(Number(card.dataset.rqOpen));
  });

  // Socket: любое изменение заявки в орг → перезагрузка + обновление карты.
  // Перезагрузку ленты ДЕБАУНСИМ (250мс): один пользовательский шаг порождает
  // несколько событий (created обеим сторонам, переходы статуса), а в активной
  // орг события идут пачками — без дебаунса каждый клиент дёргал бы полный
  // GET /api/requests на каждое, нагружая бэк и БД. Обновление открытой карты
  // делаем сразу и точечно (один запрос по id).
  socketOn('requests:changed', async (payload) => {
    clearTimeout(_reloadTimer);
    _reloadTimer = setTimeout(() => { loadRequests().catch(() => {}); }, 250);
    if (_roadmapId && document.querySelector('#request-roadmap-modal')?.classList.contains('open')
        && payload?.requestId && Number(payload.requestId) === Number(_roadmapId)) {
      try { const fresh = await reqApi.get(_roadmapId); renderRoadmap(fresh.data); } catch {}
    }
  });

  onLangChange(() => renderAll());
}
