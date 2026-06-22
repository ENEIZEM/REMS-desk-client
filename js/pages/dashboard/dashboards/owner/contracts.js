/* ═══════════════════════════════════════════════════════════════
   Owner Contracts (вкладка «Партнёры», #tab-contracts).
   3 шага (как регистрация): партнёр+роль+название → описание+док+
   дата → SLA. Кнопка «Далее» серая (.is-pending) пока обязательные
   поля шага не введены; на «Далее» шага 1 жёстко проверяем партнёра
   через бэк (existence / inactive / self / dup).
   Документ — через модульный DocPreview (js/lib/doc-preview.js).
   ═══════════════════════════════════════════════════════════════ */
import { contracts as contractsApi, media } from '../../../../api.js';
import { toast, errorMessage } from '../../../../auth.js';
import { t, applyTranslations, onLangChange } from '../../../../i18n.js';
import {
  openModal, closeModal, setLoading,
  setFieldError, clearFieldErrorById, showAlertText, hideAlertById,
} from '../../ui-helpers.js';
import { contractsBlocksHTML, escapeHTML } from '../_shared/contracts-ui.js';
import { wireDocPreview } from '../../../../lib/doc-preview.js';
import { openMediaViewer } from '../../../../lib/media-viewer.js';

let _current = [];
let _terminated = [];
let _editId = null;
const _doc = { create: { mediaId: null, file: null }, edit: { mediaId: null, file: null } };

// ── Mount ──────────────────────────────────────────────────────────
export function mountOwnerContracts(profile) {
  const slot = document.querySelector('#contracts-slot');
  if (!slot) return;
  const tabPanel = document.querySelector('#tab-contracts');
  if (tabPanel) tabPanel.classList.add('tab-fill');

  slot.innerHTML = `
    <div class="page-header page-header--with-action">
      <div>
        <h1 class="page-title" data-i18n="nav.partners">Партнёры</h1>
        <p class="page-desc" data-i18n="contracts.owner_desc">Контракты с другими организациями.</p>
      </div>
      <button class="btn btn-primary" id="btn-contract-new">
        <i class="ph ph-plus"></i> <span data-i18n="contracts.btn_new">Заключить контракт</span>
      </button>
    </div>
    <div id="owner-contracts-list"></div>
  `;
  applyTranslations();

  wireOnce();
  if (!window.__remsOwnerContractsReloadWired) {
    window.__remsOwnerContractsReloadWired = true;
    window.addEventListener('rems:reload-contracts', () => {
      if (document.querySelector('#owner-contracts-list')) loadContracts();
    });
  }
  document.querySelector('#btn-contract-new')?.addEventListener('click', openCreateModal);
  slot.querySelector('#owner-contracts-list')?.addEventListener('click', onCardAction);

  loadContracts();
}

async function loadContracts() {
  const list = document.querySelector('#owner-contracts-list');
  if (!list) return;
  try {
    const resp = await contractsApi.list();
    const data = resp.data || { current: [], terminated: [] };
    _current = data.current || [];
    _terminated = data.terminated || [];
    list.innerHTML = contractsBlocksHTML(data, true);
    applyTranslations();   // инжектит data-tooltip-text в подсказки блоков
  } catch (err) {
    toast(errorMessage(err), 'error');
  }
}

