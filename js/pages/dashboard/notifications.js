/* ═══════════════════════════════════════════════════════════════
   Notifications module
   ─────────────────────
   Owns the in-memory `_notifications` array plus every render path
   (full list + overview preview + navbar dot + sidebar badge count)
   AND the side-effects on socket arrival (sound + auto-render).

   Hybrid text resolution
   ──────────────────────
   Backend stores `message_text` as either:
     • plain text:            "Иван Петров запросил вступление"
     • or an i18n marker:     "i18n:notifications.types.<type>"

   The frontend renders via `resolveMessage(n)`:
     - if message_text starts with "i18n:", everything after the colon
       is treated as a key path; we run t(key, n.data) so the template
       can interpolate `{{userAgent}}` etc. from the socket payload.
     - otherwise the plain text is escaped and shown as-is.

   Click affordance
   ────────────────
   Clicking a notification:
     1. auto-marks it read (optimistic + API call)
     2. navigates to the route the type maps to (see TYPE_ROUTES)

   Action buttons
   ──────────────
   Each item has two icon-only actions:
     · Read  (only visible while unread)
     · Unread (only visible while read)
   They stopPropagation so clicking them doesn't also navigate.

   Sound
   ─────
   `playNotificationSound()` is exported so dashboard.js can call it
   from the socket handler. The Audio element is created lazily on
   first call (autoplay policy: most browsers gate it on a user
   gesture — after the user opens the dashboard tab once, sound works).
   ═══════════════════════════════════════════════════════════════ */

import { notifications as notifsApi, members as membersApi } from '../../api.js';
import { toast, errorMessage }        from '../../auth.js';
import { t, getLang }                 from '../../i18n.js';
import { attachLoader }               from '../../lib/lazy-loader.js';

let _notifications = [];
// Current view filter: 'all' (show everything) or 'unread' (hide rows
// where read_at is set). Persists across re-renders inside one session
// but resets on reload — the segmented control is purely a UI affordance,
// not an account-level preference.
let _filter = 'all';

// Lazily-built HTMLAudioElement. Browsers gate autoplay on first user
// gesture; we don't try to "warm up" the audio context manually because
// it has its own quirks per browser — instead we just attempt to play
// on each socket event and swallow the promise rejection that browsers
// throw when the gesture hasn't happened yet.
let _audio = null;

/* ── Per-type config ─────────────────────────────────────────────
   icon : phosphor glyph name for the small tile to the left
   color: chip tone — drives both the icon tile and the dot colour.
          Values map to css vars in style.css (--notif-color-<color>).
   href : where clicking the notification takes the user. Functions
          can read the notification to compute query strings (e.g.
          jumping to a specific session id in the profile view).
*/
// `tab` — целевая вкладка БЕЗ hash-префикса. resolveSafeHref ниже
// проверит, существует ли соответствующий tab-panel в DOM (т.е.
// доступен ли он для текущей роли), и если нет — fall-back на overview
// или solo-home в зависимости от роли. Это исключает «клик уведомления
// ведёт на пустоту» когда роль/вкладки сменились (например, юзер был
// employee, его исключили → он solo → клик на старое уведомление
// «Принято» вёл на удалённый #org).
const TYPE_CONFIG = {
  new_session:            { icon: 'ph-shield-warning',     color: 'amber',  tab: () => 'profile?section=sessions' },
  join_request:           { icon: 'ph-user-plus',          color: 'blue',   tab: (n) => {
    const action = n?.data?.action;
    const raw = String(n?.message_text ?? n?.messageText ?? '');
    // invited_by_org — это уведомление приглашённому юзеру (он solo).
    // У него нет #members, ведём на solo-home / overview.
    if (action === 'invited_by_org' || raw.includes('invited_by_org')) return 'overview';
    return 'members';
  } },
  join_accepted:          { icon: 'ph-check-circle',       color: 'green',  tab: (n) => {
    const action = n?.data?.action;
    const raw = String(n?.message_text ?? n?.messageText ?? '');
    // invitee_accepted — owner получает; ведём в Сотрудников.
    if (action === 'invitee_accepted' || raw.includes('invitee_accepted')) return 'members';
    return 'overview';
  } },
  join_accepted_alt_role: { icon: 'ph-check-circle',       color: 'green',  tab: () => 'overview' },
  join_rejected:          { icon: 'ph-x-circle',           color: 'red',    tab: (n) => {
    const action = n?.data?.action;
    const raw = String(n?.message_text ?? n?.messageText ?? '');
    // Для owner-side подтипов (withdrawn / left) — ведём в Сотрудников.
    if (action === 'withdrawn_by_applicant' || raw.includes('withdrawn_by_applicant')) return 'members';
    if (action === 'left_org'               || raw.includes('member_left_org'))       return 'members';
    // Для самого исключённого юзера — overview (он уже solo).
    return 'overview';
  } },
  status_change: {
    // И иконка, и цвет — функции от data.action, чтобы разные события
    // (контракт / смена статуса заявки) визуально отличались в ленте, а не
    // были одинаково-синими. Сначала пробуем контракт, затем статус заявки.
    icon: (n) => contractIcon(n) || requestStatusIcon(n) || 'ph-arrows-clockwise',
    color: (n) => contractColor(n) || requestStatusColor(n) || 'blue',
    tab: (n) => {
      const action = String(n?.data?.action ?? '');
      // После reload на немигрированной БД data.action может отсутствовать,
      // но message_text всё ещё несёт маркер `i18n:notifications.bodies.
      // contract_*`. Проверяем оба источника — иначе клик по контракт-
      // уведомлению уводил на requests→overview вместо «Партнёров».
      const raw = String(n?.message_text ?? n?.messageText ?? '');
      if (action.startsWith('contract') || raw.includes('contract')) return 'contracts';
      return requestTab(n);
    },
  },
  new_assignment:         { icon: 'ph-clipboard-text',     color: 'blue',   tab: (n) => requestTab(n) },
  due_date:               { icon: 'ph-clock-countdown',    color: 'amber',  tab: (n) => requestTab(n) },
  overdue:                { icon: 'ph-warning-octagon',    color: 'red',    tab: (n) => requestTab(n) },
};
// Fallback now points to #overview — the notifications tab was removed
// and the full feed lives inside the Overview tab.
const FALLBACK_CONFIG = { icon: 'ph-info', color: 'slate', tab: () => 'overview' };

