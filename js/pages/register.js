/* ═══════════════════════════════════════════════════════════════
   REMS — Registration wizard
   Step 1: contact + role + (owner: org name | other: org id)
   Step 2: 6-digit email/SMS verification code
   Step 3: full_name, department?, password, password_confirm, pin?
   Step 4: success

   Backend contract:
     POST /api/auth/code     { target, type, purpose, organization_id? }
     POST /api/auth/verify   { target, code, purpose }
     POST /api/auth/register { ...payload }

   The /api/auth/code endpoint performs eager validation on step 1
   (contact-not-registered, org existence/active/capacity), so the user
   never gets past step 1 with a fundamentally broken input.

   NOTE: Uses async IIFE instead of top-level await for maximum
   browser compatibility (avoids issues with older Chromium builds).
   ═══════════════════════════════════════════════════════════════ */

import { auth }                              from '../api.js';
import { requireGuest, toast, errorMessage } from '../auth.js';
import { t, initI18n, getLang, onLangChange, applyTranslations } from '../i18n.js';
import { wireFormGuard }                     from '../form-guard.js';
import { createCodeInput }                   from '../lib/code-input.js';
import { grantPinPass }                      from '../lib/pin-gate.js';

// ── Hoisted helpers ─────────────────────────────────────────────
function q(sel) { return document.querySelector(sel); }

function setLoading(btn, on) {
  if (!btn) return;
  btn.disabled = on;
  btn.classList.toggle('btn-loading', on);
}

function getCodeValue() {
  return [...document.querySelectorAll('.code-input')].map(i => i.value).join('');
}
function getRegPinValue() {
  return [...document.querySelectorAll('#reg-pin-inputs .pin-input')].map(i => i.value).join('');
}

function isValidContact(val) {
  // Mirrors backend/src/lib/auth-helpers.ts → detectContactType so the
  // client doesn't pass shorter-than-real-life phones (e.g. "+7996531")
  // that the backend would accept here but reject later.
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const phoneRe = /^\+?\d{10,15}$/;
  return emailRe.test(val) || phoneRe.test(val.replace(/[\s\-().]/g, ''));
}
function isStrongPassword(pw) {
  return pw.length >= 8 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /\d/.test(pw);
}
function calcStrength(pw) {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 8)    s++;
  if (/[A-Z]/.test(pw))  s++;
  if (/[a-z]/.test(pw))  s++;
  if (/\d/.test(pw))     s++;
  return Math.max(1, s);
}

// ── Error / alert helpers (i18n-friendly) ───────────────────────
// All visible error text is rendered through an i18n KEY stored on the
// element's data-i18n attribute, so applyTranslations() re-translates
// them automatically when the user switches language.

function clearAllErrors() {
  document.querySelectorAll('.form-error').forEach(el => {
    el.classList.remove('show');
    const span = el.querySelector('span');
    if (span) { span.removeAttribute('data-i18n'); span.textContent = ''; }
  });
  document.querySelectorAll('.form-input.error').forEach(el => el.classList.remove('error'));
  document.querySelectorAll('.alert').forEach(el => {
    el.classList.remove('show');
    const txt = el.querySelector('[id^="err-"][id$="-text"]');
    if (txt) { txt.removeAttribute('data-i18n'); txt.textContent = ''; }
  });
}
function clearFieldError(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('show');
  const span = el.querySelector('span');
  if (span) { span.removeAttribute('data-i18n'); span.textContent = ''; }
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
}

