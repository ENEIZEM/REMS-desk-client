/* ═══════════════════════════════════════════════════════════════
   Equipment orchestrator — общий для owner и employee.
   Владеет реестром техники: загрузка, 2-шаговая модалка добавления/
   редактирования, удаление (с подтверждением), live-синхронизация
   через socket ('equipment:changed') и перевод при смене языка.

   Монтируется из team.js обеих ролей: mountEquipment(profile).
   Список рендерится в #team-equipment-body, кнопка «Добавить» — это
   #btn-equipment-add в page-header (её добавляет team.js).
   ═══════════════════════════════════════════════════════════════ */
import { equipment as equipmentApi, media } from '../../../../api.js';
import { toast, errorMessage } from '../../../../auth.js';
import { t, applyTranslations, onLangChange } from '../../../../i18n.js';
import {
  openModal, closeModal, setLoading,
  setFieldError, clearFieldErrorById, showAlertText, hideAlertById,
} from '../../ui-helpers.js';
import { on as socketOn } from '../../../../socket.js';
import { refreshCharCounters } from '../../../../lib/char-counter.js';
import { equipmentListHTML, matchesEquipment, escapeHTML } from './equipment-ui.js';
import { openMediaViewer } from '../../../../lib/media-viewer.js';
import { wireDocPreview } from '../../../../lib/doc-preview.js';

let _equipment = [];
let _search = '';
let _categories = [];
let _catMap = new Map();          // id → { icon, name_key, desc_key }
let _profile = null;
let _selfId = null;
let _isOwner = false;
let _editId = null;
let _deleteId = null;
let _step = 1;
let _eqReloadTimer = null;        // debounce для socket-перезагрузки техники
// Фото: file/mediaId — новый загруженный; previewUrl — object-URL для превью.
const _photo = { file: null, mediaId: null, previewUrl: null };
let _photoDoc = null;   // doc-preview контроллер фото техники
const _imgCache = new Map();      // mediaFileId → object-URL (для фото карточек)

// ── Mount ──────────────────────────────────────────────────────────
export async function mountEquipment(profile) {
  _profile = profile;
  _selfId  = profile?.user?.id ?? null;
  _isOwner = (profile?.user?.org_role || profile?.user?.role) === 'owner';

  const body = document.querySelector('#team-equipment-body');
  if (!body) return;

  // Кнопка «Добавить технику» в page-header — пересоздаётся при каждом
  // ре-маунте team.js, поэтому вешаем обработчик каждый раз заново.
  document.querySelector('#btn-equipment-add')?.addEventListener('click', openAddModal);

  // Поиск по реестру — input пересоздаётся вместе с карточкой, вешаем заново.
  const searchEl = document.querySelector('#equipment-search');
  if (searchEl) {
    searchEl.value = _search;
    searchEl.addEventListener('input', () => { _search = searchEl.value; renderList(); });
  }

  wireModalOnce();
  wireSocketOnce();
  wireLangOnce();

  await ensureCategories();
  await loadEquipment();
}

async function ensureCategories() {
  if (_categories.length) { populateCategorySelect(); return; }
  try {
    const resp = await equipmentApi.categories();
    _categories = resp.data?.categories || [];
    _catMap = new Map(_categories.map(c => [Number(c.id), c]));
    populateCategorySelect();
  } catch (_) { /* список всё равно отрендерится; категории подтянем позже */ }
}

async function loadEquipment() {
  const body = document.querySelector('#team-equipment-body');
  if (!body) return;
  try {
    const resp = await equipmentApi.list();
    _equipment = resp.data?.equipment || [];
    renderList();
  } catch (err) {
    body.innerHTML = `<div class="empty-state empty-state--inline">
      <i class="ph ph-warning-circle"></i>
      <span class="empty-state-text">${escapeHTML(errorMessage(err))}</span>
    </div>`;
  }
}