function typeConfig(notif) {
  const cfg = TYPE_CONFIG[notif?.notification_type] ?? FALLBACK_CONFIG;
  // Если icon/color заданы функциями (для status_change.contract_*) —
  // разворачиваем здесь, чтобы остальной код работал с строками.
  return {
    ...cfg,
    icon:  typeof cfg.icon  === 'function' ? cfg.icon(notif)  : cfg.icon,
    color: typeof cfg.color === 'function' ? cfg.color(notif) : cfg.color,
  };
}

/** Иконка для контракт-уведомления по data.action. */
function contractIcon(n) {
  const a = String(n?.data?.action ?? '');
  if (!a.startsWith('contract')) return null;
  if (a.includes('terminat'))     return 'ph-link-break';
  if (a.includes('expired'))      return 'ph-clock-countdown';
  if (a.includes('accepted'))     return 'ph-check-circle';
  if (a.includes('rejected')
   || a.includes('cancelled'))    return 'ph-x-circle';
  if (a.includes('edited'))       return 'ph-pencil-simple';
  if (a.includes('request'))      return 'ph-handshake';
  return null;
}

/** Цветовой тон для контракт-уведомления (как у событий с сотрудниками). */
function contractColor(n) {
  const a = String(n?.data?.action ?? '');
  if (!a.startsWith('contract')) return null;
  if (a === 'contract_accepted')          return 'green';
  if (a === 'contract_rejected'
   || a === 'contract_edit_rejected'
   || a === 'contract_cancelled'
   || a === 'contract_edit_cancelled')    return 'red';
  if (a === 'contract_terminated')        return 'red';
  if (a === 'contract_terminate_request') return 'amber';
  if (a === 'contract_terminate_declined') return 'green';
  if (a === 'contract_expired')           return 'slate';
  if (a === 'contract_edited')            return 'amber';
  return 'blue';
}

/** Иконка для уведомления о смене статуса заявки (data.action='request_*').
 *  Раньше все статусы заявки были одинаково-синими с ph-arrows-clockwise. */
function requestStatusIcon(n) {
  const a = String(n?.data?.action ?? '');
  if (!a.startsWith('request_')) return null;
  if (a === 'request_assigned')    return 'ph-hand-grab';
  if (a === 'request_in_progress') return 'ph-wrench';
  if (a === 'request_done')        return 'ph-check-circle';
  if (a === 'request_closed')      return 'ph-lock-simple';
  if (a === 'request_cancelled')   return 'ph-x-circle';
  return null;
}

/** Цвет уведомления о смене статуса заявки — по семантике события:
 *  прогресс=синий, готова-к-приёмке=янтарь (нужно ваше действие),
 *  закрыта=зелёный (успех), отменена=красный. */
function requestStatusColor(n) {
  const a = String(n?.data?.action ?? '');
  if (!a.startsWith('request_')) return null;
  if (a === 'request_assigned' || a === 'request_in_progress') return 'blue';
  if (a === 'request_done')      return 'amber';
  if (a === 'request_closed')    return 'green';
  if (a === 'request_cancelled') return 'red';
  return 'blue';
}

/**
 * Куда вести по клику на уведомление о заявке — РОЛЬ-ЗАВИСИМО, т.к. лента
 * заявок у руководителя живёт на «Обзоре», а у сотрудника — на «Заявках».
 * Возвращает `<tab>/<id>` (id для подсветки целевой карточки) либо `<tab>`.
 */
