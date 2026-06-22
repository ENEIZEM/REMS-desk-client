/* ═══════════════════════════════════════════════════════════════
   Change-PIN modal (#change-pin-modal) — three 6-digit groups.

   • Current PIN group is hidden when the user doesn't have a PIN
     yet (first-time set) — the form-guard treats a hidden group as
     "passed" so the save button can light up with just new+confirm.
   ═══════════════════════════════════════════════════════════════ */

import { auth, profile }          from '../../../api.js';
import { toast, errorMessage }    from '../../../auth.js';
import { t, getLang, applyTranslations } from '../../../i18n.js';
import { phoneChannelEnabled }    from '../../../config.js';
import { wireFormGuard }          from '../../../form-guard.js';
import {
  openModal, closeModal, setLoading,
  setFieldError, clearFieldErrorById,
  showAlertText, hideAlertById,
} from '../ui-helpers.js';

let _ctx = {
  getUserProfile:        () => null,
  getAvailableContacts:  () => [],
  refresh:               () => {},
};

let _guard = null;
let _guardStep1 = null;   // Guard для Next-кнопки шага 1 (proof).
let _curInputs = [];
let _newInputs = [];
let _cfmInputs = [];

// Helper: refresh обоих guard'ов (Next шага 1 + Save шага 2). Module-
// scope потому что setChpinStep тоже module-scope и должна вызывать.
function refreshBothGuards() {
  _guard?.refresh?.();
  _guardStep1?.refresh?.();
}

// State для step-up flow («забыли PIN»).
let _stepUp = {
  active: false,        // true → доказательство кодом, false → текущим PIN
  type:   null,         // 'email' | 'phone'
  target: null,         // raw value контакта
  code:   '',           // 6 цифр
  phase:  'contact',    // 'contact' (выбор+полный ввод) | 'code' (ввод кода)
  resendTimer: null,
};
let _wizardStep = 1;    // 1 = proof (current PIN или stepup), 2 = new PIN + confirm

// Переключение visible шага и кнопок в footer.
function setChpinStep(n) {
  _wizardStep = n;
  const step1Group = document.querySelector('#chpin-current-group');
  const step1Stepup = document.querySelector('#chpin-stepup-group');
  const step2     = document.querySelector('#chpin-step-2');
  const nextBtn   = document.querySelector('#btn-chpin-next');
  const saveBtn   = document.querySelector('#btn-save-pin');
  const backBtn   = document.querySelector('#btn-chpin-back');
  const isStep1   = n === 1;
  // Step 1 контролируется forgot toggle: либо current-PIN, либо step-up.
  if (step1Group)  step1Group.style.display  = isStep1 && !_stepUp.active ? '' : 'none';
  if (step1Stepup) {
    if (isStep1 && _stepUp.active) {
      step1Stepup.classList.remove('hidden');
      step1Stepup.style.display = 'flex';
    } else {
      step1Stepup.classList.add('hidden');
      step1Stepup.style.display = 'none';
    }
  }
  if (step2) {
    if (n === 2) { step2.classList.remove('hidden'); step2.style.display = 'flex'; }
    else         { step2.classList.add('hidden');    step2.style.display = 'none'; }
  }
  if (nextBtn) nextBtn.style.display = isStep1 ? '' : 'none';
  if (saveBtn) saveBtn.style.display = isStep1 ? 'none' : '';
  // Back на step 2 — назад на step 1 (восстановить proof).
  // Back на step 1 — только в forgot+phase=code (вернуться к выбору контакта).
  if (backBtn) {
    const showBack = !isStep1 || (_stepUp.active && _stepUp.phase === 'code');
    backBtn.style.display = showBack ? '' : 'none';
  }
  // Mode-tabs нужны только на шаге 1 (выбор способа доказательства).
  const modeTabs = document.querySelector('#chpin-mode-tabs');
  if (modeTabs) modeTabs.style.display = isStep1 ? '' : 'none';
  // hint в alert
  document.querySelector('#err-chpin')?.classList.remove('show');
  refreshBothGuards();
}

