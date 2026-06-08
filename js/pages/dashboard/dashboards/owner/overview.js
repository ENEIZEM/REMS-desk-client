/* ═══════════════════════════════════════════════════════════════
   Owner Overview tab.

   По дизайн-спеку L4a:
     • БЕЗ шапки организации (в отличие от employee)
     • Шапка заявок — как .requests-card на employee/requests
       (3 picker'а: scope/type/period) ПЛЮС ещё один picker —
       фильтр по сотрудникам (имена approved-сотрудников).
     • Слева Статистика, справа Уведомления — как у employee
   ═══════════════════════════════════════════════════════════════ */

import { t, applyTranslations, onLangChange } from '../../../../i18n.js';
import { members as membersApi } from '../../../../api.js';
import { setNotificationsTarget, loadNotifications } from '../../notifications.js';
import { mountRequests } from '../_shared/requests.js';

export function mountOwnerOverview(profile) {
  const slot = document.querySelector('#owner-overview-slot');
  if (!slot) return;

  const user  = profile?.user || {};

  const PERIODS = [
    { id: 'week',  labelKey: 'period.week'  },
    { id: 'month', labelKey: 'period.month' },
    { id: 'year',  labelKey: 'period.year'  },
    { id: 'all',   labelKey: 'period.all'   },
  ];
  const SCOPE_FILTERS = [
    { id: 'all',      labelKey: 'employee.req_scope_all'      },
    { id: 'internal', labelKey: 'employee.req_scope_internal' },
    { id: 'partner',  labelKey: 'employee.req_scope_partner'  },
  ];
  // Owner-specific type labels — относятся к ВЫБРАННОМУ в 4-м фильтре
  // сотруднику: «созданные сотрудником / закрытые сотрудником / все
  // сотрудника». Когда выбрано «Все сотрудники» — это «всех».
  const TYPE_FILTERS = [
    { id: 'all_emp', labelKey: 'owner.req_type_all_emp'   },
    { id: 'created', labelKey: 'owner.req_type_created'   },
    { id: 'closed',  labelKey: 'owner.req_type_closed'    },
    { id: 'free',    labelKey: 'employee.req_type_free'   },
  ];

  const scopeKey  = 'rems_owner_overview_scope';
  const typeKey   = 'rems_owner_overview_type';
  const periodKey = 'rems_owner_overview_period';
  const empKey    = 'rems_owner_overview_employee';
  let activeScope    = localStorage.getItem(scopeKey)    || 'all';
  let activeType     = localStorage.getItem(typeKey)     || 'created';
  let activePeriod   = localStorage.getItem(periodKey)   || 'month';
  let activeEmployee = localStorage.getItem(empKey)      || 'all';

  // Employee filter — динамический (зависит от членов орги).
  // Базовый «Все сотрудники» + конкретные имена.
  let EMPLOYEE_FILTERS = [{ id: 'all', labelKey: 'owner.emp_filter_all' }];

  // page-header уже есть в HTML #tab-overview — не дублируем.
  slot.innerHTML = `
    <div class="card profile-card" style="margin-top:1rem;">
      <div class="profile-card-header profile-card-header--with-actions">
        <div class="profile-card-icon navy"><i class="ph-bold ph-clipboard-text"></i></div>
        <h3 class="profile-card-title" data-i18n="employee.requests_header_overview">Заявки</h3>
        <div class="notif-header-actions">
          ${renderTogglePicker(SCOPE_FILTERS,    activeScope,    'data-owner-scope')}
          ${renderTogglePicker(TYPE_FILTERS,     activeType,     'data-owner-type')}
          ${renderTogglePicker(PERIODS,          activePeriod,   'data-owner-period')}
          ${renderTogglePicker(EMPLOYEE_FILTERS, activeEmployee, 'data-owner-emp')}
          <span class="profile-card-tooltip profile-card-tooltip--end" tabindex="0" data-tooltip-key="owner.overview_requests_hint">
            <i class="ph ph-info"></i>
          </span>
        </div>
      </div>
      <div class="profile-card-body requests-feed-body" id="owner-overview-requests-body"
           data-requests-list data-rq-filter="all"></div>
    </div>

    <div class="profile-two-col employee-two-col" style="margin-top:1rem;">
      <div class="profile-col employee-col-left">
        <div class="card profile-card employee-stats-card">
          <div class="profile-card-header profile-card-header--with-actions">
            <div class="profile-card-icon teal"><i class="ph-bold ph-chart-bar"></i></div>
            <h3 class="profile-card-title" data-i18n="employee.stats_title">Статистика</h3>
            <div class="notif-header-actions">
              ${renderTogglePicker(PERIODS, activePeriod, 'data-owner-stats-period')}
            </div>
            <span class="profile-card-tooltip profile-card-tooltip--end" tabindex="0" data-tooltip-key="employee.stats_hint">
              <i class="ph ph-info"></i>
            </span>
          </div>
          <div class="profile-card-body" id="owner-stats-body">
            ${renderStatsRows(user)}
          </div>
        </div>
      </div>

      <div class="profile-col employee-col-right">
        <div class="card profile-card employee-notifs-card">
          <div class="profile-card-header profile-card-header--with-actions">
            <div class="profile-card-icon teal"><i class="ph-bold ph-bell"></i></div>
            <h3 class="profile-card-title" data-i18n="notifications.title">Уведомления</h3>
            <div class="notif-header-actions">
              <div class="notif-filter" role="tablist" data-notif-filter-host>
                <button type="button" class="notif-filter-btn is-active"
                        data-filter="all" role="tab" aria-selected="true"
                        data-i18n="notifications.filter_all">Все</button>
                <button type="button" class="notif-filter-btn"
                        data-filter="unread" role="tab" aria-selected="false">
                  <span data-i18n="notifications.filter_unread">Непрочитанные</span>
                  <span class="notif-filter-count" data-unread-count></span>
                </button>
              </div>
              <button class="btn btn-secondary btn-sm" data-mark-all-read>
                <i class="ph ph-checks"></i>
                <span data-i18n="notifications.mark_all">Прочитать все</span>
              </button>
            </div>
          </div>
          <div class="profile-card-body" id="employee-notifs-slot">
            <div class="empty-state empty-state--inline">
              <i class="ph ph-bell-slash"></i>
              <span class="empty-state-text" data-i18n="notifications.empty">Нет новых уведомлений</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  applyTranslations();
  setNotificationsTarget('#employee-notifs-slot');
  loadNotifications().catch(err => console.warn('[owner overview notifications]', err));

  // Заявки: лента + дорожная карта (общий модуль). Кнопка «Создать» —
  // в page-header вкладки Обзор (data-rq-create).
  mountRequests(profile).catch(err => console.warn('[owner overview requests]', err));

  // Pickers.
  wirePopoverPicker(slot, '[data-owner-scope]',         (id) => { activeScope = id; localStorage.setItem(scopeKey, id); }, SCOPE_FILTERS);
  wirePopoverPicker(slot, '[data-owner-type]',          (id) => { activeType = id;  localStorage.setItem(typeKey, id); }, TYPE_FILTERS);
  wirePopoverPicker(slot, '[data-owner-period]',        (id) => { activePeriod = id; localStorage.setItem(periodKey, id); }, PERIODS);
  wirePopoverPicker(slot, '[data-owner-stats-period]',  (id) => {
    activePeriod = id;
    localStorage.setItem(periodKey, id);
    const body = slot.querySelector('#owner-stats-body');
    if (body) body.innerHTML = renderStatsRows(user);
    applyTranslations();
  }, PERIODS);
  // Employee filter — popover, заполняется после loadMembers.
  wirePopoverPicker(slot, '[data-owner-emp]', (id) => {
    activeEmployee = id;
    localStorage.setItem(empKey, id);
  }, EMPLOYEE_FILTERS);

  // Загружаем список сотрудников и обновляем employee-filter dropdown.
  loadMembersForFilter().then(list => {
    EMPLOYEE_FILTERS = [
      { id: 'all', labelKey: 'owner.emp_filter_all' },
      ...list.map(m => ({ id: String(m.id), label: m.full_name })),
    ];
    const host = slot.querySelector('[data-owner-emp]');
    if (!host) return;
    const menu = host.querySelector('.picker-menu');
    if (!menu) return;
    menu.innerHTML = EMPLOYEE_FILTERS.map(x => `
      <button type="button" class="picker-menu-item ${x.id === activeEmployee ? 'is-active' : ''}"
              data-pick="${x.id}"${x.labelKey ? ` data-i18n="${x.labelKey}"` : ''}>
        ${escapeHTML(x.labelKey ? t(x.labelKey) : x.label)}
      </button>
    `).join('');
    applyTranslations();
  }).catch(()=>{});

  if (!slot.__remsLangBound) {
    slot.__remsLangBound = true;
    onLangChange(() => {
      const body = slot.querySelector('#owner-stats-body');
      if (body) body.innerHTML = renderStatsRows(user);
      applyTranslations();
    });
  }
}

/* ── Helpers ─────────────────────────────────────────────── */

async function loadMembersForFilter() {
  try {
    const data = await membersApi.list();
    return data?.data?.approved || [];
  } catch {
    return [];
  }
}

function renderRequestsEmpty() {
  return `
    <div class="empty-state empty-state--inline">
      <i class="ph ph-clipboard"></i>
      <span class="empty-state-text" data-i18n="employee.requests_empty_for_filter">
        По выбранным фильтрам заявок нет.
      </span>
    </div>
  `;
}

function renderStatsRows(user) {
  const stats = user.stats || {};
  const inWork     = Number(stats.requests_in_work ?? 0);
  const poolFree   = Number(stats.pool_free ?? 0);
  const closed     = Number(stats.requests_closed_period ?? 0);
  const opened     = Number(stats.requests_opened_period ?? 0);
  const handledN   = Number(stats.requests_handled ?? 0);
  const hasRating  = stats.rating_avg != null && handledN > 0;
  const ratingAvg  = hasRating ? Number(stats.rating_avg).toFixed(1) : '';
  const hasPartnerRating = false; // cross-org rating пока не реализован
  return `
    <div class="profile-row">
      <span class="profile-row-label" data-i18n="employee.stat_role">Ваша роль в организации</span>
      <span class="profile-row-value">
        <span class="row-chip chip-owner">${t('roles.owner')} <i class="ph-duotone ph-shield-star"></i></span>
      </span>
    </div>
    <div class="profile-row">
      <span class="profile-row-label" data-i18n="owner.stat_in_work_total">Заявок в работе</span>
      <span class="profile-row-value">${inWork}</span>
    </div>
    <div class="profile-row">
      <span class="profile-row-label" data-i18n="owner.stat_pool_free">Свободных в пуле</span>
      <span class="profile-row-value">${poolFree}</span>
    </div>
    <div class="profile-row">
      <span class="profile-row-label" data-i18n="owner.stat_closed_period">Закрыто за период</span>
      <span class="profile-row-value">${closed}</span>
    </div>
    <div class="profile-row">
      <span class="profile-row-label" data-i18n="owner.stat_opened_period">Открыто за период</span>
      <span class="profile-row-value">${opened}</span>
    </div>
    <div class="profile-row">
      <span class="profile-row-label" data-i18n="owner.stat_rating_internal">Средняя оценка работы внутри организации</span>
      <span class="profile-row-value">
        ${hasRating
          ? `${ratingAvg}<i class="ph-duotone ph-star stat-rating-star" aria-hidden="true" style="margin-left:.35rem;"></i>`
          : `<span class="stats-empty" data-i18n="employee.stat_rating_empty">Нет оценок</span>`}
      </span>
    </div>
    <div class="profile-row" style="border-bottom:none;">
      <span class="profile-row-label" data-i18n="owner.stat_rating_partner">Средняя оценка работы партнёрами</span>
      <span class="profile-row-value">
        ${hasPartnerRating
          ? ``
          : `<span class="stats-empty" data-i18n="employee.stat_rating_empty">Нет оценок</span>`}
      </span>
    </div>
  `;
}

function renderTogglePicker(list, activeId, marker) {
  const active = list.find(x => x.id === activeId) || list[0];
  const activeText = active?.labelKey ? t(active.labelKey) : (active?.label || '');
  const activeI18n = active?.labelKey ? ` data-i18n="${active.labelKey}"` : '';
  return `
    <div class="period-picker" ${marker}>
      <button type="button" class="picker-btn">
        <span data-active-label${activeI18n}>${escapeHTML(activeText)}</span>
        <i class="ph ph-caret-down picker-caret"></i>
      </button>
      <div class="picker-menu" hidden>
        ${list.map(x => `
          <button type="button" class="picker-menu-item ${x.id === activeId ? 'is-active' : ''}"
                  data-pick="${x.id}"${x.labelKey ? ` data-i18n="${x.labelKey}"` : ''}>
            ${escapeHTML(x.labelKey ? t(x.labelKey) : x.label)}
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function wirePopoverPicker(scope, hostSelector, onPick, list) {
  const host = scope.querySelector(hostSelector);
  if (!host) return;
  const btn   = host.querySelector('.picker-btn');
  const menu  = host.querySelector('.picker-menu');
  const label = host.querySelector('[data-active-label]');
  if (!btn || !menu) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  // ВАЖНО: label читаем из САМОГО выбранного item'а (textContent +
  // data-i18n), а НЕ из closure-параметра `list`. Employee-picker
  // перестраивает menu.innerHTML после loadMembers — closure list
  // становится устаревшим, и старый код не мог найти выбранное имя
  // (баг M4: текст кнопки не обновлялся). Чтение из DOM устойчиво к
  // динамической перестройке меню.
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-pick]');
    if (!item) return;
    const id = item.getAttribute('data-pick');
    if (label) {
      const i18nKey = item.getAttribute('data-i18n');
      if (i18nKey) label.setAttribute('data-i18n', i18nKey);
      else         label.removeAttribute('data-i18n');
      label.textContent = item.textContent.trim();
    }
    menu.querySelectorAll('.picker-menu-item').forEach(i => {
      i.classList.toggle('is-active', i.getAttribute('data-pick') === id);
    });
    menu.hidden = true;
    onPick(id);
  });
  document.addEventListener('click', (e) => {
    if (!host.contains(e.target)) menu.hidden = true;
  });
}

function escapeHTML(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