function requestTab(n) {
  const base = document.body.dataset.role === 'owner' ? 'overview' : 'requests';
  return n?.request_id ? `${base}/${n.request_id}` : base;
}

/**
 * Возвращает безопасный hash-tab — если запрошенный таб не существует
 * для текущей роли (его tab-panel либо отсутствует в DOM, либо скрыт),
 * fall-back на overview / solo-home в зависимости от роли. Так клик по
 * уведомлению никогда не ведёт на «пустоту».
 *
 * tabSpec — строка вида "members" или "requests/42" или
 * "profile?section=sessions". Базовый sliced до первого `/`,`?` — это
 * имя tab-panel, которое мы и проверяем.
 */
function resolveSafeTab(tabSpec) {
  if (!tabSpec) return safeFallbackTab();
  const baseTab = String(tabSpec).split(/[\/?]/)[0];
  const panel   = document.querySelector(`#tab-${baseTab}`);
  const navItem = document.querySelector(`.nav-item[data-tab="${baseTab}"]`);
  // Таб недоступен для текущей роли, если:
  //   • его tab-panel вообще нет в DOM, ИЛИ
  //   • nav-item существует, но скрыт (display:none) для этой роли.
  // В любом из этих случаев — fall-back, чтобы клик не вёл «в пустоту».
  if (!panel || (navItem && getComputedStyle(navItem).display === 'none')) {
    return safeFallbackTab();
  }
  return tabSpec;
}

function safeFallbackTab() {
  return document.body.dataset.role === 'solo' ? 'solo-home' : 'overview';
}

/* ── Public API ──────────────────────────────────────────────── */

export async function loadNotificationCount() {
  try {
    const data = await notifsApi.getAll({ limit: 50 });
    const items = data.data?.notifications || data.data || [];
    const unread = items.filter(n => !n.read_at).length;
    updateNotifBadge(unread);
  } catch (_) {}
}

export async function loadNotifications() {
  // The notifications tab was retired — the full feed now lives inside the
  // role overview (slot задаётся setNotificationsTarget). Лоадер вешаем на
  // актуальный контейнер рендера.
  const listEl = document.querySelector(_renderTargetSelector);
  const stopLoader = listEl ? attachLoader({ container: listEl }) : null;
  try {
    const data = await notifsApi.getAll({ limit: 100 });
    _notifications = data.data?.notifications || data.data || [];
    renderOverviewNotifs();
    updateNotifBadge(_notifications.filter(n => !n.read_at).length);
  } catch (err) { toast(errorMessage(err), 'error'); }
  finally { stopLoader?.(); }
}

/**
 * Socket handler — push a new notification into the live list, play
 * the sound, re-render.
 *
 * The payload from socket.ts differs slightly in shape from the GET
 * endpoint (socket: `messageText` / `createdAt` / `readAt`; GET:
 * `message_text` / `created_at` / `read_at`). We normalise here so
 * the rest of the module deals with snake_case.
 */
export function addNotification(notif) {
  const normalised = normaliseSocketPayload(notif);
  _notifications.unshift(normalised);
  renderOverviewNotifs();
  updateNotifBadge(_notifications.filter(n => !n.read_at).length);
  // Both side-effects fire here — sound AND a rich corner toast that
  // mirrors the in-list card (title + body + actions) so the user
  // doesn't have to open the bell to find out what just happened.
  playNotificationSound();
  showNotifToast(normalised);
}

// Called from onLangChange — labels are language-dependent.
export function rerender() {
  if (!_notifications.length) return;
  renderOverviewNotifs();
}

/**
 * Public sound playback — can be called from anywhere. Lazy-creates the
 * Audio element. Swallows the autoplay-policy rejection so it never
 * surfaces as an uncaught error in the console.
 *
 * Browser autoplay policy: most browsers REQUIRE a user gesture in the
 * tab before any <audio> can play. We prime the element on the first
 * gesture (see `primeAudio` below) — a silent muted play that the
 * browser allows during a click event, which unlocks subsequent
 * unprompted play() calls. Without this priming the first notification
 * after page load was silent on Chrome/Firefox.
 */
let _audioPrimed = false;

function ensureAudio() {
  if (_audio) return _audio;
  _audio = new Audio('/sounds/notification.mp3');
  _audio.preload = 'auto';
  _audio.volume  = 0.45;
  return _audio;
}

/**
 * One-shot priming run inside a user-gesture handler. The trick: play
 * the file MUTED first (browsers allow muted autoplay), then unmute
 * and reset position. After this run, the AudioElement is "blessed"
 * and subsequent .play() calls work without a gesture.
 */
