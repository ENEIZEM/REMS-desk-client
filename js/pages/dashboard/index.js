/* ═══════════════════════════════════════════════════════════════
   REMS — Dashboard page logic
   Tabs: overview, requests, equipment, notifications, members, org, profile
   ═══════════════════════════════════════════════════════════════ */

import { auth, profile, org, members } from '../../api.js';
import { requireAuth, logout, toast, errorMessage }    from '../../auth.js';
import { t, initI18n, getLang, onLangChange }          from '../../i18n.js';
import { connectSocket, on as socketOn }               from '../../socket.js';
import { wireFormGuard }                               from '../../form-guard.js';
import { wireMediaAttach }                             from '../../media-attach.js';
import {
  statusBadge,
  orgStatusBadge,
  roleBadgeDescriptor,
  renderIconBadge,
  renderRowChip,
} from './badges.js';
import { loadSessions } from './sessions.js';
import {
  loadNotifications,
  loadNotificationCount,
  addNotification,
  rerender as rerenderNotifications,
} from './notifications.js';
import {
  openModal,
  closeModal,
  setLoading,
  setFieldError,
  clearFieldErrorById,
  showAlertText,
  hideAlertById,
} from './ui-helpers.js';
import { wireFieldEdit }      from './modals/field-edit.js';
import { wireChangePassword } from './modals/change-password.js';
import { wireChangePin }      from './modals/change-pin.js';
import { wireChangeContact,  openChangeContact  } from './modals/change-contact.js';
import { wireDetachContact,  openDetachContact  } from './modals/detach-contact.js';
import { fmtDate, setAvatar, initials, roleLabel } from './format.js';
import { renderProfileTab }     from './tabs/profile.js';
import { populateOrgTab }       from './tabs/organization.js';
import { attachLoader }         from '../../lib/lazy-loader.js';
import { phoneChannelEnabled, loadFeatures }  from '../../config.js';
import '../../lib/char-counter.js';   // авто-счётчики символов в модалках
import { hidePageLoader }       from '../../lib/page-loader.js';
import { consumePinPass }       from '../../lib/pin-gate.js';
import { requirePinUnlock }     from './pin-lock.js';
import { openImageViewer }      from '../../lib/media-viewer.js';
import { q }                    from './dom-utils.js';
import { initSidebar }          from './chrome/sidebar.js';
import { initUserDropdown }     from './chrome/user-dropdown.js';
import { initNotificationsButton } from './chrome/notifications-button.js';
import { initMembers, loadMembers } from './members.js';

// Hide the pre-paint navigation overlay the INSTANT JS starts running.
// Per the revised timing spec ("page started rendering" = drop the
// spinner) — we no longer wait for profile data. The in-page loaders
// (attachLoader on loadProfile etc.) handle their own feedback with
// the 500 ms threshold.
hidePageLoader();

// ── Init ──────────────────────────────────────────────────────────
await initI18n();
// Подтягиваем feature-флаги (telephone-канал и пр.) до построения UI,
// который от них зависит (кнопка телефона, инвайт). Безопасный дефолт.
await loadFeatures();
if (!requireAuth()) throw new Error('not logged in');

// ── PIN gate ──────────────────────────────────────────────────────
// JWT живёт 30 дней в localStorage. Чтобы перезагрузка страницы (или
// открытие новой вкладки на этом же домене) не давала тихий доступ к
// дашборду — между загрузкой и стартом приложения требуем PIN.
//
// Исключение: вход только что произошёл (login/register) — там юзер
// уже ввёл PIN или только что его задал. Эти эндпоинты выставляют
// one-shot флаг через grantPinPass(); consumePinPass() читает + удаляет
// его. Если флага нет — показываем overlay и ждём verifyPin.
if (!consumePinPass()) {
  await requirePinUnlock();
}

// ─────────────────────────────────────────────────────────────────
// TAB NAVIGATION
// ─────────────────────────────────────────────────────────────────
// `notifications` is no longer a top-level tab — the full feed lives
// inside each role's overview slot. Keeping the legacy hash alias
// `#notifications` is handled below (it redirects to overview so old
// toast → href links don't 404).
const TAB_IDS = ['overview', 'requests', 'catalog', 'partners', 'members', 'contracts', 'org', 'profile', 'solo-home'];
let currentTab = 'overview';

