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
import { t, applyTranslations, onLangChange } from '../../../../i18n.js';
import {
  openModal, closeModal, setLoading,
  setFieldError, clearFieldErrorById, showAlertText, hideAlertById,
} from '../../ui-helpers.js';
import { on as socketOn } from '../../../../socket.js';
import { refreshCharCounters } from '../../../../lib/char-counter.js';
import { openMediaViewer } from '../../../../lib/media-viewer.js';
import { wireDocPreview } from '../../../../lib/doc-preview.js';
import {
  requestListHTML, railHTML, historyHTML, statusBadge, priorityBadge,
  statusLabel, escapeHTML,
} from './requests-ui.js';

let _requests = [];
let _profile = null, _selfId = null, _myOrgId = null, _isOwner = false;
let _eqCache = null, _contractCache = null;
let _editId = null;
let _roadmapId = null;        // открытая в дорожной карте заявка
let _finishFiles = [];        // [{file, mediaId}] — вложения при завершении
let _createFiles = [];        // [{file, mediaId}] — вложения при создании
let _priority = 'medium';     // выбранный приоритет (pill)
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
  if (name === 'free')    return _requests.filter(r => r.status === 'new' && Number(r.contractor_org_id) === Number(_myOrgId));
  if (name === 'current') return _requests.filter(r => Number(r.assigned_to_id) === Number(_selfId) && ['assigned', 'in_progress'].includes(r.status));
  if (name === 'mine')    return _requests.filter(r => Number(r.author_id) === Number(_selfId));
  return _requests; // all
}