function primeAudio() {
  if (_audioPrimed) return;
  _audioPrimed = true;
  const a = ensureAudio();
  const wasMuted = a.muted;
  a.muted = true;
  const p = a.play();
  const restore = () => { a.pause(); a.currentTime = 0; a.muted = wasMuted; };
  if (p && typeof p.then === 'function') {
    p.then(restore).catch(() => {
      // Couldn't even play muted — give up gracefully; future calls
      // will hit the same rejection silently.
      _audioPrimed = false;
      a.muted = wasMuted;
    });
  } else {
    restore();
  }
}

// Prime on the very first user gesture anywhere on the page, then
// remove the listeners — pointerdown/keydown both qualify as gestures
// per the autoplay-policy spec.
document.addEventListener('pointerdown', primeAudio, { once: true, capture: true });
document.addEventListener('keydown',     primeAudio, { once: true, capture: true });

export function playNotificationSound() {
  try {
    const a = ensureAudio();
    a.currentTime = 0;
    const p = a.play();
    if (p && typeof p.catch === 'function') p.catch(() => { /* autoplay blocked → silently no-op */ });
  } catch (_) { /* ignore */ }
}

/* ── Corner toast popup ──────────────────────────────────────────
   Lives in its OWN container (#notify-toast-container) so it stacks
   independently from the regular .toast (errors / info) — they have
   different lifecycles (notif toasts are longer-lived and stackable).

   Each toast is essentially a smaller copy of the in-list card:
   tone-coloured icon · title · body · "mark read" + "close" buttons.
   Clicking the toast body (not the buttons) navigates to the same
   href the list item would.
*/
const NOTIF_TOAST_DURATION = 7000;
const NOTIF_TOAST_MAX      = 4;

/**
 * Decide which "action mode" a toast renders.
 *
 *   'owner_decide' — Accept/Reject TEXT buttons. Used ONLY for the
 *                    owner-side join_request (someone wants to join MY
 *                    org). Clicking either action both updates the
 *                    membership AND marks the notification read.
 *
 *   'navigate'     — single "Open" icon button + close X. The default
 *                    for everything else. The "Open" icon is the
 *                    envelope-open glyph (NOT a check) to defuse the
 *                    "accept/reject" ambiguity the check+X pair caused.
 *
 * The detection uses `data.reinvited`: a join_request fired by an
 * org-side re-invite goes to the INVITEE, not the owner — in that case
 * the recipient can't accept/reject (it's their own invitation), so
 * we fall back to 'navigate' mode.
 */
function toastActionMode(notif) {
  if (notif?.notification_type === 'join_request' && !notif?.data?.reinvited) {
    return 'owner_decide';
  }
  return 'navigate';
}

function showNotifToast(notif) {
  const container = ensureNotifToastContainer();
  while (container.children.length >= NOTIF_TOAST_MAX) {
    container.firstElementChild?.remove();
  }

  const cfg   = typeConfig(notif);
  const title = resolveTitle(notif);
  const body  = resolveBody(notif);
  const mode  = toastActionMode(notif);

  // Bottom-action layout differs by mode. Both layouts auto-dismiss
  // the toast on any action button click — the user never has to chase
  // a stale toast.
  const actionsHTML = mode === 'owner_decide'
    ? `<div class="notify-toast-decide">
         <button class="btn btn-primary btn-sm"   data-action="accept">${t('notifications.actions.accept')}</button>
         <button class="btn btn-secondary btn-sm" data-action="reject">${t('notifications.actions.reject')}</button>
       </div>`
    : `<div class="notify-toast-actions">
         <button class="notify-toast-btn" data-action="read"  title="${t('notifications.actions.open')}"  aria-label="${t('notifications.actions.open')}">
           <i class="ph-bold ph-envelope-open"></i>
         </button>
         <button class="notify-toast-btn" data-action="close" title="${t('notifications.actions.close')}" aria-label="${t('notifications.actions.close')}">
           <i class="ph-bold ph-x"></i>
         </button>
       </div>`;

  const el = document.createElement('div');
  el.className = `notify-toast notif-tone-${cfg.color} notify-toast--${mode}`;
  el.innerHTML = `
    <div class="notify-toast-row">
      <div class="notify-toast-icon"><i class="ph-duotone ${cfg.icon}"></i></div>
      <div class="notify-toast-body">
        <p class="notify-toast-title">${escapeHTML(title)}</p>
        ${body && body !== title ? `<p class="notify-toast-text">${escapeHTML(body)}</p>` : ''}
      </div>
      ${mode === 'navigate' ? actionsHTML : ''}
    </div>
    ${mode === 'owner_decide' ? actionsHTML : ''}`;

  // Клик по тосту — одинарный: помечаем прочитанным, закрываем тост и
  // переходим на связанную вкладку (см. TYPE_CONFIG[type].tab). Полный
  // текст показывается при наведении (CSS .notify-toast:hover …), поэтому
  // прежней «двухтактовой» логики (раскрыть → второй клик перейти) больше
  // нет — именно она мешала переходу с одного клика.
  // В owner_decide режиме accept/reject имеют свой stopPropagation ниже.
  el.addEventListener('click', () => {
    if (!notif.read_at) markRead(notif);
    removeToast(el);
    onItemClick(notif);
  });
  el.querySelector('[data-action="read"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    markRead(notif);
    removeToast(el);
  });
  el.querySelector('[data-action="close"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    removeToast(el);
  });
  el.querySelector('[data-action="accept"]')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    await decideJoinRequest(notif, 'approved', el);
  });
  el.querySelector('[data-action="reject"]')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    await decideJoinRequest(notif, 'rejected', el);
  });

  container.appendChild(el);

  let timer = setTimeout(() => removeToast(el), NOTIF_TOAST_DURATION);
  el.addEventListener('mouseenter', () => { clearTimeout(timer); timer = null; });
  el.addEventListener('mouseleave', () => { timer = setTimeout(() => removeToast(el), NOTIF_TOAST_DURATION); });
}

