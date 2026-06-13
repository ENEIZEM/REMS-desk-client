/* ═══════════════════════════════════════════════════════════════
   Change-password modal (#change-pwd-modal) — 3-step wizard.

   Step 1: pick a verified contact + enter the current password.
   Step 2: receive a 6-digit code (same UX as register step 2 —
           wired through lib/code-input.js so the resend timer,
           auto-advance and paste handling stay identical).
   Step 3: set the new password (+ confirm + strength meter)
           and submit. Backend revokes all OTHER sessions on
           success — current session keeps working.
   ═══════════════════════════════════════════════════════════════ */

import { profile, auth }                 from '../../../api.js';
import { logout, toast, errorMessage }   from '../../../auth.js';
import { t, getLang }                    from '../../../i18n.js';
import { wireFormGuard }                 from '../../../form-guard.js';
import { createCodeInput }               from '../../../lib/code-input.js';
import {
  openModal, closeModal, setLoading,
  setFieldError, clearFieldErrorById,
  showAlertText, hideAlertById,
} from '../ui-helpers.js';

let _ctx = {
  getAvailableContacts: () => [],
  refresh:              () => {},
};

// ── State ───────────────────────────────────────────────────────
let _step          = 1;
let _verifyTarget  = null;
let _verifyType    = null;     // 'email' | 'phone'
let _oldPassword   = '';
let _code          = '';        // captured from step 2
let _guard         = null;
let _codeCtl       = null;     // createCodeInput(...) controller
let _forgotMode    = false;    // true → skip current_password, use reset-password endpoint
let _chpLockTimer  = null;
let _chpLockEndsAt = 0;

function _formatRetrySec(sec) {
  const s = Math.max(0, Math.ceil(sec));
  if (s < 60) return `${s} сек`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r > 0 ? `${m} мин ${r} сек` : `${m} мин`;
}

// Один раз получаем retry_after, дальше клиентский countdown — без
// per-second backend calls. Инпуты + «Далее» disable'нуты на время
// блокировки. При 0 — auto-clear + re-enable.
function _startChpLockCountdown(retryAfterSec) {
  if (_chpLockTimer) clearInterval(_chpLockTimer);
  _chpLockEndsAt = Date.now() + Math.max(0, Number(retryAfterSec) || 0) * 1000;
  const curInput      = document.querySelector('#chp-current');
  const forgotInput   = document.querySelector('#chp-forgot-contact');
  const nextBtn       = document.querySelector('#btn-chp-next');
  [curInput, forgotInput, nextBtn].forEach(el => el && (el.disabled = true));
  const tickOnce = () => {
    const left = (_chpLockEndsAt - Date.now()) / 1000;
    if (left <= 0) {
      clearInterval(_chpLockTimer); _chpLockTimer = null;
      hideAlertById('err-chp');
      [curInput, forgotInput, nextBtn].forEach(el => el && (el.disabled = false));
      _guard?.refresh?.();
      return;
    }
    showAlertText('err-chp', 'err-chp-text',
      t('errors.auth.pin_locked_with_timer', { time: _formatRetrySec(left) }));
  };
  tickOnce();
  _chpLockTimer = setInterval(tickOnce, 1000);
}

