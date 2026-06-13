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
  requestListHTML, historyHTML, statusBadge, priorityBadge,
  statusLabel, escapeHTML, typeChipHTML,
} from './requests-ui.js';
import { statusBadge as eqStatusBadge } from './equipment-ui.js';

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
  wireOnce();
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

export function renderAll() {
  document.querySelectorAll('[data-requests-list]').forEach(el => {
    // Завершённые/отменённые — всегда внизу списка любого фильтра
    // (stable sort сохраняет порядок по дате внутри каждой группы).
    const isTerminal = (r) => (r.status === 'closed' || r.status === 'cancelled') ? 1 : 0;
    const list = [...filterFor(el.dataset.rqFilter || 'all')].sort((a, b) => isTerminal(a) - isTerminal(b));
    el.innerHTML = requestListHTML(list);
    // Мини-превью вложений последнего статуса (приватные изображения).
    loadAttachmentThumbs(el);
    // счётчик рядом (если есть)
    const card = el.closest('.card');
    const cnt = card?.querySelector('[data-requests-count]');
    if (cnt) cnt.textContent = String(list.length);
  });
  // Подписчики (статистика на overview-вкладках и т.п.).
  _updateListeners.forEach((cb) => { try { cb(_requests); } catch (e) { console.warn('[requests listener]', e); } });
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
    sla: { critical_h: lim.internal_sla_critical_h, high_h: lim.internal_sla_high_h,
           medium_h: lim.internal_sla_medium_h, low_h: lim.internal_sla_low_h },
  };
}