async function onCardAction(e) {
  const btn = e.target.closest('[data-ct-action]');
  if (!btn) return;
  const action = btn.dataset.ctAction;
  const id = Number(btn.dataset.ctId);
  if (!id) return;
  if (action === 'view')          return openContractView(id);
  if (action === 'edit')          return openEditModal(id);
  if (action === 'edit-instead')  return editInstead(id);
  if (action === 'terminate')     return openTerminateModal(id);
  if (action === 'terminate-confirm' || action === 'terminate-decline') {
    return openTerminateRespondModal(id);
  }
  if (action === 'reject') {
    return openReasonModal({
      titleKey: 'contracts.reject_title',
      bodyKey:  'contracts.reject_body',
      onConfirm: (reason) => contractsApi.respond(id, 'reject', reason || undefined),
    });
  }
  if (action === 'cancel') {
    return openReasonModal({
      titleKey: 'contracts.cancel_title',
      bodyKey:  'contracts.cancel_body',
      onConfirm: (reason) => contractsApi.cancel(id, reason || undefined),
    });
  }

  setLoading(btn, true);
  try {
    if      (action === 'accept')            await contractsApi.respond(id, 'accept');
    else if (action === 'terminate-cancel')  await contractsApi.terminateCancel(id);
    toast(t('contracts.action_done') || 'Готово', 'ok');
    await loadContracts();
  } catch (err) {
    toast(errorMessage(err), 'error');
    setLoading(btn, false);
  }
}

// Cancel termination request → open edit (full flow).
async function editInstead(id) {
  try {
    await contractsApi.terminateCancel(id);
    await loadContracts();
    openEditModal(id);
  } catch (err) {
    toast(errorMessage(err), 'error');
  }
}

// «Открыть контракт» — модалка показывает ТОЛЬКО текст контракта
// (с сохранением форматирования) и кнопку документа. Партнёр/роль/даты/
// SLA уже видны в карточке, в модалке их не дублируем.
function openContractView(id) {
  const c = _current.find(x => x.id === id) || _terminated.find(x => x.id === id);
  if (!c) return;
  const nameEl = document.getElementById('cv-name');
  if (nameEl) nameEl.textContent = c.name;
  const descEl   = document.getElementById('cv-desc');
  const noDescEl = document.getElementById('cv-no-desc');
  if (c.description && c.description.trim()) {
    if (descEl)   { descEl.textContent = c.description; descEl.style.display = ''; }
    if (noDescEl) noDescEl.style.display = 'none';
  } else {
    if (descEl)   descEl.style.display = 'none';
    if (noDescEl) noDescEl.style.display = '';
  }
  const docBtn = document.getElementById('btn-cv-open-doc');
  if (docBtn) {
    if (c.doc?.id) {
      docBtn.style.display = '';
      docBtn.onclick = () => openMediaViewer(c.doc.id, { name: `contract-doc-${c.doc.id}` });
    } else docBtn.style.display = 'none';
  }
  openModal('contract-view-modal');
}

// Универсальная reason-модалка для cancel/reject.
let _reasonPending = null;
function openReasonModal({ titleKey, bodyKey, onConfirm }) {
  _reasonPending = { onConfirm };
  const titleEl = document.getElementById('crm-title');
  const bodyEl  = document.getElementById('crm-body');
  if (titleEl) titleEl.textContent = t(titleKey);
  if (bodyEl)  bodyEl.textContent  = t(bodyKey);
  const ta = document.getElementById('crm-reason');
  if (ta) ta.value = '';
  openModal('contract-reason-modal');
}

function openTerminateRespondModal(id) {
  const c = _current.find(x => x.id === id);
  if (!c) return;
  _editId = id;
  const nameEl = document.getElementById('ctr-name');
  if (nameEl) nameEl.textContent = c.name;
  const wrap = document.getElementById('ctr-reason-wrap');
  const reasonEl = document.getElementById('ctr-reason');
  if (c.termination_reason && reasonEl && wrap) {
    reasonEl.textContent = c.termination_reason;
    wrap.style.display = '';
  } else if (wrap) {
    wrap.style.display = 'none';
  }
  openModal('contract-terminate-respond-modal');
}

async function terminateRespondAndClose(action) {
  if (!_editId) return;
  const btn = document.getElementById(action === 'confirm' ? 'btn-ctr-confirm' : 'btn-ctr-decline');
  setLoading(btn, true);
  try {
    await contractsApi.terminateRespond(_editId, action);
    closeModal('contract-terminate-respond-modal');
    toast(t('contracts.action_done') || 'Готово', 'ok');
    await loadContracts();
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    setLoading(btn, false);
  }
}

