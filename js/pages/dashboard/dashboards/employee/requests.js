/* ═══════════════════════════════════════════════════════════════
   Employee Requests tab.

   Структура (по обновлённому дизайну):
     1. Шапка заявок — два picker'а (scope / type) + period picker.
        Min-height фикс; max-height с внутренним скроллом. Empty-state
        когда фильтр не даёт совпадений.
     2. Двухколонный блок: слева Внутренние SLA, справа Лимиты.

   Шапка организации НЕ рендерится здесь — она только на Обзоре
   (по требованию редизайна).
   ═══════════════════════════════════════════════════════════════ */

import { t, applyTranslations, onLangChange } from '../../../../i18n.js';
import { fmtBytes } from '../../format.js';
import { renderRowChip } from '../../badges.js';
import { mountRequests, renderAll as renderRequests } from '../_shared/requests.js';

// Тип-фильтр вкладки → фильтр общего модуля заявок.
function mapType(type) {
  if (type === 'free') return 'free';
  if (type === 'created' || type === 'closed') return 'mine';
  return 'all';
}

export function mountEmployeeRequests(profile) {
  const slot = document.querySelector('#employee-requests-slot');
  if (!slot) return;

  const org = profile?.organization || {};

  const SCOPE_FILTERS = [
    { id: 'all',      labelKey: 'employee.req_scope_all'      },
    { id: 'internal', labelKey: 'employee.req_scope_internal' },
    { id: 'partner',  labelKey: 'employee.req_scope_partner'  },
  ];
  const TYPE_FILTERS = [
    { id: 'all_mine', labelKey: 'employee.req_type_all_mine'  },
    { id: 'created',  labelKey: 'employee.req_type_created'   },
    { id: 'closed',   labelKey: 'employee.req_type_closed'    },
    { id: 'free',     labelKey: 'employee.req_type_free'      },
  ];
  const PERIODS = [
    { id: 'week',  labelKey: 'period.week'  },
    { id: 'month', labelKey: 'period.month' },
    { id: 'year',  labelKey: 'period.year'  },
    { id: 'all',   labelKey: 'period.all'   },
  ];
  const scopeKey  = 'rems_emp_req_scope';
  const typeKey   = 'rems_emp_req_type';
  const periodKey = 'rems_emp_req_period';
  let activeScope  = localStorage.getItem(scopeKey)  || 'all';
  let activeType   = localStorage.getItem(typeKey)   || 'created';
  let activePeriod = localStorage.getItem(periodKey) || 'month';

  slot.innerHTML = `
    <div class="page-header page-header--with-action">
      <div>
        <h1 class="page-title" data-i18n="employee.requests_title">Заявки</h1>
        <p class="page-desc" data-i18n="employee.requests_desc">Внутренние и партнёрские заявки. Фильтры применяются к видимому списку.</p>
      </div>
      <button class="btn btn-primary" data-rq-create>
        <i class="ph ph-plus"></i> <span data-i18n="requests.create_btn">Создать заявку</span>
      </button>
    </div>

    <!-- Шапка заявок: profile-card паттерн (как SLA/Лимиты) -->
    <div class="card profile-card">
      <div class="profile-card-header profile-card-header--with-actions">
        <div class="profile-card-icon navy"><i class="ph-bold ph-clipboard-text"></i></div>
        <h3 class="profile-card-title" data-i18n="employee.requests_header_full">Заявки</h3>
        <div class="notif-header-actions">
          ${renderTogglePicker(SCOPE_FILTERS,  activeScope,  'data-req-scope-picker')}
          ${renderTogglePicker(TYPE_FILTERS,   activeType,   'data-req-type-picker')}
          ${renderTogglePicker(PERIODS,        activePeriod, 'data-req-period-picker')}
          <!-- Tooltip всегда последним по правилу B10 -->
          <span class="profile-card-tooltip profile-card-tooltip--end" tabindex="0" data-tooltip-key="employee.requests_header_hint">
            <i class="ph ph-info"></i>
          </span>
        </div>
      </div>
      <div class="profile-card-body requests-feed-body" id="employee-requests-body"
           data-requests-list data-rq-filter="${mapType(activeType)}"></div>
    </div>

    <div class="profile-two-col employee-two-col" style="margin-top:1rem;">
      <!-- LEFT: Внутренние SLA -->
      <div class="profile-col employee-col-left">
        <div class="card profile-card">
          <div class="profile-card-header">
            <div class="profile-card-icon navy"><i class="ph-bold ph-clock-countdown"></i></div>
            <h3 class="profile-card-title" data-i18n="profile.internal_sla">Внутренние SLA</h3>
            <!-- Подсказка в правом углу (последняя) — B10 -->
            <span class="profile-card-tooltip profile-card-tooltip--end" tabindex="0" data-tooltip-key="profile.internal_sla_hint">
              <i class="ph ph-info"></i>
            </span>
          </div>
          <div class="profile-card-body">
            ${renderSlaRows(org)}
          </div>
        </div>
      </div>

      <!-- RIGHT: Лимиты организации -->
      <div class="profile-col employee-col-right">
        <div class="card profile-card">
          <div class="profile-card-header">
            <div class="profile-card-icon teal"><i class="ph-bold ph-gauge"></i></div>
            <h3 class="profile-card-title" data-i18n="profile.limits">Лимиты организации</h3>
            <span class="profile-card-tooltip profile-card-tooltip--end" tabindex="0" data-tooltip-key="profile.tip_limits">
              <i class="ph ph-info"></i>
            </span>
          </div>
          <div class="profile-card-body">
            ${renderLimitsRows(org)}
          </div>
        </div>
      </div>
    </div>
  `;

  // Feature pills для лимитов.
  if (org.limits) {
    const L = org.limits;
    setFeaturePill(slot.querySelector('#emp-lim-images-flag'), L.allow_image_uploads);
    setFeaturePill(slot.querySelector('#emp-lim-videos-flag'), L.allow_video_uploads);
    setFeaturePill(slot.querySelector('#emp-lim-docs-flag'),   L.allow_document_uploads);
  }

  // Pickers.
  const reRender = () => {
    const body = slot.querySelector('#employee-requests-body');
    if (body) { body.dataset.rqFilter = mapType(activeType); renderRequests(); }
  };
  wirePopoverPicker(slot, '[data-req-scope-picker]', (id) => {
    activeScope = id;
    localStorage.setItem(scopeKey, id);
    reRender();
  }, SCOPE_FILTERS);
  wirePopoverPicker(slot, '[data-req-type-picker]', (id) => {
    activeType = id;
    localStorage.setItem(typeKey, id);
    reRender();
  }, TYPE_FILTERS);
  wirePopoverPicker(slot, '[data-req-period-picker]', (id) => {
    activePeriod = id;
    localStorage.setItem(periodKey, id);
    reRender();
  }, PERIODS);

  // Перевод свежевставленного HTML.
  applyTranslations();

  // Заявки: лента + дорожная карта (общий модуль).
  mountRequests(profile).catch(err => console.warn('[employee requests]', err));

  // Re-render на смену языка: перерисуем динамические куски (лимиты
  // с template-литералами, picker active-label, body).
  if (!slot.__remsLangBound) {
    slot.__remsLangBound = true;
    onLangChange(() => {
      const sla = slot.querySelector('.profile-col.employee-col-left .profile-card-body');
      if (sla) sla.innerHTML = renderSlaRows(org);
      const lims = slot.querySelector('.profile-col.employee-col-right .profile-card-body');
      if (lims) {
        lims.innerHTML = renderLimitsRows(org);
        if (org.limits) {
          const L = org.limits;
          setFeaturePill(slot.querySelector('#emp-lim-images-flag'), L.allow_image_uploads);
          setFeaturePill(slot.querySelector('#emp-lim-videos-flag'), L.allow_video_uploads);
          setFeaturePill(slot.querySelector('#emp-lim-docs-flag'),   L.allow_document_uploads);
        }
      }
      // Picker active-labels перечитаем.
      const setActive = (sel, list, id) => {
        const lbl = slot.querySelector(`${sel} [data-active-label]`);
        const def = list.find(x => x.id === id);
        if (lbl && def) lbl.textContent = t(def.labelKey);
      };
      setActive('[data-req-scope-picker]',  SCOPE_FILTERS, activeScope);
      setActive('[data-req-type-picker]',   TYPE_FILTERS,  activeType);
      setActive('[data-req-period-picker]', PERIODS,       activePeriod);
      reRender();
      applyTranslations();
    });
  }
}

