/* ═══════════════════════════════════════════════════════════════
   Employee Overview tab.

   Структура (обновлённый дизайн):
     1. Шапка организации — identity-card + кнопка «Покинуть».
     2. Шапка заявок — компактная карточка с segmented filter
        (свободные/текущие) и min-/max-height на body.
     3. Двухколонный блок: слева Статистика (fixed-height,
        period picker), справа Уведомления (растягивается под
        высоту левого блока — НЕ наоборот).
   ═══════════════════════════════════════════════════════════════ */

import { t, applyTranslations, onLangChange } from '../../../../i18n.js';
import { membership } from '../../../../api.js';
import { toast, errorMessage } from '../../../../auth.js';
import { setNotificationsTarget, loadNotifications } from '../../notifications.js';
import { setAvatar } from '../../format.js';
import { roleBadgeDescriptor, orgStatusBadge, renderIconBadge } from '../../badges.js';
import { openModal, closeModal, setLoading } from '../../ui-helpers.js';
import {
  mountRequests, renderAll as renderRequests,
  getRequests, onRequestsUpdated, periodStart,
} from '../_shared/requests.js';

/* Статистика сотрудника из загруженной ленты заявок. Раньше она читала
   user.stats, которого backend никогда не отдавал — все значения были 0. */
function computeEmployeeStats(list, selfId, myOrgId, period) {
  const from = periodStart(period);
  const inP  = (iso) => !from || (iso && new Date(iso) >= from);
  const mineAssigned = (r) => Number(r.assigned_to_id) === Number(selfId);
  const mineAuthored = (r) => Number(r.author_id) === Number(selfId);

  const closedByMe   = list.filter(r => r.status === 'closed' && mineAssigned(r) && inP(r.closed_at));
  const ratedInt     = closedByMe.filter(r => r.rating != null && r.is_internal);
  const ratedPartner = closedByMe.filter(r => r.rating != null && !r.is_internal);
  const avg = (arr) => arr.length ? arr.reduce((s, r) => s + Number(r.rating), 0) / arr.length : null;
  return {
    requests_in_work:        list.filter(r => mineAssigned(r) && ['assigned', 'in_progress'].includes(r.status)).length,
    pool_free:               list.filter(r => r.status === 'new' && Number(r.contractor_org_id) === Number(myOrgId)).length,
    requests_closed_period:  closedByMe.length,
    requests_opened_period:  list.filter(r => mineAuthored(r) && inP(r.created_at)).length,
    requests_handled:        ratedInt.length,
    rating_avg:              avg(ratedInt),
    partner_handled:         ratedPartner.length,
    rating_avg_partner:      avg(ratedPartner),
  };
}

