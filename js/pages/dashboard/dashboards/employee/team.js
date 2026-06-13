/* ═══════════════════════════════════════════════════════════════
   Employee Team tab — объединённая вкладка «Коллеги».
   Содержит два блока:
     1. Коллеги — список approved-сотрудников орги БЕЗ статистики
        и кнопок исключения (только owner-у их видеть).
     2. Техника — список оборудования организации (placeholder
        пока нет реального API).

   Раньше Коллеги жили в #tab-members (общий с owner-views), а
   Техника в отдельном #tab-catalog. Теперь для сотрудника они
   склеены в одну страницу — меньше навигации, ближе к рабочему
   контексту.
   ═══════════════════════════════════════════════════════════════ */

import { t, applyTranslations, onLangChange } from '../../../../i18n.js';
import { members as membersApi } from '../../../../api.js';
import { setAvatar } from '../../format.js';
import { mountEquipment } from '../_shared/equipment.js';

let _empLangBound = false;

export function mountEmployeeTeam(profile) {
  const tabPanel = document.querySelector('#tab-members');
  if (!tabPanel) return;
  // .tab-fill — модификатор для viewport-fill раскладки
  // (см. style.css). Page больше не скроллится; скролл — внутри
  // cards. На re-mount у других ролей класс убирается.
  tabPanel.classList.add('tab-fill');

  // Полностью переписываем содержимое #tab-members для employee.
  // Owner-разметка (pending-секция, approved-list с invite-кнопкой)
  // не нужна — у него есть свой #btn-invite в page-header, но он
  // hidden для employee.
  tabPanel.innerHTML = `
    <div class="page-header page-header--with-action">
      <div>
        <h1 class="page-title" data-i18n="nav.colleagues">Коллеги</h1>
        <p class="page-desc" data-i18n="team.desc">Сотрудники вашей организации и закреплённая за ней техника.</p>
      </div>
      <div class="page-header-actions">
        <button class="btn btn-primary" id="btn-equipment-add">
          <i class="ph ph-plus"></i> <span data-i18n="equipment.add_btn">Добавить технику</span>
        </button>
      </div>
    </div>

    <div class="profile-two-col" style="margin-top:1rem;">
      <!-- LEFT: список коллег -->
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

      <!-- RIGHT: техника (placeholder) -->
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

  // Перерисовка коллег при смене языка (роли в строках иначе остаются
  // на старом языке).
  if (!_empLangBound) {
    _empLangBound = true;
    onLangChange(() => {
      if (document.body.dataset.role === 'employee' && document.querySelector('#team-colleagues-body')) {
        loadColleagues();
      }
    });
  }

  // Подгружаем коллег. Скрываем сервисные блоки (pending-section,
  // approved-section) — мы их полностью заменили своей разметкой.
  loadColleagues();
}

async function loadColleagues() {
  const body  = document.querySelector('#team-colleagues-body');
  const count = document.querySelector('#team-colleagues-count');
  if (!body) return;
  try {
    const data = await membersApi.list();
    const approved = data?.data?.approved || [];
    if (count) count.textContent = String(approved.length);

    if (!approved.length) {
      body.innerHTML = `
        <div class="empty-state empty-state--inline">
          <i class="ph ph-users"></i>
          <span class="empty-state-text" data-i18n="team.colleagues_empty">В организации пока только вы.</span>
        </div>
      `;
      applyTranslations();
      return;
    }

    body.innerHTML = approved.map(colleagueRowHTML).join('');
  } catch (err) {
    body.innerHTML = `
      <div class="empty-state empty-state--inline">
        <i class="ph ph-warning-circle"></i>
        <span class="empty-state-text">${escapeHTML(err?.message || 'error')}</span>
      </div>
    `;
  }
}

function colleagueRowHTML(m) {
  // Avatar tile (фото кликабельно → просмотрщик, делегат в dashboard/index.js).
  const hasPhoto = !!m.avatar?.url;
  const avatarTile = hasPhoto
    ? `<img src="${escapeHTML(m.avatar.url)}" alt="">`
    : `<span>${escapeHTML(initialsOf(m.full_name))}</span>`;
  const avatarAttrs = hasPhoto
    ? ` avatar--clickable" data-avatar-view="${escapeHTML(m.avatar.url)}" data-avatar-name="${escapeHTML(m.full_name)}" role="button" tabindex="0" title="${escapeHTML(t('common.attachment_view'))}"`
    : '"';
  const contact = m.email_masked || m.phone_masked || '—';
  const dept    = m.department || t('members.no_department');
  const roleLbl = m.org_role === 'owner'
    ? t('roles.owner')
    : t('roles.employee');
  return `
    <div class="team-colleague-row${m.org_role === 'owner' ? ' team-colleague-row--owner' : ' team-colleague-row--employee'}">
      <div class="avatar avatar-md${avatarAttrs}>${avatarTile}</div>
      <div class="team-colleague-text">
        <div class="team-colleague-name">${escapeHTML(m.full_name)}</div>
        <div class="team-colleague-contact">${escapeHTML(contact)}</div>
        <div class="team-colleague-meta">${escapeHTML(dept)}</div>
      </div>
      <span class="badge ${m.org_role === 'owner' ? 'badge-role-owner' : 'badge-role-employee'}">${escapeHTML(roleLbl)}</span>
    </div>
  `;
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