function renderList() {
  const body = document.querySelector('#team-equipment-body');
  if (!body) return;
  const term = _search.trim();
  const filtered = term ? _equipment.filter(e => matchesEquipment(e, term)) : _equipment;
  const count = document.querySelector('#team-equipment-count');
  // Счётчик: при активном поиске — «найдено / всего», иначе всего.
  if (count) count.textContent = term ? `${filtered.length}/${_equipment.length}` : String(_equipment.length);
  // ВАЖНО: НЕ сбрасываем кэш object-URL'ов — иначе при поиске/смене языка
  // миниатюры перезагружаются и мигают. Кэш живёт по mediaId весь сеанс,
  // url подставляется синхронно (см. loadCardPhotos).
  body.innerHTML = equipmentListHTML(filtered, { selfId: _selfId, isOwner: _isOwner, search: term });
  loadCardPhotos(body);
}

// Приватные фото (auth-gated). Уже загруженные берём из кэша синхронно
// (без повторного fetch → без мигания), новые — догружаем один раз.
function loadCardPhotos(scope) {
  scope.querySelectorAll('img[data-eq-photo-id]').forEach(async (img) => {
    const id = Number(img.getAttribute('data-eq-photo-id'));
    if (!id) return;
    if (_imgCache.has(id)) { img.src = _imgCache.get(id); return; }
    try {
      const url = await media.loadPrivateImage(id);
      _imgCache.set(id, url);
      img.src = url;
    } catch { /* оставляем пустым — не критично */ }
  });
}

// ── Category select ────────────────────────────────────────────────
function populateCategorySelect() {
  const sel = document.querySelector('#eq-category');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = _categories.map(c =>
    `<option value="${c.id}">${escapeHTML(t(c.name_key))}</option>`
  ).join('');
  if (prev && _catMap.has(Number(prev))) sel.value = prev;
  syncCategoryMeta();
}

function syncCategoryMeta() {
  const sel = document.querySelector('#eq-category');
  const iconEl = document.querySelector('#eq-category-icon');
  const descEl = document.querySelector('#eq-category-desc');
  if (!sel) return;
  const cat = _catMap.get(Number(sel.value));
  if (iconEl) iconEl.className = `ph-duotone ${cat?.icon || 'ph-dots-three-outline'}`;
  if (descEl) descEl.textContent = cat?.desc_key ? t(cat.desc_key) : '';
}

// ── Modal: open add / edit ──────────────────────────────────────────
function resetModal() {
  ['eq-brand', 'eq-model', 'eq-notes', 'eq-inventory', 'eq-serial', 'eq-location', 'eq-purchase', 'eq-warranty']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  clearPhoto();
  ['err-eq-brand', 'err-eq-model', 'err-eq-inventory', 'err-eq-warranty', 'err-eq-photo'].forEach(clearFieldErrorById);
  hideAlertById('err-eq');
  const sel = document.querySelector('#eq-category');
  if (sel && _categories.length) sel.value = String(_categories[0].id);
  syncCategoryMeta();
}

async function openAddModal() {
  _editId = null;
  await ensureCategories();
  resetModal();
  setModalTitle('equipment.add_title');
  showStep(1);
  openModal('equipment-modal');
  refreshCharCounters(document.querySelector('#equipment-modal'));
}

async function openEditModal(id) {
  const eq = _equipment.find(e => Number(e.id) === Number(id));
  if (!eq) return;
  _editId = id;
  await ensureCategories();
  resetModal();
  setModalTitle('equipment.edit_title');
  const set = (eid, v) => { const el = document.getElementById(eid); if (el) el.value = v ?? ''; };
  const sel = document.querySelector('#eq-category');
  if (sel) sel.value = String(eq.category_id);
  syncCategoryMeta();
  set('eq-brand', eq.brand);
  set('eq-model', eq.model);
  set('eq-notes', eq.notes);
  set('eq-inventory', eq.inventory_number);
  set('eq-serial', eq.serial_number);
  set('eq-location', eq.location);
  set('eq-purchase', eq.purchase_date ? String(eq.purchase_date).slice(0, 10) : '');
  set('eq-warranty', eq.warranty_until ? String(eq.warranty_until).slice(0, 10) : '');
  // Существующее фото — показываем превью (новый файл не выбран).
  if (eq.photo?.id) {
    try {
      const url = await media.loadPrivateImage(eq.photo.id);
      showPhotoPreview(url, /* keepObjectUrl */ false);
    } catch {}
  }
  showStep(1);
  openModal('equipment-modal');
  refreshCharCounters(document.querySelector('#equipment-modal'));
}

