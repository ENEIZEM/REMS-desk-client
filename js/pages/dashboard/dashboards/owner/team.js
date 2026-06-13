/* ═══════════════════════════════════════════════════════════════
   Owner Ресурсы — Коллеги + Техника.
   Идентичен employee/team.js, но с:
     • stats-кластером (active / closed counts) на каждой строке
     • кнопкой исключения (trash) — для всех не-self не-owner.
   ═══════════════════════════════════════════════════════════════ */

import { t, applyTranslations, onLangChange } from '../../../../i18n.js';
import { members as membersApi } from '../../../../api.js';
import { openModal } from '../../ui-helpers.js';
import { mountEquipment } from '../_shared/equipment.js';

let _langBound = false;

// Сохраняем profile на уровне модуля, чтобы re-mount по событию
// 'rems:reload-members' (после исключения сотрудника) знал контекст.
let _ownerProfile = null;
let _reloadBound = false;

export function mountOwnerTeam(profile) {
  const tabPanel = document.querySelector('#tab-members');
  if (!tabPanel) return;
  tabPanel.classList.add('tab-fill');
  _ownerProfile = profile;

  // После удаления сотрудника (confirm в #remove-member-modal,
  // обрабатывается в dashboard/index.js) диспатчится
  // 'rems:reload-members' — перерисуем owner team in-place.
  if (!_reloadBound) {
    _reloadBound = true;
    window.addEventListener('rems:reload-members', () => {
      if (document.body.dataset.role === 'owner' && _ownerProfile) {
        mountOwnerTeam(_ownerProfile);
      }
    });
  }

  const selfId = profile?.user?.id;

  tabPanel.innerHTML = `
    <div class="page-header page-header--with-action">
      <div>
        <h1 class="page-title" data-i18n="nav.colleagues">Ресурсы</h1>
        <p class="page-desc" data-i18n="team.desc">Сотрудники вашей организации и закреплённая за ней техника.</p>
      </div>
      <div class="page-header-actions">
        <button class="btn btn-secondary" id="btn-equipment-add">
          <i class="ph ph-plus"></i> <span data-i18n="equipment.add_btn">Добавить технику</span>
        </button>
        <button class="btn btn-primary" id="btn-team-invite">
          <i class="ph ph-user-plus"></i> <span data-i18n="members.invite">Пригласить</span>
        </button>
      </div>
    </div>

    <div class="profile-two-col" style="margin-top:1rem;">
      <!-- LEFT: Коллеги с статистикой и кнопкой исключения -->
      <div class="profile-col">
        <div class="card profile-card fill-block">
          <div class="profile-card-header profile-card-header--with-actions">
            <div class="profile-card-icon navy"><i class="ph-bold ph-users"></i></div>
            <h3 class="profile-card-title" data-i18n="team.colleagues_title">Коллеги</h3>
            <span id="team-colleagues-count" class="badge badge-default" style="margin-left:.4rem;"></span>
            <span class="profile-card-tooltip profile-card-tooltip--end" tabindex="0" data-tooltip-key="team.colleagues_hint">
              <i class="ph ph-info"></i>
            </span>
          </div>
          <div class="profile-card-body requests-feed-body" id="team-colleagues-body">
            <div class="empty-state empty-state--inline">
              <i class="ph ph-users"></i>
              <span class="empty-state-text" data-i18n="team.colleagues_loading">Загрузка…</span>
            </div>
          </div>
        </div>
      </div>

      <!-- RIGHT: Техника (placeholder) -->
      <div class="profile-col">
        <div class="card profile-card fill-block">
          <div class="profile-card-header profile-card-header--with-actions">
            <div class="profile-card-icon teal"><i class="ph-bold ph-desktop-tower"></i></div>
            <h3 class="profile-card-title" data-i18n="team.equipment_title">Техника</h3>
            <div class="equipment-search-wrap">
              <i class="ph ph-magnifying-glass"></i>
              <input id="equipment-search" type="search" class="form-input" data-i18n-ph="equipment.search_ph" placeholder="Поиск по технике…">
            </div>
            <span id="team-equipment-count" class="badge badge-default" style="margin-left:.4rem;"></span>
            <span class="profile-card-tooltip profile-card-tooltip--end" tabindex="0" data-tooltip-key="team.equipment_hint">
              <i class="ph ph-info"></i>
            </span>
          </div>
          <div class="profile-card-body requests-feed-body equipment-list" id="team-equipment-body">
            <div class="empty-state empty-state--inline">
              <i class="ph ph-desktop-tower"></i>
              <span class="empty-state-text" data-i18n="team.colleagues_loading">Загрузка…</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  applyTranslations();
  mountEquipment(profile);

  // Перерисовка списка коллег при смене языка (роли с t() в строках —
  // роль/«Ожидает»/«нет оценок» и т.п. иначе остаются на старом языке).
  if (!_langBound) {
    _langBound = true;
    onLangChange(() => {
      if (document.body.dataset.role === 'owner' && document.querySelector('#team-colleagues-body')) {
        loadColleagues(_ownerProfile?.user?.id);
      }
    });
  }

  // «Пригласить» — открывает общую #invite-modal (её содержимое + кнопка
  // подтверждения живут в dashboard.html и не перезаписываются). Чистим
  // поля и пинаем form-guard синтетическим input-событием, иначе кнопка
  // подтверждения осталась бы зелёной с прошлого раза.
  document.querySelector('#btn-team-invite')?.addEventListener('click', () => {
    const contactEl = document.querySelector('#invite-contact');
    const msgEl     = document.querySelector('#invite-message');
    const cntEl     = document.querySelector('#invite-message-count');
    if (contactEl) contactEl.value = '';
    if (msgEl)     msgEl.value = '';
    if (cntEl)     cntEl.textContent = '0';
    document.querySelector('#err-invite-contact')?.classList.remove('show');
    document.querySelector('#err-invite')?.classList.add('hidden');
    contactEl?.dispatchEvent(new Event('input', { bubbles: true }));
    openModal('invite-modal');
  });

  loadColleagues(selfId);
}

async function loadColleagues(selfId) {
  const body  = document.querySelector('#team-colleagues-body');
  const count = document.querySelector('#team-colleagues-count');
  if (!body) return;
  try {
    const data = await membersApi.list();
    const approved = data?.data?.approved || [];
    const pending  = data?.data?.pending  || [];
    const invites  = data?.data?.invites  || [];
    // Соискатели (подали сами) требуют решения → «Рассмотреть».
    // Приглашённые орг-ом аккаунты (direction='from_org') — ждём их
    // ответа, рассматривать нечего → отдельная плашка-ожидание.
    const applicants = pending.filter(m => m.invite_direction !== 'from_org');
    const invited    = pending.filter(m => m.invite_direction === 'from_org');
    // Счётчик = все плашки (одобренные + ожидающие + e-mail-инвайты).
    if (count) count.textContent = String(approved.length + pending.length + invites.length);
    if (!approved.length && !pending.length && !invites.length) {
      body.innerHTML = `
        <div class="empty-state empty-state--inline">
          <i class="ph ph-users"></i>
          <span class="empty-state-text" data-i18n="team.colleagues_empty">В организации пока только вы.</span>
        </div>`;
      applyTranslations();
      return;
    }
    // Порядок сверху вниз: соискатели (нужно решение) → приглашённые
    // аккаунты (ждём ответа) → e-mail-инвайты (ждём регистрации) →
    // действующие сотрудники.
    body.innerHTML =
      applicants.map(m => pendingRowHTML(m)).join('') +
      invited.map(m => invitedRowHTML(m)).join('') +
      invites.map(inv => inviteRowHTML(inv)).join('') +
      approved.map(m => colleagueRowHTML(m, selfId)).join('');

    // Wire remove-buttons.
    body.querySelectorAll('[data-action="remove-member"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id   = btn.getAttribute('data-id');
        const name = btn.getAttribute('data-name') || '';
        // Открываем общую модалку #remove-member-modal (та же что у
        // members tab). confirm-кнопку обрабатывает dashboard/index.js,
        // он удалит + диспатчит 'rems:reload-members' → mountOwnerTeam.
        window.dispatchEvent(new CustomEvent('rems:remove-member', {
          detail: { id, name },
        }));
      });
    });

    // Wire «Рассмотреть» — открывает #member-decision-modal через event-bus.
    // dashboard/index.js обработает accept/reject + перерисует список.
    body.querySelectorAll('[data-action="review-member"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent('rems:member-decision', {
          detail: {
            id:      btn.getAttribute('data-id'),
            name:    btn.getAttribute('data-name') || '',
            message: btn.getAttribute('data-message') || '',
          },
        }));
      });
    });
  } catch (err) {
    body.innerHTML = `
      <div class="empty-state empty-state--inline">
        <i class="ph ph-warning-circle"></i>
        <span class="empty-state-text">${escapeHTML(err?.message || 'error')}</span>
      </div>`;
  }
}

function colleagueRowHTML(m, selfId) {
  const hasPhoto = !!m.avatar?.url;
  const avatarTile = hasPhoto
    ? `<img src="${escapeHTML(m.avatar.url)}" alt="">`
    : `<span>${escapeHTML(initialsOf(m.full_name))}</span>`;
  // Фото кликабельно → просмотрщик (делегат в dashboard/index.js).
  const avatarAttrs = hasPhoto
    ? ` avatar--clickable" data-avatar-view="${escapeHTML(m.avatar.url)}" data-avatar-name="${escapeHTML(m.full_name)}" role="button" tabindex="0" title="${escapeHTML(t('common.attachment_view'))}"`
    : '"';
  const contact = m.email_masked || m.phone_masked || '—';
  const dept    = m.department || t('members.no_department');
  const isOwner = m.org_role === 'owner';
  const isSelf  = selfId != null && Number(selfId) === Number(m.id);
  const roleLbl = isOwner ? t('roles.owner') : t('roles.employee');
  const stats = m.stats || {};
  const active = Number(stats.active ?? 0);
  const closed = Number(stats.closed ?? 0);
  const hasRating = stats.rating_avg != null && Number(stats.rating_count) > 0;
  const ratingAvg = hasRating ? Number(stats.rating_avg).toFixed(1) : '';
  // Строка рейтинга в meta — звезда + число, или «нет оценок».
  const ratingMeta = hasRating
    ? `<span class="team-colleague-rating">${ratingAvg}<i class="ph-fill ph-star"></i></span>`
    : `<span class="team-colleague-rating is-empty">${t('employee.stat_rating_empty')}</span>`;
  // Удалить можно: не себя, не другого owner'а.
  const canRemove = !isSelf && !isOwner;
  return `
    <div class="team-colleague-row${isOwner ? ' team-colleague-row--owner' : ' team-colleague-row--employee'}">
      <div class="avatar avatar-md${avatarAttrs}>${avatarTile}</div>
      <div class="team-colleague-text">
        <div class="team-colleague-name">${escapeHTML(m.full_name)}</div>
        <div class="team-colleague-contact">${escapeHTML(contact)}</div>
        <div class="team-colleague-meta">${escapeHTML(dept)} · ${ratingMeta}</div>
      </div>
      <div class="team-colleague-stats">
        <span class="team-stat-pill is-active" title="${t('members.stat_active')}">${active}<span> ${t('members.stat_active')}</span></span>
        <span class="team-stat-pill is-closed" title="${t('members.stat_closed')}">${closed}<span> ${t('members.stat_closed')}</span></span>
      </div>
      <div class="team-colleague-actions">
        <span class="badge ${isOwner ? 'badge-role-owner' : 'badge-role-employee'} team-role-badge">${escapeHTML(roleLbl)}</span>
        ${isSelf
          ? `<span class="members-row-self" data-ct-tip="${escapeHTML(t('members.you'))}" aria-label="${t('members.you')}"><i class="ph-bold ph-user"></i></span>`
          : ''}
        ${canRemove
          ? `<button class="members-row-delete btn-remove"
                     data-action="remove-member" data-id="${m.id}"
                     data-name="${escapeHTML(m.full_name)}"
                     data-ct-tip="${escapeHTML(t('members.remove'))}" aria-label="${t('members.remove')}">
               <i class="ph-bold ph-trash"></i>
             </button>`
          : ''}
      </div>
    </div>`;
}

