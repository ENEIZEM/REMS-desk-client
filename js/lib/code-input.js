/* ═══════════════════════════════════════════════════════════════
   REMS — 6-digit verification-code input

   A reusable controller for the "6 boxes + resend countdown" UX
   that shows up in three places:
     • registration step 2  (auth.register.code_*)
     • change-password step 2
     • change-contact step 3

   The DOM markup is owned by the page (so the visual stays in CSS),
   this module wires:
     • auto-advance / backspace / paste across the 6 inputs
     • resend countdown timer + button toggle
     • onChange callback (so the host form-guard can refresh)

   Public surface returned by createCodeInput({…}):
     read()                  → "123456" (whatever the user has typed)
     clear()                 → wipe all 6 boxes + filled state
     focus()                 → focus the first input
     startResendTimer(secs?) → begin countdown (defaults to 60s)
     stopResendTimer()       → cancel the countdown and re-show "send"
     reset()                 → clear() + stopResendTimer()
   ═══════════════════════════════════════════════════════════════ */

/**
 * @param {Object}   opts
 * @param {string}   opts.inputs         CSS selector for the 6 code inputs.
 * @param {string}   [opts.resendButton] Selector for the "Send again" button.
 * @param {string}   [opts.resendWait]   Selector for the "Wait Ns" span (hidden until timer fires).
 * @param {string}   [opts.resendCounter] Selector for the inner countdown number element.
 * @param {Function} [opts.onChange]     Called whenever a digit is typed/erased.
 */
export function createCodeInput(opts) {
  const inputs = [...document.querySelectorAll(opts.inputs)];
  if (!inputs.length) {
    // Caller passed a stale selector — nothing to wire, but return a
    // no-op API so callers don't have to null-check.
    return {
      read: () => '',
      clear: () => {},
      focus: () => {},
      startResendTimer: () => {},
      stopResendTimer:  () => {},
      reset: () => {},
    };
  }

  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};

  // ── Input wiring ────────────────────────────────────────────────
  inputs.forEach((input, idx) => {
    input.addEventListener('input', () => {
      input.classList.remove('error');
      input.value = input.value.replace(/\D/, '').slice(0, 1);
      input.classList.toggle('filled', !!input.value);
      if (input.value && idx < inputs.length - 1) inputs[idx + 1].focus();
      onChange();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value && idx > 0) {
        inputs[idx - 1].focus();
        inputs[idx - 1].value = '';
        inputs[idx - 1].classList.remove('filled');
        onChange();
      }
    });
    input.addEventListener('paste', (e) => {
      const raw = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, inputs.length);
      if (!raw) return;
      e.preventDefault();
      [...raw].forEach((ch, i) => {
        if (inputs[i]) {
          inputs[i].value = ch;
          inputs[i].classList.add('filled');
        }
      });
      inputs[Math.min(raw.length, inputs.length) - 1]?.focus();
      onChange();
    });
  });

  // ── Resend countdown ────────────────────────────────────────────
  const waitEl    = opts.resendWait    ? document.querySelector(opts.resendWait)    : null;
  const btnEl     = opts.resendButton  ? document.querySelector(opts.resendButton)  : null;
  const counterEl = opts.resendCounter ? document.querySelector(opts.resendCounter) : null;
  let timerId = null;

  function stopResendTimer() {
    if (timerId) { clearInterval(timerId); timerId = null; }
    waitEl?.classList.add('hidden');
    if (btnEl) btnEl.style.display = '';
  }
  function startResendTimer(seconds = 60) {
    if (timerId) clearInterval(timerId);
    // 0 — валидное значение: кулдаун уже прошёл (backend реюзнул живой
    // код), кнопку resend показываем сразу, без минутной паузы.
    const left0 = Math.ceil(Number(seconds));
    if (!Number.isFinite(left0) || left0 <= 0) { stopResendTimer(); return; }
    let left = left0;
    waitEl?.classList.remove('hidden');
    if (btnEl)     btnEl.style.display = 'none';
    if (counterEl) counterEl.textContent = left;
    timerId = setInterval(() => {
      left--;
      if (counterEl) counterEl.textContent = left;
      if (left <= 0) stopResendTimer();
    }, 1000);
  }

  function read()  { return inputs.map(i => i.value).join(''); }
  function clear() {
    inputs.forEach(i => {
      i.value = '';
      i.classList.remove('filled', 'error');
    });
  }
  function focus() { inputs[0]?.focus(); }
  function reset() { clear(); stopResendTimer(); }

  return { read, clear, focus, startResendTimer, stopResendTimer, reset };
}
