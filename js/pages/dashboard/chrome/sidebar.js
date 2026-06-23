/* ═══════════════════════════════════════════════════════════════
   Sidebar toggle (floating chrome).
   The toggle drives `body[data-sidebar="open"|"closed"]`; CSS owns the
   visual transitions — JS just flips the attribute. State persists
   across reloads via localStorage (default "open"). On narrow screens
   the sidebar overlays content, so it auto-collapses on boot and on any
   outside click.
   ═══════════════════════════════════════════════════════════════ */
import { q } from '../dom-utils.js';

const SIDEBAR_LS_KEY = 'rems_sidebar_state';
// «Узкий» порог = момент, когда открытый сайдбар начинает ЗАХОДИТЬ на контент.
// Контент имеет текучие симметричные поля (chrome.css): на широких они
// больше вылета сайдбара (gap+ширина=256px), на узких — меньше. Граница
// пересечения ≈ 1400px. Ниже неё сайдбар ведёт себя как оверлей-ящик:
// авто-сворот на буте (чтобы не открывать поверх контента), затемняющий
// scrim при открытии и закрытие по клику вне/по scrim'у.
const NARROW_MQ = '(max-width: 1400px)';
const isNarrowScreen = () => !!window.matchMedia?.(NARROW_MQ)?.matches;

export function initSidebar() {
  const sidebar       = q('#sidebar');
  const sidebarToggle = q('#sidebar-toggle');

  // Затемняющий scrim под сайдбаром: появляется (через CSS) только когда
  // сайдбар открыт И экран узкий (сайдбар перекрывает контент). Клик по нему
  // = клик «вне сайдбара» → закрывает. Создаём один раз, держим в body.
  let scrim = q('#sidebar-scrim');
  if (!scrim) {
    scrim = document.createElement('div');
    scrim.id = 'sidebar-scrim';
    scrim.className = 'sidebar-scrim';
    scrim.setAttribute('aria-hidden', 'true');
    document.body.appendChild(scrim);
  }
  scrim.addEventListener('click', () => applySidebarState('closed'));

  function applySidebarState(state) {
    if (state !== 'open' && state !== 'closed') state = 'open';
    document.body.setAttribute('data-sidebar', state);
    try { localStorage.setItem(SIDEBAR_LS_KEY, state); } catch (_) {}
  }

  // Restore persisted state on boot:
  //   · narrow screens get auto-collapsed (the floating sidebar overlays
  //     content on mobile — defaulting to open eats the screen)
  //   · wider screens honour the user's last choice, defaulting to open
  try {
    const saved = localStorage.getItem(SIDEBAR_LS_KEY);
    if (isNarrowScreen())        applySidebarState('closed');
    else if (saved === 'closed') applySidebarState('closed');
  } catch (_) {}

  sidebarToggle?.addEventListener('click', () => {
    const current = document.body.getAttribute('data-sidebar') || 'open';
    applySidebarState(current === 'open' ? 'closed' : 'open');
  });

  // On narrow screens, close the sidebar when the user clicks anywhere
  // OUTSIDE it (it overlays content there, so taps on content imply
  // "done with the menu"). On desktop this is a no-op — the sidebar is
  // part of the layout and shouldn't auto-collapse.
  document.addEventListener('click', (e) => {
    if (!isNarrowScreen()) return;
    if (document.body.getAttribute('data-sidebar') !== 'open') return;
    if (sidebar?.contains(e.target))      return;
    if (sidebarToggle?.contains(e.target)) return;
    applySidebarState('closed');
  });
}
