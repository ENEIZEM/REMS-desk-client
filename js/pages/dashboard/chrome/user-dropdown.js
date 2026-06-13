/* ═══════════════════════════════════════════════════════════════
   User dropdown — opens on hover (with a small close-delay so a slow
   mouse-glide from the avatar to a menu item doesn't drop the panel).
   Click still toggles for touch devices and keyboard users.
   ═══════════════════════════════════════════════════════════════ */
import { q } from '../dom-utils.js';
import { logout } from '../../../auth.js';

export function initUserDropdown({ switchTab }) {
  const userDropdown = q('#user-dropdown');
  const userMenuWrap = q('.user-menu-wrap');
  let _ddCloseTimer = null;

  /* Chrome's `backdrop-filter` does NOT composite for an element nested
     inside an ancestor that also has `backdrop-filter` — the dropdown
     used to render as plain translucent white inside the navbar. The
     fix: physically MOVE the dropdown out of the navbar to document.body
     on mount, then position it via `position: fixed` against the wrap's
     bounding box. The trigger still fires hover/click handlers on the
     wrap (which stays in the navbar), but the panel itself paints in a
     sibling stacking context — no parent filter to fight with. */
  if (userDropdown && userDropdown.parentElement !== document.body) {
    document.body.appendChild(userDropdown);
    userDropdown.style.position = 'fixed';
  }

  /* Re-anchor the floating panel to the wrap's bottom-right corner. The
     dropdown stays open during this call (we run it whenever the panel
     becomes visible OR the viewport resizes). The 6 px gap matches the
     CSS `top: calc(100% + 6px)` rule used in the unmoved layout. */
  function positionDD() {
    if (!userDropdown || !userMenuWrap) return;
    const rect = userMenuWrap.getBoundingClientRect();
    // Anchor by the wrap's RIGHT edge (panel's right aligns with wrap's
    // right) and its BOTTOM (panel's top sits 6 px below). Using
    // pageX/pageY would shift the panel on scroll because we use
    // `position: fixed`; fixed elements are viewport-coordinated, so
    // viewport rects from getBoundingClientRect are exactly right.
    userDropdown.style.top   = `${rect.bottom + 6}px`;
    userDropdown.style.right = `${window.innerWidth - rect.right}px`;
    userDropdown.style.left  = 'auto';
  }
  window.addEventListener('resize', positionDD);

  function openDD()  {
    if (_ddCloseTimer) { clearTimeout(_ddCloseTimer); _ddCloseTimer = null; }
    positionDD();
    userDropdown?.classList.remove('hidden');
  }
  function closeDD() { userDropdown?.classList.add('hidden'); }
  function deferCloseDD() {
    if (_ddCloseTimer) clearTimeout(_ddCloseTimer);
    _ddCloseTimer = setTimeout(closeDD, 120);
  }

  userMenuWrap?.addEventListener('mouseenter', openDD);
  userMenuWrap?.addEventListener('mouseleave', deferCloseDD);
  /* The relocated panel listens for hover too, so the slow-mouse-glide
     from avatar to dropdown doesn't drop it. mouseenter on the panel
     cancels the close timer; mouseleave starts a fresh one. */
  userDropdown?.addEventListener('mouseenter', openDD);
  userDropdown?.addEventListener('mouseleave', deferCloseDD);

  q('#btn-user-menu')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (userDropdown?.classList.contains('hidden')) openDD();
    else closeDD();
  });
  // Tap outside the wrap AND outside the dropdown collapses the menu.
  document.addEventListener('click', (e) => {
    if (!userMenuWrap || !userDropdown) return;
    if (userMenuWrap.contains(e.target)) return;
    if (userDropdown.contains(e.target)) return;
    closeDD();
  });

  q('#dd-profile')?.addEventListener('click',  () => { closeDD(); switchTab('profile'); });
  // Org row inside the dropdown → switch to the org tab. Only meaningful for
  // approved members (otherwise the tab is hidden and switchTab() no-ops).
  q('#dd-org-link')?.addEventListener('click', () => { closeDD(); switchTab('org'); });
  q('#btn-logout')?.addEventListener('click',  () => logout());
}
