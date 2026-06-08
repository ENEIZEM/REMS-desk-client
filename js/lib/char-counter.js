/* ═══════════════════════════════════════════════════════════════
   Char-counter — авто-подписи «N / max» под текстовыми полями модалок.
   ────────────────────────────────────────────────────────────────
   Берёт лимит из атрибута maxlength (он же = лимит из БД), поэтому
   браузер сам не даёт превысить порог — счётчик информирует, а у
   самого предела подсвечивается. Работает для всех input[type=text]
   и textarea с maxlength внутри .modal — добавлять разметку вручную
   не нужно.

   Поля можно исключить атрибутом data-no-cc (например, если у поля уже
   есть собственный счётчик).
   ═══════════════════════════════════════════════════════════════ */

// Исключаем одно-символьные поля (maxlength="1") — это боксы OTP-кода и
// PIN, где счётчик «1 / 1» бессмыслен и мешает.
const SELECTOR = '.modal textarea[maxlength]:not([data-no-cc]), .modal input[type="text"][maxlength]:not([data-no-cc]):not([maxlength="1"])';

function buildCounter(max) {
  const el = document.createElement('div');
  el.className = 'char-counter';
  el.innerHTML = `<span class="cc-cur">0</span> / <span class="cc-max">${max}</span>`;
  return el;
}

function updateCounter(field) {
  const counter = field._ccEl;
  if (!counter) return;
  const max = Number(field.getAttribute('maxlength')) || 0;
  const len = (field.value || '').length;
  const cur = counter.querySelector('.cc-cur');
  if (cur) cur.textContent = String(len);
  counter.classList.toggle('is-near', max > 0 && len >= Math.floor(max * 0.9));
  counter.classList.toggle('is-full', max > 0 && len >= max);
}

/** Навесить счётчики на все подходящие поля внутри root (идемпотентно). */
export function mountCharCounters(root = document) {
  root.querySelectorAll(SELECTOR).forEach(field => {
    if (field.dataset.ccWired) return;
    const host = field.closest('.form-group') || field.parentElement;
    // Пропускаем поля, у которых уже есть свой счётчик (например
    // invite-message с #invite-message-count в .form-hint).
    if (host && host.querySelector('.char-counter, [id$="-count"]')) {
      field.dataset.ccWired = '1';
      return;
    }
    const max = Number(field.getAttribute('maxlength')) || 0;
    if (!max) return;
    const counter = buildCounter(max);
    (host || field.parentElement)?.appendChild(counter);
    field._ccEl = counter;
    field.dataset.ccWired = '1';
    field.addEventListener('input', () => updateCounter(field));
    updateCounter(field);
  });
}

/** Пересчитать все счётчики (после программного заполнения формы — edit). */
export function refreshCharCounters(root = document) {
  root.querySelectorAll(SELECTOR).forEach(field => { if (field._ccEl) updateCounter(field); });
}

// Авто-инициализация: модалки статичны в HTML, type=module выполняется
// после парсинга DOM — навешиваем сразу.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => mountCharCounters());
  } else {
    mountCharCounters();
  }
}