// ── Шаги: общая логика ───────────────────────────────────────────
const FLOWS = {
  create: {
    prefix: 'ct', total: 3,
    steps: ['ct-step-1', 'ct-step-2', 'ct-step-3'],
    requiredOk: stepCheck.bind(null, 'create'),
    onAdvance: async (fromStep) => {
      if (fromStep === 1) return await checkPartnerOnAdvance('ct');
      if (fromStep === 2) return validateStep2('ct');
      return true;
    },
    onFinal: submitCreate,
  },
  edit: {
    prefix: 'cte', total: 3,
    steps: ['cte-step-1', 'cte-step-2', 'cte-step-3'],
    requiredOk: stepCheck.bind(null, 'edit'),
    onAdvance: async (fromStep) => {
      if (fromStep === 2) return validateStep2('cte');
      return true;
    },
    onFinal: submitEdit,
  },
};
const _flowState = { create: { step: 1 }, edit: { step: 1 } };

/** Жёсткая проверка обязательных полей шага → true/false.
 *  Side-effect для шага 3: показывает inline-ошибку под SLA-блоком
 *  при значениях вне 1..720, чтобы юзер видел причину серой кнопки. */
function stepCheck(which, step) {
  const p = which === 'create' ? 'ct' : 'cte';
  if (step === 1) {
    if (which === 'create') {
      const id = Number(document.getElementById('ct-partner-id')?.value);
      const name = (document.getElementById('ct-name')?.value || '').trim();
      const role = document.querySelector('input[name="ct-role"]:checked');
      return Number.isInteger(id) && id > 0 && !!role && name.length > 0;
    }
    return (document.getElementById('cte-name')?.value || '').trim().length > 0;
  }
  if (step === 2) {
    const desc = (document.getElementById(`${p}-desc`)?.value || '').trim();
    const date = document.getElementById(`${p}-end-date`)?.value || '';
    return desc.length > 0 && isValidEndDate(date);
  }
  if (step === 3) {
    const fields = ['critical', 'high', 'medium', 'low',
                    'critical-res', 'high-res', 'medium-res', 'low-res'];
    let bad = false, emptyAny = false;
    for (const k of fields) {
      const raw = document.getElementById(`${p}-sla-${k}`)?.value;
      if (raw === '' || raw == null) { emptyAny = true; continue; }
      const v = Number(raw);
      if (!Number.isInteger(v) || v < 1 || v > 720) { bad = true; break; }
    }
    const errEl = document.getElementById(`err-${p}-sla`);
    const errSpan = errEl?.querySelector('span');
    if (bad) {
      if (errEl && errSpan) {
        errSpan.textContent = t('contracts.sla_out_of_range') || 'Значения SLA должны быть от 1 до 720 часов';
        errEl.classList.add('show');
      }
      return false;
    }
    if (errEl) errEl.classList.remove('show');
    return !emptyAny;
  }
  return true;
}

function isValidEndDate(d) {
  if (!d) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const year = Number(d.slice(0, 4));
  if (year < 1970 || year > 9999) return false;
  const ts = Date.parse(d);
  return Number.isFinite(ts);
}

function validateStep2(prefix) {
  clearFieldErrorById(`err-${prefix}-desc`);
  clearFieldErrorById(`err-${prefix}-end-date`);
  const desc = (document.getElementById(`${prefix}-desc`)?.value || '').trim();
  const date = document.getElementById(`${prefix}-end-date`)?.value || '';
  let ok = true;
  if (!desc) { setFieldError(`err-${prefix}-desc`, t('errors.required') || 'Обязательное поле'); ok = false; }
  if (!isValidEndDate(date)) { setFieldError(`err-${prefix}-end-date`, t('contracts.invalid_end_date_msg') || 'Год должен быть 4 цифры (1970–9999)'); ok = false; }
  return ok;
}