// ─────────────────────────────────────────────────────────────────
// BOOT — async IIFE (no top-level await: works in all ES-module
// browsers including older Chromium/Safari builds)
// ─────────────────────────────────────────────────────────────────
(async () => {
  try { await initI18n(); } catch (e) { console.error('[register] i18n failed:', e); }

  if (!requireGuest()) return;   // already logged in — bail out before touching UI

  // Re-translate visible alerts/field-errors when language changes.
  onLangChange(() => applyTranslations());

  // ── Wizard state ─────────────────────────────────────────────
  let currentStep  = 1;
  let selectedRole = null;

  const state = {
    contact:           '',
    role:              '',
    organization_name: '',
    organization_id:   null,
    // Если регистрация инициирована переходом по invite-ссылке —
    // сохраняем токен. На финальном submit отправим его (если контакт
    // совпадает с приглашённым), backend сам решит auto-accept vs pending.
    invite_token:      '',
    invite_contact:    '',   // sentinel — оригинальный контакт инвайта
  };

  // ── Invite-token предзаполнение ───────────────────────────────
  // URL вида /register?invite=<hex32+>. Дёргаем мета-эндпоинт: если ok →
  // показываем trust-block с инфо орг + force role=employee + pre-fill
  // email (но НЕ readonly). Если юзер поменяет email на свой → вернёмся
  // в обычный режим регистрации (с ролями + org-name/org-id полями).
  let inviteMeta = null;
  try {
    const inviteToken = new URLSearchParams(location.search).get('invite');
    if (inviteToken && /^[a-f0-9]{32,128}$/i.test(inviteToken)) {
      const metaResp = await fetch(`/api/auth/invite/${encodeURIComponent(inviteToken)}`, {
        headers: { 'X-Device-Id': await (await import('../api.js')).getDeviceId() },
      });
      if (metaResp.ok) {
        inviteMeta = (await metaResp.json())?.data;
        if (inviteMeta?.organization_id) {
          state.invite_token   = inviteToken;
          state.invite_contact = String(inviteMeta.contact_raw || '').toLowerCase().trim();
          // ── Trust-block: orgs/role info ──────────────────────
          const trustEl   = q('#invite-trust');
          const orgEl     = q('#invite-trust-org');
          const orgIdEl   = q('#invite-trust-org-id');
          const logoEl    = q('#invite-trust-logo');
          if (orgEl)   orgEl.textContent   = inviteMeta.organization_name || '—';
          if (orgIdEl) orgIdEl.textContent = String(inviteMeta.organization_id);
          if (logoEl && inviteMeta.organization_logo) {
            logoEl.innerHTML = `<img src="${inviteMeta.organization_logo}" alt="" style="width:100%; height:100%; object-fit:cover;">`;
          }
          if (trustEl) { trustEl.classList.remove('hidden'); trustEl.style.display = 'block'; }
          // Pre-fill контакт (EDITABLE — юзер может поменять).
          const contactInput = q('#reg-contact');
          if (contactInput) contactInput.value = inviteMeta.contact_raw || '';
          enterInviteMode();
        }
      }
    }
  } catch (e) {
    console.warn('[register] invite meta fetch failed:', e);
  }

  // Переход в invite-mode: скрываем role-grid (роль = employee) + поля
  // org-name/org-id (значения зафиксированы invite-токеном).
  function enterInviteMode() {
    state.role = 'employee';
    selectedRole = 'employee';
    state.organization_id = inviteMeta ? Number(inviteMeta.organization_id) : null;
    // Force-check radio + dispatch change → запускает существующий
    // listener (он апдейтит selectedRole, .selected class'ы и т.д.).
    const employeeRadio = document.querySelector('input[name="role"][value="employee"]');
    if (employeeRadio) {
      employeeRadio.checked = true;
      employeeRadio.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // #org-id — programmatic fill + input event для form-guard.
    const orgIdInput = document.querySelector('#org-id');
    if (orgIdInput && inviteMeta) {
      orgIdInput.value = String(inviteMeta.organization_id);
      orgIdInput.dispatchEvent(new Event('input',  { bubbles: true }));
      orgIdInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // #reg-contact pre-filled выше — дёрнем input event на случай если
    // form-guard ещё не инициализирован и пропустит первичный refresh.
    document.querySelector('#reg-contact')?.dispatchEvent(new Event('input', { bubbles: true }));
    // Подсветка employee-card.
    document.querySelectorAll('.role-card').forEach(card => {
      const r = card.querySelector('input[name="role"]');
      card.classList.toggle('selected', !!r?.checked);
    });
    // Скрываем role-section + org-name/org-id form-groups.
    const roleSection = document.querySelector('.role-grid')?.closest('.form-group');
    if (roleSection)     roleSection.classList.add('hidden');
    document.querySelector('#org-name-group')?.classList.add('hidden');
    document.querySelector('#org-id-group')?.classList.add('hidden');
    document.querySelector('#invite-mismatch')?.classList.add('hidden');
    document.querySelector('#invite-mismatch')?.style.setProperty('display', 'none');
    // Form-guard refresh — может ещё не быть инициализирован, поэтому
    // дёргаем и через task queue (после init), и сразу.
    if (typeof guardStep1 !== 'undefined') guardStep1?.refresh?.();
    setTimeout(() => guardStep1?.refresh?.(), 0);
  }

  // Выход из invite-mode: юзер поменял email на не-совпадающий → ведём
  // как обычную регистрацию (с выбором роли + полями org). КРИТИЧНО:
  // снять `hidden` со ВСЕХ form-group-ов которые мы прятали в enterInviteMode
  // (role-grid, org-name-group, org-id-group), иначе они остаются невидимы
  // и юзер не может выбрать роль/ввести org_id → Next залочена form-guard'ом.
  function exitInviteMode() {
    state.invite_contact = '';
    state.role = '';
    selectedRole = null;
    state.organization_id = null;
    document.querySelectorAll('input[name="role"]').forEach(r => { r.checked = false; });
    document.querySelectorAll('.role-card').forEach(c => c.classList.remove('selected'));
    const roleSection = document.querySelector('.role-grid')?.closest('.form-group');
    if (roleSection) roleSection.classList.remove('hidden');
    // Возвращаем поля org. ROLE-listener (см. ниже) включит нужное из
    // двух (#org-name-group или #org-id-group) в зависимости от выбранной
    // роли; пока селектор пустой — пусть оба будут не-hidden, чтобы
    // юзер сразу видел потенциальные поля.
    const orgNameGrp = document.getElementById('org-name-group');
    const orgIdGrp   = document.getElementById('org-id-group');
    if (orgNameGrp) { orgNameGrp.classList.remove('hidden'); orgNameGrp.style.display = 'none'; }
    if (orgIdGrp)   { orgIdGrp.classList.remove('hidden');   orgIdGrp.style.display   = 'none'; }
    // Сбрасываем pre-filled org-id (был от инвайта, теперь не релевантен).
    const orgIdInput = document.querySelector('#org-id');
    if (orgIdInput) {
      orgIdInput.value = '';
      orgIdInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    document.querySelector('#invite-trust')?.classList.add('hidden');
    document.querySelector('#invite-trust')?.style.setProperty('display', 'none');
    document.querySelector('#invite-mismatch')?.classList.remove('hidden');
    document.querySelector('#invite-mismatch')?.style.setProperty('display', 'flex');
    setTimeout(() => guardStep1?.refresh?.(), 0);
  }

  // Listener на email: если в invite-mode и юзер поменял на не-совпадающий —
  // переходим в regular. Если потом ввёл обратно совпадение — возвращаемся в invite.
  document.querySelector('#reg-contact')?.addEventListener('input', () => {
    if (!inviteMeta) return;
    const current = String(document.querySelector('#reg-contact')?.value || '')
      .toLowerCase().trim().replace(/[\s\-().]/g, '');
    const expected = String(inviteMeta.contact_raw || '')
      .toLowerCase().trim().replace(/[\s\-().]/g, '');
    const inInvite = !document.querySelector('#invite-trust')?.classList.contains('hidden');
    if (current === expected && !inInvite) {
      // Вернули правильный контакт → invite-mode снова.
      document.querySelector('#invite-trust')?.classList.remove('hidden');
      document.querySelector('#invite-trust')?.style.setProperty('display', 'block');
      enterInviteMode();
    } else if (current !== expected && inInvite) {
      exitInviteMode();
    }
  });

  // ── Code-input controller (step 2) ───────────────────────────
  // The wiring (auto-advance, paste, backspace, resend countdown)
  // lives in lib/code-input.js so registration, change-password
  // and change-contact all behave identically.
  const codeCtl = createCodeInput({
    inputs:        '.code-input',
    resendButton:  '#btn-resend',
    resendWait:    '#resend-wait',
    resendCounter: '#resend-countdown',
    onChange: () => {
      hideAlert('err-step2');
      const btn2 = q('#btn-step2');
      const val  = codeCtl.read();
      if (btn2) btn2.disabled = val.length < 6;
      // Auto-submit on 6th digit (preserves the existing UX).
      if (val.length === 6) btn2?.click();
    },
  });

  // ── Step navigation ──────────────────────────────────────────
  function goStep(n) {
    currentStep = n;
    for (let i = 1; i <= 4; i++) {
      q(`#step-${i}`)?.classList.toggle('hidden', i !== n);

      const circle = q(`#step-circle-${i}`);
      if (!circle) continue;
      circle.classList.remove('active', 'done');

      if (i < n) {
        circle.classList.add('done');
        circle.innerHTML = '<i class="ph ph-check" style="font-size:.875rem;"></i>';
      } else {
        circle.textContent = String(i);
        if (i === n) circle.classList.add('active');
      }

      const line = q(`#step-line-${i}`);
      if (line) line.classList.toggle('done', i < n);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // ROLE SELECTION — owner (creates a new org) vs employee (joins an
  // existing org by ID). The fine-grained manager / technician roles
  // from earlier drafts are gone; assignment of specific responsibility
  // for a request happens through the request itself, not the user row.
  // ─────────────────────────────────────────────────────────────
  document.querySelectorAll('input[name="role"]').forEach(radio => {
    radio.addEventListener('change', () => {
      selectedRole = radio.value;

      // Explicit .selected class — guaranteed in all browsers
      document.querySelectorAll('.role-card').forEach(card => {
        const r = card.querySelector('input[name="role"]');
        card.classList.toggle('selected', !!r?.checked);
      });

      const orgNameGrp = document.getElementById('org-name-group');
      const orgIdGrp   = document.getElementById('org-id-group');
      if (orgNameGrp) orgNameGrp.style.display = selectedRole === 'owner' ? '' : 'none';
      if (orgIdGrp)   orgIdGrp.style.display   = selectedRole === 'owner' ? 'none' : '';

      clearFieldError('err-role');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // VISUAL FORM-GUARDS — gray-out the CTA until required fields look
  // filled. Click is still allowed (real validation lives in the click
  // handlers), this is purely a visual "pending" cue.
  // ─────────────────────────────────────────────────────────────
  const guardStep1 = wireFormGuard({
    button:   '#btn-step1',
    required: [
      { sel: '#reg-contact',          kind: 'text' },
      { sel: 'input[name="role"]',    kind: 'radio-group' },
      // Conditional: owner needs org-name. Для employee org-id
      // ОПЦИОНАЛЕН — guard пропускает дальше даже с пустым полем
      // (юзер заявит из solo home позже). Если введён — проверяем
      // что валидное число.
      {
        kind:  'fn',
        watch: ['#org-name', '#org-id', 'input[name="role"]'],
        fn: () => {
          const role = document.querySelector('input[name="role"]:checked')?.value;
          if (!role) return false;
          if (role === 'owner') {
            return !!document.querySelector('#org-name')?.value.trim();
          }
          const v = document.querySelector('#org-id')?.value.trim();
          if (!v) return true;   // пусто — solo-режим, OK
          const n = parseInt(v, 10);
          return Number.isFinite(n) && n > 0;
        },
      },
    ],
  });

  const guardStep3 = wireFormGuard({
    button:   '#btn-step3',
    required: [
      { sel: '#reg-name',      kind: 'text' },
      { sel: '#reg-password',  kind: 'text' },
      { sel: '#reg-password2', kind: 'text' },
      { sel: '#reg-pin-inputs .pin-input', kind: 'digit-group', total: 6 },
    ],
  });

  // ─────────────────────────────────────────────────────────────
  // STEP 1 — Validate inputs, then ask backend to issue a code.
  // Backend performs all heavy checks (contact-already-registered,
  // org-exists/active/has-capacity) so step 1 stops the user before
  // step 2 if anything is wrong.
  // ─────────────────────────────────────────────────────────────
  q('#btn-step1')?.addEventListener('click', async () => {
    clearAllErrors();

    const contact = q('#reg-contact')?.value.trim() ?? '';
    let valid = true;

    if (!contact) {
      showFieldError('err-contact', 'errors.required');
      valid = false;
    } else if (!isValidContact(contact)) {
      showFieldError('err-contact', 'errors.invalid_contact');
      valid = false;
    }

    if (!selectedRole) {
      showFieldError('err-role', 'errors.select_role');
      valid = false;
    }

    if (selectedRole === 'owner') {
      const orgName = q('#org-name')?.value.trim() ?? '';
      if (!orgName) {
        showFieldError('err-org-name', 'errors.required');
        valid = false;
      } else {
        state.organization_name = orgName;
        state.organization_id   = null;
      }
    } else if (selectedRole) {
      // Org ID НЕОБЯЗАТЕЛЕН. Пусто → юзер регистрируется как solo
      // (без orga); может подать заявку позже из solo home. Если
      // заполнено — валидируем как число > 0.
      const orgIdRaw = q('#org-id')?.value.trim() ?? '';
      if (!orgIdRaw) {
        state.organization_name = '';
        state.organization_id   = null;
      } else {
        const orgIdNum = parseInt(orgIdRaw, 10);
        if (!Number.isFinite(orgIdNum) || orgIdNum < 1) {
          showFieldError('err-org-id', 'errors.validation.invalid_id');
          valid = false;
        } else {
          state.organization_name = '';
          state.organization_id   = orgIdNum;
        }
      }
    }

    if (!valid) return;

    state.contact = contact;
    state.role    = selectedRole;

    const btn = q('#btn-step1');
    setLoading(btn, true);
    try {
      const resp = await auth.sendCode(contact, 'register', state.organization_id);
      const display = q('#contact-display');
      if (display) display.textContent = contact;
      goStep(2);

      // Backend differentiates a freshly issued code from a re-use of an
      // existing in-flight code (when the user goes back to step 1 and
      // forward again within the cooldown window).
      //   reused=true  → tell the user to use the code already sent
      //   reused=false → tell the user a fresh code was sent (and clear
      //                  any stale digits in the inputs)
      const reused   = resp?.data?.reused === true;
      // cooldown=0 валиден (живой код реюзнут после кулдауна) — || 60 нельзя.
      const cooldownRaw = Number(resp?.data?.cooldown);
      codeCtl.startResendTimer(Number.isFinite(cooldownRaw) ? cooldownRaw : 60);

      if (reused) {
        toast(t('auth.register.code_use_existing'), 'info');
      } else {
        // Clear any leftover digits from a previous code-entry attempt
        document.querySelectorAll('.code-input').forEach(i => {
          i.value = '';
          i.classList.remove('error', 'filled');
        });
        const btn2 = q('#btn-step2');
        if (btn2) btn2.disabled = true;
      }

      setTimeout(() => document.querySelector('.code-input')?.focus(), 80);
    } catch (err) {
      // Map specific backend errors to the matching field instead of a generic alert.
      if (err?.error_key === 'errors.contact_already_registered' ||
          err?.error_key === 'errors.email_already_registered'   ||
          err?.error_key === 'errors.phone_already_registered') {
        showFieldError('err-contact', err.error_key);
        return;
      }
      if (err?.error_key === 'errors.organization.not_found'   ||
          err?.error_key === 'errors.organization.inactive'    ||
          err?.error_key === 'errors.organization.employee_limit_reached') {
        showFieldError('err-org-id', err.error_key);
        return;
      }
      showAlertFromError('err-step1', 'err-step1-text', err);
    } finally {
      setLoading(btn, false);
    }
  });

  // ─────────────────────────────────────────────────────────────
  // STEP 2 — Verification code (inputs + resend wired by codeCtl)
  // ─────────────────────────────────────────────────────────────
  q('#btn-step2')?.addEventListener('click', async () => {
    const code = codeCtl.read();
    if (code.length < 6) return;

    hideAlert('err-step2');
    const btn = q('#btn-step2');
    setLoading(btn, true);
    try {
      await auth.verifyCode(state.contact, code);
      goStep(3);
      setTimeout(() => q('#reg-name')?.focus(), 80);
    } catch (err) {
      showAlertFromError('err-step2', 'err-step2-text', err);
      document.querySelectorAll('.code-input').forEach(i => i.classList.add('error'));
      if (btn) btn.disabled = false;
      codeCtl.focus();
    } finally {
      setLoading(btn, false);
    }
  });

  q('#btn-back-step1')?.addEventListener('click', () => { codeCtl.stopResendTimer(); goStep(1); });

  // Resend code (step 2)
  q('#btn-resend')?.addEventListener('click', async () => {
    hideAlert('err-step2');
    try {
      const resp = await auth.sendCode(state.contact, 'register', state.organization_id, { resend: true });
      const cooldown = Number(resp?.data?.cooldown) || 60;
      codeCtl.startResendTimer(cooldown);
      // If backend reused the existing code (shouldn't normally happen on
      // resend because UI disables the button during cooldown, but defensive),
      // tell the user; otherwise show a "code resent" confirmation.
      if (resp?.data?.reused) {
        toast(t('auth.register.code_use_existing'), 'info');
      } else {
        toast(t('auth.register.code_resend') + '…', 'ok');
        codeCtl.clear();
        codeCtl.focus();
        const btn2 = q('#btn-step2');
        if (btn2) btn2.disabled = true;
      }
    } catch (err) {
      showAlertFromError('err-step2', 'err-step2-text', err);
    }
  });

  // ─────────────────────────────────────────────────────────────
  // STEP 3 — Personal info & finish
  // ─────────────────────────────────────────────────────────────

  // Password visibility toggle — обе кнопки (новый + повтор)
  // через единый паттерн «найди соседний input в .input-wrap».
  function wirePwToggle(btnId, inputId) {
    const btn = q('#' + btnId);
    const inp = q('#' + inputId);
    if (!btn || !inp) return;
    btn.addEventListener('click', () => {
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      const icon = btn.querySelector('i');
      if (icon) icon.className = show ? 'ph ph-eye-slash' : 'ph ph-eye';
    });
  }
  wirePwToggle('toggle-reg-pw',  'reg-password');
  wirePwToggle('toggle-reg-pw2', 'reg-password2');

  // Password strength bar
  q('#reg-password')?.addEventListener('input', () => {
    const pw       = q('#reg-password')?.value ?? '';
    const strength = calcStrength(pw);
    const bars     = document.querySelectorAll('.pw-bar');
    const colors   = ['#ef4444', '#f59e0b', '#0d9488', '#0f766e'];
    const labels_ru = ['Очень слабый', 'Слабый', 'Хороший', 'Надёжный'];
    const labels_en = ['Very weak', 'Weak', 'Good', 'Strong'];
    const labels    = getLang() === 'en' ? labels_en : labels_ru;

    const strengthEl = q('#pw-strength');
    if (strengthEl) strengthEl.style.display = pw ? '' : 'none';
    bars.forEach((bar, i) => {
      bar.style.background = i < strength ? colors[strength - 1] : 'var(--clr-border)';
    });
    const lbl = q('#pw-strength-label');
    if (lbl) { lbl.textContent = pw ? labels[strength - 1] : ''; lbl.style.color = colors[strength - 1]; }
  });

  // PIN inputs in step 3 (PIN is OPTIONAL)
  document.querySelectorAll('#reg-pin-inputs .pin-input').forEach((input, idx, all) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/, '').slice(0, 1);
      input.classList.toggle('filled', !!input.value);
      if (input.value && idx < all.length - 1) all[idx + 1].focus();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value && idx > 0) {
        all[idx - 1].focus();
        all[idx - 1].value = '';
        all[idx - 1].classList.remove('filled');
      }
    });
  });

  q('#btn-back-step2')?.addEventListener('click', () => goStep(2));

  q('#btn-step3')?.addEventListener('click', async () => {
    clearAllErrors();

    const fullName  = q('#reg-name')?.value.trim()  ?? '';
    const dept      = q('#reg-dept')?.value.trim()   ?? '';
    const password  = q('#reg-password')?.value      ?? '';
    const password2 = q('#reg-password2')?.value     ?? '';
    const pin       = getRegPinValue();
    let valid = true;

    if (!fullName) {
      showFieldError('err-name', 'errors.required');
      valid = false;
    }
    if (!password) {
      showFieldError('err-reg-password', 'errors.required');
      valid = false;
    } else if (!isStrongPassword(password)) {
      showFieldError('err-reg-password', 'errors.password_weak');
      valid = false;
    }
    if (!password2) {
      showFieldError('err-reg-password2', 'errors.required');
      valid = false;
    } else if (password && password !== password2) {
      showFieldError('err-reg-password2', 'errors.password_mismatch');
      valid = false;
    }
    // PIN is required (6 digits)
    if (!pin) {
      showFieldError('err-reg-pin', 'errors.required');
      valid = false;
    } else if (pin.length !== 6) {
      showFieldError('err-reg-pin', 'errors.pin_length');
      valid = false;
    }
    if (!valid) return;

    const payload = {
      contact:          state.contact,
      full_name:        fullName,
      password,
      password_confirm: password2,
      pin,                       // 6 digits, required
      language_code:    getLang(),
    };
    if (dept) payload.department = dept;
    if (state.role === 'owner') {
      payload.organization_name = state.organization_name;
    } else if (state.organization_id) {
      // Joining an existing org: backend always assigns role=employee.
      payload.organization_id = state.organization_id;
    }

    const btn = q('#btn-step3');
    setLoading(btn, true);
    try {
      // Auto-accept by invite: если юзер пришёл по invite-ссылке и ввёл
      // ТОТ ЖЕ контакт, что был приглашён — пропускаем pending и сразу
      // создаём approved-сотрудника через accept-invite endpoint.
      // Если контакт не совпадает — обычная регистрация (pending).
      const contactNorm = String(state.contact).toLowerCase().replace(/[\s\-().]/g, '');
      const inviteNorm  = String(state.invite_contact).toLowerCase().replace(/[\s\-().]/g, '');
      const matchesInvite = state.invite_token && inviteNorm && contactNorm === inviteNorm;
      if (matchesInvite) {
        await auth.acceptInvite(state.invite_token, {
          full_name: fullName,
          password,
          password_confirm: password2,
          pin,
          language_code: getLang(),
          ...(dept && { department: dept }),
        });
      } else {
        await auth.register(payload);
      }
      grantPinPass();
      codeCtl.stopResendTimer();
      goStep(4);
    } catch (err) {
      showAlertFromError('err-step3', 'err-step3-text', err);
    } finally {
      setLoading(btn, false);
    }
  });

})().catch(err => {
  console.error('[register] Fatal initialization error:', err);
});