// Switch UI between «I remember the password» (default) и forgot-mode.
// Управляется segmented-tab'ами #chp-mode-known / #chp-mode-forgot.
// В forgot-mode прячем «Текущий пароль» и просим ПОЛНЫЙ контакт
// (как identity-proof, аналогично detach-contact). На бэк уйдёт
// auth.resetPassword(target, code, new_pw).
function setForgotMode(on) {
  _forgotMode = !!on;
  const curGroup     = document.querySelector('#chp-current-group');
  const forgotGroup  = document.querySelector('#chp-forgot-contact-group');
  if (curGroup)    curGroup.style.display    = on ? 'none' : '';
  if (forgotGroup) forgotGroup.style.display = on ? '' : 'none';
  document.querySelector('#chp-mode-known')?.classList.toggle('active', !on);
  document.querySelector('#chp-mode-known')?.setAttribute('aria-selected', String(!on));
  document.querySelector('#chp-mode-forgot')?.classList.toggle('active', on);
  document.querySelector('#chp-mode-forgot')?.setAttribute('aria-selected', String(on));
  const curInput     = document.querySelector('#chp-current');
  const forgotInput  = document.querySelector('#chp-forgot-contact');
  if (curInput)    curInput.value = '';
  if (forgotInput) forgotInput.value = '';
  clearFieldErrorById('err-chp-current');
  clearFieldErrorById('err-chp-forgot-contact');
  hideAlertById('err-chp');
  _oldPassword = '';
  _guard?.refresh();
}

// ── Step helpers ────────────────────────────────────────────────
function setStep(n) {
  _step = n;
  // Toggle step panels.
  document.querySelector('#chp-step-1')?.classList.toggle('hidden', n !== 1);
  document.querySelector('#chp-step-2')?.classList.toggle('hidden', n !== 2);
  document.querySelector('#chp-step-3')?.classList.toggle('hidden', n !== 3);
  document.querySelector('#chp-step-4')?.classList.toggle('hidden', n !== 4);
  // Steps-track itself is hidden on the success step — it's a celebratory
  // dead-end, not a stage of the wizard.
  document.querySelector('#chp-steps-track')?.classList.toggle('hidden', n === 4);
  // Progress track: 1/2/3 circles + 1→2, 2→3 lines.
  for (let i = 1; i <= 3; i++) {
    const c = document.querySelector(`#chp-circle-${i}`);
    if (!c) continue;
    c.classList.remove('active', 'done');
    if (i < n)       { c.classList.add('done'); c.innerHTML = '<i class="ph ph-check" style="font-size:.875rem;"></i>'; }
    else             { c.textContent = String(i); if (i === n) c.classList.add('active'); }
    const line = document.querySelector(`#chp-line-${i}`);
    if (line) line.classList.toggle('done', i < n);
  }
  // Footer reshuffles per step:
  //   1: [Далее] [Отмена]
  //   2: [Далее] [Назад] [Отмена]
  //   3: [Сохранить] [Назад] [Отмена]
  //   4: [Войти в систему]                  ← terminal success state
  const nextBtn   = document.querySelector('#btn-chp-next');
  const backBtn   = document.querySelector('#btn-chp-back');
  const cancelBtn = document.querySelector('#btn-chp-cancel');
  if (backBtn)   backBtn.style.display   = (n === 2 || n === 3) ? '' : 'none';
  if (cancelBtn) cancelBtn.style.display = n === 4 ? 'none' : '';
  if (nextBtn) {
    if (n === 4) {
      nextBtn.textContent = t('profile.change_pwd_success_btn') || 'Войти в систему';
      nextBtn.setAttribute('data-i18n', 'profile.change_pwd_success_btn');
      nextBtn.classList.add('w-full');
      nextBtn.disabled = false;          // override the form-guard's disabled state
      nextBtn.classList.remove('is-pending');
    } else {
      nextBtn.classList.remove('w-full');
      if (n === 3) {
        nextBtn.textContent = t('common.save') || 'Сохранить';
        nextBtn.setAttribute('data-i18n', 'common.save');
      } else {
        nextBtn.textContent = t('common.next') || 'Далее';
        nextBtn.setAttribute('data-i18n', 'common.next');
      }
    }
  }
  _guard?.refresh();
}

// Closing the modal at step 4 means "I confirmed I'll re-auth" — we drop
// the local token. At any earlier step it's a regular cancel.
function handleClose() {
  if (_step === 4) {
    closeModal('change-pwd-modal');
    logout();  // navigates to /pages/login.html
  } else {
    closeModal('change-pwd-modal');
  }
}