// 4 кликабельные SLA-плашки = выбор приоритета. Часы реакции берутся из
// источника (контракт / внутренние SLA орг). Выбранная — подсвечена.
function renderSlaGrid() {
  const grid = document.querySelector('#rq-sla-grid');
  const srcEl = document.querySelector('#rq-sla-source');
  if (!grid) return;
  const src = slaSource();
  const h = t('profile.hours_short');
  const order = [['critical', 'critical_h'], ['high', 'high_h'], ['medium', 'medium_h'], ['low', 'low_h']];
  grid.innerHTML = order.map(([p, key]) => {
    const v = src?.sla?.[key];
    return `<button type="button" class="rq-sla-cell rq-prio-${p}${_priority === p ? ' is-on' : ''}" data-rq-prio="${p}">
      <span class="rq-sla-cell-label">${escapeHTML(t('requests.priority.' + p))}</span>
      <span class="rq-sla-cell-val">${v != null ? `${v} ${escapeHTML(h)}` : '—'}</span>
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
      <div class="rq-eq-status">${eqStatusBadge(eq.status)}</div>
    </div>`;
}

// Кастомный список техники + скрытый #rq-equipment как источник значения
// (его читают step2Valid/submit). selectedId — предвыбор (edit / с карточки).
function populateEquipmentSelect(selectedId) {
  const hidden = document.querySelector('#rq-equipment');
  const wrap   = document.querySelector('#rq-equipment-list');
  if (hidden) hidden.value = selectedId ? String(selectedId) : '';
  if (!wrap) return;
  const list = _eqCache || [];
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

function renderRoadmap(data) {
  const r = data.request;
  _requests = _requests.map(x => Number(x.id) === Number(r.id) ? r : x); // keep cache fresh
  const numEl = document.querySelector('#rrm-number'); if (numEl) numEl.textContent = r.request_number;
  // Чипы статуса / приоритета(SLA) / типа — в блоке заголовка после номера.
  const subEl = document.querySelector('#rrm-sub');
  if (subEl) {
    subEl.classList.add('rrm-sub-chips');
    subEl.innerHTML = `${statusBadge(r.status)}${priorityBadge(r.priority)}${typeChipHTML(r)}`;
  }

  // Сводка: бейджи → описание в мягкой панели → сетка «подпись/значение».
  // titleText — нативная подсказка на случай обрезанного значения;
  // wide — растянуть элемент на всю строку сетки (длинные «Стороны»).
  const sumItem = (icon, labelKey, valueHTML, { titleText = '', wide = false } = {}) => `
    <div class="rrm-sum-item${wide ? ' rrm-sum-item--wide' : ''}">
      <span class="rrm-sum-ico"><i class="ph ${icon}"></i></span>
      <span class="rrm-sum-text">
        <span class="rrm-sum-lbl">${escapeHTML(t(labelKey))}</span>
        <span class="rrm-sum-val"${titleText ? ` title="${escapeHTML(titleText)}"` : ''}>${valueHTML}</span>
      </span>
    </div>`;
  const eqVal = r.equipment
    ? escapeHTML([r.equipment.brand, r.equipment.model].filter(Boolean).join(' ') || r.equipment.inventory_number || '—')
    : escapeHTML(t('requests.no_equipment'));
  const eqIcon = r.equipment?.category_icon || 'ph-desktop';
  const partiesVal = r.is_internal
    ? escapeHTML(r.client_org_name || t('requests.internal_tag'))
    : `${escapeHTML(r.client_org_name || '—')} <i class="ph ph-arrow-right rq-parties-arrow"></i> ${escapeHTML(r.contractor_org_name || '—')}`;
  const ratingVal = r.rating
    ? `<span class="rrm-sum-stars">${'<i class="ph-fill ph-star"></i>'.repeat(r.rating)}${'<i class="ph ph-star"></i>'.repeat(5 - r.rating)}</span>`
    : '';
  const partiesTitle = r.is_internal
    ? (r.client_org_name || '')
    : `${r.client_org_name || '—'} → ${r.contractor_org_name || '—'}`;
  // Сводка — только сетка «подпись/значение» (бейджи ушли в заголовок,
  // описание-сообщение ушло под событие «Заявка создана» в истории).
  document.querySelector('#rrm-summary').innerHTML = `
    <div class="rrm-sum-grid">
      ${sumItem(r.is_internal ? 'ph-buildings' : 'ph-handshake', 'requests.sum_parties', partiesVal, { titleText: partiesTitle, wide: !r.is_internal })}
      ${sumItem(eqIcon, 'requests.sum_equipment', eqVal, { titleText: r.equipment ? eqVal.replace(/&[a-z]+;/g, '') : '' })}
      ${sumItem('ph-user', 'requests.sum_author', escapeHTML(r.author_name || '—'), { titleText: r.author_name || '' })}
      ${sumItem('ph-user-gear', 'requests.sum_executor', escapeHTML(r.assignee_name || t('requests.unassigned')), { titleText: r.assignee_name || '' })}
      ${r.due_date ? sumItem('ph-calendar', 'requests.sum_due', escapeHTML(new Date(r.due_date).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ru-RU'))) : ''}
      ${ratingVal ? sumItem('ph-star', 'requests.sum_rating', ratingVal) : ''}
    </div>`;

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
  histEl.innerHTML = historyHTML(history);
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
  if (r.status === 'done' && isAuthorOrOwner)          actions.push(b('close', 'requests.act_close', 'btn-primary', 'ph-star'));
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
  document.querySelector('#rq-attach-list').innerHTML = '';
  clearFieldErrorById('err-rq-resolution'); hideAlertById('err-rq-finish');
  openModal('request-finish-modal');
  refreshCharCounters(document.querySelector('#request-finish-modal'));
}
// Превью-тайлы вложений (миниатюра изображения / иконка PDF + имя + удалить).
// Клик по тайлу (кроме «удалить») — повторный полный предпросмотр через
// doc-preview (как у документа контракта).
// Сетка квадратов: миниатюры вложений + квадрат «+» в конце. Лимит — 4
// файла на одну запись статуса (3 фото + 1 документ — как раз ряд из 4).
const RQ_ATTACH_MAX = 4;
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
  // Квадрат «+» — пока не достигнут лимит.
  if (files.length < RQ_ATTACH_MAX) {
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
  socketOn('requests:changed', async (payload) => {
    await loadRequests();
    if (_roadmapId && document.querySelector('#request-roadmap-modal')?.classList.contains('open')
        && payload?.requestId && Number(payload.requestId) === Number(_roadmapId)) {
      try { const fresh = await reqApi.get(_roadmapId); renderRoadmap(fresh.data); } catch {}
    }
  });

  onLangChange(() => renderAll());
}
