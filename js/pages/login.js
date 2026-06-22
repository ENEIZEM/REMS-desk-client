/* ═══════════════════════════════════════════════════════════════
   REMS — Login page logic

   Two entry paths:
     • step-password: contact + password + PIN
         For new devices, expired tokens, fresh installs.
         All three fields required.
     • step-pin: 6-digit PIN only
         For returning users on the same device — a valid token is
         already in localStorage, so backend skips password and just
         checks PIN. This is the "quick unlock" path.

   NOTE: Uses async IIFE instead of top-level await for maximum
   browser compatibility (avoids issues with older Chromium builds).
   ═══════════════════════════════════════════════════════════════ */

import { auth, getDeviceId }                 from '../api.js';
import { requireGuest, toast, errorMessage } from '../auth.js';
import { t, initI18n, onLangChange, applyTranslations, getLang } from '../i18n.js';
import { wireFormGuard }                     from '../form-guard.js';
import { grantPinPass }                      from '../lib/pin-gate.js';
import { phoneChannelEnabled, loadFeatures } from '../config.js';

// ── Hoisted helpers ─────────────────────────────────────────────
function q(sel) { return document.querySelector(sel); }
// `on=false` is suppressed if the button is currently mid-lockout
// (data-lockedUntil > now) — the countdown timer owns the disabled
// state until it expires, and request-finally hooks must respect it.
function setLoading(btn, on) {
  if (!btn) return;
  if (!on && btn.dataset.lockedUntil && Number(btn.dataset.lockedUntil) > Date.now()) {
    btn.classList.toggle('btn-loading', false);
    return;
  }
  btn.disabled = on;
  btn.classList.toggle('btn-loading', on);
}
function joinDigits(nodeList) {
  return [...nodeList].map(i => i.value).join('');
}

// i18n-friendly error rendering: every visible error text stores its
// i18n key on data-i18n so applyTranslations() can re-resolve it on
// language switch.