function selectContact(typeOrEntry) {
  const entry = typeof typeOrEntry === 'object'
    ? typeOrEntry
    : _ctx.getAvailableContacts().find(c => c.type === typeOrEntry);
  if (!entry) return;
  _verifyType   = entry.type;
  _verifyTarget = entry.value;
  // Reflect selection in the radio buttons (no-op if hidden).
  const radio = document.querySelector(`#chp-contact-choice input[name="chp-contact"][value="${entry.type}"]`);
  if (radio) radio.checked = true;
  document.querySelectorAll('#chp-contact-choice .role-card').forEach(card => {
    const r = card.querySelector('input[name="chp-contact"]');
    card.classList.toggle('selected', !!r?.checked);
  });
}

function calcPwdStrength(pw) {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 8)   s++;
  if (/[A-Z]/.test(pw)) s++;
  if (/[a-z]/.test(pw)) s++;
  if (/\d/.test(pw))    s++;
  return Math.max(1, s);
}

function openChangePwdModal() {
  // Reset form state.
  ['chp-current', 'chp-new', 'chp-confirm'].forEach(id => {
    const el = document.querySelector('#' + id);
    if (el) el.value = '';
  });
  hideAlertById('err-chp');
  clearFieldErrorById('err-chp-current');
  clearFieldErrorById('err-chp-new');
  clearFieldErrorById('err-chp-confirm');
  document.querySelector('#chp-strength').style.display = 'none';
  document.querySelectorAll('#chp-strength .pw-bar').forEach(b => { b.style.background = 'var(--clr-border)'; });
  const lbl = document.querySelector('#chp-strength-label');
  if (lbl) lbl.textContent = '';

  _verifyTarget = null;
  _verifyType   = null;
  _oldPassword  = '';
  _code         = '';
  _codeCtl?.reset();

  // Populate the contact picker. 2 контакта → role-grid с обеими
  // карточками (юзер выбирает). 1 контакт → не показываем выбор,
  // вместо этого compact text «EMAIL / контакт» в .single-contact-line.
  const available = _ctx.getAvailableContacts();
  const choice    = document.querySelector('#chp-contact-choice');
  const single    = document.querySelector('#chp-contact-single');
  const emailC    = available.find(c => c.type === 'email');
  const phoneC    = available.find(c => c.type === 'phone');
  const both      = !!emailC && !!phoneC;

  if (both) {
    if (single) single.style.display = 'none';
    if (choice) {
      choice.style.display = 'grid';
      choice.classList.remove('contact-picker--single');
    }
    document.querySelector('#chp-contact-email-label').textContent = emailC.masked;
    document.querySelector('#chp-contact-phone-label').textContent = phoneC.masked;
    document.querySelectorAll('#chp-contact-choice input[name="chp-contact"]').forEach(r => { r.checked = false; });
    document.querySelectorAll('#chp-contact-choice .role-card').forEach(c => c.classList.remove('selected'));
  } else if (emailC || phoneC) {
    if (choice) choice.style.display = 'none';
    if (single) single.style.display = 'flex';
    const entry = emailC || phoneC;
    const typeLabel = entry.type === 'email' ? t('profile.email') : t('profile.phone');
    document.querySelector('#chp-contact-single-type').textContent   = typeLabel;
    document.querySelector('#chp-contact-single-target').textContent = entry.masked;
    selectContact(entry);
  } else {
    // No verified contacts — спрячем picker полностью.
    if (choice) choice.style.display = 'none';
    if (single) single.style.display = 'none';
  }

  // Открываем всегда в режиме «помню пароль» — пользователь сам нажмёт
  // «Забыли пароль?», если нужно.
  setForgotMode(false);
  setStep(1);
  openModal('change-pwd-modal');
  setTimeout(() => document.querySelector('#chp-current')?.focus(), 80);
}