function switchTab(name, { updateHash = true } = {}) {
  if (!TAB_IDS.includes(name)) return;
  currentTab = name;
  document.querySelectorAll('.nav-item[data-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === name);
  });
  TAB_IDS.forEach(id => {
    document.getElementById(`tab-${id}`)?.classList.toggle('active', id === name);
  });
  // Sync URL hash so a hard-reload or shared link reopens the same tab.
  // We do this with replaceState to avoid polluting browser history with
  // every sidebar click.
  if (updateHash) {
    try {
      const nextHash = '#' + name;
      if (location.hash !== nextHash) {
        history.replaceState(null, '', location.pathname + location.search + nextHash);
      }
    } catch {}
  }
  // Notifications tab was retired — the feed now lives inside the
  // Overview tab, so we refresh it on every Overview visit.
  if (name === 'overview')      loadNotifications();
  if (name === 'members')       loadMembers();
  if (name === 'org')           loadOrgProfile();
  if (name === 'profile')       loadSessions();    // refresh session list each open
}

document.querySelectorAll('.nav-item[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});
// «Это вы» в списке коллег — клик ведёт на вкладку профиля. Делегировано
// на document, т.к. строки коллег пересоздаются при ре-рендере.
document.addEventListener('click', (e) => {
  if (e.target.closest?.('.members-row-self')) switchTab('profile');
});
document.querySelectorAll('[data-tab-trigger]').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tabTrigger));
});

