/* ═══════════════════════════════════════════════════════════════
   Personal "Профиль" tab — identity strip + 2 cards (Личные
   данные / Аккаунт). Pure render: takes (user, role, isOwner,
   ownerOrgCreatedAt) and paints the existing DOM.
   ═══════════════════════════════════════════════════════════════ */

import { t } from '../../../i18n.js';
import {
  statusBadge, roleBadgeDescriptor,
  renderIconBadge, renderRowChip,
} from '../badges.js';
import { fmtDate, setAvatar } from '../format.js';

export function renderProfileTab(user, role, isOwner, ownerOrgCreatedAt) {
  // ── Identity strip ─────────────────────────────────────────
  setAvatar(document.querySelector('#profile-initials'), document.querySelector('#profile-avatar-img'), user);
  // Кольцо аватара: sys_admin → фиолетовое (перебивает роль), иначе по
  // роли в орге (owner=золото, employee=роза). Solo/pending — без кольца.
  const avEl = document.querySelector('#profile-avatar');
  if (avEl) {
    avEl.classList.remove('avatar--ring-owner', 'avatar--ring-employee', 'avatar--ring-admin');
    if (user.global_role === 'sys_admin') avEl.classList.add('avatar--ring-admin');
    else if (user.membership_status === 'approved' && role === 'owner') avEl.classList.add('avatar--ring-owner');
    else if (user.membership_status === 'approved' && role === 'employee') avEl.classList.add('avatar--ring-employee');
  }
  document.querySelector('#profile-fullname').textContent      = user.full_name || '—';
  document.querySelector('#profile-userid-inline').textContent = `#${user.id ?? '—'}`;
  document.querySelector('#profile-head-email').textContent    = user.email_masked || '';
  document.querySelector('#profile-head-phone').textContent    = user.phone_masked || '';

  // Identity-strip badges. По решению UX:
  //   • Status (заявка отклонена/принята/и т.д.) — НЕ показываем в шапке
  //     профиля никогда: эта инфа уже передана через uведомление и видна
  //     на solo home.
  //   • Role (Руководитель/Сотрудник) — показываем ТОЛЬКО когда юзер
  //     реально в орге (status=approved). Solo юзер (no org, pending,
  //     rejected) → ничего, шапка без chip'ов.
  const roleEl   = document.querySelector('#profile-role-badge');
  const statusEl = document.querySelector('#profile-status-badge');
  if (statusEl) statusEl.style.display = 'none';
  if (roleEl) {
    const showRole = user.membership_status === 'approved' && !!role;
    if (showRole) {
      roleEl.style.display = '';
      renderIconBadge(roleEl, roleBadgeDescriptor(role));
    } else {
      roleEl.style.display = 'none';
    }
  }

  // Admin-плашка — рядом с ролью в орге. Показываем, если юзер числится
  // в системе как sys_admin (global_role). indigo-тон + корона.
  const adminEl = document.querySelector('#profile-admin-badge');
  if (adminEl) {
    if (user.global_role === 'sys_admin') {
      adminEl.style.display = '';
      renderIconBadge(adminEl, roleBadgeDescriptor('sys_admin'));
    } else {
      adminEl.style.display = 'none';
    }
  }

  // ── LEFT card: Личные данные ───────────────────────────────
  document.querySelector('#info-fullname').textContent = user.full_name  || '—';
  document.querySelector('#info-dept').textContent     = user.department || '—';
  // Role inside «Личные данные»: container-less chip (read-only info).
  renderRowChip(document.querySelector('#info-role'), roleBadgeDescriptor(role));

  // Role-tooltip:
  //   owner   → hidden (nothing useful to say)
  //   manager → shown with the "you can change technician/employee" hint
  //   other   → shown with the generic "ask your owner/manager" hint
  // Role-change tooltip — N/A with the owner+employee model
  // (no role transitions through self-service).
  document.querySelector('#info-role-tooltip')?.classList.add('hidden');

  // Contacts: masked value as sub-line under label, action button on right.
  // The button flips between "Сменить" (gray) and "Привязать" (green)
  // depending on whether the user already has a contact of this type.
  // The dedicated "verified" pill is gone — verification is implied by
  // the fact that the contact is shown at all.
  const setRowAction = (btnEl, mode) => {
    if (!btnEl) return;
    btnEl.classList.remove('btn-row-change', 'btn-row-link');
    btnEl.classList.add(mode === 'link' ? 'btn-row-link' : 'btn-row-change');
  };

  const emailSub  = document.querySelector('#info-email-sub');
  const emailBtn  = document.querySelector('#btn-edit-email');
  const emailBtnL = document.querySelector('#btn-edit-email-label');
  if (user.email_masked) {
    emailSub.textContent = user.email_masked;
    emailBtnL.setAttribute('data-i18n', 'common.change');
    emailBtnL.textContent = t('common.change');
    setRowAction(emailBtn, 'change');
  } else {
    emailSub.textContent = '';
    emailBtnL.setAttribute('data-i18n', 'common.link');
    emailBtnL.textContent = t('common.link');
    setRowAction(emailBtn, 'link');
  }

  const phoneSub  = document.querySelector('#info-phone-sub');
  const phoneBtn  = document.querySelector('#btn-edit-phone');
  const phoneBtnL = document.querySelector('#btn-edit-phone-label');
  if (user.phone_masked) {
    phoneSub.textContent = user.phone_masked;
    phoneBtnL.setAttribute('data-i18n', 'common.change');
    phoneBtnL.textContent = t('common.change');
    setRowAction(phoneBtn, 'change');
  } else {
    phoneSub.textContent = '';
    phoneBtnL.setAttribute('data-i18n', 'common.link');
    phoneBtnL.textContent = t('common.link');
    setRowAction(phoneBtn, 'link');
  }

  // ── RIGHT card: Аккаунт ────────────────────────────────────
  // Password + PIN dates render as a sub-line under their labels.
  const pwdSub = document.querySelector('#info-pwd-changed');
  pwdSub.textContent = user.updated_at ? `${t('profile.password_last_changed')}: ${fmtDate(user.updated_at)}` : '—';
  const pinSub = document.querySelector('#info-pin-set');
  pinSub.textContent = user.pin_set_at ? `${t('profile.pin_last_changed')}: ${fmtDate(user.pin_set_at)}` : '—';
  document.querySelector('#info-created-at').textContent = fmtDate(user.created_at);
  document.querySelector('#info-last-login').textContent = fmtDate(user.last_login);
  // For owners, "в организации с" shows org creation date; for others, last update.
  document.querySelector('#info-joined').textContent = isOwner ? fmtDate(ownerOrgCreatedAt) : fmtDate(user.updated_at);
}