/* ── Helpers ─────────────────────────────────────────────────── */

function renderRequestsEmpty(type, scope, period) {
  // Реальных заявок ещё нет — всегда empty. Текст уточняет про
  // выбранные фильтры. Layout: иконка + текст на одной строке с
  // мягким padding'ом, не центрируется по карточке (по требованию).
  return `
    <div class="empty-state empty-state--inline">
      <i class="ph ph-clipboard"></i>
      <span class="empty-state-text" data-i18n="employee.requests_empty_for_filter">
        По выбранным фильтрам заявок нет.
      </span>
    </div>
  `;
}

function renderSlaRows(org) {
  const L = org?.limits || {};
  const h = t('profile.hours_short');
  const cells = [
    { key: 'profile.sla_critical', cls: 'sla-critical', val: L.internal_sla_critical_h },
    { key: 'profile.sla_high',     cls: 'sla-high',     val: L.internal_sla_high_h     },
    { key: 'profile.sla_medium',   cls: 'sla-medium',   val: L.internal_sla_medium_h   },
    { key: 'profile.sla_low',      cls: 'sla-low',      val: L.internal_sla_low_h      },
  ];
  return cells.map((c, i) => `
    <div class="profile-row sla-row-wide"
         ${i === cells.length - 1 ? 'style="border-bottom:none;"' : ''}>
      <span class="profile-row-label">
        <span class="sla-pri ${c.cls}" data-i18n="${c.key}">—</span>
      </span>
      <span class="profile-row-value">${c.val != null ? `${c.val} ${h}` : '—'}</span>
    </div>
  `).join('');
}