// Open the tab matching #hash on initial load (e.g. landing-header
// "Профиль" link → /pages/dashboard.html#profile) AND on hashchange
// (e.g. user presses Back).
function applyHashTab() {
  // Hash может быть «#profile?section=sessions» или «#requests/42» —
  // обрезаем после первого '?' / '/' до базового имени вкладки.
  let tab = (location.hash || '').replace(/^#/, '');
  tab = tab.split(/[?\/]/)[0];
  const role = document.body.dataset.role;
  // Solo-юзер: на скрытые вкладки (overview/requests/etc) → solo-home.
  if (role === 'solo' && tab !== 'solo-home' && tab !== 'profile') {
    switchTab('solo-home', { updateHash: false });
    return;
  }
  // employee/owner: на #solo-home (могли быть на нём как solo и потом
  // получить approve) → overview.
  if (role !== 'solo' && tab === 'solo-home') {
    switchTab('overview', { updateHash: false });
    return;
  }
  // Если хэш указывает на скрытый/недоступный для роли таб — overview.
  if (tab && TAB_IDS.includes(tab)) {
    const panel = document.getElementById(`tab-${tab}`);
    const navItem = document.querySelector(`.nav-item[data-tab="${tab}"]`);
    // ВАЖНО: НЕ опираемся на computed display панели — у любой неактивной
    // tab-panel display:none (см. .tab-panel{} в style.css), поэтому
    // переход по hash на ещё-не-активную вкладку ложно считался «скрытой
    // для роли» и сбрасывал на overview (баг: клик по уведомлению о
    // контракте не открывал «Партнёров»). Роль-недоступность определяем
    // по классу .hidden (его ставит hide() в role-helpers) и по скрытому
    // nav-item.
    const panelHidden = panel && panel.classList.contains('hidden');
    const navHidden = navItem && getComputedStyle(navItem).display === 'none';
    if (panelHidden || navHidden) {
      switchTab(role === 'solo' ? 'solo-home' : 'overview', { updateHash: false });
      return;
    }
    switchTab(tab, { updateHash: false });
    // #overview/<id> | #requests/<id> (клик по уведомлению о заявке) →
    // подсветить целевую карточку. Лента у owner на «Обзоре», у employee
    // на «Заявках» — поддерживаем оба базовых таба.
    if (tab === 'requests' || tab === 'overview') {
      const m = (location.hash || '').match(/#(?:overview|requests)\/(\d+)/);
      if (m) document.dispatchEvent(new CustomEvent('rems:focus-request', { detail: { id: Number(m[1]) } }));
    }
    return;
  }
  // Нет хэша — дефолтный для роли.
  if (!tab) switchTab(role === 'solo' ? 'solo-home' : 'overview', { updateHash: false });
}
window.addEventListener('hashchange', applyHashTab);
// "settings" is currently mapped to the same panel as "profile" — keep it
// here so the landing-header dropdown link works.
if (location.hash === '#settings') switchTab('profile', { updateHash: false });
else applyHashTab();

// ─────────────────────────────────────────────────────────────────
// CHROME — user dropdown, sidebar toggle, notifications bell. Each is
// self-contained in ./chrome/*; they only need switchTab injected.
// ─────────────────────────────────────────────────────────────────
initUserDropdown({ switchTab });
initSidebar();
initNotificationsButton({ switchTab });

// ─────────────────────────────────────────────────────────────────
// MODAL HELPERS — primitives live in ./dashboard/ui-helpers.js.
// What remains here is the page-wide [data-close-modal] delegation.
// ─────────────────────────────────────────────────────────────────
document.querySelectorAll('[data-close-modal]').forEach(btn => {
  btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
});
// Backdrop click does NOT close the modal. Every modal has explicit
// Cancel / Back / × buttons — accidental outside-clicks would otherwise
// wipe whatever the user had typed.

// ─────────────────────────────────────────────────────────────────
// LOAD USER PROFILE
// ─────────────────────────────────────────────────────────────────
let _userProfile = null;
// Verified contacts the user can prove ownership of for step-up auth
// (change password / change contact). Populated by loadProfile().
let _availableContacts = [];

let _userPermissions = {};
let _orgData         = null;

let _loadProfileInflight = false;
async function loadProfile() {
  // Деблокируем параллельные вызовы — если два notification'а пришли
  // подряд, обе попытки сделают role-router и могут гонять. Просто
  // игнорируем второй вызов пока первый не завершился.
  if (_loadProfileInflight) return;
  _loadProfileInflight = true;
  // Full-page loader: appears only if /api/profile/me takes > 1.5 s,
  // and once shown stays for at least 1.5 s so it never strobes.
  const stopLoader = attachLoader({ container: document.body });
  try {
    const resp  = await profile.get();
    const user  = resp.data?.user         ?? resp.data;
    const org   = resp.data?.organization ?? null;
    const perms = resp.data?.permissions  ?? {};
    _userProfile        = user;
    _userPermissions    = perms;
    _orgData            = org;
    _availableContacts  = Array.isArray(resp.data?.available_contacts)
      ? resp.data.available_contacts
      : [];

    // ── Role-router: определяем роль и mount'им соответствующий
    // дашборд. Re-mount триггерится КАЖДЫЙ раз когда:
    //   • роль изменилась (solo → employee после approve),
    //   • ИЛИ остаёмся solo, но membership_status изменился
    //     (null → pending после join, rejected → null после leave) —
    //     solo home должен перерисовать badge и кнопку.
    // location.reload() намеренно НЕ используем — он триггерит PIN-gate
    // (referrer пустой/dashboard). In-place re-mount чище.
    try {
      // pending_org нужен solo home для текста кнопки «Отменить запрос в [orgName] (ID X)».
      // Без него orgLabel остаётся пустой и кнопка показывается без идентификатора.
      const profileResponse = {
        user,
        organization: org,
        membership: resp.data?.membership,
        pending_org: resp.data?.pending_org ?? null,
      };
      const { detectRole, applyRoleAttributes, loadDashboardForRole } =
        await import('./role-router.js');
      const detectedRole   = detectRole(profileResponse);
      const currentRole    = document.body.dataset.role;
      const currentStatus  = document.body.dataset.membership || '';
      const newStatus      = String(user.membership_status || '');
      const roleChanged    = detectedRole !== currentRole;
      const statusChanged  = newStatus !== currentStatus;
      if (!window.__remsRoleBooted || roleChanged || (detectedRole === 'solo' && statusChanged)) {
        const wasBooted = window.__remsRoleBooted;
        window.__remsRoleBooted = true;
        // Прячем сайдбар-навигацию на время (ре)монтажа: до того как
        // оркестратор роли скроет лишние пункты, статический HTML показал бы
        // полный набор вкладок (флеш «8 вкладок»). Возвращаем в finally
        // loadProfile, когда состояние навигации уже корректное.
        document.body.classList.remove('rems-nav-ready');
        // КРИТИЧНО при смене дашборда: предыдущий orchestrator мог
        // выставить inline style.display='none' на tab-panels и
        // nav-items (hide() из role-helpers.js). Эти inline styles
        // overrideят CSS .active rule — switchTab() для новой роли
        // не сможет показать нужную панель. Сбрасываем все
        // tab-panel inline-display перед сменой роли.
        if (roleChanged) {
          document.querySelectorAll('.tab-panel').forEach(el => {
            el.style.display = '';
            el.classList.remove('hidden');
            // .tab-fill — модификатор viewport-fill для tab'ов с
            // list-блоками. При смене роли сбрасываем; следующий
            // boot re-applyит где нужно.
            el.classList.remove('tab-fill');
          });
          document.querySelectorAll('.nav-item').forEach(el => {
            el.style.display = '';
            el.classList.remove('hidden');
          });
          // КРИТИЧНО: сбросить inline display + 'hidden' класс на
          // ВСЕХ data-role-only-слотах. Иначе при смене solo→employee
          // слот #employee-overview-slot (его solo-boot скрыл через
          // hide('[data-role-only="employee"]')) остаётся inline
          // display:none — даже после переключения роли. Слот
          // ЗАПОЛНЕН (mount запустился), но НЕ виден. После сброса
          // CSS-правила [data-role-only] по body[data-role] всё ставят
          // на свои места автоматически.
          document.querySelectorAll('[data-role-only]').forEach(el => {
            el.style.display = '';
            el.classList.remove('hidden');
          });
          // org-nav-section тоже скрыт у solo — открываем обратно для
          // employee/owner (их оркестратор сам решит видимость).
          const orgNav = document.querySelector('#org-nav-section');
          if (orgNav) orgNav.style.display = '';
          // Restore «Обзор» tab-link если был переименован в «Главная»
          // в solo dashboard (data-tab переключался на solo-home).
          const homeBtn = document.querySelector('.nav-item[data-tab="solo-home"]');
          if (homeBtn) {
            homeBtn.dataset.tab = 'overview';
            const span = homeBtn.querySelector('span');
            // Возвращаем И data-i18n (solo выставлял 'nav.home'), И текст —
            // иначе applyTranslations() позже вернул бы лейбл "Главная/Home"
            // на не-solo дашборде.
            if (span) {
              span.setAttribute('data-i18n', 'nav.dashboard');
              span.textContent = t('nav.dashboard') || 'Обзор';
            }
          }
        }
        applyRoleAttributes(detectedRole, user.membership_status);
        const boot = await loadDashboardForRole(detectedRole);
        // boot() в собственном try/catch — если в mount-функции какой-то
        // роли произошла ошибка, без try/catch её ловит ВНЕШНИЙ catch и
        // switchTab НЕ вызывается → пустой дашборд до reload.
        let mountFailed = false;
        try { boot?.(profileResponse); }
        catch (mountErr) {
          mountFailed = true;
          console.error('[dashboard mount] failed:', mountErr);
        }
        if (!wasBooted || roleChanged) {
          switchTab(detectedRole === 'solo' ? 'solo-home' : 'overview');
          // 3-tier safety net против пустого дашборда после смены роли:
          //   1. queueMicrotask — повтор сразу после текущего стека.
          //   2. requestAnimationFrame — после первого paint.
          //   3. setTimeout 150ms — последний шанс (на случай если
          //      DOM-перестройки ещё в полёте).
          // Каждый tier проверяет slot.innerHTML; если уже заполнен —
          // выходит без повторного mount'а.
          const slotId = detectedRole === 'solo'
            ? '#solo-home-slot'
            : detectedRole === 'employee'
              ? '#employee-overview-slot'
              : '#owner-overview-slot';
          const tryRemount = (tier) => {
            const slot = document.querySelector(slotId);
            if (!slot) return;
            if (slot.innerHTML.trim()) return;
            console.warn(`[dashboard ${tier}] slot empty — remounting`);
            try { boot?.(profileResponse); }
            catch (e) { console.error(`[dashboard ${tier} remount] failed:`, e); }
          };
          queueMicrotask(() => tryRemount('microtask'));
          requestAnimationFrame(() => tryRemount('raf'));
          setTimeout(() => tryRemount('timeout'), 150);
        } else if (roleChanged === false) {
          applyHashTab();
        }
      }
    } catch (e) {
      console.error('[role-router] failed:', e);
    }

    const role     = user.org_role || user.role;
    const isOwner  = role === 'owner';
    const canEditOrg = !!perms.can_edit_organization;
    const canEditLim = !!perms.can_edit_limits;
    const hasOrg     = !!org && user.membership_status === 'approved';

    // ── Navbar mini-avatar + dropdown identity block ───────────
    setAvatar(q('#nav-avatar-initials'), q('#nav-avatar-img'), user);
    q('#dd-name').textContent  = user.full_name || '—';
    q('#dd-email').textContent = user.email_masked || user.phone_masked || '—';

    // Org row in the dropdown: name + role-or-status pill, clickable → #org.
    // Approved members get the role pill (gold/teal/etc.). Pending/rejected/
    // suspended/no-org users get the status pill so they understand WHY the
    // dashboard might be limited.
    const ddOrgEl  = q('#dd-org');
    const ddPillEl = q('#dd-pill');
    if (ddOrgEl)  ddOrgEl.textContent = org?.name || '—';
    if (ddPillEl) {
      if (hasOrg && role) {
        renderRowChip(ddPillEl, roleBadgeDescriptor(role));
      } else {
        renderRowChip(ddPillEl, statusBadge(user.membership_status));
      }
    }
    // Hide the org link entirely when there is no org row to navigate to.
    const ddOrgLink = q('#dd-org-link');
    if (ddOrgLink) ddOrgLink.style.display = hasOrg ? '' : 'none';

    updateWelcome(user);

    // ── Profile tab (identity strip + 2 cards) ─────────────────
    renderProfileTab(user, role, isOwner, org?.created_at);

    // ── ORG TAB visibility — only when approved member of an org ──
    const navItemOrg = q('#nav-item-org');
    if (navItemOrg) navItemOrg.style.display = hasOrg ? '' : 'none';
    if (!hasOrg && currentTab === 'org') switchTab('profile', { updateHash: true });

    // Sidebar Organization section visibility:
    //   · Section header ("Организация") shows for ANY approved member
    //     (so newly-approved employees see the section + their org tab).
    //   · "Сотрудники" sub-item is owner-only (manage-others permission).
    //   · "Ваша организация" sub-item is approved-member-only — handled
    //     above near `navItemOrg.style.display = hasOrg ? ...`.
    // This is the fix for the "approved employee can't see their org tab"
    // bug: previously the entire section was gated on `canManage`, which
    // hid the org link from any non-owner.
    const canManage = role === 'owner';
    q('#org-nav-section').style.display    = hasOrg                ? '' : 'none';
    // Members tab — для ВСЕХ approved-членов: owner видит «Сотрудники»
    // (с invite/remove кнопками), employee — «Коллеги» (read-only, без
    // статистики/удаления, объединено с техникой в employee/team.js).
    q('#nav-item-members').style.display   = hasOrg                ? '' : 'none';

    // ── Populate the «Ваша организация» tab ────────────────────
    if (hasOrg && org) populateOrgTab(org, role, canEditOrg, canEditLim, user.global_role === 'sys_admin');

    // ── Tooltip text injection (CSS reads data-tooltip-text) ───
    document.querySelectorAll('[data-tooltip-key]').forEach(el => {
      el.setAttribute('data-tooltip-text', t(el.dataset.tooltipKey));
    });

    loadNotificationCount();

  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    stopLoader();
    _loadProfileInflight = false;
    // Навигация уже в корректном для роли состоянии — показываем её
    // (снимали видимость на время монтажа, см. role-router выше).
    document.body.classList.add('rems-nav-ready');
    // No hidePageLoader() here — the overlay was already dismissed at
    // module-init time (right after imports). Per the new spec, the
    // moment dashboard JS started running counts as "page rendered".
  }
}

function updateWelcome(user) {
  const lang  = getLang();
  const first = (user?.full_name || '').split(' ')[0] || (lang === 'en' ? 'there' : '');
  const greeting = lang === 'en'
    ? `Welcome, ${first}!`
    : `Добро пожаловать, ${first}!`;
  const el = q('#welcome-title');
  if (el) el.textContent = greeting;
}

// ─────────────────────────────────────────────────────────────────
// AVATAR UPLOAD — uses the shared media-attach controller (see
// frontend/js/media-attach.js). Same preview/confirm flow used by
// the org logo, so both widgets share the modal styling and the
// pick → preview → confirm pipeline.
// ─────────────────────────────────────────────────────────────────
wireMediaAttach({
  input:       '#avatar-input',
  trigger:     '#btn-change-avatar',
  entityType:  'user',
  confirm:     (mediaFileId) => profile.confirmAvatar(mediaFileId),
  deleteFn:    ()             => profile.deleteAvatar(),
  hasExisting: () => !!_userProfile?.avatar?.url,
  onSuccess:   () => {
    toast(t('toasts.avatar_updated'), 'ok');
    loadProfile();
    // Свой аватар отображается и в списке коллег/сотрудников (там та же
    // строка members.list с avatar.url). loadProfile() обновляет только
    // профиль — освежаем и members-списки (legacy tab + owner/employee
    // team рендерят свой список по событию).
    loadMembers().catch(() => {});
    window.dispatchEvent(new CustomEvent('rems:reload-members'));
  },
  titleKey: 'profile.media_avatar_title',
  hintKey:  'profile.media_avatar_hint',
  // Crop preview is shown as a square (same green-bordered tile as the
  // org logo) — the actual avatar element in the UI is still circular,
  // but the modal frames the kept area as a 1:1 square because that's
  // what gets stored. Keeps the preview behaviour identical between
  // avatar and org-logo.
  cropPreview: 'square',
  getLimits: () => _orgData?.limits ?? null,
  t, toast, errorMessage,
});

// ─────────────────────────────────────────────────────────────────
// CHANGE PASSWORD — owned by ./dashboard/modals/change-password.js.
// Wired via wireChangePassword() at boot (see bottom of this file).
// ─────────────────────────────────────────────────────────────────
// Generic show/hide password toggle. Any [data-toggle-pw="<input id>"]
// button flips the target input between type=password and type=text and
// swaps the eye icon. Page-wide — used by change-password, detach-contact,
// and any other form that mounts a password input.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-toggle-pw]');
  if (!btn) return;
  const input = document.getElementById(btn.dataset.togglePw);
  if (!input) return;
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  const icon = btn.querySelector('i');
  if (icon) icon.className = showing ? 'ph ph-eye' : 'ph ph-eye-slash';
});

