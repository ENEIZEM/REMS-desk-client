/* ═══════════════════════════════════════════════════════════════
   Active sessions list for the Profile tab.

   Token lives 30 days. Visualise remaining lifetime with a
   horizontal bar whose colour blends from the brand accent-green
   (full life) to error-red (about to expire). We interpolate the
   two literal hex values rather than HSL so the ramp matches the
   actual palette colours instead of an arbitrary spectrum slice.
   ═══════════════════════════════════════════════════════════════ */

import { profile }                from '../../api.js';
import { errorMessage, toast }    from '../../auth.js';
import { t, getLang }             from '../../i18n.js';
import { attachLoader }           from '../../lib/lazy-loader.js';
import { openModal, closeModal, setLoading } from './ui-helpers.js';

// Завершать ЧУЖИЕ сессии можно только из достаточно «взрослой» текущей
// сессии — защита: угнавший свежий доступ не вышибет настоящего владельца
// сразу. Кнопка отзыва появляется лишь когда текущей сессии ≥ 5 дней.
const REVOKE_MIN_AGE_DAYS = 5;

function osIcon(os) {
  if (!os) return 'ph-monitor';
  const s = os.toLowerCase();
  if (s.includes('windows')) return 'ph-windows-logo';
  if (s.includes('mac'))     return 'ph-apple-logo';
  if (s.includes('linux'))   return 'ph-linux-logo';
  if (s.includes('android')) return 'ph-android-logo';
  if (s.includes('ios'))     return 'ph-apple-logo';
  return 'ph-monitor';
}

function _hex2rgb(h) {
  const v = h.replace('#', '');
  return [parseInt(v.slice(0,2), 16), parseInt(v.slice(2,4), 16), parseInt(v.slice(4,6), 16)];
}
function _mixRgb(a, b, t) {
  return a.map((v, i) => Math.round(v + (b[i] - v) * t));
}

// Cache the resolved palette values so we don't getComputedStyle() every
// row render. Falls back to literal accent/error if CSS vars aren't yet
// readable (e.g. unit-test contexts).
let _accentRgb = null, _errorRgb = null;
function _palette() {
  if (_accentRgb && _errorRgb) return { accent: _accentRgb, error: _errorRgb };
  const cs = getComputedStyle(document.documentElement);
  const a  = cs.getPropertyValue('--clr-accent').trim() || '#0d9488';
  const e  = cs.getPropertyValue('--clr-error').trim()  || '#ef4444';
  _accentRgb = _hex2rgb(a.startsWith('#') ? a : '#0d9488');
  _errorRgb  = _hex2rgb(e.startsWith('#') ? e : '#ef4444');
  return { accent: _accentRgb, error: _errorRgb };
}
function tokenColorByDaysLeft(daysLeft) {
  const ratio = Math.max(0, Math.min(1, daysLeft / 30));   // 1=full life, 0=expired
  const { accent, error } = _palette();
  const [r, g, b] = _mixRgb(error, accent, ratio);          // 0 → error, 1 → accent
  return `rgb(${r}, ${g}, ${b})`;
}

function formatRemaining(expiresAt) {
  const ms   = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return { days: 0, hours: 0, label: '0' + t('profile.days_short') };
  const days  = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const label = days >= 1
    ? `${days}${t('profile.days_short')}`
    : `${hours}${t('profile.hours_short')}`;
  return { days, hours, label };
}

export async function loadSessions() {
  const listEl = document.querySelector('#sessions-list');
  const cntEl  = document.querySelector('#sessions-count');
  if (!listEl) return;

  // Empty the list area and arm the deferred loader. The overlay only
  // surfaces if the fetch takes >1.5 s; otherwise the user just sees
  // the new rows pop in without any flicker.
  listEl.innerHTML = '';
  const stopLoader = attachLoader({ container: listEl });

  try {
    const resp = await profile.sessions();
    const sessions = resp.data?.sessions ?? [];
    cntEl.textContent = `${sessions.length}`;

    if (!sessions.length) {
      listEl.innerHTML = `<div class="empty-state" style="padding:1.5rem 0;">
        <i class="ph ph-device-mobile"></i>
        <p class="empty-state-text">${t('profile.sessions_empty')}</p>
      </div>`;
      return;
    }

    // Возраст текущей сессии — от него зависит, показывать ли кнопки
    // отзыва чужих сессий.
    const current = sessions.find(s => s.is_current);
    const currentAgeDays = current ? (Date.now() - new Date(current.created_at).getTime()) / 86400000 : 0;
    const canRevoke = currentAgeDays >= REVOKE_MIN_AGE_DAYS;

    listEl.innerHTML = sessions.map(s => sessionRowHTML(s, canRevoke)).join('');
    // Bind revoke handlers after render so the DOM exists.
    listEl.querySelectorAll('[data-action="revoke-session"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-session-id');
        if (id) revokeSession(id);
      });
    });
  } catch (err) {
    listEl.innerHTML = `<div class="empty-state" style="padding:1.5rem 0;">
      <i class="ph ph-warning-circle"></i>
      <p class="empty-state-text">${errorMessage(err)}</p>
    </div>`;
  } finally {
    stopLoader();
  }
}