/**
 * Owner-side accept/reject handler for join_request toasts.
 * Calls the same PATCH /orgs/members/manage endpoint the Members tab
 * uses, then auto-marks the notification as read (per UX spec: the
 * decision IS the reading) and dismisses the toast.
 *
 * On failure: rollback the optimistic read state and surface a toast.
 */
async function decideJoinRequest(notif, action, toastEl) {
  const userId = notif?.data?.userId;
  if (!userId) {
    toast(errorMessage(new Error('Missing user id')), 'error');
    return;
  }

  // Disable both buttons while the network is in-flight so a double
  // click doesn't fire two manage() calls.
  toastEl?.querySelectorAll('button[data-action="accept"], button[data-action="reject"]')
    .forEach(b => { b.disabled = true; });

  try {
    await membersApi.manage(userId, action);
    // Decision counts as read — flip the row and refresh the badge.
    if (!notif.read_at) await markRead(notif);
    toast(t(action === 'approved' ? 'notifications.actions.accepted_toast' : 'notifications.actions.rejected_toast'), 'ok');
    removeToast(toastEl);
    // Synchronise members list + profile (employee-count в шапке орги)
    // и любой текущий dashboard. Backend сам шлёт socket-уведомление
    // юзеру, но toast-action происходит у OWNER'а — его собственный
    // dashboard не получает push (он сам инициировал change). Эмулируем
    // тот же refresh-bus.
    window.dispatchEvent(new CustomEvent('rems:reload-profile'));
    window.dispatchEvent(new CustomEvent('rems:reload-members'));
  } catch (err) {
    toastEl?.querySelectorAll('button[data-action="accept"], button[data-action="reject"]')
      .forEach(b => { b.disabled = false; });
    toast(errorMessage(err), 'error');
  }
}

function removeToast(el) {
  if (!el || !el.isConnected) return;
  el.classList.add('notify-toast-leaving');
  setTimeout(() => el.remove(), 260);
}

function ensureNotifToastContainer() {
  let c = document.getElementById('notify-toast-container');
  if (!c) {
    c = document.createElement('div');
    c.id = 'notify-toast-container';
    document.body.appendChild(c);
  }
  return c;
}

/* ── Rendering ───────────────────────────────────────────────── */

// Render-target задаёт оркестратор дашборда: solo → #solo-notifs-slot,
// owner/employee → #employee-notifs-slot (карточка внутри overview-слота).
// До первого setNotificationsTarget ленты на экране ещё нет.
let _renderTargetSelector = '#employee-notifs-slot';
export function setNotificationsTarget(selector) {
  _renderTargetSelector = selector || '#employee-notifs-slot';
  // Если в новом контейнере уже есть данные — рендерим в него сразу.
  renderOverviewNotifs();
}

function renderOverviewNotifs() {
  // Sync the segmented filter UI (counts + active state) even if the
  // feed container isn't on screen (it lives in #overview-notifs which
  // only the owner/employee dashboards render). The filter host's
  // own visibility is owned by HTML.
  syncFilterUI();

  const el = document.querySelector(_renderTargetSelector);
  if (!el) return;

  const items = _filter === 'unread'
    ? _notifications.filter(n => !n.read_at)
    : _notifications;

  if (!items.length) {
    // Empty-state text varies by filter — «Нет непрочитанных» если фильтр
    // активен, иначе общий «Нет уведомлений». Это снимает у юзера
    // когнитивный диссонанс: «у меня 12 уведомлений, но я вижу пусто».
    const emptyKey = _filter === 'unread' && _notifications.length
      ? 'notifications.empty_unread'
      : 'notifications.empty';
    el.innerHTML = `<div class="empty-state" style="padding:2rem;"><i class="ph ph-bell-slash"></i><p class="empty-state-text">${t(emptyKey)}</p></div>`;
    return;
  }
  el.innerHTML = items.map(notifItemHTML).join('');
  bindItemHandlers(el, items);
}