async function checkPartnerOnAdvance(prefix) {
  const id = Number(document.getElementById(`${prefix}-partner-id`)?.value);
  clearFieldErrorById(`err-${prefix}-partner`);
  try { await contractsApi.checkPartner(id); return true; }
  catch (err) { setFieldError(`err-${prefix}-partner`, errorMessage(err)); return false; }
}

function showStep(which, step) {
  const flow = FLOWS[which];
  _flowState[which].step = step;
  flow.steps.forEach((sid, i) => {
    const el = document.getElementById(sid);
    if (el) el.style.display = (i + 1) === step ? '' : 'none';
  });
  // Step circles (как в register.html): прошлые .done, текущий .active.
  const root = document.getElementById(`${flow.prefix}-stepper`);
  root?.querySelectorAll('.step-circle').forEach(el => {
    const n = Number(el.dataset.step);
    el.classList.toggle('done',   n < step);
    el.classList.toggle('active', n === step);
  });
  root?.querySelectorAll('.step-line').forEach(el => {
    const n = Number(el.dataset.line);
    el.classList.toggle('done', n < step);
  });
  const cur = document.getElementById(`${flow.prefix}-step-cur`);
  if (cur) cur.textContent = String(step);
  // Back / Next labels
  const back = document.getElementById(`btn-${flow.prefix}-back`);
  if (back) back.style.display = step > 1 ? '' : 'none';
  const lbl = document.getElementById(`${flow.prefix}-next-label`);
  if (lbl) {
    lbl.textContent = (step === flow.total)
      ? (which === 'create' ? (t('contracts.create_send') || 'Отправить предложение') : (t('common.save') || 'Сохранить'))
      : (t('common.continue') || 'Далее');
  }
  hideAlertById(`err-${flow.prefix}`);
  refreshGuard(which);
}

function refreshGuard(which) {
  const step = _flowState[which].step;
  const ok = FLOWS[which].requiredOk(step);
  const btn = document.getElementById(`btn-${FLOWS[which].prefix}-next`);
  if (!btn) return;
  btn.classList.toggle('is-pending', !ok);
}

/** Подсветить незаполненные обязательные поля шага (клик по серой кнопке). */
function highlightMissing(which, step) {
  const p = which === 'create' ? 'ct' : 'cte';
  const req = t('errors.required') || 'Обязательное поле';
  if (step === 1) {
    if (which === 'create') {
      const id = Number(document.getElementById('ct-partner-id')?.value);
      if (!(Number.isInteger(id) && id > 0)) setFieldError('err-ct-partner', req);
      if (!(document.getElementById('ct-name')?.value || '').trim()) setFieldError('err-ct-name', req);
      if (!document.querySelector('input[name="ct-role"]:checked')) showAlertText('err-ct', 'err-ct-text', req);
    } else {
      if (!(document.getElementById('cte-name')?.value || '').trim()) setFieldError('err-cte-name', req);
    }
  } else if (step === 2) {
    validateStep2(p);
  } else if (step === 3) {
    const errEl = document.getElementById(`err-${p}-sla`);
    const errSpan = errEl?.querySelector('span');
    if (errEl && errSpan) { errSpan.textContent = t('contracts.sla_required') || t('errors.required'); errEl.classList.add('show'); }
  }
}

function wireFlow(which) {
  const flow = FLOWS[which];
  flow.steps.forEach(sid => {
    const root = document.getElementById(sid);
    if (!root) return;
    root.addEventListener('input',  () => refreshGuard(which));
    root.addEventListener('change', () => refreshGuard(which));
  });
  document.getElementById(`btn-${flow.prefix}-next`)?.addEventListener('click', async () => {
    const step = _flowState[which].step;
    if (!flow.requiredOk(step)) { highlightMissing(which, step); return; }  // серая кнопка → подсветим, чего не хватает
    const ok = await flow.onAdvance(step);
    if (!ok) return;
    if (step < flow.total) showStep(which, step + 1);
    else await flow.onFinal();
  });
  document.getElementById(`btn-${flow.prefix}-back`)?.addEventListener('click', () => {
    const step = _flowState[which].step;
    if (step > 1) showStep(which, step - 1);
  });
}