function wirePinGroup(rootSel) {
  const inputs = [...document.querySelectorAll(`${rootSel} .pin-input`)];
  inputs.forEach((input, idx) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/, '').slice(0, 1);
      input.classList.toggle('filled', !!input.value);
      if (input.value && idx < inputs.length - 1) inputs[idx + 1].focus();
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
      [...raw].forEach((ch, i) => { if (inputs[i]) { inputs[i].value = ch; inputs[i].classList.add('filled'); } });
      inputs[Math.min(raw.length, inputs.length) - 1]?.focus();
    });
  });
  return inputs;
}

function readDigits(inputs)  { return inputs.map(i => i.value).join(''); }
function clearDigits(inputs) { inputs.forEach(i => { i.value = ''; i.classList.remove('filled'); }); }

export function wireChangePin(ctx) {
  Object.assign(_ctx, ctx);

  // SMS выключен → контакт всегда email; убираем «+7…» из плейсхолдера
  // forgot-поля (см. [[sms-capability-flag]]).
  if (!phoneChannelEnabled()) {
    const fc = document.querySelector('#chpin-forgot-contact[data-i18n-ph]');
    if (fc) { fc.setAttribute('data-i18n-ph', 'profile.full_contact_ph_email'); applyTranslations(); }
  }

  _curInputs = wirePinGroup('#chpin-current');
  _newInputs = wirePinGroup('#chpin-new');
  _cfmInputs = wirePinGroup('#chpin-confirm');

  _guard = wireFormGuard({
    button:   '#btn-save-pin',
    required: [{
      kind:  'fn',
      watch: ['#chpin-current .pin-input', '#chpin-new .pin-input', '#chpin-confirm .pin-input', '.chpin-code-input'],
      fn: () => {
        const join = (sel) =>
          [...document.querySelectorAll(`${sel} .pin-input`)].map(i => i.value).join('');
        const newOk     = join('#chpin-new')     .length === 6;
        const confirmOk = join('#chpin-confirm') .length === 6;
        // Proof: либо текущий PIN, либо verification код, либо ничего
        // (если у юзера ещё нет PIN — первичная установка).
        const currentGroup = document.getElementById('chpin-current-group');
        const currentHidden = !currentGroup || currentGroup.offsetParent === null;
        let proofOk;
        if (_stepUp.active) {
          const code = [...document.querySelectorAll('.chpin-code-input')].map(i => i.value).join('');
          proofOk = !!_stepUp.target && code.length === 6;
        } else if (currentHidden) {
          proofOk = true;   // первая установка
        } else {
          proofOk = join('#chpin-current').length === 6;
        }
        return newOk && confirmOk && proofOk;
      },
    }],
  });

  // Form-guard для Next-кнопки шага 1: серая пока proof не введён
  // (current PIN заполнен ИЛИ выбран контакт + введён 6-значный код).
  _guardStep1 = wireFormGuard({
    button:   '#btn-chpin-next',
    required: [{
      kind:  'fn',
      watch: ['#chpin-current .pin-input', '.chpin-code-input', '#chpin-forgot-contact'],
      fn: () => {
        if (_stepUp.active) {
          // Phase contact: нужен picker selection + не пустой full-input.
          if (_stepUp.phase === 'contact') {
            return !!_stepUp.target && !!document.querySelector('#chpin-forgot-contact')?.value.trim();
          }
          // Phase code: нужен 6-значный код.
          const code = [...document.querySelectorAll('.chpin-code-input')].map(i => i.value).join('');
          return !!_stepUp.target && code.length === 6;
        }
        const cur = [...document.querySelectorAll('#chpin-current .pin-input')].map(i => i.value).join('');
        return cur.length === 6;
      },
    }],
  });

  // Live-refresh form-guard на ввод в full-contact textbox.
  document.querySelector('#chpin-forgot-contact')?.addEventListener('input', () => refreshBothGuards());

  // Wire code-инпуты step-up (auto-advance / backspace / paste).
  const codeInputs = [...document.querySelectorAll('.chpin-code-input')];
  codeInputs.forEach((input, idx) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/, '').slice(0, 1);
      input.classList.toggle('filled', !!input.value);
      if (input.value && idx < codeInputs.length - 1) codeInputs[idx + 1].focus();
      refreshBothGuards();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value && idx > 0) {
        codeInputs[idx - 1].focus();
        codeInputs[idx - 1].value = '';
        codeInputs[idx - 1].classList.remove('filled');
        refreshBothGuards();
      }
    });
    input.addEventListener('paste', (e) => {
      const raw = (e.clipboardData || window.clipboardData)
        .getData('text').replace(/\D/g, '').slice(0, codeInputs.length);
      if (!raw) return;
      e.preventDefault();
      [...raw].forEach((ch, i) => { if (codeInputs[i]) { codeInputs[i].value = ch; codeInputs[i].classList.add('filled'); } });
      codeInputs[Math.min(raw.length, codeInputs.length) - 1]?.focus();
      refreshBothGuards();
    });
  });

  // ─── Step-up toggle (forgot PIN) ──────────────────────────────────
  function selectStepUpContact(typeOrEntry) {
    const entry = typeof typeOrEntry === 'object'
      ? typeOrEntry
      : _ctx.getAvailableContacts().find(c => c.type === typeOrEntry);
    if (!entry) return;
    _stepUp.type   = entry.type;
    _stepUp.target = entry.value;
    document.querySelectorAll('#chpin-contact-choice .role-card').forEach(card => {
      const r = card.querySelector('input[name="chpin-contact"]');
      card.classList.toggle('selected', !!r?.checked);
    });
    refreshBothGuards();
  }

  function syncModeTabs() {
    const known = document.querySelector('#chpin-mode-known');
    const forgot = document.querySelector('#chpin-mode-forgot');
    if (known) {
      known.classList.toggle('active', !_stepUp.active);
      known.setAttribute('aria-selected', String(!_stepUp.active));
    }
    if (forgot) {
      forgot.classList.toggle('active', _stepUp.active);
      forgot.setAttribute('aria-selected', String(_stepUp.active));
    }
  }

  function enterStepUp() {
    _stepUp.active = true;
    _stepUp.code   = '';
    document.querySelector('#chpin-current-group')?.style.setProperty('display', 'none');
    const su = document.querySelector('#chpin-stepup-group');
    if (su) { su.classList.remove('hidden'); su.style.display = 'flex'; }
    syncModeTabs();
    // 2 контакта → role-grid. 1 контакт → compact text вместо карточки.
    const available = _ctx.getAvailableContacts();
    const emailC    = available.find(c => c.type === 'email');
    const phoneC    = available.find(c => c.type === 'phone');
    const both      = !!emailC && !!phoneC;
    const choice    = document.querySelector('#chpin-contact-choice');
    const single    = document.querySelector('#chpin-contact-single');

    if (both) {
      if (single) single.style.display = 'none';
      if (choice) {
        choice.style.display = 'grid';
        choice.classList.remove('contact-picker--single');
      }
      document.querySelector('#chpin-contact-email-label').textContent = emailC.masked;
      document.querySelector('#chpin-contact-phone-label').textContent = phoneC.masked;
      document.querySelectorAll('#chpin-contact-choice input[name="chpin-contact"]').forEach(r => { r.checked = false; });
      document.querySelectorAll('#chpin-contact-choice .role-card').forEach(c => c.classList.remove('selected'));
      _stepUp.target = null;
      _stepUp.type   = null;
    } else if (emailC || phoneC) {
      if (choice) choice.style.display = 'none';
      if (single) single.style.display = 'flex';
      const entry     = emailC || phoneC;
      const typeLabel = entry.type === 'email' ? t('profile.email') : t('profile.phone');
      document.querySelector('#chpin-contact-single-type').textContent   = typeLabel;
      document.querySelector('#chpin-contact-single-target').textContent = entry.masked;
      selectStepUpContact(entry);
    } else {
      if (choice) choice.style.display = 'none';
      if (single) single.style.display = 'none';
    }
    codeInputs.forEach(i => { i.value = ''; i.classList.remove('filled', 'error'); });
    const fcInput = document.querySelector('#chpin-forgot-contact');
    if (fcInput) fcInput.value = '';
    clearFieldErrorById('err-chpin-forgot-contact');
    // Starts на phase-contact (выбор email/phone + полный ввод).
    setStepUpPhase('contact');
    setChpinStep(1);
    refreshBothGuards();
  }

  function exitStepUp() {
    _stepUp.active = false;
    _stepUp.target = null;
    _stepUp.type   = null;
    _stepUp.code   = '';
    if (_stepUp.resendTimer) { clearInterval(_stepUp.resendTimer); _stepUp.resendTimer = null; }
    codeInputs.forEach(i => { i.value = ''; i.classList.remove('filled', 'error'); });
    // Сброс sub-phase на старт чтобы при следующем enterStepUp
    // показалась contact-phase, а не code-phase.
    setStepUpPhase('contact');
    setChpinStep(1);
    syncModeTabs();
    setTimeout(() => _curInputs[0]?.focus(), 50);
  }

  // Seg-tabs «Помню PIN» / «Забыл PIN» — единый source of truth.
  document.querySelector('#chpin-mode-known')?.addEventListener('click', () => {
    if (!_stepUp.active) return;
    exitStepUp();
  });
  document.querySelector('#chpin-mode-forgot')?.addEventListener('click', () => {
    if (_stepUp.active) return;
    enterStepUp();
  });

  // Радио-карточки контакта.
  document.querySelectorAll('#chpin-contact-choice input[name="chpin-contact"]').forEach(r => {
    r.addEventListener('change', () => {
      if (r.checked) selectStepUpContact(r.value);
    });
  });

  function setResendCountdown(seconds) {
    const btnRes = document.querySelector('#btn-chpin-resend');
    const waitEl = document.querySelector('#chpin-resend-wait');
    const cntEl  = document.querySelector('#chpin-resend-countdown');
    if (_stepUp.resendTimer) { clearInterval(_stepUp.resendTimer); _stepUp.resendTimer = null; }
    if (seconds <= 0) {
      if (waitEl) waitEl.classList.add('hidden');
      if (btnRes) btnRes.style.display = '';
      return;
    }
    if (waitEl) waitEl.classList.remove('hidden');
    if (btnRes) btnRes.style.display = 'none';
    if (cntEl)  cntEl.textContent = String(seconds);
    _stepUp.resendTimer = setInterval(() => {
      seconds -= 1;
      if (cntEl) cntEl.textContent = String(seconds);
      if (seconds <= 0) {
        clearInterval(_stepUp.resendTimer);
        _stepUp.resendTimer = null;
        if (waitEl) waitEl.classList.add('hidden');
        if (btnRes) btnRes.style.display = '';
      }
    }, 1000);
  }

  // Sub-phase для forgot-PIN flow:
  //   'contact' — выбор email/phone + ПОЛНЫЙ ввод контакта (ownership-proof)
  //   'code'    — ввод 6-значного кода + resend
  // Перехо через footer-«Далее»; отдельных кнопок «Отправить код» /
  // «← Изменить контакт» больше нет (footer-Back закроет phase code).
  function setStepUpPhase(phase) {
    _stepUp.phase = phase;
    const contactBlock = document.querySelector('#chpin-stepup-phase-contact');
    const codeBlock    = document.querySelector('#chpin-code-block');
    if (contactBlock) contactBlock.style.display = phase === 'contact' ? 'flex' : 'none';
    if (codeBlock) {
      if (phase === 'code') {
        codeBlock.classList.remove('hidden');
        codeBlock.style.display = 'flex';
      } else {
        codeBlock.classList.add('hidden');
        codeBlock.style.display = 'none';
      }
    }
    // Back-button в footer: на phase=contact — нет смысла (юзер уже в начале);
    // на phase=code — вернёт в phase=contact.
    const backBtn = document.querySelector('#btn-chpin-back');
    if (backBtn && _wizardStep === 1) {
      backBtn.style.display = phase === 'code' ? '' : 'none';
    }
    if (phase === 'code') setTimeout(() => codeInputs[0]?.focus(), 50);
    refreshBothGuards();
  }

  async function sendStepUpCode(isResend = false) {
    if (!_stepUp.target || !_stepUp.type) {
      return showAlertText('err-chpin', 'err-chpin-text', t('errors.required'));
    }
    hideAlertById('err-chpin');
    try {
      const resp = await profile.sendCode({
        target:  _stepUp.target,
        type:    _stepUp.type,
        purpose: 'change_password',
        // resend только с явной кнопки — повторный вход в code-phase
        // реюзает живой код, а не перевыпускает его.
        ...(isResend && { resend: true }),
      });
      setStepUpPhase('code');
      codeInputs.forEach(i => { i.value = ''; i.classList.remove('filled', 'error'); });
      setResendCountdown(Number(resp?.data?.cooldown) || 60);
    } catch (err) {
      showAlertText('err-chpin', 'err-chpin-text', errorMessage(err));
    }
  }
  // Resend по кнопке внутри code-phase — тот же sendCode, но с resend-флагом.
  document.querySelector('#btn-chpin-resend')?.addEventListener('click', () => sendStepUpCode(true));

  document.querySelector('#btn-open-change-pin')?.addEventListener('click', () => {
    const hasPin = !!_ctx.getUserProfile()?.has_pin;
    // Step-up в reset state.
    exitStepUp();
    // Скрываем «Не помню PIN» link, если PIN ещё не задан (первая установка).
    document.querySelector('#chpin-forgot-link')?.style.setProperty('display', hasPin ? '' : 'none');
    [_curInputs, _newInputs, _cfmInputs].forEach(clearDigits);
    codeInputs.forEach(i => { i.value = ''; i.classList.remove('filled', 'error'); });
    hideAlertById('err-chpin');
    // Без PIN'а у юзера — первичная установка, доказательство не нужно,
    // прыгаем сразу на шаг 2 (новый PIN).
    if (!hasPin) {
      document.querySelector('#chpin-current-group')?.style.setProperty('display', 'none');
      setChpinStep(2);
      openModal('change-pin-modal');
      setTimeout(() => _newInputs[0]?.focus(), 80);
      return;
    }
    // Иначе нормальный 2-step flow.
    setChpinStep(1);
    openModal('change-pin-modal');
    setTimeout(() => _curInputs[0]?.focus(), 80);
  });

  // ── Next-button (step 1 → step 2) ─────────────────────────────
  document.querySelector('#btn-chpin-next')?.addEventListener('click', async () => {
    hideAlertById('err-chpin');
    const hasPin = !!_ctx.getUserProfile()?.has_pin;
    // Без PIN'а проверять нечего — этот путь не должен попадать на step 1 вообще.
    if (!hasPin) { setChpinStep(2); return; }

    if (_stepUp.active) {
      const btn = document.querySelector('#btn-chpin-next');

      // Phase A (contact): валидируем full input vs picker selection
      // и отправляем код. Переход на phase=code делает sendStepUpCode.
      if (_stepUp.phase === 'contact') {
        clearFieldErrorById('err-chpin-forgot-contact');
        if (!_stepUp.target || !_stepUp.type) {
          return showAlertText('err-chpin', 'err-chpin-text', t('errors.required'));
        }
        const typed = String(document.querySelector('#chpin-forgot-contact')?.value ?? '').trim();
        if (!typed) {
          return setFieldError('err-chpin-forgot-contact', t('errors.required'));
        }
        const norm = _stepUp.type === 'phone'
          ? typed.toLowerCase().replace(/[\s\-().]/g, '')
          : typed.toLowerCase();
        const expected = _stepUp.type === 'phone'
          ? String(_stepUp.target).toLowerCase().replace(/[\s\-().]/g, '')
          : String(_stepUp.target).toLowerCase();
        if (norm !== expected) {
          return setFieldError('err-chpin-forgot-contact', t('profile.contact_mismatch'));
        }
        setLoading(btn, true);
        try {
          await sendStepUpCode();
        } finally {
          setLoading(btn, false);
        }
        return;
      }

      // Phase B (code): verify-code → переход на step 2 (новый PIN).
      const code = [...document.querySelectorAll('.chpin-code-input')].map(i => i.value).join('');
      if (code.length !== 6) {
        return showAlertText('err-chpin', 'err-chpin-text', t('errors.required'));
      }
      setLoading(btn, true);
      try {
        const { auth } = await import('../../../api.js');
        await auth.resetVerifyCode(_stepUp.target, code);
        _stepUp.code = code;
        setChpinStep(2);
        setTimeout(() => _newInputs[0]?.focus(), 80);
      } catch (err) {
        showAlertText('err-chpin', 'err-chpin-text', errorMessage(err));
      } finally {
        setLoading(btn, false);
      }
      return;
    }

    // Normal flow: current PIN. Раньше фронт пропускал на step 2 без
    // фактической проверки → юзер мог ввести любой PIN и попасть в
    // шаг ввода нового. Бэк отвергал на финальном сабмите, но UX был
    // запутан. Теперь eager-check через /api/auth/verify-pin —
    // endpoint имеет brute-force защиту (5 попыток / 30 мин lock),
    // attempts_remaining + retry_after возвращаются в payload.
    const current = _curInputs.map(i => i.value).join('');
    if (current.length !== 6) {
      return showAlertText('err-chpin', 'err-chpin-text', t('errors.required'));
    }
    const btnNext = document.querySelector('#btn-chpin-next');
    setLoading(btnNext, true);
    try {
      await auth.verifyPin(current);
      setChpinStep(2);
      setTimeout(() => _newInputs[0]?.focus(), 80);
    } catch (err) {
      const key    = err?.error_key;
      const params = err?.data?.error_params || {};
      if (key === 'errors.auth.pin_locked' || key === 'errors.auth.account_locked') {
        const retry = Number(params.retry_after) || 0;
        _startChpinLockCountdown(retry);
      } else if (key === 'errors.auth.pin_invalid' && typeof params.attempts_remaining === 'number') {
        showAlertText('err-chpin', 'err-chpin-text',
          t('errors.auth.pin_invalid_with_attempts', { n: params.attempts_remaining }));
      } else {
        showAlertText('err-chpin', 'err-chpin-text', errorMessage(err));
      }
    } finally {
      setLoading(btnNext, false);
    }
  });

  // Хелпер форматирования секунд → «Xс / Yмин Zс».
  function _formatRetry(sec) {
    const s = Math.max(0, Math.ceil(sec));
    if (s < 60) return `${s} сек`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r > 0 ? `${m} мин ${r} сек` : `${m} мин`;
  }

  // Клиент-side countdown во время lockout: ОДИН раз получили retry_after,
  // дальше локально тикаем — backend не дёргается каждую секунду. По
  // достижении 0 авто-снимаем ошибку и re-enable input'ы.
  let _chpinLockTimer = null;
  let _chpinLockEndsAt = 0;
  function _startChpinLockCountdown(retryAfterSec) {
    if (_chpinLockTimer) clearInterval(_chpinLockTimer);
    _chpinLockEndsAt = Date.now() + Math.max(0, Number(retryAfterSec) || 0) * 1000;
    // Дисейблим все PIN-инпуты + Next-кнопку — никакого нового запроса
    // во время блокировки.
    [..._curInputs, ..._newInputs, ..._cfmInputs,
     ...document.querySelectorAll('.chpin-code-input')]
      .forEach(i => { i.disabled = true; });
    const nextBtn = document.querySelector('#btn-chpin-next');
    const saveBtn = document.querySelector('#btn-save-pin');
    [nextBtn, saveBtn].forEach(b => b && (b.disabled = true));
    const errText = document.querySelector('#err-chpin-text');
    const tick = () => {
      const left = (_chpinLockEndsAt - Date.now()) / 1000;
      if (left <= 0) {
        clearInterval(_chpinLockTimer); _chpinLockTimer = null;
        hideAlertById('err-chpin');
        [..._curInputs, ..._newInputs, ..._cfmInputs,
         ...document.querySelectorAll('.chpin-code-input')]
          .forEach(i => { i.disabled = false; });
        refreshBothGuards();
        return;
      }
      if (errText) {
        errText.textContent = t('errors.auth.pin_locked_with_timer', { time: _formatRetry(left) });
      }
    };
    showAlertText('err-chpin', 'err-chpin-text',
      t('errors.auth.pin_locked_with_timer', { time: _formatRetry(retryAfterSec) }));
    tick();
    _chpinLockTimer = setInterval(tick, 1000);
  }

  document.querySelector('#btn-chpin-back')?.addEventListener('click', () => {
    // На step 2 (новый PIN) — назад на step 1.
    // На step 1 в forgot-mode + phase=code — назад в phase=contact
    // (юзер хочет сменить контакт или начать заново).
    if (_wizardStep === 2) {
      setChpinStep(1);
      return;
    }
    if (_stepUp.active && _stepUp.phase === 'code') {
      hideAlertById('err-chpin');
      codeInputs.forEach(i => { i.value = ''; i.classList.remove('filled', 'error'); });
      if (_stepUp.resendTimer) { clearInterval(_stepUp.resendTimer); _stepUp.resendTimer = null; }
      setStepUpPhase('contact');
    }
  });

  document.querySelector('#btn-save-pin')?.addEventListener('click', async () => {
    hideAlertById('err-chpin');
    const hasPin = !!_ctx.getUserProfile()?.has_pin;
    const fresh   = readDigits(_newInputs);
    const confirm = readDigits(_cfmInputs);

    if (fresh.length !== 6) {
      return showAlertText('err-chpin', 'err-chpin-text', t('errors.pin_length'));
    }
    if (fresh !== confirm) {
      return showAlertText('err-chpin', 'err-chpin-text', t('errors.validation.pin_mismatch') || 'PIN codes do not match');
    }

    // Собираем proof: step-up (код), current_pin, или ничего (первичная установка).
    const payload = { pin: fresh, pin_confirm: confirm };
    if (hasPin) {
      if (_stepUp.active) {
        const code = readDigits([...document.querySelectorAll('.chpin-code-input')]);
        if (code.length !== 6 || !_stepUp.target) {
          return showAlertText('err-chpin', 'err-chpin-text', t('errors.required'));
        }
        payload.verification_code   = code;
        payload.verification_target = _stepUp.target;
      } else {
        const current = readDigits(_curInputs);
        if (current.length !== 6) {
          return showAlertText('err-chpin', 'err-chpin-text', t('errors.required'));
        }
        payload.current_pin = current;
      }
    }

    const btn = document.querySelector('#btn-save-pin');
    setLoading(btn, true);
    try {
      await auth.setPin(payload);
      toast(t('toasts.pin_updated'), 'ok');
      closeModal('change-pin-modal');
      exitStepUp();
      _ctx.refresh();
    } catch (err) {
      showAlertText('err-chpin', 'err-chpin-text', errorMessage(err));
    } finally {
      setLoading(btn, false);
    }
  });
}