function syncFilterUI() {
  // Поддерживаем сразу несколько фильтр-хостов на странице (например,
  // owner/employee overview + solo home). Все они синхронизируются с
  // одним глобальным _filter — клик в любом отражается во всех.
  const hosts = document.querySelectorAll('[data-notif-filter-host]');
  if (!hosts.length) return;
  const unreadCount = _notifications.filter(n => !n.read_at).length;
  hosts.forEach(host => {
    host.querySelectorAll('.notif-filter-btn').forEach(btn => {
      const active = btn.getAttribute('data-filter') === _filter;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    host.querySelectorAll('[data-unread-count]').forEach(el => {
      el.textContent = unreadCount > 0 ? String(unreadCount > 99 ? '99+' : unreadCount) : '';
      el.style.display = unreadCount > 0 ? '' : 'none';
    });
  });
}

/**
 * Attach click + per-button handlers to a freshly-rendered container.
 * `items` mirrors the rendered slice so index → notification works.
 */
function bindItemHandlers(container, items) {
  container.querySelectorAll('.notification-item').forEach((el, i) => {
    const notif = items[i];

    // Одинарный клик = переход на связанную вкладку. Полный текст
    // уведомления раскрывается при наведении (hover) — за это отвечает
    // CSS-правило .notification-item:hover .notification-body, поэтому
    // здесь больше нет «двухтактовой» логики (раскрыть → второй клик
    // перейти): именно она создавала ощущение, что клик «не работает».
    el.addEventListener('click', () => onItemClick(notif));

    // Per-action buttons. Read/unread are mutually exclusive by render,
    // so at most one is in the DOM at any time per row.
    el.querySelector('[data-action="read"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      markRead(notif);
    });
    el.querySelector('[data-action="unread"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      markUnread(notif);
    });
  });
}

function notifItemHTML(n) {
  const unread = !n.read_at;
  const expanded = !!n._expanded;
  const cfg    = typeConfig(n);
  const title  = resolveTitle(n);
  const body   = resolveBody(n);
  const time   = formatRelativeTime(n.created_at);

  const actionBtn = unread
    ? `<button class="notif-action" data-action="read"   title="${t('notifications.mark_read')}" aria-label="${t('notifications.mark_read')}">
         <i class="ph-bold ph-check"></i>
       </button>`
    : `<button class="notif-action" data-action="unread" title="${t('notifications.mark_unread')}" aria-label="${t('notifications.mark_unread')}">
         <i class="ph-bold ph-arrow-counter-clockwise"></i>
       </button>`;

  // BODY is rendered ONLY if it's distinct from the title — for static
  // notifications (no extra context) the title alone is enough and a
  // duplicate line would be noise.
  const bodyHTML = body && body !== title
    ? `<p class="notification-body">${escapeHTML(body)}</p>`
    : '';

  return `
    <div class="notification-item notif-tone-${cfg.color} ${unread ? 'unread' : ''}${expanded ? ' is-expanded' : ''}"
         data-id="${n.id}" data-type="${n.notification_type}" role="button" tabindex="0">
      <div class="notification-icon"><i class="ph-duotone ${cfg.icon}"></i></div>
      <div class="notification-content">
        <p class="notification-title">${escapeHTML(title)}</p>
        ${bodyHTML}
        <p class="notification-time">${time}</p>
      </div>
      <div class="notification-actions">
        ${actionBtn}
        ${unread ? '<div class="notif-unread-dot" aria-hidden="true"></div>' : ''}
      </div>
    </div>`;
}

/**
 * Title resolver — always derives from notification_type so the title
 * automatically follows the user's current language. Unknown types
 * fall back to a generic "Notification" label.
 *
 * Exported so the toast popup in dashboard.js renders the same title.
 */