// Клик по аватару с фото (коллеги, участники) → просмотрщик изображения.
// data-avatar-view хранит публичный URL фото, data-avatar-name — имя для
// заголовка скачивания. Делегировано — строки списков пересоздаются.
document.addEventListener('click', (e) => {
  const av = e.target.closest('[data-avatar-view]');
  if (!av) return;
  openImageViewer(av.dataset.avatarView, { name: av.dataset.avatarName || 'avatar' });
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const av = e.target.closest?.('[data-avatar-view]');
  if (!av) return;
  e.preventDefault();
  openImageViewer(av.dataset.avatarView, { name: av.dataset.avatarName || 'avatar' });
});

// ─────────────────────────────────────────────────────────────────
// MODAL WIRING — each modal owns its own state, form-guard, and DOM
// handlers; this file just passes in the live state getters.
// ─────────────────────────────────────────────────────────────────
wireFieldEdit({
  getUserProfile: () => _userProfile,
  getOrgData:     () => _orgData,
  refresh:        () => loadProfile(),
});

wireChangePassword({
  getAvailableContacts: () => _availableContacts,
  refresh:              () => loadProfile(),
});

wireChangePin({
  getUserProfile:        () => _userProfile,
  getAvailableContacts:  () => _availableContacts,
  refresh:               () => loadProfile(),
});