// ── Role cards (create) ───────────────────────────────────────────
function wireRoleCards() {
  document.querySelectorAll('[data-ct-role]').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('[data-ct-role]').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      const inp = card.querySelector('input[type="radio"]');
      if (inp) inp.checked = true;
      refreshGuard('create');
    });
  });
}

// ── Doc tile + shared DocPreview ───────────────────────────────────
function fmtBytes(n) {
  if (!n) return '—';
  const mb = n / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;
}
function renderDocTile(which) {
  const prefix = which === 'edit' ? 'cte' : 'ct';
  const state = _doc[which];
  const empty  = document.getElementById(`${prefix}-doc-empty`);
  const filled = document.getElementById(`${prefix}-doc-filled`);
  const nameEl = document.getElementById(`${prefix}-doc-name`);
  const sizeEl = document.getElementById(`${prefix}-doc-size`);
  const iconEl = document.getElementById(`${prefix}-doc-icon`);
  if (state.file) {
    empty?.classList.add('hidden');
    filled?.classList.remove('hidden');
    if (nameEl) nameEl.textContent = state.file.name;
    if (sizeEl) sizeEl.textContent = fmtBytes(state.file.size);
    if (iconEl) iconEl.className = state.file.type === 'application/pdf'
      ? 'ph-duotone ph-file-pdf' : 'ph-duotone ph-image';
  } else {
    empty?.classList.remove('hidden');
    filled?.classList.add('hidden');
  }
}
let _docPreviewCreate = null;
let _docPreviewEdit = null;
function wireDocTiles() {
  _docPreviewCreate = wireDocPreview({
    entityType: 'contract',
    onSave: ({ mediaFileId, file }) => {
      _doc.create.mediaId = mediaFileId;
      _doc.create.file = file;
      renderDocTile('create');
    },
  });
  _docPreviewEdit = wireDocPreview({
    entityType: 'contract',
    onSave: ({ mediaFileId, file }) => {
      _doc.edit.mediaId = mediaFileId;
      _doc.edit.file = file;
      renderDocTile('edit');
    },
  });

  const tileCreate = document.getElementById('ct-doc-tile');
  tileCreate?.addEventListener('click', (e) => {
    if (e.target.closest('#ct-doc-clear')) return;
    if (_doc.create.file) _docPreviewCreate.reopenPreview(_doc.create.file);
    else                  _docPreviewCreate.openPicker();
  });
  document.getElementById('ct-doc-clear')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _doc.create = { mediaId: null, file: null };
    renderDocTile('create');
  });

  const tileEdit = document.getElementById('cte-doc-tile');
  tileEdit?.addEventListener('click', (e) => {
    if (e.target.closest('#cte-doc-clear')) return;
    if (_doc.edit.file) _docPreviewEdit.reopenPreview(_doc.edit.file);
    else                _docPreviewEdit.openPicker();
  });
  document.getElementById('cte-doc-clear')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _doc.edit = { mediaId: null, file: null };
    renderDocTile('edit');
  });
}

