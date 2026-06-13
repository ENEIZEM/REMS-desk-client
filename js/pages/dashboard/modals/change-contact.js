/* ═══════════════════════════════════════════════════════════════
   Change-contact wizard (#change-contact-modal) — 3 steps.

   • Step 1: confirm current contact (skipped when LINKING a new one).
   • Step 2: enter the new contact and request a 6-digit code.
   • Step 3: enter the code and submit. Backend revokes ALL sessions
             on success.

   Uses /api/profile/send-code with purpose=change_email|change_phone
   and the matching /api/profile/change-email / change-phone endpoints.

   Plays together with detach-contact.js: the "Открепить" link in the
   wizard hands off to openDetach(type) supplied by the wiring caller.
   ═══════════════════════════════════════════════════════════════ */

import { profile }                from '../../../api.js';
import { toast, errorMessage }    from '../../../auth.js';
import { t, getLang }             from '../../../i18n.js';
import { wireFormGuard }          from '../../../form-guard.js';
import { createCodeInput }        from '../../../lib/code-input.js';
import {
  openModal, closeModal, setLoading,
  setFieldError, clearFieldErrorById,
  showAlertText, hideAlertById,
} from '../ui-helpers.js';

let _ctx = {
  getUserProfile:       () => null,
  getAvailableContacts: () => [],
  refresh:              () => {},
  openDetach:           () => {},
};

let _type     = null;         // 'email' | 'phone'
let _mode     = 'change';     // 'change' (has existing contact) | 'link'
let _step     = 1;
let _newValue = null;         // normalised new contact value
let _guard    = null;
let _codeCtl  = null;         // createCodeInput(...) controller

function setStep(step) {
  _step = step;
  document.querySelector('#chc-step1')?.classList.toggle('hidden', step !== 1);
  document.querySelector('#chc-step2')?.classList.toggle('hidden', step !== 2);
  document.querySelector('#chc-step3')?.classList.toggle('hidden', step !== 3);
  const backBtn = document.querySelector('#btn-chc-back');
  const nextBtn = document.querySelector('#btn-chc-next');
  if (backBtn) backBtn.style.display = step > 1 ? '' : 'none';
  if (nextBtn) {
    if (step === 1) {
      nextBtn.textContent = t('common.continue') || 'Далее';
      nextBtn.setAttribute('data-i18n', 'common.continue');
    } else if (step === 2) {
      nextBtn.textContent = t('profile.change_contact_send_code') || 'Отправить код';
      nextBtn.setAttribute('data-i18n', 'profile.change_contact_send_code');
    } else {
      nextBtn.textContent = t('common.save') || 'Сохранить';
      nextBtn.setAttribute('data-i18n', 'common.save');
    }
  }
  _guard?.refresh();
}

function normaliseContactInput(type, raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  return type === 'email' ? v.toLowerCase() : v.replace(/[\s\-\(\)\.]/g, '');
}
function isValidEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }
function isValidPhone(s) { return /^\+?\d{10,15}$/.test(s); }

// Exported so dashboard.js (and detach-contact.js "Назад") can open the wizard.
export function openChangeContact(type) {
  _type     = type;
  _newValue = null;
  hideAlertById('err-chc');
  clearFieldErrorById('err-chc-current');
  clearFieldErrorById('err-chc-new');
  _codeCtl?.reset();
  document.querySelector('#chc-current-input').value = '';
  document.querySelector('#chc-new-input').value     = '';

  // Decide LINK vs CHANGE based on whether the user already has this contact.
  const user = _ctx.getUserProfile();
  const hasIt = type === 'email' ? !!user?.has_email : !!user?.has_phone;
  _mode = hasIt ? 'change' : 'link';

  // Title + per-step copy.
  const titleKey = type === 'email'
    ? (_mode === 'change' ? 'profile.change_email' : 'profile.link_email')
    : (_mode === 'change' ? 'profile.change_phone' : 'profile.link_phone');
  document.querySelector('#chc-title').textContent = t(titleKey);
  document.querySelector('#chc-title').setAttribute('data-i18n', titleKey);
  // Header icon — envelope for email, phone for phone contact.
  const iconEl = document.querySelector('#chc-icon');
  if (iconEl) iconEl.className = type === 'email' ? 'ph-bold ph-envelope-simple' : 'ph-bold ph-device-mobile';

  // "Detach contact" link is visible only when:
  //   • we're in CHANGE mode (LINK doesn't have anything to detach), AND
  //   • the user has ANOTHER verified contact (else we'd strand them).
  const otherVerified = _type === 'email'
    ? (user?.has_phone && user?.phone_verified)
    : (user?.has_email && user?.email_verified);
  const detachRow = document.querySelector('#chc-detach-row');
  if (detachRow) detachRow.style.display = (_mode === 'change' && otherVerified) ? '' : 'none';

  // If linking, skip the confirm-current step.
  setStep(_mode === 'link' ? 2 : 1);

  openModal('change-contact-modal');
  setTimeout(() => {
    if (_step === 1) document.querySelector('#chc-current-input')?.focus();
    else             document.querySelector('#chc-new-input')?.focus();
  }, 80);
}

