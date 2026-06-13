/* ═══════════════════════════════════════════════════════════════
   Dashboard DOM utilities — tiny shared helpers used across the
   dashboard orchestrator and its extracted modules.
   ═══════════════════════════════════════════════════════════════ */

export function q(sel) { return document.querySelector(sel); }

export function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