function clearErrors() {
  document.querySelectorAll('.form-error').forEach(el => {
    el.classList.remove('show');
    const span = el.querySelector('span');
    if (span) { span.removeAttribute('data-i18n'); span.textContent = ''; }
  });
  document.querySelectorAll('.form-input.error').forEach(el => el.classList.remove('error'));
  document.querySelectorAll('.pin-input.error').forEach(el => el.classList.remove('error'));
  hideAlert('err-login');
  hideAlert('err-pin');
}
function showFieldError(id, key) {
  const el = document.getElementById(id);
  if (!el) return;
  const span = el.querySelector('span');
  if (span) {
    span.setAttribute('data-i18n', key);
    span.textContent = t(key);
  }
  el.classList.add('show');
  el.closest('.form-group')?.querySelector('.form-input')?.classList.add('error');
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function showAlertKey(alertId, textId, key, fallback) {
  const alertEl = document.getElementById(alertId);
  if (!alertEl) return;
  alertEl.classList.add('show');
  const el = document.getElementById(textId);
  if (el) {
    el.setAttribute('data-i18n', key);
    const translated = t(key);
    el.textContent = (translated !== key) ? translated : (fallback || translated);
  }
  alertEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function showAlertFromError(alertId, textId, err) {
  const key = err?.error_key || 'errors.server_error';
  showAlertKey(alertId, textId, key, err?.message || errorMessage(err));
}
function hideAlert(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('show');
  const txt = el.querySelector('[id$="-text"]');
  if (txt) { txt.removeAttribute('data-i18n'); txt.textContent = ''; }
  // Cancel any live countdown attached to this alert.
  if (el._countdownTimer) {
    clearInterval(el._countdownTimer);
    el._countdownTimer = null;
  }
}

// Format a number of seconds as "M:SS" — used in lock-timer alerts so the
// user sees exactly when they can retry. Always shows minutes:seconds even
// for small values (e.g. "0:35"), which reads more clearly than "35s".
function fmtCountdown(secs) {
  const s = Math.max(0, Math.ceil(secs));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

// Render the alert text by interpolating {n} / {time} from a params bag.
// If a live `retry_after` (seconds) is present, install a 1s interval that
// keeps the countdown text fresh until it hits 0. While the countdown is
// running, the two submit buttons (#btn-password, #btn-pin) are forced
// disabled (greyed out, .btn-loading off) so the user can't fire another
// request that the backend would just reject; the disabled flag is lifted
// when the timer reaches zero.
function showAlertWithParams(alertId, textId, key, params = {}) {
  const alertEl = document.getElementById(alertId);
  if (!alertEl) return;
  alertEl.classList.add('show');
  const el = document.getElementById(textId);
  if (!el) return;
  // Cancel any previous countdown bound to this alert.
  if (alertEl._countdownTimer) {
    clearInterval(alertEl._countdownTimer);
    alertEl._countdownTimer = null;
  }
  el.removeAttribute('data-i18n');

  const render = (extra = {}) => {
    const all = { ...params, ...extra };
    let txt = t(key);
    if (txt === key) txt = '';     // fall back to nothing-found; caller can pass a plain string
    Object.entries(all).forEach(([k, v]) => {
      txt = txt.replaceAll(`{${k}}`, String(v));
    });
    el.textContent = txt;
  };

  if (typeof params.retry_after === 'number' && params.retry_after > 0) {
    const startedAt = Date.now();
    const total     = params.retry_after;
    // Force-disable both submit buttons for the duration. We set a flag
    // (data-locked-until) so subsequent form-guard refreshes can't flip
    // disabled=false during the countdown.
    const lockedUntil = startedAt + total * 1000;
    [q('#btn-password'), q('#btn-pin')].forEach(btn => {
      if (!btn) return;
      btn.dataset.lockedUntil = String(lockedUntil);
      btn.disabled = true;
      btn.classList.remove('btn-loading');
    });
    const tick = () => {
      const left = total - Math.floor((Date.now() - startedAt) / 1000);
      if (left <= 0) {
        clearInterval(alertEl._countdownTimer);
        alertEl._countdownTimer = null;
        // Истёкший lockout: прячем alert (UX-просьба) и разблокируем
        // кнопки. Form-guard пересчитает disabled на следующем input'е.
        alertEl.classList.remove('show');
        el.textContent = '';
        [q('#btn-password'), q('#btn-pin')].forEach(btn => {
          if (!btn) return;
          delete btn.dataset.lockedUntil;
          btn.disabled = false;
        });
        return;
      }
      render({ time: fmtCountdown(left) });
    };
    tick();
    alertEl._countdownTimer = setInterval(tick, 1000);
  } else {
    render();
  }
  alertEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Generic wiring for any group of single-digit input boxes (PIN, code).
// Auto-advance on type, backspace-to-previous, paste-fills, optional
// onSubmit() callback fires when all boxes are filled.
function wireDigitBoxes(inputs, { onSubmit } = {}) {
  inputs.forEach((input, idx) => {
    input.addEventListener('input', () => {
      input.classList.remove('error');
      input.value = input.value.replace(/\D/, '').slice(0, 1);
      input.classList.toggle('filled', !!input.value);
      if (input.value && idx < inputs.length - 1) inputs[idx + 1].focus();
      if (joinDigits(inputs).length === inputs.length) onSubmit?.();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value && idx > 0) {
        inputs[idx - 1].focus();
        inputs[idx - 1].value = '';
        inputs[idx - 1].classList.remove('filled');
      }
    });
    input.addEventListener('paste', (e) => {
      const raw = (e.clipboardData || window.clipboardData)
        .getData('text').replace(/\D/g, '').slice(0, inputs.length);
      if (!raw) return;
      e.preventDefault();
      [...raw].forEach((ch, i) => {
        if (inputs[i]) {
          inputs[i].value = ch;
          inputs[i].classList.add('filled');
        }
      });
      inputs[Math.min(raw.length, inputs.length) - 1]?.focus();
      if (joinDigits(inputs).length === inputs.length) onSubmit?.();
    });
  });
}

// ─────────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────────
(async () => {
  try { await Promise.all([initI18n(), loadFeatures()]); }
  catch (e) { console.error('[login] init failed:', e); }

  // requireGuest redirects (asynchronously via location.href) if a token
  // is already in localStorage. Returning early prevents the brief flash
  // of the login UI when navigating from the freshly-registered step 4.
  if (!requireGuest()) return;

  getDeviceId().catch(() => {});

  // Пока SMS не подключён — вход только по email: подпись поля без «или
  // телефон» (плейсхолдер оставляем общий, бэкенд примет любой контакт у
  // тех, у кого телефон уже привязан). Логику не режем.
  if (!phoneChannelEnabled()) {
    const lbl = document.querySelector('[data-i18n="auth.login.contact_label"]');
    if (lbl) lbl.setAttribute('data-i18n', 'auth.login.contact_label_email');
    // Все плейсхолдеры с «или +7 999…» → email-only (вход И форма «забыли
    // пароль» используют один ключ auth.login.contact_ph).
    document.querySelectorAll('[data-i18n-ph="auth.login.contact_ph"]')
      .forEach(el => el.setAttribute('data-i18n-ph', 'auth.login.contact_ph_email'));
    // Подзаголовок/подсказка восстановления пароля упоминают «телефон/номер».
    const fSub = document.querySelector('[data-i18n="auth.forgot.subtitle_contact"]');
    if (fSub) fSub.setAttribute('data-i18n', 'auth.forgot.subtitle_contact_email');
    const fHint = document.querySelector('[data-i18n="auth.forgot.contact_hint"]');
    if (fHint) fHint.setAttribute('data-i18n', 'auth.forgot.contact_hint_email');
    applyTranslations();
  }

  // Re-translate visible alerts/field errors on language change.
  onLangChange(() => applyTranslations());

  // ── Saved state ───────────────────────────────────────────────
  const savedToken   = localStorage.getItem('rems_token');
  const savedContact = localStorage.getItem('rems_contact') || '';

  // Returning user on the same device with a valid cached token: show
  // the PIN-only fast-path. This branch is kept defensively — requireGuest
  // would normally already have redirected to /dashboard.
  if (savedToken) {
    q('#step-password')?.classList.add('hidden');
    q('#step-pin')?.classList.remove('hidden');
  }

  // ── Password visibility toggle ────────────────────────────────
  q('#toggle-pw')?.addEventListener('click', () => {
    const pw = q('#password');
    if (!pw) return;
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    const icon = q('#pw-icon');
    if (icon) icon.className = show ? 'ph ph-eye-slash' : 'ph ph-eye';
  });

  // ─────────────────────────────────────────────────────────────
  // STEP: PASSWORD + PIN LOGIN
  //
  // Both fields are required. The inline PIN inputs (.login-pin-input)
  // live in the same form as contact+password — pressing Enter or
  // clicking «Войти» submits everything together.
  // ─────────────────────────────────────────────────────────────
  const loginPinInputs = document.querySelectorAll('.login-pin-input');
  wireDigitBoxes(loginPinInputs, {
    // Auto-submit the form when all 6 PIN digits are entered AND password
    // is non-empty. Otherwise just stop at the last input.
    onSubmit: () => {
      const password = q('#password')?.value ?? '';
      const contact  = q('#contact')?.value?.trim() ?? '';
      if (contact && password) q('#btn-password')?.click();
    },
  });

  // Visual gray-out until contact + password + 6-digit PIN are present.
  // Click still passes through to handleLogin (which paints field errors).
  wireFormGuard({
    button:   '#btn-password',
    required: [
      { sel: '#contact',  kind: 'text' },
      { sel: '#password', kind: 'text' },
      { sel: '.login-pin-input', kind: 'digit-group', total: 6 },
    ],
  });

  async function handleLogin(e) {
    if (e?.preventDefault) e.preventDefault();
    clearErrors();

    const contact  = q('#contact')?.value.trim()  ?? '';
    const password = q('#password')?.value         ?? '';
    const pin      = joinDigits(loginPinInputs);
    let valid = true;

    if (!contact)  { showFieldError('err-contact',  'errors.required'); valid = false; }
    if (!password) { showFieldError('err-password', 'errors.required'); valid = false; }
    if (!pin) {
      showFieldError('err-login-pin', 'errors.required');
      valid = false;
    } else if (pin.length !== 6) {
      showFieldError('err-login-pin', 'errors.pin_length');
      valid = false;
    }
    if (!valid) return;

    const btn = q('#btn-password');
    setLoading(btn, true);
    try {
      const data = await auth.login(contact, password, pin);
      localStorage.setItem('rems_token',   data.data.token);
      localStorage.setItem('rems_contact', contact);
      // Юзер только что ввёл пароль (+PIN при необходимости) — выдаём
      // one-shot pass, иначе dashboard сразу попросит PIN ещё раз.
      grantPinPass();
      window.location.href = '/pages/dashboard.html';
    } catch (err) {
      const params = err?.data?.error_params || {};
      const key    = err?.error_key;

      // Lockout: render a live M:SS countdown until retry_after expires.
      if (key === 'errors.auth.account_locked') {
        showAlertWithParams('err-login', 'err-login-text',
          'errors.auth.account_locked_with_timer',
          { retry_after: Number(params.retry_after) || 0 });
        return;
      }
      // Invalid credentials: show remaining attempts inline.
      if (key === 'errors.auth.invalid_credentials') {
        if (typeof params.attempts_remaining === 'number') {
          showAlertWithParams('err-login', 'err-login-text',
            'errors.auth.invalid_credentials_with_attempts',
            { n: params.attempts_remaining });
        } else {
          showAlertFromError('err-login', 'err-login-text', err);
        }
        return;
      }

      if (key === 'errors.auth.pin_locked') {
        loginPinInputs.forEach(i => { i.classList.add('error'); i.value = ''; i.classList.remove('filled'); });
        showAlertWithParams('err-login', 'err-login-text',
          'errors.auth.pin_locked_with_timer',
          { retry_after: Number(params.retry_after) || 0 });
        loginPinInputs[0]?.focus();
        return;
      }
      if (key === 'errors.auth.pin_invalid' && typeof params.attempts_remaining === 'number') {
        loginPinInputs.forEach(i => { i.classList.add('error'); i.value = ''; i.classList.remove('filled'); });
        showAlertWithParams('err-login', 'err-login-text',
          'errors.auth.pin_invalid_with_attempts',
          { n: params.attempts_remaining });
        loginPinInputs[0]?.focus();
        return;
      }
      if (key === 'errors.auth.pin_invalid' ||
          key === 'errors.auth.pin_required' ||
          key === 'errors.auth.pin_not_set') {
        // Highlight PIN row in red and reset values for re-entry
        loginPinInputs.forEach(i => {
          i.classList.add('error');
          i.value = '';
          i.classList.remove('filled');
        });
        showFieldError('err-login-pin', key);
        loginPinInputs[0]?.focus();
        return;
      }
      showAlertFromError('err-login', 'err-login-text', err);
    } finally {
      setLoading(btn, false);
    }
  }

  // Form submit (Enter key) — preventDefault keeps fields intact
  q('#form-password')?.addEventListener('submit', handleLogin);
  // Button click — belt-and-suspenders in case form listener misses
  q('#btn-password')?.addEventListener('click',  handleLogin);

  // ─────────────────────────────────────────────────────────────
  // STEP: PIN-ONLY FAST PATH (#step-pin)
  // Activated only when a valid token already exists for this device.
  // ─────────────────────────────────────────────────────────────
  const fastPinInputs = document.querySelectorAll('#step-pin .pin-input');
  wireDigitBoxes(fastPinInputs, {
    onSubmit: () => q('#btn-pin')?.click(),
  });

  // Fast-PIN button: gray until all 6 digits filled.
  wireFormGuard({
    button:   '#btn-pin',
    required: [
      { sel: '#step-pin .pin-input', kind: 'digit-group', total: 6 },
    ],
  });

  q('#btn-pin')?.addEventListener('click', async () => {
    const pin = joinDigits(fastPinInputs);
    if (pin.length < 6) return;

    hideAlert('err-pin');
    const btn     = q('#btn-pin');
    const contact = savedContact || q('#contact')?.value?.trim() || '';
    setLoading(btn, true);

    try {
      const data = await auth.login(contact, null, pin);
      localStorage.setItem('rems_token', data.data.token);
      grantPinPass();   // юзер только что ввёл PIN — не спрашиваем ещё раз
      window.location.href = '/pages/dashboard.html';
    } catch (err) {
      const params = err?.data?.error_params || {};
      const key    = err?.error_key;
      if (key === 'errors.auth.pin_locked') {
        showAlertWithParams('err-pin', 'err-pin-text',
          'errors.auth.pin_locked_with_timer',
          { retry_after: Number(params.retry_after) || 0 });
      } else if (key === 'errors.auth.pin_invalid' && typeof params.attempts_remaining === 'number') {
        showAlertWithParams('err-pin', 'err-pin-text',
          'errors.auth.pin_invalid_with_attempts',
          { n: params.attempts_remaining });
      } else if (key === 'errors.auth.account_locked') {
        showAlertWithParams('err-pin', 'err-pin-text',
          'errors.auth.account_locked_with_timer',
          { retry_after: Number(params.retry_after) || 0 });
      } else {
        showAlertFromError('err-pin', 'err-pin-text', err);
      }
      fastPinInputs.forEach(i => {
        i.value = '';
        i.classList.remove('filled');
      });
      fastPinInputs[0]?.focus();
      if (btn) btn.disabled = true;
    } finally {
      setLoading(btn, false);
    }
  });

  // ── Back to password (from step-pin → step-password) ──────────
  q('#back-to-password')?.addEventListener('click', () => {
    localStorage.removeItem('rems_token');
    q('#step-pin')?.classList.add('hidden');
    q('#step-password')?.classList.remove('hidden');
  });

  // ─────────────────────────────────────────────────────────────
  // FORGOT-PASSWORD — 3-шаговый wizard в стиле change-password modal.
  //   Step 1: ввод контакта (валидация формата ДО запроса к бэку)
  //   Step 2: 6-значный код от sendCode('reset_password')
  //   Step 3: новый пароль + подтверждение
  //   Step 4: success → автоматически возвращаемся к login с предзаполненным
  //           контактом и пустым полем пароля.
  //
  // Бэк через purpose='reset_password' возвращает success даже для
  // незарегистрированного контакта (anti-enumeration). Здесь это
  // незаметно: пройдём на шаг 2, ввод неверного кода → backend
  // ответит code_invalid, пользователь увидит «неверный код».
  // ─────────────────────────────────────────────────────────────
  const fpCodeInputs = document.querySelectorAll('.forgot-code-input');
  const fpPinInputs  = document.querySelectorAll('.fp-pin-new');
  const fpPin2Inputs = document.querySelectorAll('.fp-pin-confirm');
  let fpStep         = 1;
  let fpContact      = '';
  let fpResendTimer  = null;
  let fpMode         = 'password';   // 'password' | 'pin'

  function fpHideAllAlerts() {
    hideAlert('err-fp-1');
    hideAlert('err-fp-2');
    hideAlert('err-fp-3');
  }

  function fpSetStep(n) {
    fpStep = n;
    for (let i = 1; i <= 4; i++) {
      q(`#fp-step-${i}`)?.classList.toggle('hidden', i !== n);
    }
    // Stepper: 4-й шаг — success, скрываем стрелочки прогресса
    q('#fp-steps-track')?.classList.toggle('hidden', n === 4);
    for (let i = 1; i <= 3; i++) {
      const c = q(`#fp-circle-${i}`);
      if (!c) continue;
      c.classList.remove('active', 'done');
      if (i < n) {
        c.classList.add('done');
        c.innerHTML = '<i class="ph ph-check" style="font-size:.875rem;"></i>';
      } else {
        c.textContent = String(i);
        if (i === n) c.classList.add('active');
      }
      const line = q(`#fp-line-${i}`);
      if (line) line.classList.toggle('done', i < n);
    }
    // Кнопки footer'а перекраиваются под шаг.
    const next   = q('#btn-fp-next');
    const back   = q('#btn-fp-back');
    const cancel = q('#btn-fp-cancel');
    const nextTx = q('#btn-fp-next-text');
    if (back)   back.style.display   = (n === 2 || n === 3) ? '' : 'none';
    if (cancel) cancel.style.display = (n === 4) ? 'none' : '';
    if (next) {
      if (n === 4) {
        if (nextTx) { nextTx.textContent = t('auth.forgot.success_btn') || 'Войти'; nextTx.setAttribute('data-i18n', 'auth.forgot.success_btn'); }
      } else if (n === 3) {
        if (nextTx) { nextTx.textContent = t('auth.forgot.submit') || 'Сменить пароль'; nextTx.setAttribute('data-i18n', 'auth.forgot.submit'); }
      } else {
        if (nextTx) { nextTx.textContent = t('common.next') || 'Далее'; nextTx.setAttribute('data-i18n', 'common.next'); }
      }
    }
    // Recompute form-guard на новом шаге — required fields разные.
    if (typeof fpGuard !== 'undefined') fpGuard?.refresh?.();
  }

  function fpSetResendCountdown(seconds) {
    const btnRes  = q('#btn-fp-resend');
    const waitEl  = q('#fp-resend-wait');
    const cntEl   = q('#fp-resend-countdown');
    if (fpResendTimer) { clearInterval(fpResendTimer); fpResendTimer = null; }
    if (seconds <= 0) {
      if (waitEl) waitEl.classList.add('hidden');
      if (btnRes) btnRes.style.display = '';
      return;
    }
    if (waitEl) waitEl.classList.remove('hidden');
    if (btnRes) btnRes.style.display = 'none';
    if (cntEl)  cntEl.textContent = String(seconds);
    fpResendTimer = setInterval(() => {
      seconds -= 1;
      if (cntEl) cntEl.textContent = String(seconds);
      if (seconds <= 0) {
        clearInterval(fpResendTimer);
        fpResendTimer = null;
        if (waitEl) waitEl.classList.add('hidden');
        if (btnRes) btnRes.style.display = '';
      }
    }, 1000);
  }

  function showForgotCard(mode = 'password') {
    fpMode = mode;
    q('#step-password')?.classList.add('hidden');
    q('#step-pin')?.classList.add('hidden');
    q('#step-forgot')?.classList.remove('hidden');
    fpHideAllAlerts();
    clearFieldError('err-forgot-contact');
    fpContact = '';
    fpCodeInputs.forEach(i => { i.value = ''; i.classList.remove('filled', 'error'); });
    fpPinInputs.forEach(i  => { i.value = ''; i.classList.remove('filled', 'error'); });
    fpPin2Inputs.forEach(i => { i.value = ''; i.classList.remove('filled', 'error'); });
    const pwd  = q('#forgot-pwd');  if (pwd)  pwd.value  = '';
    const pwd2 = q('#forgot-pwd2'); if (pwd2) pwd2.value = '';
    q('#fp-strength').style.display = 'none';
    // Подставляем title/subtitle и панель в зависимости от режима.
    const titleEl    = q('#step-forgot .auth-title');
    const subtitleEl = q('#step-forgot .auth-subtitle');
    if (mode === 'pin') {
      if (titleEl)    { titleEl.textContent    = t('auth.forgot.pin_title'); titleEl.setAttribute('data-i18n', 'auth.forgot.pin_title'); }
      if (subtitleEl) { subtitleEl.textContent = t('auth.forgot.pin_subtitle'); subtitleEl.setAttribute('data-i18n', 'auth.forgot.pin_subtitle'); }
    } else {
      if (titleEl)    { titleEl.textContent    = t('auth.forgot.title'); titleEl.setAttribute('data-i18n', 'auth.forgot.title'); }
      if (subtitleEl) { subtitleEl.textContent = t('auth.forgot.subtitle'); subtitleEl.setAttribute('data-i18n', 'auth.forgot.subtitle'); }
    }
    // Step-3 панели: показываем нужную. У .hidden !important — поэтому
    // снимаем/ставим класс, а не только style.display.
    const pwdPanel = q('#fp-step-3-pwd');
    const pinPanel = q('#fp-step-3-pin');
    if (pwdPanel) {
      pwdPanel.classList.toggle('hidden', mode === 'pin');
      pwdPanel.style.display = mode === 'pin' ? 'none' : 'flex';
    }
    if (pinPanel) {
      pinPanel.classList.toggle('hidden', mode !== 'pin');
      pinPanel.style.display = mode === 'pin' ? 'flex' : 'none';
    }
    const contactEl = q('#forgot-contact');
    if (contactEl) {
      const prefilled = q('#contact')?.value?.trim();
      contactEl.value = prefilled || '';
      setTimeout(() => contactEl.focus(), 50);
    }
    fpSetStep(1);
  }

  function hideForgotCard() {
    q('#step-forgot')?.classList.add('hidden');
    q('#step-password')?.classList.remove('hidden');
    if (fpResendTimer) { clearInterval(fpResendTimer); fpResendTimer = null; }
  }

  q('#open-forgot')?.addEventListener('click', (e) => {
    e.preventDefault();
    showForgotCard('password');
  });
  q('#open-forgot-pin')?.addEventListener('click', (e) => {
    e.preventDefault();
    showForgotCard('pin');
  });
  q('#btn-fp-cancel')?.addEventListener('click', hideForgotCard);
  q('#btn-fp-back')?.addEventListener('click', () => {
    if (fpStep === 3)      fpSetStep(2);
    else if (fpStep === 2) fpSetStep(1);
  });

  // Form-guard для «Далее» в forgot wizard. На каждом шаге своё условие:
  //   step 1 — введён контакт
  //   step 2 — все 6 цифр кода заполнены
  //   step 3 (mode=password) — оба поля пароля непустые
  //   step 3 (mode=pin)      — оба PIN-инпута заполнены (12 цифр)
  //   step 4 — success, кнопка всё равно скрыта
  const fpGuard = wireFormGuard({
    button:   '#btn-fp-next',
    required: [{
      kind:  'fn',
      watch: ['#forgot-contact', '.forgot-code-input',
              '#forgot-pwd', '#forgot-pwd2',
              '.fp-pin-new', '.fp-pin-confirm'],
      fn: () => {
        if (fpStep === 1) return !!q('#forgot-contact')?.value.trim();
        if (fpStep === 2) return joinDigits(fpCodeInputs).length === 6;
        if (fpStep === 3) {
          if (fpMode === 'pin') {
            return joinDigits(fpPinInputs).length === 6 && joinDigits(fpPin2Inputs).length === 6;
          }
          return !!q('#forgot-pwd')?.value && !!q('#forgot-pwd2')?.value;
        }
        return true;
      },
    }],
  });
  // Глобальный refresh — вызывается при смене шага / mode.
  const fpRefreshGuard = () => fpGuard?.refresh?.();

  // Wire 6-значные code-инпуты (стандартный auto-advance / backspace / paste).
  wireDigitBoxes(fpCodeInputs);
  // То же для двух PIN-групп шага 3 (режим pin).
  wireDigitBoxes(fpPinInputs);
  wireDigitBoxes(fpPin2Inputs);
  // Авто-сабмит шага 2: как только заполнены 6 цифр — кнопка "Далее" нажимается.
  fpCodeInputs.forEach((inp, idx) => {
    if (idx === fpCodeInputs.length - 1) {
      inp.addEventListener('input', () => {
        if (inp.value && joinDigits(fpCodeInputs).length === 6 && fpStep === 2) {
          setTimeout(() => q('#btn-fp-next')?.click(), 80);
        }
      });
    }
  });

  // Password-strength meter для шага 3 (зеркало change-password modal).
  q('#forgot-pwd')?.addEventListener('input', () => {
    const pw = q('#forgot-pwd').value;
    let s = 0;
    if (pw.length >= 8)   s++;
    if (/[A-Z]/.test(pw)) s++;
    if (/[a-z]/.test(pw)) s++;
    if (/\d/.test(pw))    s++;
    const strength = Math.max(1, s);
    const wrap = q('#fp-strength');
    if (!wrap) return;
    wrap.style.display = pw ? '' : 'none';
    const bars   = wrap.querySelectorAll('.pw-bar');
    const colors = ['#ef4444', '#f59e0b', '#0d9488', '#0f766e'];
    const labels = getLang() === 'en'
      ? ['Very weak', 'Weak', 'Good', 'Strong']
      : ['Очень слабый', 'Слабый', 'Хороший', 'Надёжный'];
    bars.forEach((bar, i) => {
      const color = i < strength ? colors[strength - 1] : 'var(--clr-border)';
      bar.style.background = color;
      bar.style.backgroundColor = color;
    });
    const lbl = q('#fp-strength-label');
    if (lbl) { lbl.textContent = pw ? labels[strength - 1] : ''; lbl.style.color = colors[strength - 1]; }
  });
  // Кнопки eye-toggle для двух password-инпутов.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-toggle-pw]');
    if (!btn || !btn.closest('#step-forgot')) return;
    const inp = q('#' + btn.dataset.togglePw);
    if (!inp) return;
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    const icon = btn.querySelector('i');
    if (icon) icon.className = show ? 'ph ph-eye-slash' : 'ph ph-eye';
  });

  // Resend на шаге 2.
  q('#btn-fp-resend')?.addEventListener('click', async () => {
    if (!fpContact) return;
    hideAlert('err-fp-2');
    try {
      const data = await auth.sendCode(fpContact, 'reset_password', null, { resend: true });
      fpSetResendCountdown(Number(data?.data?.cooldown) || 60);
      fpCodeInputs.forEach(i => { i.value = ''; i.classList.remove('filled', 'error'); });
      fpCodeInputs[0]?.focus();
    } catch (err) {
      showAlertFromError('err-fp-2', 'err-fp-2-text', err);
    }
  });

  // Главная кнопка "Далее" — диспатчер по шагам.
  async function fpNext() {
    if (fpStep === 1) {
      const contact = q('#forgot-contact')?.value?.trim() || '';
      hideAlert('err-fp-1');
      clearFieldError('err-forgot-contact');
      if (!contact) {
        showFieldError('err-forgot-contact', 'errors.validation.missing_fields');
        return;
      }
      const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact);
      const isPhone = /^\+?[0-9\s\-\(\)\.]{7,20}$/.test(contact);
      if (!isEmail && !isPhone) {
        showFieldError('err-forgot-contact', 'errors.validation.invalid_contact_format');
        return;
      }

      const btn = q('#btn-fp-next');
      setLoading(btn, true);
      try {
        const data = await auth.sendCode(contact, 'reset_password');
        fpContact = contact;
        const masked = isEmail
          ? contact.replace(/(.{1,2})(.*)(@.*)/, (_, a, b, c) => a + '*'.repeat(Math.max(1, b.length)) + c)
          : contact.replace(/(.{0,3})(.*)(.{2})/, (_, a, b, c) => a + '*'.repeat(Math.max(1, b.length)) + c);
        const tgtEl = q('#forgot-target-mask');
        if (tgtEl) tgtEl.textContent = masked;
        fpSetStep(2);
        fpSetResendCountdown(Number(data?.data?.cooldown) || 60);
        setTimeout(() => fpCodeInputs[0]?.focus(), 80);
      } catch (err) {
        showAlertFromError('err-fp-1', 'err-fp-1-text', err);
      } finally {
        setLoading(btn, false);
      }
      return;
    }

    if (fpStep === 2) {
      // Перед переходом на шаг 3 проверяем код через reset-verify-code:
      // он НЕ потребляет код (шаг 3 это сделает при финальном submit),
      // но инкрементит failed_attempts на miss — bruteforce ограничен 5
      // попытками. Иначе юзер мог бы пройти весь мастер с фиктивным
      // кодом, что плохо UX-wise.
      const code = joinDigits(fpCodeInputs);
      if (code.length !== 6) {
        showAlertKey('err-fp-2', 'err-fp-2-text', 'errors.validation.missing_fields');
        return;
      }
      hideAlert('err-fp-2');
      const btn = q('#btn-fp-next');
      setLoading(btn, true);
      try {
        await auth.resetVerifyCode(fpContact, code);
        fpSetStep(3);
        setTimeout(() => {
          if (fpMode === 'pin') document.querySelectorAll('.fp-pin-new')[0]?.focus();
          else q('#forgot-pwd')?.focus();
        }, 80);
      } catch (err) {
        const params = err?.data?.error_params || {};
        const key    = err?.error_key;
        if (key === 'errors.verification.code_invalid' && typeof params.attempts_remaining === 'number') {
          showAlertWithParams('err-fp-2', 'err-fp-2-text',
            'errors.verification.code_invalid_with_attempts',
            { n: params.attempts_remaining });
        } else {
          showAlertFromError('err-fp-2', 'err-fp-2-text', err);
        }
        fpCodeInputs.forEach(i => { i.classList.add('error'); });
        fpCodeInputs[0]?.focus();
      } finally {
        setLoading(btn, false);
      }
      return;
    }

    if (fpStep === 3) {
      const code = joinDigits(fpCodeInputs);
      hideAlert('err-fp-3');
      const btn = q('#btn-fp-next');

      if (fpMode === 'pin') {
        const pin  = joinDigits(fpPinInputs);
        const pin2 = joinDigits(fpPin2Inputs);
        clearFieldError('err-fp-pin');
        clearFieldError('err-fp-pin2');
        if (!/^\d{6}$/.test(pin)) {
          showFieldError('err-fp-pin', 'errors.validation.pin_invalid_format');
          return;
        }
        if (pin !== pin2) {
          showFieldError('err-fp-pin2', 'errors.validation.pin_mismatch');
          return;
        }
        setLoading(btn, true);
        try {
          await auth.resetPin({
            target: fpContact, code,
            new_pin: pin, new_pin_confirm: pin2,
          });
          fpSetStep(4);
        } catch (err) {
          showAlertFromError('err-fp-3', 'err-fp-3-text', err);
          if (err?.error_key === 'errors.verification.code_invalid' ||
              err?.error_key === 'errors.verification.code_not_found') {
            fpCodeInputs.forEach(i => { i.value = ''; i.classList.remove('filled'); i.classList.add('error'); });
            fpSetStep(2);
            setTimeout(() => fpCodeInputs[0]?.focus(), 80);
            showAlertKey('err-fp-2', 'err-fp-2-text', 'errors.verification.code_invalid');
          }
        } finally {
          setLoading(btn, false);
        }
        return;
      }

      // mode === 'password'
      const pwd  = q('#forgot-pwd')?.value  || '';
      const pwd2 = q('#forgot-pwd2')?.value || '';
      clearFieldError('err-fp-pwd');
      clearFieldError('err-fp-pwd2');

      if (pwd.length < 8 || !/[A-Z]/.test(pwd) || !/[a-z]/.test(pwd) || !/\d/.test(pwd)) {
        showFieldError('err-fp-pwd', 'errors.validation.password_requirements');
        return;
      }
      if (pwd !== pwd2) {
        showFieldError('err-fp-pwd2', 'errors.validation.passwords_mismatch');
        return;
      }

      setLoading(btn, true);
      try {
        await auth.resetPassword({
          target: fpContact, code,
          new_password: pwd, new_password_confirm: pwd2,
        });
        fpSetStep(4);
      } catch (err) {
        showAlertFromError('err-fp-3', 'err-fp-3-text', err);
        if (err?.error_key === 'errors.verification.code_invalid' ||
            err?.error_key === 'errors.verification.code_not_found') {
          fpCodeInputs.forEach(i => { i.value = ''; i.classList.remove('filled'); i.classList.add('error'); });
          fpSetStep(2);
          setTimeout(() => fpCodeInputs[0]?.focus(), 80);
          showAlertKey('err-fp-2', 'err-fp-2-text', 'errors.verification.code_invalid');
        }
      } finally {
        setLoading(btn, false);
      }
      return;
    }

    if (fpStep === 4) {
      // Готово — возвращаемся к login со заполненным контактом.
      const lc = q('#contact');
      if (lc) lc.value = fpContact;
      hideForgotCard();
      toast(t(fpMode === 'pin' ? 'auth.forgot.pin_success_toast' : 'auth.forgot.success_toast'), 'ok');
    }
  }
  q('#btn-fp-next')?.addEventListener('click', fpNext);
  // Helper: clear field-error span by id.
  function clearFieldError(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('show');
    const span = el.querySelector('span');
    if (span) span.textContent = '';
  }

})().catch(err => {
  console.error('[login] Fatal initialization error:', err);
});