async function chcNext() {
  hideAlertById('err-chc');

  if (_step === 1) {
    // Validate that the user knows their current contact. Apply the same
    // normaliser to BOTH sides so we don't accidentally strip dots out of
    // emails ("j.doe@example.com" must not become "jdoe@examplecom").
    const typed = normaliseContactInput(_type, document.querySelector('#chc-current-input').value);
    if (!typed) { setFieldError('err-chc-current', t('errors.required')); return; }
    const entry  = _ctx.getAvailableContacts().find(c => c.type === _type);
    const stored = entry ? normaliseContactInput(_type, entry.value) : '';
    if (!entry || typed !== stored) {
      setFieldError('err-chc-current',
        t('profile.change_contact_current_mismatch') || t('errors.verification.code_invalid'));
      return;
    }
    setStep(2);
    setTimeout(() => document.querySelector('#chc-new-input')?.focus(), 80);
    return;
  }

  if (_step === 2) {
    const newVal = normaliseContactInput(_type, document.querySelector('#chc-new-input').value);
    if (!newVal) { setFieldError('err-chc-new', t('errors.required')); return; }
    const ok = _type === 'email' ? isValidEmail(newVal) : isValidPhone(newVal);
    if (!ok) {
      setFieldError('err-chc-new',
        _type === 'email' ? t('errors.invalid_contact') : t('errors.invalid_contact'));
      return;
    }
    // Don't allow setting to the existing value.
    const existing = _ctx.getAvailableContacts().find(c => c.type === _type);
    if (existing && existing.value && newVal === String(existing.value).toLowerCase().replace(/[\s\-\(\)\.]/g, '')) {
      setFieldError('err-chc-new', t('errors.contact_same_as_current') || t('errors.validation.duplicate_data'));
      return;
    }
    _newValue = newVal;

    const btn = document.querySelector('#btn-chc-next');
    setLoading(btn, true);
    try {
      const resp = await profile.sendCode({
        target:  newVal,
        type:    _type,
        purpose: _type === 'email' ? 'change_email' : 'change_phone',
      });
      document.querySelector('#chc-step3-target').textContent = newVal;
      setStep(3);
      _codeCtl?.clear();
      const cooldown = Number(resp?.data?.cooldown) || 60;
      _codeCtl?.startResendTimer(cooldown);
      setTimeout(() => _codeCtl?.focus(), 80);
      toast(t('profile.change_pwd_code_sent') || 'Код отправлен', 'ok');
    } catch (err) {
      showAlertText('err-chc', 'err-chc-text', errorMessage(err));
    } finally {
      setLoading(btn, false);
    }
    return;
  }

  if (_step === 3) {
    const code = _codeCtl?.read() ?? '';
    if (code.length !== 6) { showAlertText('err-chc', 'err-chc-text', t('errors.pin_length')); return; }

    const btn = document.querySelector('#btn-chc-next');
    setLoading(btn, true);
    try {
      _type === 'email'
        ? await profile.changeEmail({ new_email: _newValue, verification_code: code })
        : await profile.changePhone({ new_phone: _newValue, verification_code: code });
      closeModal('change-contact-modal');
      toast(t('toasts.contact_saved'), 'ok');
      _ctx.refresh();
    } catch (err) {
      showAlertText('err-chc', 'err-chc-text', errorMessage(err));
    } finally {
      setLoading(btn, false);
    }
  }
}

export function wireChangeContact(ctx) {
  Object.assign(_ctx, ctx);

  // Step 3 code-input — same controller registration / change-password use.
  _codeCtl = createCodeInput({
    inputs:        '.chc-code-input',
    resendButton:  '#btn-chc-resend',
    resendWait:    '#chc-resend-wait',
    resendCounter: '#chc-resend-countdown',
    onChange: () => _guard?.refresh(),
  });

  _guard = wireFormGuard({
    button:   '#btn-chc-next',
    required: [{
      kind: 'fn',
      watch: ['#chc-current-input', '#chc-new-input', '.chc-code-input'],
      fn: () => {
        if (_step === 1) return !!document.querySelector('#chc-current-input')?.value.trim();
        if (_step === 2) return !!document.querySelector('#chc-new-input')?.value.trim();
        // Step 3
        return (_codeCtl?.read().length ?? 0) === 6;
      },
    }],
  });

  document.querySelector('#btn-chc-next')?.addEventListener('click', chcNext);
  document.querySelector('#btn-chc-back')?.addEventListener('click', () => {
    if (_step === 3)      setStep(2);
    else if (_step === 2 && _mode === 'change') setStep(1);
  });

  document.querySelector('#btn-chc-resend')?.addEventListener('click', async () => {
    if (!_newValue) return;
    const btn = document.querySelector('#btn-chc-resend');
    setLoading(btn, true);
    try {
      const resp = await profile.sendCode({
        target:  _newValue,
        type:    _type,
        purpose: _type === 'email' ? 'change_email' : 'change_phone',
        resend:  true,
      });
      const cooldown = Number(resp?.data?.cooldown) || 60;
      _codeCtl?.startResendTimer(cooldown);
      _codeCtl?.clear();
      _codeCtl?.focus();
      toast(t('profile.change_pwd_code_sent') || 'Код отправлен', 'ok');
    } catch (err) {
      showAlertText('err-chc', 'err-chc-text', errorMessage(err));
    } finally {
      setLoading(btn, false);
    }
  });

  // "Открепить контакт" link inside the change-contact modal → detach modal.
  document.querySelector('#btn-chc-detach')?.addEventListener('click', () => {
    if (_type) _ctx.openDetach(_type);
  });
}
