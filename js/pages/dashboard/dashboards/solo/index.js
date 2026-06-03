/* ═══════════════════════════════════════════════════════════════
   SOLO dashboard orchestrator.
   Юзер не в организации — у него только две вкладки: «Главная»
   (welcome + CTA на создание/вступление) и «Профиль».
   Прячем всю sidebar-секцию «Организация», все owner/employee
   контент-блоки. Включаем solo-tab-panel.
   ═══════════════════════════════════════════════════════════════ */

import { hide, show } from '../_shared/role-helpers.js';
import { mountSoloHome } from './home.js';
import { t } from '../../../../i18n.js';

export function bootSoloDashboard(profile) {
  // Sidebar: оставляем только Главную + Профиль. Скрываем всё что
  // относится к работе внутри организации (Заявки, Каталог, Партнёры,
  // Команда, Организация).
  hide('#org-nav-section');
  // Профиль у solo вынесен в отдельную секцию (org-section, где он
  // живёт у employee/owner, скрыта целиком).
  show('#profile-solo-section', 'block');
  hide('[data-role-only="owner"]');
  hide('[data-role-only="employee"]');
  hide('.nav-item[data-tab="requests"]');
  hide('.nav-item[data-tab="equipment"]');
  hide('.nav-item[data-tab="catalog"]');
  hide('.nav-item[data-tab="partners"]');
  hide('.nav-item[data-tab="contracts"]');
  hide('#tab-contracts');

  // «Обзор» переименовываем в «Главная» — переключаем data-tab,
  // чтобы клик вёл на solo-tab-panel.
  const homeBtn = document.querySelector('.nav-item[data-tab="overview"]');
  if (homeBtn) {
    homeBtn.dataset.tab = 'solo-home';
    const span = homeBtn.querySelector('span');
    // Меняем И data-i18n, И textContent (как relabelMembers у employee):
    // applyTranslations() — DOM-walker по data-i18n — иначе перетёр бы
    // хардкод-текст обратно на nav.dashboard ("Обзор"/"Overview") при
    // любом переключении языка, а на EN-локали лейбл был бы по-русски.
    if (span) {
      span.setAttribute('data-i18n', 'nav.home');
      span.textContent = t('nav.home');
    }
  }

  // Скрываем все остальные tab-panel'ы — solo home единственный visible.
  hide('#tab-overview');
  hide('#tab-requests');
  hide('#tab-equipment');
  hide('#tab-catalog');
  hide('#tab-partners');
  hide('#tab-members');
  hide('#tab-org');

  show('#tab-solo-home');
  document.querySelector('#tab-solo-home')?.classList.add('active');

  mountSoloHome(profile);
}