// ── Once-wiring ───────────────────────────────────────────────────
function wireOnce() {
  if (window.__remsContractModalsWired) return;
  window.__remsContractModalsWired = true;
  wireFlow('create');
  wireFlow('edit');
  wireRoleCards();
  wireDocTiles();
  // Receiver decision modal (terminate-respond) — кнопки внутри модалки.
  document.getElementById('btn-ctr-confirm')?.addEventListener('click', () => terminateRespondAndClose('confirm'));
  document.getElementById('btn-ctr-decline')?.addEventListener('click', () => terminateRespondAndClose('decline'));

  // Reason modal — общая для cancel/reject. Кнопка confirm берёт текст и
  // вызывает закэшированный onConfirm.
  document.getElementById('btn-crm-confirm')?.addEventListener('click', async () => {
    if (!_reasonPending) return;
    const reason = (document.getElementById('crm-reason')?.value || '').trim();
    const btn = document.getElementById('btn-crm-confirm');
    setLoading(btn, true);
    try {
      await _reasonPending.onConfirm(reason);
      closeModal('contract-reason-modal');
      toast(t('contracts.action_done') || 'Готово', 'ok');
      await loadContracts();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setLoading(btn, false);
      _reasonPending = null;
    }
  });

  // Перерисовка списка при смене языка (#3) — onLangChange не вызывает
  // mountOwnerContracts повторно (роль не сменилась), поэтому ловим сами.
  onLangChange(() => {
    if (document.body.dataset.role !== 'owner') return;
    if (document.querySelector('#owner-contracts-list')) loadContracts();
  });

  // Terminate modal
  document.getElementById('btn-ctt-confirm')?.addEventListener('click', async () => {
    hideAlertById('err-ctt');
    if (!_editId) return;
    const reason = (document.getElementById('ctt-reason')?.value || '').trim();
    const btn = document.getElementById('btn-ctt-confirm');
    setLoading(btn, true);
    try {
      await contractsApi.terminate(_editId, reason || undefined);
      closeModal('contract-terminate-modal');
      toast(t('contracts.terminate_sent_toast') || 'Запрос на разрыв отправлен', 'ok');
      await loadContracts();
    } catch (err) {
      showAlertText('err-ctt', 'err-ctt-text', errorMessage(err));
    } finally {
      setLoading(btn, false);
    }
  });
}

// ── Create flow ────────────────────────────────────────────────────
function resetCreateModal() {
  ['ct-partner-id', 'ct-name', 'ct-desc', 'ct-end-date',
   'ct-sla-critical', 'ct-sla-high', 'ct-sla-medium', 'ct-sla-low',
   'ct-sla-critical-res', 'ct-sla-high-res', 'ct-sla-medium-res', 'ct-sla-low-res',
  ].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.querySelectorAll('[data-ct-role]').forEach(c => c.classList.toggle('selected', c.dataset.ctRole === 'client'));
  const cr = document.querySelector('input[name="ct-role"][value="client"]');
  if (cr) cr.checked = true;
  _doc.create = { mediaId: null, file: null };
  renderDocTile('create');
  clearFieldErrorById('err-ct-partner');
  clearFieldErrorById('err-ct-name');
  clearFieldErrorById('err-ct-desc');
  clearFieldErrorById('err-ct-end-date');
  hideAlertById('err-ct');
}
function openCreateModal() {
  resetCreateModal();
  showStep('create', 1);
  openModal('contract-create-modal');
  setTimeout(() => document.getElementById('ct-partner-id')?.focus(), 80);
}
function readSla(prefix) {
  const v = (k) => {
    const raw = document.getElementById(`${prefix}-sla-${k}`)?.value;
    return raw === '' || raw == null ? undefined : Number(raw);
  };
  return {
    sla_critical_response_h:   v('critical'),
    sla_high_response_h:       v('high'),
    sla_medium_response_h:     v('medium'),
    sla_low_response_h:        v('low'),
    sla_critical_resolution_h: v('critical-res'),
    sla_high_resolution_h:     v('high-res'),
    sla_medium_resolution_h:   v('medium-res'),
    sla_low_resolution_h:      v('low-res'),
  };
}
async function submitCreate() {
  const partnerId = Number(document.getElementById('ct-partner-id')?.value);
  const name = (document.getElementById('ct-name')?.value || '').trim();
  const myRole = document.querySelector('input[name="ct-role"]:checked')?.value || 'client';
  const desc = (document.getElementById('ct-desc')?.value || '').trim();
  const endDate = document.getElementById('ct-end-date')?.value || '';
  const payload = {
    partner_org_id: partnerId, my_role: myRole, contract_name: name,
    contract_description: desc, end_date: endDate,
    ...(_doc.create.mediaId ? { contract_doc_media_id: _doc.create.mediaId } : {}),
    ...readSla('ct'),
  };
  const btn = document.getElementById('btn-ct-next');
  setLoading(btn, true);
  try {
    await contractsApi.create(payload);
    closeModal('contract-create-modal');
    toast(t('contracts.created_toast') || 'Предложение отправлено', 'ok');
    await loadContracts();
  } catch (err) {
    const key = err?.error_key;
    if (['errors.organization.not_found','errors.organization.inactive','errors.contracts.cannot_contract_self','errors.contracts.already_exists'].includes(key)) {
      showStep('create', 1);
      setFieldError('err-ct-partner', errorMessage(err));
    } else {
      showAlertText('err-ct', 'err-ct-text', errorMessage(err));
    }
  } finally {
    setLoading(btn, false);
  }
}