export function resolveTitle(n) {
  const type = n?.notification_type ?? n?.type;
  if (!type) return t('notifications.types.unknown');
  // Subtype overrides: переиспользуем enum-член 'join_rejected' для
  // нескольких семантически разных событий (без расширения CHECK
  // constraint в БД). Различаем по data.action ИЛИ — если data не
  // дошло (например, после reload персистнутая запись из notifications
  // не имеет data-колонки) — по messageText, в которую запихан
  // i18n-ключ конкретного подтипа.
  const action = n?.data?.action;
  const rawMsg = String(n?.message_text ?? n?.messageText ?? '');
  if (type === 'join_rejected') {
    if (action === 'removed_by_owner'       || rawMsg.includes('removed_by_owner'))
      return t('notifications.types.removed_by_owner');
    if (action === 'withdrawn_by_applicant' || rawMsg.includes('withdrawn_by_applicant'))
      return t('notifications.types.withdrawn_by_applicant');
    if (action === 'left_org'               || rawMsg.includes('member_left_org'))
      return t('notifications.types.member_left_org');
  }
  if (type === 'join_request' && (action === 'invited_by_org' || rawMsg.includes('invited_by_org'))) {
    return t('notifications.types.invited_by_org');
  }
  // Контракты: status_change + data.action='contract_*'. Заголовок —
  // по конкретному действию; имя контракта подставляется в тело (body).
  // action может быть undefined для не-контрактных status_change (смена
  // статуса заявки) — приводим к строке, иначе .startsWith() кидает
  // TypeError и ломает рендер заголовка всей карточки/тоста.
  if (type === 'status_change' && String(action ?? '').startsWith('contract')) {
    return t(`notifications.types.${action}`);
  }
  // Owner-side join_request — дублируем имя заявителя в title.
  if (type === 'join_request' && n?.data?.applicantName) {
    return t('notifications.types.join_request_from', { name: n.data.applicantName });
  }
  if (type === 'join_accepted' && (action === 'invitee_accepted' || rawMsg.includes('invitee_accepted'))) {
    return t('notifications.types.invitee_accepted');
  }
  if (type === 'join_accepted' && (action === 'invitee_joined_via_link' || rawMsg.includes('invitee_joined_via_link'))) {
    return t('notifications.types.invitee_joined_via_link');
  }
  return t(`notifications.types.${type}`);
}

/**
 * Body resolver — hybrid. Detects three shapes for message_text:
 *
 *   "i18n:notifications.bodies.foo"
 *     → modern i18n marker; translate the key after `i18n:`. Supports
 *       optional {{placeholder}} interpolation against n.data.
 *
 *   "notification.foo"
 *     → legacy format written before migration 002 / the messageText
 *       refactor. Treated as an i18n key under `notifications.bodies.*`
 *       so older rows in the DB don't render as raw "notification.foo".
 *
 *   anything else
 *     → plain text; escaped on render.
 *
 * Exported so the toast popup uses the same resolution.
 */
export function resolveBody(n) {
  const raw  = n?.message_text ?? n?.messageText ?? '';
  const data = n?.data || {};
  if (typeof raw !== 'string' || !raw) return '';
  if (raw.startsWith('i18n:')) {
    return t(raw.slice(5), data);
  }
  // Legacy: "notification.<type>" — older rows persisted this shape
  // before the i18n: prefix convention. Map them onto the new keys.
  if (raw.startsWith('notification.')) {
    const type = raw.slice('notification.'.length);
    const key  = `notifications.bodies.${type}_default`;
    const out  = t(key, data);
    // If the key is missing the locale bundle, t() returns the key
    // itself — in that case prefer falling back to the per-TYPE title
    // so the user at least sees a meaningful sentence, not a debug
    // marker like `notifications.bodies.foo_default`.
    if (out === key) return t(`notifications.types.${type}`);
    return out;
  }
  return raw;
}

/** @deprecated keep for one release in case external callers exist */
export const resolveMessage = resolveBody;

/* ── Mutators ────────────────────────────────────────────────── */

function onItemClick(notif) {
  // Auto-mark as read on click. Optimistic + fire-and-forget; if the
  // request fails the badge will reconcile on the next loadNotifications.
  if (!notif.read_at) markRead(notif);
  const cfg = typeConfig(notif);
  try {
    // Берём `tab` (новый contract) или `href` (legacy) и кладём в
    // resolveSafeTab — он подменит несуществующие для текущей роли
    // вкладки на overview/solo-home.
    let tabSpec;
    if (typeof cfg.tab === 'function')      tabSpec = cfg.tab(notif);
    else if (typeof cfg.tab === 'string')   tabSpec = cfg.tab;
    else if (typeof cfg.href === 'function') tabSpec = String(cfg.href(notif)).split('#')[1] || '';
    else if (typeof cfg.href === 'string')   tabSpec = String(cfg.href).split('#')[1] || '';
    tabSpec = resolveSafeTab(tabSpec);
    const href = `/pages/dashboard.html#${tabSpec}`;
    if (!href) return;
    // Если URL — это тот же dashboard.html с другим hash'ем — меняем только
    // hash, чтобы НЕ дёрнуть PIN-gate (это in-system навигация, юзер не
    // должен заново подтверждать личность). Полный location.href set может
    // в некоторых сценариях привести к reload (если текущий URL без hash'а),
    // что попадёт под PIN-gate.
    const isSamePage = href.startsWith('/pages/dashboard.html')
                    && location.pathname.endsWith('/pages/dashboard.html');
    if (isSamePage) {
      const hashIdx = href.indexOf('#');
      const newHash = hashIdx >= 0 ? href.slice(hashIdx) : '';
      // Сначала ставим hash (это никогда не вызовет reload), потом
      // диспатчим hashchange — на случай, если hash совпал с текущим
      // (тогда нативный event не выстрелит, а tab-switcher его слушает).
      const prev = location.hash;
      location.hash = newHash;
      if (prev === newHash) window.dispatchEvent(new HashChangeEvent('hashchange'));
    } else {
      window.location.href = href;
    }
  } catch (_) { /* navigation issue is non-fatal */ }
}