export function mountEmployeeOverview(profile) {
  const slot = document.querySelector('#employee-overview-slot');
  if (!slot) return;

  const org   = profile?.organization || {};
  const user  = profile?.user || {};
  const role  = user.org_role || 'employee';
  const orgName = org.name || '—';

  // Период — клиентский state. Сохраняется в localStorage.
  const PERIODS = [
    { id: 'week',   labelKey: 'period.week'   },
    { id: 'month',  labelKey: 'period.month'  },
    { id: 'year',   labelKey: 'period.year'   },
    { id: 'all',    labelKey: 'period.all'    },
  ];
  const periodStorageKey = 'rems_emp_overview_period';
  let activePeriod = localStorage.getItem(periodStorageKey) || 'month';

  // B9: в Обзоре только две опции (свободные / текущие = мои в работе).
  const reqFilterKey = 'rems_emp_overview_req_filter';
  let activeReqFilter = localStorage.getItem(reqFilterKey) || 'free';

  slot.innerHTML = `
    ${renderOrgHeader(org, role)}

    <!-- Шапка заявок: оформление как у других profile-card блоков
         (иконка-тайл слева + заголовок + actions + tooltip последним). -->
    <div class="card profile-card" style="margin-top:1rem;">
      <div class="profile-card-header profile-card-header--with-actions">
        <div class="profile-card-icon navy"><i class="ph-bold ph-clipboard-text"></i></div>
        <h3 class="profile-card-title" data-i18n="employee.requests_header_overview">Заявки</h3>
        <div class="notif-header-actions">
          <div class="notif-filter" role="tablist" data-overview-req-filter>
            <button type="button" class="notif-filter-btn ${activeReqFilter === 'free' ? 'is-active' : ''}"
                    data-req-filter="free" role="tab"
                    data-i18n="employee.req_filter_free_short">Свободные</button>
            <button type="button" class="notif-filter-btn ${activeReqFilter === 'current' ? 'is-active' : ''}"
                    data-req-filter="current" role="tab"
                    data-i18n="employee.req_filter_current">Текущие</button>
          </div>
          <span class="profile-card-tooltip profile-card-tooltip--end" tabindex="0" data-tooltip-key="employee.req_filter_hint_overview">
            <i class="ph ph-info"></i>
          </span>
        </div>
      </div>
      <div class="profile-card-body requests-feed-body" id="employee-overview-requests-body"
           data-requests-list data-rq-filter="${activeReqFilter}"></div>
    </div>

    <div class="profile-two-col employee-two-col" style="margin-top:1rem;">
      <div class="profile-col employee-col-left">
        <div class="card profile-card employee-stats-card">
          <div class="profile-card-header profile-card-header--with-actions">
            <div class="profile-card-icon teal"><i class="ph-bold ph-chart-bar"></i></div>
            <h3 class="profile-card-title" data-i18n="employee.stats_title">Статистика</h3>
            <div class="notif-header-actions">
              ${renderPeriodPicker(PERIODS, activePeriod)}
            </div>
            <span class="profile-card-tooltip profile-card-tooltip--end" tabindex="0" data-tooltip-key="employee.stats_hint">
              <i class="ph ph-info"></i>
            </span>
          </div>
          <div class="profile-card-body" id="employee-stats-body">
            ${renderStatsRows(user, org, activePeriod)}
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

  // Применяем i18n-перевод к свежевставленному HTML — DOM-walker не
  // запускается автоматически когда innerHTML переписан JS-ом. Без
  // этого data-i18n="..." элементы остаются с дефолтным текстом
  // (или пустые) и переводятся только при следующей смене языка.
  applyTranslations();

  setNotificationsTarget('#employee-notifs-slot');
  loadNotifications().catch(err => console.warn('[employee overview notifications]', err));

  // Заявки: загрузка ленты + кнопка «Создать» + дорожная карта (общий модуль).
  mountRequests(profile).catch(err => console.warn('[employee overview requests]', err));

  // Статистика пересчитывается из ленты — обновляем при каждой её
  // перерисовке (первая загрузка, socket-синк, действия по заявкам).
  onRequestsUpdated('emp-overview-stats', () => {
    const body = slot.querySelector('#employee-stats-body');
    if (!body) return;
    body.innerHTML = renderStatsRows(user, org, activePeriod);
    applyTranslations();
  });

  // Re-render на смену языка: пересоберём dynamic-куски (stats rows,
  // picker label), т.к. они построены через template literal с t()
  // и не имеют data-i18n.
  if (!slot.__remsLangBound) {
    slot.__remsLangBound = true;
    onLangChange(() => {
      // Перерисуем только динамические куски — состояние сохраняем
      // через localStorage (period/filter).
      const body = slot.querySelector('#employee-stats-body');
      if (body) body.innerHTML = renderStatsRows(user, org, activePeriod);
      // Picker active-label: перечитаем из текущего id.
      const pickerLabel = slot.querySelector('[data-period-picker] [data-active-label]');
      const pk = PERIODS.find(p => p.id === activePeriod);
      if (pickerLabel && pk) pickerLabel.textContent = t(pk.labelKey);
      applyTranslations();
    });
  }

  // Period picker (для статистики).
  wirePopoverPicker(slot, '[data-period-picker]', (id) => {
    activePeriod = id;
    localStorage.setItem(periodStorageKey, id);
    const body = slot.querySelector('#employee-stats-body');
    if (body) body.innerHTML = renderStatsRows(user, org, activePeriod);
  }, PERIODS);

  // Segmented request-filter (свободные / текущие).
  slot.querySelector('[data-overview-req-filter]')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-req-filter]');
    if (!btn) return;
    const next = btn.getAttribute('data-req-filter');
    if (!next || next === activeReqFilter) return;
    activeReqFilter = next;
    localStorage.setItem(reqFilterKey, next);
    // Sync active state.
    slot.querySelectorAll('[data-req-filter]').forEach(b => {
      b.classList.toggle('is-active', b.getAttribute('data-req-filter') === next);
    });
    const body = slot.querySelector('#employee-overview-requests-body');
    if (body) { body.dataset.rqFilter = next; renderRequests(); }
  });

  // Leave-org confirm.
  wireLeaveOrgModal();
  slot.querySelector('[data-action="leave-org"]')?.addEventListener('click', () => {
    const span = document.querySelector('#leave-org-target');
    if (span) span.textContent = orgName + (org.id ? ` (ID ${org.id})` : '');
    const reasonInput = document.querySelector('#leave-org-reason');
    if (reasonInput) reasonInput.value = '';
    openModal('leave-org-modal');
  });

  // Логотип орги.
  const logoInitials = slot.querySelector('#emp-org-logo-initials');
  const logoImg      = slot.querySelector('#emp-org-logo-img');
  if (logoInitials && logoImg) {
    setAvatar(logoInitials, logoImg, {
      avatar: org.logo,
      full_name: org.name,
      updated_at: org.updated_at,
    });
  }
  renderIconBadge(slot.querySelector('#emp-org-head-active'), orgStatusBadge(org.is_active));
  renderIconBadge(slot.querySelector('#emp-org-head-myrole'), roleBadgeDescriptor(role));
}

/* ── Shared org header (используется только здесь) ──────────── */

export function renderOrgHeader(org, role) {
  const orgName = org?.name || '—';
  const orgIdLabel = org?.id != null ? `#${org.id}` : '—';
  const planLabel = org?.subscription_purchased ? 'Pro' : 'Free';
  return `
    <div class="card profile-identity-card employee-org-header">
      <div class="profile-org-logo">
        <div class="avatar avatar-xxl">
          <span id="emp-org-logo-initials">?</span>
          <img id="emp-org-logo-img" src="" alt="" style="display:none;">
        </div>
      </div>
      <div class="profile-identity-info">
        <h2 class="profile-identity-name">
          <span>${escapeHTML(orgName)}</span>
        </h2>
        <p class="profile-identity-meta">
          <span style="color:var(--clr-text-muted);" data-i18n="profile.organization_id">ID</span>:
          <span style="font-weight:600;">${escapeHTML(orgIdLabel)}</span>
          ·
          <span data-i18n="profile.plan">Тариф</span>:
          <span style="font-weight:700; color:var(--clr-accent);">${planLabel}</span>
        </p>
        <div class="profile-identity-badges">
          <span id="emp-org-head-active" class="badge badge-default">—</span>
          <span id="emp-org-head-myrole" class="badge badge-default">—</span>
        </div>
      </div>
      <div class="employee-org-header-actions">
        <button class="btn btn-danger-ghost btn-sm" data-action="leave-org" title="${t('membership.leave_btn')}">
          <i class="ph ph-sign-out"></i>
          <span data-i18n="membership.leave_btn">Покинуть организацию</span>
        </button>
      </div>
    </div>
  `;
}