// ── Edit flow ──────────────────────────────────────────────────────
function openEditModal(id) {
  const c = _current.find(x => x.id === id);
  if (!c) return;
  _editId = id;
  const ctx = document.getElementById('cte-context');
  if (ctx) {
    const roleLbl = c.my_role === 'client' ? (t('contracts.role_client') || 'Заказчик') : (t('contracts.role_contractor') || 'Исполнитель');
    ctx.innerHTML = `<i class="ph ph-handshake"></i> <strong>${escapeHTML(c.partner?.name || '')}</strong> · ${escapeHTML(roleLbl)}`;
  }
  const set = (eid, val) => { const el = document.getElementById(eid); if (el) el.value = val ?? ''; };
  set('cte-name', c.name);
  set('cte-desc', c.description);
  set('cte-end-date', c.end_date ? String(c.end_date).slice(0, 10) : '');
  set('cte-sla-critical', c.sla?.critical_h ?? '');
  set('cte-sla-high',     c.sla?.high_h ?? '');
  set('cte-sla-medium',   c.sla?.medium_h ?? '');
  set('cte-sla-low',      c.sla?.low_h ?? '');
  set('cte-sla-critical-res', c.sla?.critical_resolution_h ?? '');
  set('cte-sla-high-res',     c.sla?.high_resolution_h ?? '');
  set('cte-sla-medium-res',   c.sla?.medium_resolution_h ?? '');
  set('cte-sla-low-res',      c.sla?.low_resolution_h ?? '');
  _doc.edit = { mediaId: null, file: null };
  renderDocTile('edit');
  ['err-cte-name','err-cte-desc','err-cte-end-date'].forEach(clearFieldErrorById);
  hideAlertById('err-cte');
  showStep('edit', 1);
  openModal('contract-edit-modal');
  setTimeout(() => document.getElementById('cte-name')?.focus(), 80);
}
async function submitEdit() {
  if (!_editId) return;
  const name = (document.getElementById('cte-name')?.value || '').trim();
  const desc = (document.getElementById('cte-desc')?.value || '').trim();
  const endDate = document.getElementById('cte-end-date')?.value || '';
  const payload = {
    contract_name: name, contract_description: desc, end_date: endDate,
    ...(_doc.edit.mediaId ? { contract_doc_media_id: _doc.edit.mediaId } : {}),
    ...readSla('cte'),
  };
  const btn = document.getElementById('btn-cte-next');
  setLoading(btn, true);
  try {
    await contractsApi.update(_editId, payload);
    closeModal('contract-edit-modal');
    toast(t('contracts.edit_sent_toast') || 'Изменения отправлены на согласование', 'ok');
    await loadContracts();
  } catch (err) {
    showAlertText('err-cte', 'err-cte-text', errorMessage(err));
  } finally {
    setLoading(btn, false);
  }
}

function openTerminateModal(id) {
  _editId = id;
  hideAlertById('err-ctt');
  const r = document.getElementById('ctt-reason'); if (r) r.value = '';
  openModal('contract-terminate-modal');
}