async function markRead(notif) {
  if (notif.read_at) return;
  // Optimistic update + sync with server.
  notif.read_at = new Date().toISOString();
  refreshAll();
  try {
    await notifsApi.markRead(notif.id);
  } catch (err) {
    // Roll back on failure.
    notif.read_at = null;
    refreshAll();
    toast(errorMessage(err), 'error');
  }
}

async function markUnread(notif) {
  if (!notif.read_at) return;
  const prev = notif.read_at;
  notif.read_at = null;
  refreshAll();
  try {
    await notifsApi.markUnread(notif.id);
  } catch (err) {
    notif.read_at = prev;
    refreshAll();
    toast(errorMessage(err), 'error');
  }
}

function refreshAll() {
  renderOverviewNotifs();
  updateNotifBadge(_notifications.filter(n => !n.read_at).length);
}

function updateNotifBadge(count) {
  // Single surface now — the bell-pin chip in the navbar (`#notif-dot`,
  // also used by the landing page's `#nav-bell-dot`). The sidebar tab
  // badge `#notif-badge` is gone (the notifications tab itself was
  // retired). Cap label at "9+" so the chip stays one character wide.
  const label = count > 9 ? '9+' : String(count);
  document.querySelectorAll('#notif-dot, #nav-bell-dot').forEach(dot => {
    dot.textContent  = count > 0 ? label : '';
    dot.style.display = count > 0 ? '' : 'none';
  });
}

/* ── Helpers ─────────────────────────────────────────────────── */

/**
 * Socket events use camelCase keys; GET responses use snake_case.
 * Normalise to snake_case so the render functions stay simple.
 */
function normaliseSocketPayload(p) {
  return {
    id:                p.notificationId ?? p.id,
    organization_id:   p.orgId ?? p.organization_id,
    recipient_id:      p.recipientId ?? p.recipient_id,
    request_id:        p.requestId ?? p.request_id,
    notification_type: p.type ?? p.notification_type,
    message_text:      p.messageText ?? p.messageKey ?? p.message_text ?? '',
    read_at:           p.readAt ?? p.read_at ?? null,
    created_at:        p.createdAt ?? p.created_at ?? new Date().toISOString(),
    data:              p.data ?? {},
  };
}

function formatRelativeTime(isoStr) {
  if (!isoStr) return '';
  const diff  = Date.now() - new Date(isoStr).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  const lang  = getLang();
  if (mins < 1)   return lang === 'en' ? 'just now'     : 'только что';
  if (mins < 60)  return lang === 'en' ? `${mins}m ago`  : `${mins} мин. назад`;
  if (hours < 24) return lang === 'en' ? `${hours}h ago` : `${hours} ч. назад`;
  if (days < 7)   return lang === 'en' ? `${days}d ago`  : `${days} д. назад`;
  return new Date(isoStr).toLocaleDateString(lang === 'en' ? 'en-US' : 'ru-RU');
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Segmented filter (All / Unread) wire-up ──────────────────── */

// Event-delegated so it works even if the dashboard re-mounts the
// filter host (e.g. after a role swap that re-renders the chrome).
document.addEventListener('click', (e) => {
  const btn = e.target?.closest?.('.notif-filter-btn');
  if (!btn) return;
  const host = btn.closest('[data-notif-filter-host]');
  if (!host) return;
  const next = btn.getAttribute('data-filter');
  if (!next || next === _filter) return;
  _filter = next;
  refreshAll();
});

/* ── "Mark all as read" wire-up ───────────────────────────────── */

// Делегированный обработчик: ловим клики и по #btn-mark-all-read
// (overview/owner/employee), и по любому элементу с [data-mark-all-read]
// (solo home, потенциально другие места). Это позволяет иметь несколько
// «Прочитать все» кнопок на странице без дублирования логики.
document.addEventListener('click', async (e) => {
  const btn = e.target?.closest?.('#btn-mark-all-read, [data-mark-all-read]');
  if (!btn) return;
  const unread = _notifications.filter(n => !n.read_at);
  if (!unread.length) return;
  // Optimistic: clear local state first, then call the single bulk
  // endpoint. The previous Promise.all-of-N approach is gone — server
  // now owns the bulk transition in one statement.
  const stamp = new Date().toISOString();
  _notifications.forEach(n => { if (!n.read_at) n.read_at = stamp; });
  refreshAll();
  try {
    await notifsApi.markAllRead();
    toast(t('toasts.all_marked_as_read'), 'ok');
  } catch (err) {
    // Best-effort rollback — flip back any rows we just stamped.
    _notifications.forEach(n => { if (n.read_at === stamp) n.read_at = null; });
    refreshAll();
    toast(errorMessage(err), 'error');
  }
});