function renderLimitsRows(org) {
  const L = org?.limits || {};
  const planLabel = org?.subscription_purchased ? 'Pro' : 'Free';
  const empCount = org?.current_employee_count ?? 0;
  const empMax   = L.max_employees ?? '—';
  const reqMax   = L.max_active_requests ?? '—';
  // Активных заявок пока 0 (нет requests-API). Подставится позже.
  const reqCur   = 0;
  const perReq  = t('profile.per_request');
  const upTo    = t('profile.up_to');
  const pcsUnit = t('profile.pcs_unit');

  // B11: тариф справа (как value); строка "Сотрудников · Заявок"
  // объединена в один sub-line под заголовком «Тариф».
  return `
    <div class="profile-row">
      <span class="profile-row-label-stack">
        <span class="profile-row-label" data-i18n="profile.plan">Тариф</span>
        <span class="profile-row-sub">
          ${empCount} / ${empMax} <span data-i18n="profile.max_employees_short">сотрудников</span>
          ·
          ${reqCur} / ${reqMax} <span data-i18n="profile.max_active_requests_short">активных заявок</span>
        </span>
      </span>
      <span class="profile-row-value plan-pill">${planLabel}</span>
    </div>
    <div class="profile-row">
      <span class="profile-row-label-stack">
        <span class="profile-row-label" data-i18n="profile.images">Изображения</span>
        <span class="profile-row-sub">
          ${L.max_photo_per_request != null
            ? `${upTo} ${L.max_photo_per_request} ${pcsUnit}${perReq} · ${fmtBytes(L.max_image_upload_size_bytes)}`
            : '—'}
        </span>
      </span>
      <span id="emp-lim-images-flag" class="badge feature-pill">—</span>
    </div>
    <div class="profile-row">
      <span class="profile-row-label-stack">
        <span class="profile-row-label" data-i18n="profile.documents">Документы</span>
        <span class="profile-row-sub">
          ${L.max_document_per_request != null
            ? `${upTo} ${L.max_document_per_request} ${pcsUnit}${perReq} · ${fmtBytes(L.max_document_upload_size_bytes)}`
            : '—'}
        </span>
      </span>
      <span id="emp-lim-docs-flag" class="badge feature-pill">—</span>
    </div>
    <div class="profile-row" style="border-bottom:none;">
      <span class="profile-row-label-stack">
        <span class="profile-row-label" data-i18n="profile.videos">Видео</span>
        <span class="profile-row-sub">
          ${L.max_videos_per_request != null
            ? `${upTo} ${L.max_videos_per_request} ${pcsUnit}${perReq} · ${fmtBytes(L.max_video_upload_size_bytes)} · ${L.max_video_duration_seconds}${t('profile.seconds_short')}`
            : '—'}
        </span>
      </span>
      <span id="emp-lim-videos-flag" class="badge feature-pill">—</span>
    </div>
  `;
}

function setFeaturePill(el, allowed) {
  if (!el) return;
  const desc = allowed
    ? { key: 'profile.feature_allowed', chip: 'chip-allowed', icon: 'ph-check-circle' }
    : { key: 'profile.feature_denied',  chip: 'chip-denied',  icon: 'ph-prohibit'    };
  renderRowChip(el, desc);
}

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