// "Upgrade subscription" — coming-soon toast
q('#btn-upgrade-sub')?.addEventListener('click', (e) => {
  e.preventDefault();
  toast(t('profile.upgrade_coming_soon'), 'info');
});
// "Link Telegram" — coming-soon toast
q('#btn-link-telegram')?.addEventListener('click', (e) => {
  e.preventDefault();
  toast(t('profile.telegram_coming_soon'), 'info');
});
// Email / Phone change/link buttons → open the 3-step contact-change wizard.
q('#btn-edit-email')?.addEventListener('click', () => openChangeContact('email'));
// Телефон оставлен в ЛК (значение видно), но привязка/смена по SMS пока
// недоступна — пока нет SMS-провайдера показываем тост (как у Telegram),
// не открывая мастер. Флоу change-contact и бэкенд не трогаем.
q('#btn-edit-phone')?.addEventListener('click', () => {
  if (!phoneChannelEnabled()) { toast(t('profile.phone_sms_soon'), 'info'); return; }
  openChangeContact('phone');
});

wireChangeContact({
  getUserProfile:       () => _userProfile,
  getAvailableContacts: () => _availableContacts,
  refresh:              () => loadProfile(),
  openDetach:           openDetachContact,
});
wireDetachContact({
  refresh:           () => loadProfile(),
  openChangeContact,
});

