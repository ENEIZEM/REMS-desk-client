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

export function initSidebar() {
  const sidebar       = q('#sidebar');
  const sidebarToggle = q('#sidebar-toggle');

  function applySidebarState(state) {
    if (state !== 'open' && state !== 'closed') state = 'open';
    document.body.setAttribute('data-sidebar', state);
    try { localStorage.setItem(SIDEBAR_LS_KEY, state); } catch (_) {}
  }

  // Restore persisted state on boot:
  //   · narrow screens get auto-collapsed (the floating sidebar overlays
  //     content on mobile — defaulting to open eats the screen)
  //   · wider screens honour the user's last choice, defaulting to open
  const isNarrow = window.matchMedia?.('(max-width: 768px)')?.matches;
  try {
    const saved = localStorage.getItem(SIDEBAR_LS_KEY);
    if (isNarrow)         applySidebarState('closed');
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
    if (!window.matchMedia?.('(max-width: 768px)')?.matches) return;
    if (document.body.getAttribute('data-sidebar') !== 'open') return;
    if (sidebar?.contains(e.target))      return;
    if (sidebarToggle?.contains(e.target)) return;
    applySidebarState('closed');
  });
}