// ── Step transitions ────────────────────────────────────────────
async function chpNext() {
  hideAlertById('err-chp');

  if (_step === 1) {
    if (!_verifyTarget) {
      showAlertText('err-chp', 'err-chp-text', t('errors.required'));
      return;
    }
    const cur = document.querySelector('#chp-current')?.value ?? '';
    if (!_forgotMode) {
      // Known-pwd mode: проверяем старый пароль.
      if (!cur) { setFieldError('err-chp-current', t('errors.required')); return; }
      _oldPassword = cur;
    } else {
      // Forgot-mode: проверяем ПОЛНЫЙ контакт (нормализованный) на
      // совпадение с _verifyTarget (raw value доступного контакта).
      _oldPassword = '';
      const typed = String(document.querySelector('#chp-forgot-contact')?.value ?? '').trim();
      if (!typed) {
        setFieldError('err-chp-forgot-contact', t('errors.required'));
        return;
      }
      const norm = _verifyType === 'phone'
        ? typed.toLowerCase().replace(/[\s\-().]/g, '')
        : typed.toLowerCase();
      const expected = _verifyType === 'phone'
        ? String(_verifyTarget).toLowerCase().replace(/[\s\-().]/g, '')
        : String(_verifyTarget).toLowerCase();
      if (norm !== expected) {
        setFieldError('err-chp-forgot-contact', t('profile.contact_mismatch'));
        return;
      }
    }
    const btn = document.querySelector('#btn-chp-next');
    setLoading(btn, true);
    try {
      const sendPayload = {
        target:  _verifyTarget,
        type:    _verifyType,
        // В forgot-mode purpose='reset_password' (правильный код для
        // последующего auth.resetPassword), иначе обычный 'change_password'.
        purpose: _forgotMode ? 'reset_password' : 'change_password',
        // current_password — eager check сервера: если ошибочный, бэк
        // вернёт invalid_credentials БЕЗ траты email/SMS. В forgot-mode не шлём.
        ...(!_forgotMode && { current_password: cur }),
      };
      const resp = _forgotMode
        ? await auth.sendCode(_verifyTarget, 'reset_password')
        : await profile.sendCode(sendPayload);
      const targetLabel =
        (_ctx.getAvailableContacts().find(c => c.value === _verifyTarget)?.masked) || _verifyTarget;
      document.querySelector('#chp-code-target').textContent = targetLabel;
      setStep(2);
      _codeCtl?.clear();
      const cooldown = Number(resp?.data?.cooldown) || 60;
      _codeCtl?.startResendTimer(cooldown);
      setTimeout(() => _codeCtl?.focus(), 80);
      toast(t('profile.change_pwd_code_sent') || 'Код отправлен', 'ok');
    } catch (err) {
      const key    = err?.error_key;
      const params = err?.data?.error_params || {};
      if (key === 'errors.auth.account_locked') {
        _startChpLockCountdown(Number(params.retry_after) || 0);
      } else if (key === 'errors.auth.invalid_credentials' && typeof params.attempts_remaining === 'number') {
        setFieldError('err-chp-current',
          t('errors.auth.pin_invalid_with_attempts', { n: params.attempts_remaining }));
      } else if (key === 'errors.auth.invalid_credentials') {
        setFieldError('err-chp-current', errorMessage(err));
      } else {
        showAlertText('err-chp', 'err-chp-text', errorMessage(err));
      }
    } finally {
      setLoading(btn, false);
    }
    return;
  }

  if (_step === 2) {
    const code = _codeCtl?.read() ?? '';
    if (code.length !== 6) {
      showAlertText('err-chp', 'err-chp-text', t('errors.pin_length'));
      return;
    }
    // В forgot-mode проверяем код сразу через reset-verify-code endpoint —
    // он не consumed-ит код, но даёт чёткое «code_invalid» при wrong code
    // (бэк инкрементит failed_attempts, чтобы bruteforce был bounded).
    // В обычном change-password flow код проверится только на финальном
    // submit; здесь сохраняем старое поведение, чтобы не множить запросы.
    if (_forgotMode) {
      const btn = document.querySelector('#btn-chp-next');
      setLoading(btn, true);
      try {
        await auth.resetVerifyCode(_verifyTarget, code);
        _code = code;
        setStep(3);
        setTimeout(() => document.querySelector('#chp-new')?.focus(), 80);
      } catch (err) {
        showAlertText('err-chp', 'err-chp-text', errorMessage(err));
      } finally {
        setLoading(btn, false);
      }
      return;
    }
    _code = code;
    setStep(3);
    setTimeout(() => document.querySelector('#chp-new')?.focus(), 80);
    return;
  }

  if (_step === 3) {
    const newPw  = document.querySelector('#chp-new')?.value ?? '';
    const newPw2 = document.querySelector('#chp-confirm')?.value ?? '';

    clearFieldErrorById('err-chp-new');
    clearFieldErrorById('err-chp-confirm');

    if (!newPw)  { setFieldError('err-chp-new',     t('errors.required')); return; }
    if (!newPw2) { setFieldError('err-chp-confirm', t('errors.required')); return; }
    if (newPw.length < 8 || !/[A-Z]/.test(newPw) || !/[a-z]/.test(newPw) || !/\d/.test(newPw)) {
      setFieldError('err-chp-new', t('errors.password_weak'));
      return;
    }
    if (newPw !== newPw2) {
      setFieldError('err-chp-confirm', t('errors.password_mismatch'));
      return;
    }

    const btn = document.querySelector('#btn-chp-next');
    setLoading(btn, true);
    try {
      if (_forgotMode) {
        // Forgot-mode → auth.resetPassword: бэк проверит код, апдейтит
        // password_hash, ревокает ВСЕ сессии (включая текущую).
        await auth.resetPassword({
          target: _verifyTarget, code: _code,
          new_password: newPw, new_password_confirm: newPw2,
        });
      } else {
        await profile.changePassword({
          old_password:        _oldPassword,
          new_password:        newPw,
          new_password_confirm: newPw2,
          verification_code:   _code,
          verification_target: _verifyTarget,
        });
      }
      // Land on the success screen — closing the modal from here drops the
      // local token so the user signs in with the new password.
      setStep(4);
    } catch (err) {
      showAlertText('err-chp', 'err-chp-text', errorMessage(err));
    } finally {
      setLoading(btn, false);
    }
    return;
  }

  if (_step === 4) {
    // The "Войти в систему" CTA — same behaviour as closing the modal at
    // step 4: log the user out so they reauth with the new password.
    handleClose();
  }
}