function setModalTitle(key) {
  const el = document.querySelector('#eq-modal-title');
  if (el) { el.setAttribute('data-i18n', key); el.textContent = t(key); }
}

// ── Stepper ─────────────────────────────────────────────────────────
const EQ_TOTAL_STEPS = 3;

function showStep(n) {
  _step = n;
  for (let i = 1; i <= EQ_TOTAL_STEPS; i++) {
    const el = document.querySelector(`#eq-step-${i}`);
    if (el) el.style.display = i === n ? '' : 'none';
  }
  const stepper = document.querySelector('#eq-stepper');
  stepper?.querySelectorAll('.step-circle').forEach(el => {
    const k = Number(el.dataset.step);
    el.classList.toggle('done', k < n);
    el.classList.toggle('active', k === n);
  });
  stepper?.querySelectorAll('.step-line').forEach(el => {
    el.classList.toggle('done', Number(el.dataset.line) < n);
  });
  const cur = document.querySelector('#eq-step-cur'); if (cur) cur.textContent = String(n);
  const back = document.querySelector('#btn-eq-back'); if (back) back.style.display = n > 1 ? '' : 'none';
  const lbl = document.querySelector('#eq-next-label');
  if (lbl) {
    const key = n === EQ_TOTAL_STEPS ? (_editId ? 'common.save' : 'equipment.btn_add') : 'common.continue';
    lbl.setAttribute('data-i18n', key);
    lbl.textContent = t(key);
  }
  hideAlertById('err-eq');
  refreshGuard();
}

function stepValid(n) {
  const v = (id) => (document.getElementById(id)?.value || '').trim();
  if (n === 1) return !!document.querySelector('#eq-category')?.value && !!v('eq-brand') && !!v('eq-model');
  if (n === 2) return v('eq-inventory').length > 0;
  return true;   // шаг 3 — все поля необязательны
}
function refreshGuard() {
  const btn = document.querySelector('#btn-eq-next');
  if (btn) btn.classList.toggle('is-pending', !stepValid(_step));
}
// Клик по серой кнопке → подсветить незаполненные обязательные поля шага.
function highlightEqMissing(n) {
  const v = (id) => (document.getElementById(id)?.value || '').trim();
  if (n === 1) {
    if (!v('eq-brand')) setFieldError('err-eq-brand', t('errors.required'));
    if (!v('eq-model')) setFieldError('err-eq-model', t('errors.required'));
  } else if (n === 2) {
    if (!v('eq-inventory')) setFieldError('err-eq-inventory', t('errors.required'));
  }
}

// ── Photo ───────────────────────────────────────────────────────────
function clearPhoto() {
  if (_photo.previewUrl) { try { URL.revokeObjectURL(_photo.previewUrl); } catch {} }
  _photo.file = null; _photo.mediaId = null; _photo.previewUrl = null;
  document.querySelector('#eq-photo-empty')?.classList.remove('hidden');
  document.querySelector('#eq-photo-filled')?.classList.add('hidden');
  const img = document.querySelector('#eq-photo-img'); if (img) img.src = '';
  const input = document.querySelector('#eq-photo-input'); if (input) input.value = '';
}

function showPhotoPreview(url, keepObjectUrl) {
  if (keepObjectUrl) _photo.previewUrl = url;
  const img = document.querySelector('#eq-photo-img'); if (img) img.src = url;
  document.querySelector('#eq-photo-empty')?.classList.add('hidden');
  document.querySelector('#eq-photo-filled')?.classList.remove('hidden');
}

