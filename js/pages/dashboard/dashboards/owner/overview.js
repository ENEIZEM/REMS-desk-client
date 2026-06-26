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
import {
  mountRequests, renderAll as renderRequests,
  registerListFilter, setRequestTeam, periodStart,
} from '../_shared/requests.js';

export function mountOwnerOverview(profile) {
  const slot = document.querySelector('#owner-overview-slot');
  if (!slot) return;

  const PERIODS = [
    { id: 'week',  labelKey: 'period.week'  },
    { id: 'month', labelKey: 'period.month' },
    { id: 'year',  labelKey: 'period.year'  },
    { id: 'all',   labelKey: 'period.all'   },
  ];
  const scopeKey  = 'rems_owner_overview_scope';
  const periodKey = 'rems_owner_overview_period';
  let activeScope  = localStorage.getItem(scopeKey)  || 'all';
  let activePeriod = localStorage.getItem(periodKey) || 'month';

  // Пре-фильтр ленты: ТОЛЬКО период (к архиву). Охват («тип заявки»)
  // теперь живёт в под-фильтрах — renderAll читает feed.dataset.rqScope
  // и сам отрисовывает сегмент в [data-rq-scope]. Ось «чьё/стадия» —
  // плитки (segmentedHTML), линза «сотрудник» — панель «Команда» (renderAll
  // через data-rq-team-emp). Здесь по охвату/сотруднику НЕ фильтруем.
  registerListFilter('owner-overview', (r) => {
    const terminal = r.status === 'closed' || r.status === 'cancelled';
    if (terminal) {
      const from = periodStart(activePeriod);
      if (from && new Date(r.closed_at || r.created_at) < from) return false;
    }
    return true;
  });

  // page-header уже есть в HTML #tab-overview — не дублируем.
  slot.innerHTML = `
    <!-- Плитки = статистика + первичный фильтр (рендерит renderAll). -->
    <div class="rq-tiles-row" data-rq-tiles="owner-overview"></div>

    <!-- Под-фильтры над лентой: тип заявки (сегмент с цифрами) │ период
         (выпадающий список) │ команда. Разделены вертикальными линиями. -->
    <div class="rq-subfilters">
      <div class="rq-subfilter-group" data-rq-scope="owner-overview"></div>
      <div class="rq-subfilter-group rq-subfilter-period">
        ${renderTogglePicker(PERIODS, activePeriod, 'data-owner-period')}
      </div>
      <div class="rq-subfilter-group rq-subfilter-team" data-rq-team="owner-overview"></div>
      <!-- Подсказка по заявкам — ПРЯМО в контейнере фильтров, по центру по
           высоте (align-items:center у .rq-subfilters), прижата вправо. -->
      <span class="profile-card-tooltip rq-filters-hint" tabindex="0" data-tooltip-key="owner.overview_requests_hint">
        <i class="ph ph-info"></i>
      </span>
    </div>

    <!-- Рабочая зона: лента заявок | уведомления (2-колонка, лента шире). -->
    <div class="profile-two-col employee-two-col rq-work-cols" style="margin-top:.75rem;">
      <div class="profile-col employee-col-left">
        <div class="card profile-card rq-work-feed">
          <div class="profile-card-header">
            <div class="profile-card-icon navy"><i class="ph-bold ph-clipboard-text"></i></div>
            <h3 class="profile-card-title" data-i18n="employee.requests_header_overview">Заявки</h3>
            <!-- Подсказка переехала в контейнер фильтров (.rq-subfilters). -->
          </div>
          <div class="profile-card-body requests-feed-body" id="owner-overview-requests-body"
               data-requests-list data-rq-segmented data-rq-filter="owner-overview"
               data-rq-scope="${activeScope}"></div>
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
                  <span data-i18n="notifications.filter_unread">Новые</span>
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

  // Заявки: лента + плитки + Команда (общий модуль). Кнопка «Создать» —
  // в page-header вкладки Обзор (data-rq-create).
  mountRequests(profile).catch(err => console.warn('[owner overview requests]', err));

  // Охват («тип заявки») обрабатывает renderAll (клик по [data-rq-scope-pick]),
  // тут вешаем только период.
  wirePopoverPicker(slot, '[data-owner-period]', (id) => { activePeriod = id; localStorage.setItem(periodKey, id); renderRequests(); }, PERIODS);

  // Команда: участники → панель нагрузки (workload). renderAll отрисует её
  // в [data-rq-team]; имена берутся из состава + исполнителей заявок.
  loadMembersForFilter().then(list => setRequestTeam(list)).catch(() => {});

  if (!slot.__remsLangBound) {
    slot.__remsLangBound = true;
    onLangChange(() => { renderRequests(); applyTranslations(); });
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
