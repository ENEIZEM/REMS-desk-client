// frontend/js/pages/dashboard/chrome/subfilter-wrap.js
//
// Под-фильтры лент (тип заявки │ период │ сотрудник) разделены вертикальными
// сепараторами — это border-left у каждой группы, кроме первой
// (.rq-subfilter-group:not(:first-child)). Когда какая-то группа переносится
// на НОВУЮ строку, её сепаратор рисуется в НАЧАЛЕ строки и выглядит лишним.
//
// CSS не умеет определять «первый элемент перенесённой строки», поэтому
// помечаем такие группы классом .is-row-start (CSS убирает у них border-left
// и левый паддинг). Признак новой строки — offsetLeft НЕ увеличился
// относительно предыдущей группы (он сбрасывается к началу контейнера).
// offsetLeft устойчив к разной высоте/выравниванию элементов (в отличие от
// offsetTop). Пересчитываем на ресайзе и при ре-рендере лент.

function fixContainer(container) {
  const groups = container.querySelectorAll('.rq-subfilter-group');
  let prevLeft = null;
  groups.forEach((g) => {
    const left = g.offsetLeft;
    const rowStart = prevLeft === null || left <= prevLeft;
    g.classList.toggle('is-row-start', rowStart);
    prevLeft = left;
  });
}

let scheduled = false;
function scanAll() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    document.querySelectorAll('.rq-subfilters').forEach(fixContainer);
  });
}

export function initSubfilterWrap() {
  scanAll();
  // Ширина страницы меняется → группы могут перенестись → пересчёт.
  try { new ResizeObserver(scanAll).observe(document.body); }
  catch { window.addEventListener('resize', scanAll); }
  // Ленты перерисовываются (смена вкладки/фильтров/команды) → ловим
  // появление новых .rq-subfilters и их детей. scanAll дебаунсится через rAF.
  try { new MutationObserver(scanAll).observe(document.body, { childList: true, subtree: true }); }
  catch (_) {}
}