function renderRequestsEmpty(filter) {
  const key = filter === 'current'
    ? 'employee.requests_empty_current'
    : 'employee.requests_empty_free';
  return `
    <div class="empty-state empty-state--inline">
      <i class="ph ph-clipboard"></i>
      <span class="empty-state-text" data-i18n="${key}">
        По выбранным фильтрам заявок нет.
      </span>
    </div>
  `;
}

/* ── Stats rows ──────────────────────────────────────────────── */

function renderStatsRows(user, org, period) {
  const role = user.org_role || 'employee';
  const stats = computeEmployeeStats(getRequests(), user.id, org?.id, period);
  const inWork = Number(stats.requests_in_work ?? 0);
  const poolFree = Number(stats.pool_free ?? 0);
  const closedByMe = Number(stats.requests_closed_period ?? 0);
  const openedByMe = Number(stats.requests_opened_period ?? 0);
  const handledN = Number(stats.requests_handled ?? 0);
  const hasRating = stats.rating_avg != null && handledN > 0;
  const ratingAvg = hasRating ? Number(stats.rating_avg).toFixed(1) : '';
  const hasPartnerRating = stats.rating_avg_partner != null && Number(stats.partner_handled) > 0;
  const partnerAvg = hasPartnerRating ? Number(stats.rating_avg_partner).toFixed(1) : '';
  // Цветной chip роли (унифицированные цвета: owner=orange, employee=rose).
  const roleChipClass = role === 'owner' ? 'chip-owner'
    : role === 'sys_admin' ? 'chip-sys-admin' : 'chip-employee';
  const roleIcon = role === 'owner' ? 'ph-shield-star'
    : role === 'sys_admin' ? 'ph-crown-simple' : 'ph-user';
  const roleLabel = role === 'owner'
    ? (t('roles.owner') || 'Руководитель')
    : role === 'sys_admin'
      ? (t('roles.sys_admin') || 'Администратор')
      : (t('roles.employee') || 'Сотрудник');

  return `
    <div class="profile-row">
      <span class="profile-row-label" data-i18n="employee.stat_role">Ваша роль в организации</span>
      <span class="profile-row-value">
        <span class="row-chip ${roleChipClass}">${escapeHTML(roleLabel)} <i class="ph-duotone ${roleIcon}"></i></span>
      </span>
    </div>
    <div class="profile-row">
      <span class="profile-row-label" data-i18n="employee.stat_my_in_work">Мои заявки в работе</span>
      <span class="profile-row-value">${inWork}</span>
    </div>
    <div class="profile-row">
      <span class="profile-row-label" data-i18n="employee.stat_pool_free">Свободно заявок в пуле</span>
      <span class="profile-row-value">${poolFree}</span>
    </div>
    <div class="profile-row">
      <span class="profile-row-label" data-i18n="employee.stat_closed_by_me">Закрыто заявок мною</span>
      <span class="profile-row-value">${closedByMe}</span>
    </div>
    <div class="profile-row">
      <span class="profile-row-label" data-i18n="employee.stat_opened_by_me">Открыто заявок мною</span>
      <span class="profile-row-value">${openedByMe}</span>
    </div>
    <div class="profile-row">
      <span class="profile-row-label" data-i18n="employee.stat_rating_internal">Средняя оценка моей работы внутри организации</span>
      <span class="profile-row-value">
        ${hasRating
          ? `${ratingAvg}<i class="ph-duotone ph-star stat-rating-star" aria-hidden="true" style="margin-left:.35rem;"></i>`
          : `<span class="stats-empty" data-i18n="employee.stat_rating_empty">Нет оценок</span>`}
      </span>
    </div>
    <div class="profile-row" style="border-bottom:none;">
      <span class="profile-row-label" data-i18n="employee.stat_rating_partner">Средняя оценка моей работы партнёрами</span>
      <span class="profile-row-value">
        ${hasPartnerRating
          ? `${partnerAvg}<i class="ph-duotone ph-star stat-rating-star" aria-hidden="true" style="margin-left:.35rem;"></i>`
          : `<span class="stats-empty" data-i18n="employee.stat_rating_empty">Нет оценок</span>`}
      </span>
    </div>
  `;
}

