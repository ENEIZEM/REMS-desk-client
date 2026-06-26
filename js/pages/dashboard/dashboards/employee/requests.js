/* ═══════════════════════════════════════════════════════════════
   Employee Requests tab — единственный рабочий стол заявок сотрудника.

   Структура (редизайн 2026-06): только шапка + лента. Плитки-KPI
   (фильтры) и сегментация — внутри ленты (общий модуль). Дублирующие
   блоки SLA/лимитов УБРАНЫ отсюда — они доступны во вкладке «Организация»
   (read-only), а Обзор сотрудника больше не дублирует ленту заявок.
   ═══════════════════════════════════════════════════════════════ */

import { t, applyTranslations, onLangChange } from '../../../../i18n.js';
import { setNotificationsTarget, loadNotifications } from '../../notifications.js';
import {
  mountRequests, renderAll as renderRequests,
  registerListFilter, periodStart,
} from '../_shared/requests.js';

// Единственный рабочий стол заявок сотрудника. Рендерится в слот вкладки
// «Обзор» (#employee-overview-slot) — отдельная вкладка «Заявки» убрана,
// чтобы не дублировать ленту (орг-шапка/SLA/лимиты живут в «Организации»).
export function mountEmployeeRequests(profile) {
  const slot = document.querySelector('#employee-overview-slot');
  if (!slot) return;

  const PERIODS = [
    { id: 'week',  labelKey: 'period.week'  },
    { id: 'month', labelKey: 'period.month' },
    { id: 'year',  labelKey: 'period.year'  },
    { id: 'all',   labelKey: 'period.all'   },
  ];
  const scopeKey  = 'rems_emp_req_scope';
  const periodKey = 'rems_emp_req_period';
  let activeScope  = localStorage.getItem(scopeKey)  || 'all';
  let activePeriod = localStorage.getItem(periodKey) || 'month';

  // Пре-фильтр ленты — ТОЛЬКО период. Охват («тип заявки») переехал в
  // под-фильтры: renderAll читает feed.dataset.rqScope и сам рисует
  // сегмент в [data-rq-scope]. Ось «чьё/какая стадия» (мои/свободные/
  // закрытые) раскладывают секции (segmentedHTML): Требуют действия /
  // Свободный пул / В работе / Архив.
  registerListFilter('emp-requests-tab', (r) => {
    // Период применяем ТОЛЬКО к архиву (терминальным) — активные заявки не
    // должны прятаться под «месяц» (старая, но ещё открытая заявка важна).
    const terminal = r.status === 'closed' || r.status === 'cancelled';
    if (terminal) {
      const from = periodStart(activePeriod);
      if (from && new Date(r.closed_at || r.created_at) < from) return false;
    }
    return true;
  });

  slot.innerHTML = `
    <!-- Шапка вкладки «Обзор» (заголовок + «Создать заявку») — общая,
         в #tab-overview; здесь не дублируем. Плитки = статистика+фильтр. -->
    <div class="rq-tiles-row" data-rq-tiles="emp-requests-tab"></div>

    <!-- Под-фильтры над лентой: тип заявки (сегмент с цифрами) │ период
         (выпадающий список). Разделены вертикальной линией. -->
    <div class="rq-subfilters">
      <div class="rq-subfilter-group" data-rq-scope="emp-requests-tab"></div>
      <div class="rq-subfilter-group rq-subfilter-period">
        ${renderTogglePicker(PERIODS, activePeriod, 'data-req-period-picker')}
      </div>
      <!-- Подсказка по заявкам — в контейнере фильтров, по центру по высоте,
           прижата вправо (.rq-filters-hint { margin-left:auto }). -->
      <span class="profile-card-tooltip rq-filters-hint" tabindex="0" data-tooltip-key="employee.requests_header_hint">
        <i class="ph ph-info"></i>
      </span>
    </div>

    <!-- Рабочая зона: лента заявок | уведомления (2-колонка, лента шире) —
         единый паттерн с дашбордом руководителя. Отступ сверху как у
         руководителя — иначе под-фильтры «прилипают» к лентам. -->
    <div class="profile-two-col employee-two-col rq-work-cols" style="margin-top:.75rem;">
      <div class="profile-col employee-col-left">
        <div class="card profile-card rq-work-feed">
          <div class="profile-card-header">
            <div class="profile-card-icon navy"><i class="ph-bold ph-clipboard-text"></i></div>
            <h3 class="profile-card-title" data-i18n="employee.requests_header_full">Заявки</h3>
            <!-- Подсказка переехала в контейнер фильтров (.rq-subfilters). -->
          </div>
          <div class="profile-card-body requests-feed-body" id="employee-requests-body"
               data-requests-list data-rq-segmented data-rq-filter="emp-requests-tab"
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

  // Pickers — фильтр зарегистрирован выше, достаточно перерисовать.
  // Охват («тип заявки») обрабатывает renderAll (клик по [data-rq-scope-pick]);
  // тут вешаем только период.
  const reRender = () => renderRequests();
  wirePopoverPicker(slot, '[data-req-period-picker]', (id) => {
    activePeriod = id;
    localStorage.setItem(periodKey, id);
    reRender();
  }, PERIODS);

  // Перевод свежевставленного HTML.
  applyTranslations();

  // Уведомления — в правой колонке рабочей зоны (как у руководителя).
  setNotificationsTarget('#employee-notifs-slot');
  loadNotifications().catch(err => console.warn('[employee requests notifications]', err));

  // Заявки: лента + дорожная карта (общий модуль).
  mountRequests(profile).catch(err => console.warn('[employee requests]', err));

  // Re-render на смену языка: перечитать picker active-label + перерисовать.
  if (!slot.__remsLangBound) {
    slot.__remsLangBound = true;
    onLangChange(() => {
      const setActive = (sel, list, id) => {
        const lbl = slot.querySelector(`${sel} [data-active-label]`);
        const def = list.find(x => x.id === id);
        if (lbl && def) lbl.textContent = t(def.labelKey);
      };
      setActive('[data-req-period-picker]', PERIODS, activePeriod);
      reRender();
      applyTranslations();
    });
  }
}

/* ── Helpers ─────────────────────────────────────────────────── */

/**
 * Popover picker без иконок (B8). Pill-кнопка с label + caret;
 * dropdown-меню по клику. Закрывается при клике снаружи.
 */
function renderTogglePicker(list, activeId, marker) {
  const active = list.find(x => x.id === activeId) || list[0];
  // data-i18n на active-label и menu-item — applyTranslations() сам
  // переведёт при смене языка. Без этого picker оставался на старом
  // языке после переключения RU↔EN.
  return `
    <div class="period-picker" ${marker}>
      <button type="button" class="picker-btn">
        <span data-active-label data-i18n="${active.labelKey}">${escapeHTML(t(active.labelKey))}</span>
        <i class="ph ph-caret-down picker-caret"></i>
      </button>
      <div class="picker-menu" hidden>
        ${list.map(x => `
          <button type="button" class="picker-menu-item ${x.id === activeId ? 'is-active' : ''}"
                  data-pick="${x.id}" data-i18n="${x.labelKey}">
            ${escapeHTML(t(x.labelKey))}
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

function escapeHTML(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
