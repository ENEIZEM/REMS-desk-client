/* ═══════════════════════════════════════════════════════════════
   UI primitives shared by every dashboard modal.
   Tiny, dependency-free DOM helpers — kept in one place so the
   modal modules don't each carry their own copy.
   ═══════════════════════════════════════════════════════════════ */

import { applyTranslations } from '../../i18n.js';

export function openModal(id)  {
  document.querySelector(`#${id}`)?.classList.add('open');
  // Универсально: при открытии любой модалки прогоняем перевод — так
  // статический контент (data-i18n) всегда на текущем языке, даже если
  // модалка инжектится динамически или язык переключали при закрытой.
  try { applyTranslations(); } catch {}
}
export function closeModal(id) { document.querySelector(`#${id}`)?.classList.remove('open'); }

// Глобальный Escape-listener для всех модалок. Backdrop-клик намеренно
// отключён (см. dashboard/index.js — нельзя случайно потерять введённые
// данные), но клавиатурные юзеры должны иметь способ закрыть модалку
// без поиска × кнопки. Закрываем самую верхнюю открытую модалку.
if (typeof document !== 'undefined' && !window.__remsModalEscapeWired) {
  window.__remsModalEscapeWired = true;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Берём последнюю открытую модалку — она и есть «верхняя» в стеке.
    const open = document.querySelectorAll('.modal.open');
    if (!open.length) return;
    const top = open[open.length - 1];
    top.classList.remove('open');
  });
}

export function setLoading(btn, on) {
  if (!btn) return;
  btn.disabled = on;
  btn.classList.toggle('btn-loading', on);
}

export function setFieldError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  const span = el.querySelector('span');
  if (span) span.textContent = msg;
  el.classList.add('show');
}

export function clearFieldErrorById(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('show');
  const span = el.querySelector('span');
  if (span) span.textContent = '';
}

export function showAlertText(alertId, textId, msg) {
  const a = document.getElementById(alertId);
  if (!a) return;
  a.classList.add('show');
  a.classList.remove('hidden');
  const t = document.getElementById(textId);
  if (t) t.textContent = msg;
}

export function hideAlertById(id) {
  const a = document.getElementById(id);
  if (!a) return;
  a.classList.remove('show');
  a.classList.add('hidden');
}

// (Modal-header lang switcher был удалён по запросу — лангсвитчер
// живёт в основном navbar'е, который поднят z-index'ом над
// modal-backdrop, см. CSS .navbar.)