// ─────────────────────────────────────────────────────────────────
// ORG PROFILE — populated by populateOrgTab() inside loadProfile();
// switchTab('org') just re-fetches /api/profile/me which carries the
// org payload already.
// ─────────────────────────────────────────────────────────────────
async function loadOrgProfile() {
  // Refresh to pick up any pending changes (e.g. someone else just
  // updated the org name) without leaving the user on stale data.
  await loadProfile();
}

// (legacy #btn-edit-org + #btn-save-org-name handlers removed —
//  org-name edits now go through the generic #field-edit-modal)

// Org logo — wired via the shared media-attach controller. Permission to
// trigger (clicking the wrap) is gated elsewhere by .editable on the
// wrapping element; the wireMediaAttach trigger here just hands the click
// through to the <input>.
wireMediaAttach({
  input:       '#org-logo-input',
  trigger:     '#org-logo-wrap.editable',
  entityType:  'organization',
  confirm:     (mediaFileId) => org.confirmLogo(mediaFileId),
  deleteFn:    ()             => org.deleteLogo(),
  hasExisting: () => !!_orgData?.logo?.url,
  onSuccess:   () => {
    toast(t('toasts.logo_updated'), 'ok');
    loadOrgProfile();
  },
  titleKey: 'profile.media_logo_title',
  hintKey:  'profile.media_logo_hint',
  cropPreview: 'square',         // org logo is rendered as a square tile
  getLimits: () => _orgData?.limits ?? null,
  t, toast, errorMessage,
});

