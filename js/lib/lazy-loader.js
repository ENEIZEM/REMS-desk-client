/* ═══════════════════════════════════════════════════════════════
   REMS — Lazy loader overlay
   ───────────────────────────────────────────────────────────────
   Wraps an async operation with a deferred loader.

   Threshold philosophy (revised):
     • showAfter: 500 ms — sub-half-second ops don't flash a spinner
                            at all (fast → invisible feedback).
     • minVisible:    0 — no floor. The moment the operation finishes
                          (= "the page started to appear"), the spinner
                          fades. We no longer hold it artificially to
                          prevent a perceived strobe; in practice the
                          500 ms gate is enough to dedupe the noisy
                          near-instant cases.

   Usage:
     await lazyLoad(profile.get(), { container: q('#tab-profile') });

   Or attach freely and return a `done()` to clear:
     const stop = attachLoader({ container });
     try { await work(); } finally { stop(); }
   ═══════════════════════════════════════════════════════════════ */

/**
 * Wrap a promise with the deferred + minimum-visible overlay.
 * Returns the original promise unchanged.
 */
export function lazyLoad(promise, opts = {}) {
  const stop = attachLoader(opts);
  promise.then(stop, stop);
  return promise;
}

/**
 * Attach an overlay manually. Returns a function that, when called,
 * tears the overlay down respecting the minVisible floor.
 */
export function attachLoader({
  container,
  showAfter  = 500,
  minVisible = 0,
} = {}) {
  const host = container || document.body;
  let overlay = null;
  let shownAt = 0;
  let cancelled = false;
  let originalPosition = null;
  let originalMinHeight = null;

  const showTimer = setTimeout(() => {
    if (cancelled) return;
    shownAt = Date.now();
    overlay = document.createElement('div');
    overlay.className = 'loader-overlay';
    overlay.innerHTML = '<span class="spinner spinner-lg" aria-label="Loading"></span>';

    // Anchor the absolutely-positioned overlay to the host. If the host
    // is positioned statically we promote it to `relative` only for as
    // long as the overlay lives; the original value is restored on
    // teardown so we never permanently mutate the host's layout.
    if (host !== document.body) {
      const cs = getComputedStyle(host);
      if (cs.position === 'static') {
        originalPosition = host.style.position;
        host.style.position = 'relative';
      }
      // Если хост ПУСТОЙ (например, #sessions-list до загрузки списка),
      // его высота = 0 → inset:0-overlay тоже 0×0, спиннер flex-центром
      // вытекает наружу и заходит на шапку. Даём хосту min-height на
      // время загрузки, чтобы overlay имел габариты, и убираем на teardown.
      const rect = host.getBoundingClientRect();
      if (rect.height < 96) {
        originalMinHeight = host.style.minHeight;
        host.style.minHeight = '8rem';
      }
    } else {
      overlay.classList.add('loader-overlay--fixed');
    }
    host.appendChild(overlay);
  }, showAfter);

  return function stop() {
    cancelled = true;
    clearTimeout(showTimer);
    if (!overlay) return;
    const elapsed   = Date.now() - shownAt;
    const remaining = Math.max(0, minVisible - elapsed);
    const node      = overlay;
    overlay = null;
    setTimeout(() => {
      node.classList.add('loader-overlay--fade');
      // Match the CSS fade-out duration so we don't yank the node mid-anim.
      setTimeout(() => {
        node.remove();
        if (originalPosition  !== null) host.style.position  = originalPosition;
        if (originalMinHeight !== null) host.style.minHeight = originalMinHeight;
      }, 180);
    }, remaining);
  };
}