// Плашка соискателя (pending) — визуально отличается badge «Ожидает»
// и кнопкой «Рассмотреть» (а не trash). Показываем рейтинг + сообщение.
function pendingRowHTML(m) {
  const avatarTile = m.avatar?.url
    ? `<img src="${escapeHTML(m.avatar.url)}" alt="">`
    : `<span>${escapeHTML(initialsOf(m.full_name))}</span>`;
  const contact = m.email_masked || m.phone_masked || '—';
  const dept    = m.department || t('members.no_department');
  const stats   = m.stats || {};
  const hasRating = stats.rating_avg != null && Number(stats.rating_count) > 0;
  const ratingAvg = hasRating ? Number(stats.rating_avg).toFixed(1) : '';
  const ratingMeta = hasRating
    ? `<span class="team-colleague-rating">${ratingAvg}<i class="ph-fill ph-star"></i></span>`
    : `<span class="team-colleague-rating is-empty">${t('employee.stat_rating_empty')}</span>`;
  const inviteMsg = (m.invite_message || '').trim();
  return `
    <div class="team-colleague-row team-colleague-row--pending">
      <div class="avatar avatar-md">${avatarTile}</div>
      <div class="team-colleague-text">
        <div class="team-colleague-name">${escapeHTML(m.full_name)}</div>
        <div class="team-colleague-contact">${escapeHTML(contact)}</div>
        <div class="team-colleague-meta">${escapeHTML(dept)} · ${ratingMeta}</div>
      </div>
      <div class="team-colleague-actions">
        <span class="badge badge-warning team-role-badge">${t('members.pending_badge')}</span>
        <button class="btn btn-primary"
                data-action="review-member" data-id="${m.id}"
                data-name="${escapeHTML(m.full_name)}"
                data-message="${escapeHTML(inviteMsg)}">
          <i class="ph ph-user-check"></i>
          <span>${t('members.decision_review')}</span>
        </button>
      </div>
    </div>`;
}

