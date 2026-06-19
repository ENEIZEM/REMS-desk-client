/* ═══════════════════════════════════════════════════════════════
   Generic single-field edit modal (#field-edit-modal).

   Every editable row has [data-edit-field="<key>"]. Click → modal
   opens pre-filled with the current value, validates per
   descriptor, and on Save calls the matching API endpoint.
   Container layout in read mode never changes.

   Wired once by dashboard/index.js via wireFieldEdit({…}). Callers
   supply state getters so the descriptors can read live values
   without sharing module variables.
   ═══════════════════════════════════════════════════════════════ */

import { profile, org }            from '../../../api.js';
import { toast, errorMessage }     from '../../../auth.js';
import { t }                       from '../../../i18n.js';
import { wireFormGuard }           from '../../../form-guard.js';
import { openModal, closeModal, setLoading } from '../ui-helpers.js';

let _ctx = {
  getUserProfile: () => null,
  getOrgData:     () => null,
  refresh:        () => {},
};

const FIELD_EDITORS = {
  // Personal profile fields
  full_name: {
    title:  'profile.name',
    type:   'text',
    max:    255,
    current: () => _ctx.getUserProfile()?.full_name || '',
    save:    (val) => profile.update({ full_name: val }),
    successKey: 'profile.saved_personal',
  },
  department: {
    title:  'profile.department',
    type:   'text',
    max:    150,
    current: () => _ctx.getUserProfile()?.department || '',
    save:    (val) => profile.update({ department: val }),
    successKey: 'profile.saved_personal',
  },
  // email + phone use dedicated [Сменить]/[Привязать] buttons that lead
  // through the verification-code wizard (change-contact.js). They DO NOT
  // use the generic field-edit modal.

  // Org fields
  organization_name: {
    title:  'profile.organization',
    type:   'text',
    max:    255,
    current: () => _ctx.getOrgData()?.name || '',
    save:    (val) => org.updateSettings({ organization_name: val }),
    successKey: 'profile.saved_org',
  },
  // `occupation` (customer / contractor) editor removed alongside the
  // organizations.occupation column — that distinction now lives on each
  // contract row between two organisations, not as an attribute of the
  // org itself.

  // SLA fields
  internal_sla_critical_h: { title: 'profile.sla_critical', type: 'number', min: 1, max: 240, current: () => _ctx.getOrgData()?.limits?.internal_sla_critical_h, save: (v) => org.updateLimits({ internal_sla_critical_h: v }), successKey: 'profile.sla_saved' },
  internal_sla_high_h:     { title: 'profile.sla_high',     type: 'number', min: 1, max: 240, current: () => _ctx.getOrgData()?.limits?.internal_sla_high_h,     save: (v) => org.updateLimits({ internal_sla_high_h: v     }), successKey: 'profile.sla_saved' },
  internal_sla_medium_h:   { title: 'profile.sla_medium',   type: 'number', min: 1, max: 240, current: () => _ctx.getOrgData()?.limits?.internal_sla_medium_h,   save: (v) => org.updateLimits({ internal_sla_medium_h: v   }), successKey: 'profile.sla_saved' },
  internal_sla_low_h:      { title: 'profile.sla_low',      type: 'number', min: 1, max: 240, current: () => _ctx.getOrgData()?.limits?.internal_sla_low_h,      save: (v) => org.updateLimits({ internal_sla_low_h: v      }), successKey: 'profile.sla_saved' },
  // SLA реакции (срок взятия) — отдельный редактируемый набор для внутренних заявок.
  internal_response_sla_critical_h: { title: 'profile.sla_critical', type: 'number', min: 1, max: 240, current: () => _ctx.getOrgData()?.limits?.internal_response_sla_critical_h, save: (v) => org.updateLimits({ internal_response_sla_critical_h: v }), successKey: 'profile.sla_saved' },
  internal_response_sla_high_h:     { title: 'profile.sla_high',     type: 'number', min: 1, max: 240, current: () => _ctx.getOrgData()?.limits?.internal_response_sla_high_h,     save: (v) => org.updateLimits({ internal_response_sla_high_h: v     }), successKey: 'profile.sla_saved' },
  internal_response_sla_medium_h:   { title: 'profile.sla_medium',   type: 'number', min: 1, max: 240, current: () => _ctx.getOrgData()?.limits?.internal_response_sla_medium_h,   save: (v) => org.updateLimits({ internal_response_sla_medium_h: v   }), successKey: 'profile.sla_saved' },
  internal_response_sla_low_h:      { title: 'profile.sla_low',      type: 'number', min: 1, max: 240, current: () => _ctx.getOrgData()?.limits?.internal_response_sla_low_h,      save: (v) => org.updateLimits({ internal_response_sla_low_h: v      }), successKey: 'profile.sla_saved' },
};