// ── Submit ──────────────────────────────────────────────────────────
function buildPayload() {
  const val = (id) => (document.getElementById(id)?.value || '').trim();
  const payload = {
    category_id:      Number(document.querySelector('#eq-category')?.value),
    inventory_number: val('eq-inventory'),
    brand:            val('eq-brand')    || undefined,
    model:            val('eq-model')    || undefined,
    notes:            val('eq-notes')    || undefined,
    serial_number:    val('eq-serial')   || undefined,
    location:         val('eq-location') || undefined,
    purchase_date:    val('eq-purchase') || undefined,
    warranty_until:   val('eq-warranty') || undefined,
  };
  // photo_media_id отправляем ТОЛЬКО если выбран новый файл (иначе на
  // edit бэкенд сохранит прежнее фото).
  if (_photo.mediaId) payload.photo_media_id = _photo.mediaId;
  return payload;
}

function validateBeforeSubmit() {
  ['err-eq-brand', 'err-eq-model', 'err-eq-inventory', 'err-eq-warranty'].forEach(clearFieldErrorById);
  const v = (id) => (document.getElementById(id)?.value || '').trim();
  let firstBadStep = null;
  if (!v('eq-brand'))     { setFieldError('err-eq-brand', t('errors.required')); firstBadStep ??= 1; }
  if (!v('eq-model'))     { setFieldError('err-eq-model', t('errors.required')); if (firstBadStep == null) firstBadStep = 1; }
  if (!v('eq-inventory')) { setFieldError('err-eq-inventory', t('errors.required')); if (firstBadStep == null) firstBadStep = 2; }
  const p = v('eq-purchase'), w = v('eq-warranty');
  if (p && w && Date.parse(w) < Date.parse(p)) {
    setFieldError('err-eq-warranty', t('equipment.warranty_before_purchase')); if (firstBadStep == null) firstBadStep = 3;
  }
  if (firstBadStep != null) { showStep(firstBadStep); return false; }
  return true;
}

async function submit() {
  if (!validateBeforeSubmit()) return;
  const btn = document.querySelector('#btn-eq-next');
  setLoading(btn, true);
  try {
    if (_editId) await equipmentApi.update(_editId, buildPayload());
    else         await equipmentApi.create(buildPayload());
    closeModal('equipment-modal');
    toast(t(_editId ? 'equipment.updated_toast' : 'equipment.created_toast'), 'ok');
    await loadEquipment();   // свою карточку обновим сразу; остальным придёт socket
  } catch (err) {
    showAlertText('err-eq', 'err-eq-text', errorMessage(err));
  } finally {
    setLoading(btn, false);
  }
}

// ── Delete ──────────────────────────────────────────────────────────
function openDeleteModal(id) {
  const eq = _equipment.find(e => Number(e.id) === Number(id));
  if (!eq) return;
  _deleteId = id;
  const nameEl = document.querySelector('#eq-del-name');
  if (nameEl) nameEl.textContent = eq.brand || eq.model || eq.inventory_number || '';
  openModal('equipment-delete-modal');
}

async function confirmDelete() {
  if (!_deleteId) return;
  const btn = document.querySelector('#btn-eq-delete-confirm');
  setLoading(btn, true);
  try {
    await equipmentApi.remove(_deleteId);
    closeModal('equipment-delete-modal');
    toast(t('equipment.deleted_toast'), 'ok');
    await loadEquipment();
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    setLoading(btn, false);
    _deleteId = null;
  }
}