/**
 * Render one session row. Non-current rows get a small "sign-out" icon
 * button that calls the revoke endpoint after a confirm() — the wording
 * makes it clear the OTHER device's session is being terminated, not
 * this one.
 */
function sessionRowHTML(s, canRevoke = false) {
  const left  = formatRemaining(s.token_expires_at);
  const color = tokenColorByDaysLeft(left.days + left.hours / 24);
  const pct   = Math.max(2, Math.min(100, ((left.days * 24 + left.hours) / (30 * 24)) * 100));
  // Single header line: OS in primary text, browser appended in muted
  // gray after a separator. Device hash falls back when both are unknown.
  // For the CURRENT session we promote the whole "icon + OS + browser"
  // block to success colour and attach a card-style tooltip — no extra
  // standalone icon. The OS icon's own treatment is preserved (same
  // glyph + size), only its colour inherits.
  const osLabel      = s.os      && s.os      !== 'Unknown' ? s.os      : '';
  const browserLabel = s.browser && s.browser !== 'Unknown' ? s.browser : '';
  const primary = osLabel || browserLabel || s.device_hash;
  const browserSpan = osLabel && browserLabel
    ? (s.is_current
        ? `<span style="font-weight:500; opacity:.85;"> · ${browserLabel}</span>`
        : `<span style="color:var(--clr-text-muted); font-weight:500;"> · ${browserLabel}</span>`)
    : '';
  const blockColor = s.is_current ? 'var(--clr-success)' : 'var(--clr-text-primary)';
  const iconColor  = s.is_current ? 'var(--clr-success)' : 'var(--clr-accent)';
  const tooltipAttrs = s.is_current
    ? `class="profile-card-tooltip session-current-block" tabindex="0" data-tooltip-text="${t('profile.session_current')}"`
    : '';

  // Кнопка отзыва — только на не-текущих сессиях. Текущую юзер закрывает
  // через обычный logout (чистит токен в localStorage). Иконка sign-out
  // + tooltip с текстом, чтобы понять что произойдёт.
  const revokeBtn = (s.is_current || !canRevoke) ? '' : `
    <button class="session-revoke-btn"
            data-action="revoke-session"
            data-session-id="${s.id}"
            data-ct-tip="${t('profile.session_revoke')}"
            aria-label="${t('profile.session_revoke')}">
      <i class="ph-bold ph-sign-out"></i>
    </button>`;

  return `
    <div class="profile-row" data-session-id="${s.id}" style="flex-direction:column; align-items:stretch; gap:.5rem;">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:.75rem;">
        <span ${tooltipAttrs} style="display:flex; align-items:center; gap:.6rem; min-width:0; color:${blockColor};">
          <i class="ph-duotone ${osIcon(s.os)}" style="color:${iconColor}; font-size:1.25rem;"></i>
          <span style="min-width:0; font-size:var(--text-sm); font-weight:600;">
            ${primary}${browserSpan}
          </span>
        </span>
        <span style="display:flex; align-items:center; gap:.5rem;">
          <span style="font-size:var(--text-sm); font-weight:600; color:${color}; white-space:nowrap;">${left.label}</span>
          ${revokeBtn}
        </span>
      </div>
      <div style="height:6px; background:var(--clr-bg-muted); border-radius:3px; overflow:hidden;">
        <div style="height:100%; width:${pct}%; background:${color}; transition:width .3s;"></div>
      </div>
      <div style="display:flex; gap:1rem; font-size:var(--text-xs); color:var(--clr-text-muted);">
        <span>${t('profile.session_last_used')}: ${new Date(s.last_used_at).toLocaleString(getLang() === 'en' ? 'en-GB' : 'ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</span>
        <span>${t('profile.session_created')}: ${new Date(s.created_at).toLocaleString(getLang() === 'en' ? 'en-GB' : 'ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</span>
      </div>
    </div>
  `;
}

// Подтверждение через модалку (#session-revoke-modal) вместо нативного
// confirm. Кнопку подтверждения вешаем один раз.
let _pendingRevokeId = null;
let _revokeWired = false;

function revokeSession(id) {
  _pendingRevokeId = id;
  wireRevokeModalOnce();
  openModal('session-revoke-modal');
}

function wireRevokeModalOnce() {
  if (_revokeWired) return;
  _revokeWired = true;
  document.querySelector('#btn-session-revoke-confirm')?.addEventListener('click', doRevoke);
}

async function doRevoke() {
  const id = _pendingRevokeId;
  if (!id) return;
  const btn = document.querySelector('#btn-session-revoke-confirm');
  setLoading(btn, true);
  try {
    await profile.revokeSession(id);
    closeModal('session-revoke-modal');
    await loadSessions();   // обновит и счётчик #sessions-count
    toast(t('profile.session_revoked_toast'), 'ok');
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    setLoading(btn, false);
    _pendingRevokeId = null;
  }
}