export function renderAll() {
  document.querySelectorAll('[data-requests-list]').forEach(el => {
    const list = filterFor(el.dataset.rqFilter || 'all');
    el.innerHTML = requestListHTML(list);
    // счётчик рядом (если есть)
    const card = el.closest('.card');
    const cnt = card?.querySelector('[data-requests-count]');
    if (cnt) cnt.textContent = String(list.length);
  });
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

/* ── Create / edit modal (одна страница, без шагов) ─────────────── */
async function openCreateModal(prefillEquipmentId) {
  _editId = null;
  await Promise.all([ensureEquipment(), ensureContracts()]);
  resetRqModal();
  setRqTitle('requests.create_title');
  setSubmitLabel('requests.create_confirm');
  if (prefillEquipmentId) { populateEquipmentSelect(prefillEquipmentId); syncEquipmentMeta(); }
  refreshSubmitGuard();
  openModal('request-modal');
  refreshCharCounters(document.querySelector('#request-modal'));
}

async function openEditModal(id) {
  const r = _requests.find(x => Number(x.id) === Number(id));
  if (!r) return;
  _editId = id;
  await Promise.all([ensureEquipment(), ensureContracts()]);
  resetRqModal();
  setRqTitle('requests.edit_title');
  setSubmitLabel('common.save');
  selectType(r.is_internal ? 'internal' : 'contract');
  setPriority(r.priority);
  populateEquipmentSelect(r.equipment?.id ?? '');
  syncEquipmentMeta();
  document.querySelector('#rq-desc').value = r.description || '';
  refreshSubmitGuard();
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
  syncEquipmentMeta();
  _priority = null;          // приоритет не выбран — пользователь кликает SLA-плашку
  renderSlaGrid();
  _createFiles = [];
  renderCreateAttachList();
  const d = document.querySelector('#rq-desc'); if (d) d.value = '';
  clearFieldErrorById('err-rq-desc');
  clearFieldErrorById('err-rq-equipment');
  clearFieldErrorById('err-rq-priority');
  hideAlertById('err-rq');
}

// ── Приоритет = выбор SLA-плашки (цвет + часы реакции) ──────────────
function setPriority(p) {
  _priority = p;
  document.querySelectorAll('#rq-sla-grid [data-rq-prio]').forEach(el => {
    el.classList.toggle('is-on', el.dataset.rqPrio === p);
  });
  clearFieldErrorById('err-rq-priority');
  refreshSubmitGuard();
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

// ── Мета выбранного оборудования (иконка + название) ────────────────
function syncEquipmentMeta() {
  const box = document.querySelector('#rq-equipment-meta');
  if (!box) return;
  const id = Number(document.querySelector('#rq-equipment')?.value);
  const eq = (_eqCache || []).find(e => Number(e.id) === id);
  if (!eq) { box.innerHTML = ''; box.style.display = 'none'; return; }
  box.style.display = '';
  const name = [eq.brand, eq.model].filter(Boolean).join(' ') || eq.inventory_number;
  box.innerHTML = `
    <i class="ph-duotone ${eq.category_icon || 'ph-desktop'}"></i>
    <div class="rq-meta-text">
      <div class="rq-meta-title">${escapeHTML(name)}</div>
      <div class="rq-meta-sub">${escapeHTML(t('equipment.inventory_short'))}: ${escapeHTML(eq.inventory_number)}${eq.location ? ' · ' + escapeHTML(eq.location) : ''}</div>
    </div>`;
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
  refreshSubmitGuard();
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

function populateEquipmentSelect(selectedId) {
  const sel = document.querySelector('#rq-equipment');
  if (!sel) return;
  const list = _eqCache || [];
  const opts = [`<option value="" disabled selected>${escapeHTML(t('requests.equipment_select_ph'))}</option>`]
    .concat(list.map(e => `<option value="${e.id}">${escapeHTML([e.brand, e.model].filter(Boolean).join(' ') || e.inventory_number)}</option>`));
  sel.innerHTML = opts.join('');
  if (selectedId) sel.value = String(selectedId);
}

function curType() {
  return document.querySelector('input[name="rq-type"]:checked')?.value || 'internal';
}

// Все обязательные поля заполнены? (тип+контракт, приоритет, оборудование, описание)
function formValid() {
  if (curType() === 'contract' && !document.querySelector('#rq-contract')?.value) return false;
  if (!_priority) return false;
  if (!document.querySelector('#rq-equipment')?.value) return false;
  if (!(document.querySelector('#rq-desc')?.value || '').trim()) return false;
  return true;
}
function refreshSubmitGuard() {
  const btn = document.querySelector('#btn-rq-submit');
  if (btn) btn.classList.toggle('is-pending', !formValid());
}
// Подсветить незаполненные обязательные поля (клик по серой кнопке).
function highlightMissing() {
  if (curType() === 'contract' && !document.querySelector('#rq-contract')?.value)
    showAlertText('err-rq', 'err-rq-text', t('requests.contract_required'));
  if (!_priority) setFieldError('err-rq-priority', t('errors.required'));
  if (!document.querySelector('#rq-equipment')?.value) setFieldError('err-rq-equipment', t('errors.required'));
  if (!(document.querySelector('#rq-desc')?.value || '').trim()) setFieldError('err-rq-desc', t('errors.required'));
}

async function submitRequest() {
  if (!formValid()) { highlightMissing(); return; }   // серая кнопка → подсветить
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
  const railEl = document.querySelector('#rrm-rail');
  const histEl = document.querySelector('#rrm-history');
  const sumEl  = document.querySelector('#rrm-summary');
  if (railEl) railEl.innerHTML = '';
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
  const subEl = document.querySelector('#rrm-sub');
  if (subEl) subEl.innerHTML = `${statusLabel(r.status)} · ${escapeHTML(t('requests.priority.' + r.priority))}`;

  document.querySelector('#rrm-rail').innerHTML = railHTML(data.history, r.status);

  const eqLine = r.equipment ? `<i class="ph ${r.equipment.category_icon || 'ph-desktop'}"></i> ${escapeHTML([r.equipment.brand, r.equipment.model].filter(Boolean).join(' ') || r.equipment.inventory_number || '—')}` : t('requests.no_equipment');
  const parties = r.is_internal ? t('requests.internal_tag') : `${escapeHTML(r.client_org_name || '—')} → ${escapeHTML(r.contractor_org_name || '—')}`;
  document.querySelector('#rrm-summary').innerHTML = `
    <div class="rrm-sum-row">${statusBadge(r.status)}${priorityBadge(r.priority)}</div>
    <div class="rrm-sum-desc">${escapeHTML(r.description)}</div>
    <div class="rrm-sum-meta">
      <span class="contract-muted">${parties}</span>
      <span class="contract-muted">${eqLine}</span>
      ${r.assignee_name ? `<span class="contract-muted"><i class="ph ph-user"></i> ${escapeHTML(r.assignee_name)}</span>` : ''}
      ${r.due_date ? `<span class="contract-muted"><i class="ph ph-calendar"></i> ${escapeHTML(new Date(r.due_date).toLocaleDateString())}</span>` : ''}
      ${r.rating ? `<span class="contract-muted">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</span>` : ''}
    </div>`;

  const histEl = document.querySelector('#rrm-history');
  histEl.innerHTML = historyHTML(data.history);
  loadAttachmentThumbs(histEl);
  wireScrollSpy(histEl);

  renderRoadmapActions(r);
}

function renderRoadmapActions(r) {
  const wrap = document.querySelector('#rrm-actions');
  if (!wrap) return;
  const isAssignee = Number(r.assigned_to_id) === Number(_selfId);
  const isContractor = Number(r.contractor_org_id) === Number(_myOrgId);
  const isAuthorOrOwner = Number(r.author_id) === Number(_selfId) || (_isOwner && Number(r.client_org_id) === Number(_myOrgId));
  const btns = [];
  const b = (action, key, cls = 'btn-primary', icon = 'ph-arrow-right') =>
    `<button class="btn ${cls}" data-rq-act="${action}" data-rq-id="${r.id}"><i class="ph ${icon}"></i> <span>${escapeHTML(t(key))}</span></button>`;
  if (r.status === 'new' && isContractor)             btns.push(b('take', 'requests.act_take', 'btn-primary', 'ph-hand-grabbing'));
  if (r.status === 'assigned' && isAssignee)          btns.push(b('start', 'requests.act_start', 'btn-primary', 'ph-play'));
  if (r.status === 'in_progress' && isAssignee)       btns.push(b('finish', 'requests.act_finish', 'btn-primary', 'ph-check'));
  if (r.status === 'done' && isAuthorOrOwner)         btns.push(b('close', 'requests.act_close', 'btn-primary', 'ph-star'));
  if (r.status === 'new' && Number(r.author_id) === Number(_selfId)) btns.push(b('edit', 'requests.act_edit', 'btn-secondary', 'ph-pencil-simple'));
  if (!['closed', 'cancelled'].includes(r.status) && isAuthorOrOwner) btns.push(b('cancel', 'requests.act_cancel', 'btn-danger', 'ph-x-circle'));
  btns.push(`<button class="btn btn-secondary" data-close-modal="request-roadmap-modal" data-i18n="common.close">${escapeHTML(t('common.close'))}</button>`);
  wrap.innerHTML = btns.join('');
}

// Приватные миниатюры вложений.
function loadAttachmentThumbs(scope) {
  scope.querySelectorAll('img[data-rq-att-id]').forEach(async (img) => {
    const id = Number(img.getAttribute('data-rq-att-id'));
    if (!id) return;
    try { const url = await media.loadPrivateImage(id); _imgCache.set(id, url); img.src = url; } catch {}
  });
}

// Scroll-spy: подсвечиваем шаг rail по статусу видимой записи истории.
function wireScrollSpy(histEl) {
  if (!histEl) return;
  const spy = () => {
    const events = [...histEl.querySelectorAll('.rrm-event')];
    if (!events.length) return;
    const top = histEl.scrollTop;
    let current = events[0];
    for (const ev of events) {
      if (ev.offsetTop - histEl.offsetTop <= top + 24) current = ev;
    }
    const status = current?.dataset.eventStatus;
    document.querySelectorAll('#rrm-rail .rrm-rail-step').forEach(s => {
      s.classList.toggle('is-inview', s.dataset.railStatus === status);
    });
  };
  histEl.addEventListener('scroll', spy);
  spy();
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
  document.querySelector('#rq-contract')?.addEventListener('change', () => { renderSlaGrid(); refreshSubmitGuard(); });
  document.querySelector('#rq-equipment')?.addEventListener('change', () => { syncEquipmentMeta(); clearFieldErrorById('err-rq-equipment'); refreshSubmitGuard(); });
  document.querySelector('#rq-desc')?.addEventListener('input', refreshSubmitGuard);
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
  document.addEventListener('click', (e) => {
    const create = e.target.closest?.('[data-rq-create]');
    if (create) { openCreateModal(); return; }
    const open = e.target.closest?.('[data-rq-open]');
    if (open) { openRoadmap(Number(open.dataset.rqOpen)); return; }
    const act = e.target.closest?.('#rrm-actions [data-rq-act]');
    if (act) { doAction(act.dataset.rqAct, Number(act.dataset.rqId)); return; }
    const attView = e.target.closest?.('[data-rq-att-view]');
    if (attView) { openMediaViewer(Number(attView.dataset.rqAttView), { name: `attachment-${attView.dataset.rqAttView}` }); return; }
    const attOpen = e.target.closest?.('[data-rq-att-open]');
    if (attOpen) { openMediaViewer(Number(attOpen.dataset.rqAttOpen), { name: `attachment-${attOpen.dataset.rqAttOpen}` }); return; }
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