// ─────────────────────────────────────────────────────────────────
// MEMBERS — tab renderer, remove/decision modals and the invite flow
// live in ./members.js. Current profile is injected for self/owner
// checks; loadMembers is imported above for switchTab + socket refresh.
// ─────────────────────────────────────────────────────────────────
initMembers({ getProfile: () => _userProfile });

// ─────────────────────────────────────────────────────────────────
// SOCKET
// ─────────────────────────────────────────────────────────────────
async function initSocketConn() {
  try {
    const socket = await connectSocket();
    if (!socket) return;

    // Сервер уведомляет о невалидной сессии через connect_error с кодом
    // DEVICE_MISMATCH / SESSION_REVOKED / SESSION_EXPIRED. Без подписчика
    // пользователь оставался залогинен с протухшим токеном; logout() чистит
    // токен, отключает socket и редиректит на login.
    socketOn('auth:error', () => {
      logout();
    });

    // Per-user push. addNotification() normalises camelCase ↔ snake_case
    // internally AND plays the sound — we just feed it the raw socket
    // payload. The toast uses resolveNotifMessage() so an i18n-keyed
    // payload (`i18n:notifications.types.new_session`) shows the
    // localized sentence instead of the raw key.
    // Some notification types signal a server-side change to the
    // CURRENT user's membership/role state. The dashboard caches that
    // state in `_userProfile` for tab-visibility / org-grant checks —
    // so on those types we re-fetch the profile, otherwise the sidebar's
    // "Организация" tab stays hidden until a manual page reload even
    // though the user is now an approved member.
    const MEMBERSHIP_REFRESH_TYPES = new Set([
      'join_accepted',
      'join_rejected',
      'join_accepted_alt_role',
    ]);
    socketOn('user:notification', (payload) => {
      // DEFENSIVE GUARD: if the payload has a recipientId AND it isn't
      // the current user, drop it. The server already routes
      // `user:notification` to a single room (user:${recipientId}), so
      // this should never happen — but stale socket-to-room mappings
      // across rapid logouts/logins HAVE produced cross-user toasts in
      // testing (e.g., owner seeing "Ваша заявка одобрена" toast after
      // approving someone). Comparing against the freshly-loaded
      // profile id closes the loophole regardless of room state.
      if (
        payload?.recipientId != null &&
        _userProfile?.id != null &&
        Number(payload.recipientId) !== Number(_userProfile.id)
      ) return;

      // addNotification() уже показывает богатый notify-toast (иконка +
      // заголовок + тело + действия) и проигрывает звук. Отдельный простой
      // toast(text,'info') здесь дублировал бы попап на каждое событие —
      // убран. Простые toast'ы остаются там, где они единственные (например
      // «отметить все прочитанными»).
      addNotification(payload);
      const subAction = payload?.data?.action;
      // Контракт-события → освежаем вкладку «Партнёры»/«Контракты», если открыта.
      if (String(subAction ?? '').startsWith('contract')) {
        window.dispatchEvent(new CustomEvent('rems:reload-contracts'));
      }
      const rawMsg    = String(payload?.message_text ?? payload?.messageText ?? '');
      const isInvitedByOrg = payload?.type === 'join_request' &&
        (subAction === 'invited_by_org' || rawMsg.includes('invited_by_org'));
      const isInviteeAccepted = payload?.type === 'join_accepted' &&
        (subAction === 'invitee_accepted' || rawMsg.includes('invitee_accepted'));

      if (MEMBERSHIP_REFRESH_TYPES.has(payload?.type)) {
        loadProfile();
      }
      // СОЛО получает приглашение от owner'а (join_request + invited_by_org):
      // его membership_status стал pending+from_org — нужно
      // перезагрузить профиль, чтобы solo home отрисовал invitation card
      // с текстом owner'а. Без этого солошник не видит приглашение до
      // ручного reload (что и было багом).
      if (isInvitedByOrg) {
        loadProfile();
      }
      // OWNER получает уведомление о НОВОЙ pending-заявке
      // (join_request без 'invited_by_org' action) или о принятии
      // приглашения (invitee_accepted). В обоих случаях members-state
      // изменился — refreshim ВСЕГДА, не только когда currentTab=members.
      // Если owner на overview — счётчик/чип pending обновится; если на
      // members — список освежится. Без этого fix owner видел изменения
      // только после перезагрузки.
      const ownerNeedsMembersRefresh =
        (payload?.type === 'join_request' && !isInvitedByOrg) ||
        isInviteeAccepted;
      if (ownerNeedsMembersRefresh) {
        loadMembers().catch(() => {});
        // owner/team.js рендерит СВОЙ список (Коллеги в Ресурсах) — он
        // слушает только 'rems:reload-members'. Без диспатча новая
        // pending-заявка появлялась бы лишь после ручного reload.
        window.dispatchEvent(new CustomEvent('rems:reload-members'));
        loadProfile();   // employee-count в шапке орги тоже обновим
      }
      // Если сотрудник покинул орг (или withdraw pending) — owner
      // должен увидеть это сразу на любой вкладке.
      if (
        payload?.type === 'join_rejected' &&
        (subAction === 'left_org' || subAction === 'withdrawn_by_applicant')
      ) {
        loadMembers().catch(() => {});
        window.dispatchEvent(new CustomEvent('rems:reload-members'));
        loadProfile();
      }
    });

    // Org-wide push — no toast (it can flood when many events fire);
    // the bell badge + list refresh are enough signal.
    // Если открыта вкладка участников и пришло событие о смене состава
    // (join_request от соискателя, join_accepted/rejected от владельца) —
    // перерисовываем список, иначе owner не увидит новых заявителей пока
    // не переключится на другой таб и обратно.
    const MEMBERS_REFRESH_TYPES = new Set([
      'join_request',
      'join_accepted',
      'join_rejected',
      'join_accepted_alt_role',
    ]);
    socketOn('org:notification', (payload) => {
      addNotification(payload);
      if (MEMBERS_REFRESH_TYPES.has(payload?.type)) {
        loadMembers().catch(() => {});
        // owner/team.js (Коллеги в Ресурсах) перерисуется по событию.
        window.dispatchEvent(new CustomEvent('rems:reload-members'));
      }
    });
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────
// LANGUAGE CHANGE
// ─────────────────────────────────────────────────────────────────
// On language switch, applyTranslations() handles every static [data-i18n]
// element, but a lot of profile/org content is built dynamically by JS
// (dates, sub-lines like "до N шт./заявку", role/status chips, sessions,
// etc.) — those don't carry a data-i18n by themselves. The cleanest way
// to keep everything in sync is to re-run the same render that initially
// populated the tabs. loadProfile() is idempotent and uses cached data
// at the network layer.
//
// Previously this callback also did `textContent = roleLabel(...)` on
// #info-role and #profile-role-badge — that destroyed the chip's icon +
// inner translatable <span>, leaving plain text behind. Removed.
onLangChange(() => {
  if (_userProfile) loadProfile().catch(() => {});
  // Sessions render their own labels ("session_current", date formats,
  // OS strings) inside loadSessions(); re-run it so the language switch
  // takes effect immediately on the open Profile tab.
  if (currentTab === 'profile') loadSessions().catch(() => {});
  // Members list embeds locale-dependent strings (role chips, "это
  // вы", "В организации с DD MMM YYYY", "В работе" / "Закрыто"). Re-fire
  // loadMembers if the tab is currently visible so the user sees the
  // translation update on lang switch without re-opening the tab.
  if (currentTab === 'members') loadMembers().catch(() => {});
  rerenderNotifications();
  // Inline-ошибки под полями и alert-баннеры заполняются переведённым
  // текстом в момент валидации и сами по себе не переводятся. На смене
  // языка прячем их (стале-текст на старом языке) — при следующей
  // валидации они появятся уже на новом языке.
  document.querySelectorAll('.form-error.show').forEach(el => el.classList.remove('show'));
  document.querySelectorAll('.alert.show:not(.hidden)').forEach(el => { el.classList.remove('show'); el.classList.add('hidden'); });
});

// ─────────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────────
loadProfile();
initSocketConn().catch(() => {});

// ─── In-page profile reload trigger ─────────────────────────────
// Любая модалка / экран, который изменил состояние юзера через бэк
// (например solo join-modal: organization_id + status -> pending),
// диспатчит событие 'rems:reload-profile'. Здесь оно превращается
// в loadProfile() — НЕ перезагрузку страницы (location.reload()
// триггерит PIN-gate, потому что referrer пустой/dashboard).
// loadProfile() в свою очередь вызовет role-router, который сравнит
// новую роль с активной и re-mount'ит соответствующий дашборд.
window.addEventListener('rems:reload-profile', () => {
  loadProfile().catch(err => console.warn('[reload-profile]', err));
});
// Точечный refresh members-list (без полного loadProfile) — для
// случаев когда owner сам совершил accept/reject из toast'а и его
// дашборд не получит socket-events от себя самого.
window.addEventListener('rems:reload-members', () => {
  loadMembers().catch(err => console.warn('[reload-members]', err));
});

// q() / escapeHTML() moved to ./dom-utils.js (imported at top).

