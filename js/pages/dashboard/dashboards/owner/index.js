/* ═══════════════════════════════════════════════════════════════
   OWNER dashboard orchestrator.
   Запускается role-router'ом после загрузки профиля если
   profile.user.org_role === 'owner'.

   Что делает:
     • Снимает hidden со всех owner-only элементов sidebar
     • Скрывает employee-only элементы (если такие есть)
     • Включает placeholder вкладки «Каталог» и «Партнёры»
     • Делегирует данные-логику в shared модули (members.js,
       organization.js, profile.js — те что уже существуют)

   НЕ дублирует boot, auth, socket — это всё уже сделано
   главным index.js. Этот файл — только UI-скоп для роли.
   ═══════════════════════════════════════════════════════════════ */

import { hide, show } from '../_shared/role-helpers.js';
import { mountOwnerOverview }  from './overview.js';
import { mountOwnerRequests }  from './requests.js';
import { mountOwnerCatalog }   from './catalog.js';
import { mountOwnerPartners }  from './partners.js';
import { mountOwnerTeam }      from './team.js';
import { mountOwnerContracts } from './contracts.js';
import { t, onLangChange }     from '../../../../i18n.js';

function safeRun(name, fn) {
  try { fn(); }
  catch (e) { console.error(`[owner mount: ${name}] failed:`, e); }
}

export function bootOwnerDashboard(profile) {
  show('#org-nav-section', 'block');
  show('#nav-item-org');
  show('#nav-item-contracts');
  hide('#profile-solo-section');
  hide('[data-role-only="employee"]');
  hide('[data-role-only="solo"]');

  // Owner tabs (финальный набор): Обзор, Ресурсы, Партнёры
  // (=#tab-contracts, переименован), Ваша организация, Профиль.
  // Скрываем: Каталог (встроен в Ресурсы), отдельный Заявки tab
  // (заявки теперь в Обзоре), старую вкладку Партнёры (#tab-partners —
  // её роль перешла к Контрактам, переименованным в «Партнёры»).
  hide('.nav-item[data-tab="catalog"]');
  hide('#tab-catalog');
  hide('.nav-item[data-tab="requests"]');
  hide('#tab-requests');
  hide('.nav-item[data-tab="partners"]');
  hide('#tab-partners');

  // «Контракты» nav-item + page-title → «Партнёры». Вызывается ПОСЛЕ
  // mountOwnerContracts (он перезаписывает #tab-contracts innerHTML).
  const relabelContracts = () => {
    const lbl = t('nav.partners');
    const navC = document.querySelector('#nav-item-contracts span');
    if (navC) { navC.setAttribute('data-i18n', 'nav.partners'); navC.textContent = lbl; }
    const titleC = document.querySelector('#tab-contracts .page-title');
    if (titleC) { titleC.setAttribute('data-i18n', 'nav.partners'); titleC.textContent = lbl; }
  };

  // Sidebar: «Сотрудники» → «Ресурсы» (та же логика что у employee,
  // owner тоже видит коллег + технику единым tab'ом). Меняем И
  // data-i18n attribute, И textContent — DOM-walker не перетрёт.
  const relabelMembersForOwner = () => {
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
  relabelMembersForOwner();

  // Owner mounts. Каждый — в своём try/catch. Requests/Partners tabs
  // скрыты — их mount не нужен. Overview подключает notifications сам.
  safeRun('overview',  () => mountOwnerOverview(profile));
  safeRun('catalog',   () => mountOwnerCatalog());
  safeRun('team',      () => mountOwnerTeam(profile));
  safeRun('contracts', () => mountOwnerContracts(profile));

  // Relabel ПОСЛЕ mounts (mountOwnerContracts перезаписывает title).
  relabelContracts();

  if (!window.__remsOwnerColleaguesRelabelWired) {
    window.__remsOwnerColleaguesRelabelWired = true;
    onLangChange(() => {
      if (document.body.dataset.role === 'owner') {
        relabelMembersForOwner();
        relabelContracts();
      }
    });
  }
}