// ── Wiring (once) ───────────────────────────────────────────────────
function wireModalOnce() {
  if (window.__remsEquipmentModalWired) return;
  window.__remsEquipmentModalWired = true;

  document.querySelector('#eq-category')?.addEventListener('change', syncCategoryMeta);

  // Фото техники — через общий doc-preview (ограничения → превью → имя;
  // Сохранить / Выбрать другое / Отмена), как и все вложения в проекте.
  _photoDoc = wireDocPreview({
    entityType: 'equipment',
    allowedMime: ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'],
    titleKey: 'equipment.photo_label', hintKey: 'equipment.photo_hint',
    onSave: ({ mediaFileId, file }) => {
      if (_photo.previewUrl) { try { URL.revokeObjectURL(_photo.previewUrl); } catch {} }
      _photo.mediaId = mediaFileId;
      _photo.file = file;
      _photo.previewUrl = URL.createObjectURL(file);
      showPhotoPreview(_photo.previewUrl, false);
      clearFieldErrorById('err-eq-photo');
    },
  });
  const tile = document.querySelector('#eq-photo-tile');
  tile?.addEventListener('click', (e) => {
    if (e.target.closest('#eq-photo-clear')) return;
    if (_photo.file) _photoDoc.reopenPreview(_photo.file); else _photoDoc.openPicker();
  });
  document.querySelector('#eq-photo-clear')?.addEventListener('click', (e) => { e.stopPropagation(); clearPhoto(); });

  // Guard refresh on input.
  ['eq-step-1', 'eq-step-2'].forEach(sid => {
    const root = document.getElementById(sid);
    root?.addEventListener('input', refreshGuard);
    root?.addEventListener('change', refreshGuard);
  });

  // Stepper nav.
  document.querySelector('#btn-eq-next')?.addEventListener('click', () => {
    if (!stepValid(_step)) { highlightEqMissing(_step); return; }   // серая кнопка → что не так
    if (_step < EQ_TOTAL_STEPS) showStep(_step + 1);
    else submit();
  });

  // Просмотр фото техники — общий просмотрщик (с кнопкой «Скачать»).
  document.addEventListener('click', (e) => {
    const el = e.target.closest?.('#team-equipment-body [data-eq-photo-view]');
    if (!el) return;
    const id = Number(el.dataset.eqPhotoView);
    if (id) openMediaViewer(id, { name: `equipment-${id}` });
  });
  document.querySelector('#btn-eq-back')?.addEventListener('click', () => { if (_step > 1) showStep(_step - 1); });

  // List actions (delegated на document — #team-equipment-body
  // пересоздаётся при каждом ре-маунте team.js, поэтому слушаем выше).
  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('#team-equipment-body [data-eq-action]');
    if (!btn) return;
    const id = Number(btn.dataset.eqId);
    if (btn.dataset.eqAction === 'edit')   openEditModal(id);
    if (btn.dataset.eqAction === 'delete') openDeleteModal(id);
    if (btn.dataset.eqAction === 'new-request') {
      // Открываем модалку новой заявки с предвыбранным оборудованием
      // (слушает requests.js).
      window.dispatchEvent(new CustomEvent('rems:new-request', { detail: { equipmentId: id } }));
    }
    if (btn.dataset.eqAction === 'go-request') {
      // Переход к активной заявке по этой технике — ведём в ленту заявок и
      // подсвечиваем карточку, как при клике по уведомлению. Лента у owner на
      // «Обзоре», у остальных — на «Заявках». Меняем только hash (in-system
      // навигация, без reload/PIN-gate); если hash совпал — дёргаем hashchange.
      const reqId = Number(btn.dataset.eqRequestId);
      if (reqId) {
        const base = document.body.dataset.role === 'owner' ? 'overview' : 'requests';
        const newHash = `#${base}/${reqId}`;
        const prev = location.hash;
        location.hash = newHash;
        if (prev === newHash) window.dispatchEvent(new HashChangeEvent('hashchange'));
      }
    }
  });

  document.querySelector('#btn-eq-delete-confirm')?.addEventListener('click', confirmDelete);
}

function wireSocketOnce() {
  if (window.__remsEquipmentSocketWired) return;
  window.__remsEquipmentSocketWired = true;
  socketOn('equipment:changed', () => {
    // Любое изменение в орг — перезагружаем список, если он на экране.
    // Дебаунс 250мс: статус техники синхронизируется при создании/закрытии
    // заявок (события идут пачками) — без дебаунса был бы полный перезапрос
    // реестра на каждое.
    if (!document.querySelector('#team-equipment-body')) return;
    clearTimeout(_eqReloadTimer);
    _eqReloadTimer = setTimeout(() => { loadEquipment().catch?.(() => {}); }, 250);
  });
}

function wireLangOnce() {
  if (window.__remsEquipmentLangWired) return;
  window.__remsEquipmentLangWired = true;
  onLangChange(() => {
    populateCategorySelect();      // ярлыки опций + мета категории
    if (document.querySelector('#team-equipment-body')) renderList();
  });
}