// Плашка приглашённого АККАУНТА (direction='from_org', есть user-строка,
// status='pending'). Рассматривать нечего — ждём, пока человек примет
// приглашение. Без кнопки «Рассмотреть», с badge «Приглашён».
function invitedRowHTML(m) {
  const avatarTile = m.avatar?.url
    ? `<img src="${escapeHTML(m.avatar.url)}" alt="">`
    : `<span>${escapeHTML(initialsOf(m.full_name))}</span>`;
  const contact = m.email_masked || m.phone_masked || '—';
  const dept    = m.department || t('members.no_department');
  return `
    <div class="team-colleague-row team-colleague-row--pending">
      <div class="avatar avatar-md">${avatarTile}</div>
      <div class="team-colleague-text">
        <div class="team-colleague-name">${escapeHTML(m.full_name)}</div>
        <div class="team-colleague-contact">${escapeHTML(contact)}</div>
        <div class="team-colleague-meta">${escapeHTML(dept)} · ${escapeHTML(t('members.invite_awaiting'))}</div>
      </div>
      <div class="team-colleague-actions">
        <span class="badge badge-info team-role-badge">
          <i class="ph ph-paper-plane-tilt"></i> ${escapeHTML(t('members.invite_sent_badge'))}
        </span>
      </div>
    </div>`;
}