/* ── Period picker (без иконки — B8) ─────────────────────────── */

function renderPeriodPicker(periods, activeId) {
  const active = periods.find(p => p.id === activeId) || periods[0];
  // data-i18n на active-label и каждом menu-item — applyTranslations()
  // подхватит переводы при смене языка автоматически (раньше picker
  // оставался на старом языке).
  return `
    <div class="period-picker" data-period-picker>
      <button type="button" class="picker-btn">
        <span data-active-label data-i18n="${active.labelKey}">${escapeHTML(t(active.labelKey))}</span>
        <i class="ph ph-caret-down picker-caret"></i>
      </button>
      <div class="picker-menu" hidden>
        ${periods.map(p => `
          <button type="button" class="picker-menu-item ${p.id === activeId ? 'is-active' : ''}"
                  data-pick="${p.id}" data-i18n="${p.labelKey}">
            ${escapeHTML(t(p.labelKey))}
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
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-pick]');
    if (!item) return;
    const id = item.getAttribute('data-pick');
    if (label) {
      const def = list.find(x => x.id === id);
      if (def) {
        // Apdate AND data-i18n attr AND textContent — иначе при смене
        // языка DOM-walker вернёт старый перевод.
        label.setAttribute('data-i18n', def.labelKey);
        label.textContent = t(def.labelKey);
      }
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

/* ── Leave-org modal ─────────────────────────────────────────── */

let _leaveModalWired = false;
function wireLeaveOrgModal() {
  if (_leaveModalWired) return;
  _leaveModalWired = true;

  document.querySelector('#btn-leave-org-confirm')?.addEventListener('click', async () => {
    const btn = document.querySelector('#btn-leave-org-confirm');
    const reasonEl = document.querySelector('#leave-org-reason');
    const reason = (reasonEl?.value || '').trim().slice(0, 500);
    setLoading(btn, true);
    try {
      await membership.leave(reason);
      closeModal('leave-org-modal');
      toast(t('membership.leave_done'), 'ok');
      window.dispatchEvent(new CustomEvent('rems:reload-profile'));
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setLoading(btn, false);
    }
  });
}

function escapeHTML(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