export function wireChangePassword(ctx) {
  Object.assign(_ctx, ctx);

  // ── Code-input controller (step 2). ────────────────────────────
  _codeCtl = createCodeInput({
    inputs:        '.chp-code-input',
    resendButton:  '#btn-chp-resend',
    resendWait:    '#chp-resend-wait',
    resendCounter: '#chp-resend-countdown',
    onChange: () => _guard?.refresh(),
  });

  // ── Form-guard — gates #btn-chp-next per step. ─────────────────
  _guard = wireFormGuard({
    button:   '#btn-chp-next',
    required: [{
      kind:  'fn',
      watch: ['#chp-current', '#chp-forgot-contact', '#chp-new', '#chp-confirm',
              '.chp-code-input', '#chp-contact-choice input[name="chp-contact"]'],
      fn: () => {
        if (_step === 1) {
          if (!_verifyTarget) return false;
          if (_forgotMode) {
            // forgot-mode: вместо current_password нужен ПОЛНЫЙ контакт.
            return !!document.querySelector('#chp-forgot-contact')?.value.trim();
          }
          return !!document.querySelector('#chp-current')?.value.trim();
        }
        if (_step === 2) {
          return (_codeCtl?.read().length ?? 0) === 6;
        }
        // Step 3
        return !!document.querySelector('#chp-new')?.value.trim()
            && !!document.querySelector('#chp-confirm')?.value.trim();
      },
    }],
  });

  // ── Open button (Profile tab → "Сменить пароль"). ──────────────
  document.querySelector('#btn-open-change-pwd')?.addEventListener('click', openChangePwdModal);

  // ── Close button + Cancel ─────────────────────────────────────
  // Cancel doesn't carry data-close-modal anymore — change-password owns
  // its dismissal so the success step (4) can force a logout. The header
  // ×, in contrast, still uses the page-level [data-close-modal] handler
  // to close; we just chain a logout here when we're on the success step.
  document.querySelector('#btn-chp-cancel')?.addEventListener('click', () => {
    closeModal('change-pwd-modal');
    if (_step === 4) logout();
  });
  document.querySelector('#change-pwd-modal .modal-close')?.addEventListener('click', () => {
    if (_step === 4) logout();
  });

  // ── Radio cards in the contact picker (step 1). ────────────────
  document.querySelectorAll('#chp-contact-choice input[name="chp-contact"]').forEach(r => {
    r.addEventListener('change', () => {
      if (r.checked) selectContact(r.value);
      _guard?.refresh();
    });
  });

  // ── Step navigation buttons. ───────────────────────────────────
  document.querySelector('#btn-chp-next')?.addEventListener('click', chpNext);
  document.querySelector('#btn-chp-back')?.addEventListener('click', () => {
    if (_step === 3)      setStep(2);
    else if (_step === 2) setStep(1);
  });

  // ── Segmented-tab переключение режима (шаг 1) ─────────────────
  document.querySelector('#chp-mode-known')?.addEventListener('click', () => {
    setForgotMode(false);
    setTimeout(() => document.querySelector('#chp-current')?.focus(), 50);
  });
  document.querySelector('#chp-mode-forgot')?.addEventListener('click', () => {
    setForgotMode(true);
  });

  // ── Resend code (step 2). ──────────────────────────────────────
  document.querySelector('#btn-chp-resend')?.addEventListener('click', async () => {
    if (!_verifyTarget) return;
    hideAlertById('err-chp');
    try {
      const resp = _forgotMode
        ? await auth.sendCode(_verifyTarget, 'reset_password', null, { resend: true })
        : await profile.sendCode({
            target:  _verifyTarget,
            type:    _verifyType,
            purpose: 'change_password',
            resend:  true,
          });
      const cooldown = Number(resp?.data?.cooldown) || 60;
      _codeCtl?.startResendTimer(cooldown);
      _codeCtl?.clear();
      _codeCtl?.focus();
      toast(t('profile.change_pwd_code_sent') || 'Код отправлен', 'ok');
    } catch (err) {
      showAlertText('err-chp', 'err-chp-text', errorMessage(err));
    }
  });

  // ── Live password-strength meter (step 3). ─────────────────────
  document.querySelector('#chp-new')?.addEventListener('input', () => {
    const pw       = document.querySelector('#chp-new').value;
    const strength = calcPwdStrength(pw);
    const bars     = document.querySelectorAll('#chp-strength .pw-bar');
    const colors   = ['#ef4444', '#f59e0b', '#0d9488', '#0f766e'];
    const labels_ru = ['Очень слабый', 'Слабый', 'Хороший', 'Надёжный'];
    const labels_en = ['Very weak', 'Weak', 'Good', 'Strong'];
    const labels    = getLang() === 'en' ? labels_en : labels_ru;
    document.querySelector('#chp-strength').style.display = pw ? '' : 'none';
    bars.forEach((bar, i) => {
      bar.style.background = i < strength ? colors[strength - 1] : 'var(--clr-border)';
    });
    const lbl = document.querySelector('#chp-strength-label');
    if (lbl) { lbl.textContent = pw ? labels[strength - 1] : ''; lbl.style.color = colors[strength - 1]; }
  });
}