// Плашка e-mail/phone-инвайта (org_invites): человек ещё НЕ
// зарегистрирован, поэтому имени нет — показываем контакт + обратный
// отсчёт до истечения приглашения.
function inviteRowHTML(inv) {
  const icon = inv.contact_type === 'phone' ? 'ph-device-mobile' : 'ph-envelope-simple';
  return `
    <div class="team-colleague-row team-colleague-row--pending">
      <div class="avatar avatar-md team-invite-avatar"><i class="ph ${icon}"></i></div>
      <div class="team-colleague-text">
        <div class="team-colleague-name">${escapeHTML(inv.contact_masked)}</div>
        <div class="team-colleague-contact">${escapeHTML(t('members.invite_awaiting'))}</div>
        <div class="team-colleague-meta">${escapeHTML(inviteTtl(inv.expires_at))}</div>
      </div>
      <div class="team-colleague-actions">
        <span class="badge badge-info team-role-badge">
          <i class="ph ph-paper-plane-tilt"></i> ${escapeHTML(t('members.invite_sent_badge'))}
        </span>
      </div>
    </div>`;
}

// Срок жизни инвайта → человекочитаемая строка «истекает через N дн./ч.».
function inviteTtl(expiresAt) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return t('members.invite_expired');
  const days  = Math.floor(ms / 86400000);
  const hours = Math.floor(ms / 3600000);
  const time  = days >= 1
    ? `${days} ${t('members.days_short')}`
    : `${Math.max(1, hours)} ${t('members.hours_short')}`;
  return t('members.invite_expires_in', { time });
}

function initialsOf(name) {
  return String(name || '?')
    .trim().split(/\s+/).slice(0, 2)
    .map(s => s[0]?.toUpperCase() || '').join('') || '?';
}
function escapeHTML(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