let _currentFieldKey = null;
let _guard = null;

function openFieldEditModal(fieldKey) {
  const desc = FIELD_EDITORS[fieldKey];
  if (!desc) return;
  _currentFieldKey = fieldKey;

  document.querySelector('#field-edit-title').textContent = t(desc.title);
  document.querySelector('#field-edit-label').textContent = t(desc.title);
  const errEl = document.querySelector('#field-edit-error');
  errEl.classList.remove('show');

  const txt = document.querySelector('#field-edit-input');
  const num = document.querySelector('#field-edit-number');
  const sel = document.querySelector('#field-edit-select');
  txt.style.display = num.style.display = sel.style.display = 'none';

  const hint = document.querySelector('#field-edit-hint');
  if (desc.hintKey) { hint.textContent = t(desc.hintKey); hint.classList.remove('hidden'); }
  else              { hint.classList.add('hidden'); }

  if (desc.type === 'number') {
    num.style.display = '';
    num.min = desc.min ?? '';
    num.max = desc.max ?? '';
    num.value = desc.current() ?? '';
  } else if (desc.type === 'select') {
    sel.style.display = '';
    sel.innerHTML = desc.options.map(o =>
      `<option value="${o.value}">${t(o.labelKey)}</option>`).join('');
    sel.value = desc.current();
  } else {
    txt.style.display = '';
    txt.maxLength = desc.max ?? 255;
    txt.value = desc.current() ?? '';
  }
  openModal('field-edit-modal');
  (desc.type === 'number' ? num : desc.type === 'select' ? sel : txt).focus();
  // After visibility swap, recompute the gray-look on the save button.
  _guard?.refresh();
}

export function wireFieldEdit(ctx) {
  Object.assign(_ctx, ctx);

  // ── Visual form-guard ──────────────────────────────────────────
  // Only one of text/number/select is visible at a time — the
  // fn-predicate inspects whichever element is currently shown.
  _guard = wireFormGuard({
    button:   '#btn-field-edit-save',
    required: [{
      kind:  'fn',
      watch: ['#field-edit-input', '#field-edit-number', '#field-edit-select'],
      fn: () => {
        const txt = document.getElementById('field-edit-input');
        const num = document.getElementById('field-edit-number');
        const sel = document.getElementById('field-edit-select');
        if (txt && txt.style.display !== 'none') return !!txt.value.trim();
        if (num && num.style.display !== 'none') return num.value !== '' && !Number.isNaN(Number(num.value));
        if (sel && sel.style.display !== 'none') return !!sel.value;
        return false;
      },
    }],
  });

  // ── Open-modal click delegation for every [data-edit-field] row ──
  document.querySelectorAll('[data-edit-field]').forEach(btn => {
    btn.addEventListener('click', () => openFieldEditModal(btn.dataset.editField));
  });

  // ── Save button ────────────────────────────────────────────────
  document.querySelector('#btn-field-edit-save')?.addEventListener('click', async () => {
    const desc = FIELD_EDITORS[_currentFieldKey];
    if (!desc) return;

    let value;
    if (desc.type === 'number') {
      value = Number(document.querySelector('#field-edit-number').value);
      if (!Number.isInteger(value) || value < (desc.min ?? -Infinity) || value > (desc.max ?? Infinity)) {
        const err = document.querySelector('#field-edit-error');
        err.querySelector('span').textContent = `${desc.min}–${desc.max}`;
        err.classList.add('show');
        return;
      }
    } else if (desc.type === 'select') {
      value = document.querySelector('#field-edit-select').value;
    } else {
      value = document.querySelector('#field-edit-input').value.trim();
      if (!value) {
        const err = document.querySelector('#field-edit-error');
        err.querySelector('span').textContent = t('errors.required');
        err.classList.add('show');
        return;
      }
    }

    const btn = document.querySelector('#btn-field-edit-save');
    setLoading(btn, true);
    try {
      await desc.save(value);
      if (!desc.skipSaveToast) toast(t(desc.successKey || 'profile.saved_generic'), 'ok');
      closeModal('field-edit-modal');
      await _ctx.refresh();
    } catch (err) {
      if (err?.error_key === 'profile.telegram_coming_soon') {
        // Special-case: email/phone change not yet wired
        closeModal('field-edit-modal');
        toast('Скоро будет', 'info');
        return;
      }
      const errEl = document.querySelector('#field-edit-error');
      errEl.querySelector('span').textContent = errorMessage(err);
      errEl.classList.add('show');
    } finally {
      setLoading(btn, false);
    }
  });
}
