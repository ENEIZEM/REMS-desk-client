/* ═══════════════════════════════════════════════════════════════
   EMPLOYEE dashboard orchestrator.
   role-router вызывает после loadProfile для approved сотрудника.

   В сравнении с owner:
     • Скрывает «Команда» management actions (manage / remove)
     • Скрывает «Партнёры» вкладку — контракты ведёт руководитель
     • Скрывает invite-кнопку
     • Members rendered как «Коллеги» (read-only)
     • Organization рендерится в read-only режиме (edit-кнопки
       скрыты автоматически по permissions из /profile/me)
   ═══════════════════════════════════════════════════════════════ */

import { hide, show } from '../_shared/role-helpers.js';
import { mountEmployeeRequests }  from './requests.js';
import { mountEmployeeContracts } from './contracts.js';
import { mountEmployeeTeam }      from './team.js';
import { setNotificationsTarget } from '../../notifications.js';
import { t, onLangChange }        from '../../../../i18n.js';

// Helper: wrap each mount in its own try/catch so one failure doesn't
// short-circuit later mounts. Logs to console with named breadcrumb.
function safeRun(name, fn) {
  try { fn(); }
  catch (e) { console.error(`[employee mount: ${name}] failed:`, e); }
}

export function bootEmployeeDashboard(profile) {
  console.log('[employee boot] start');
  // ВАЖНО: notifications target ставит сам mountEmployeeOverview
  // (на собственный #employee-notifs-slot). Здесь не нужно.
  show('#org-nav-section', 'block');
  // Solo-режим у профиля — только когда нет орги. Сейчас employee →
  // профиль живёт в org-section вместе с Коллеги/Контракты/Организация.
  hide('#profile-solo-section');
  hide('[data-role-only="owner"]');
  hide('[data-role-only="solo"]');

  // Сотрудник: вкладка «Организация» доступна READ-ONLY — здесь живут
  // справочные SLA-матрица + лимиты + орг-шапка (членство). Все edit-
  // контролы (карандаши, лого, имя, апгрейд) скрыты по permissions
  // (can_edit_* = false из /profile/me → populateOrgTab их прячет).
  show('#nav-item-org');

  // Вкладка «Заявки» убрана: рабочий стол (плитки + лента | уведомления)
  // живёт на «Обзоре» (единый воркспейс, без дубля ленты).
  hide('.nav-item[data-tab="requests"]');
  hide('#tab-requests');

  // Members tab → «Коллеги» (объединённая с техникой — см. H4).
  // Скрываем owner-only управление (invite/delete).
  hide('#btn-invite');
  hide('.members-row-delete');

  // Скрываем катaлог (отдельный tab) — для employee он встроен
  // во вкладку «Коллеги» вторым блоком.
  hide('.nav-item[data-tab="catalog"]');
  hide('#tab-catalog');

  // Контракты доступны сотруднику (read-only) — показываем sidebar-link.
  show('#nav-item-contracts');

  // Sidebar: «Сотрудники» → «Коллеги», page-title тоже.
  // Меняем И data-i18n attribute, И textContent, чтобы DOM-walker
  // applyTranslations() (который бежит при init + onLangChange) не
  // перетёр текст обратно на "Сотрудники" — он читает data-i18n.
  const relabelMembers = () => {
    const lbl = t('nav.colleagues');
    const navMembersEl = document.querySelector('#nav-item-members span');
    if (navMembersEl) {
      navMembersEl.setAttribute('data-i18n', 'nav.colleagues');
      navMembersEl.textContent = lbl;
    }
    const tabMembersTitle = document.querySelector('#tab-members .page-title');
    if (tabMembersTitle) {
      tabMembersTitle.setAttribute('data-i18n', 'nav.colleagues');
      tabMembersTitle.textContent = lbl;
    }
  };
  relabelMembers();
  if (!window.__remsColleaguesRelabelWired) {
    window.__remsColleaguesRelabelWired = true;
    onLangChange(() => {
      if (document.body.dataset.role === 'employee') relabelMembers();
    });
  }

  // Каждый mount — независимый try/catch. Ошибка в одном не блокирует
  // остальные. Самая критичная — overview (стартовая вкладка); если она
  // падает, switchTab('overview') показывает пустую панель.
  // «Обзор» = единый рабочий стол заявок (mountEmployeeRequests рендерит
  // в #employee-overview-slot). Отдельной вкладки «Заявки» больше нет.
  safeRun('overview',  () => mountEmployeeRequests(profile));
  safeRun('contracts', () => mountEmployeeContracts(profile));
  // Team-вкладка (объединение коллеги + техника) — отрисует второй
  // блок в #tab-members. Делается ПОСЛЕ basic-mounts.
  safeRun('team',      () => mountEmployeeTeam(profile));
  console.log('[employee boot] done');
}
