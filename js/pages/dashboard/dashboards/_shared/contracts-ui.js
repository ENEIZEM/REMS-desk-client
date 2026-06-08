/* ═══════════════════════════════════════════════════════════════
   Shared contracts UI — рендер карточек контрактов (owner + employee).
   owner/contracts.js навешивает управление (кнопки), employee — read-only.
   ═══════════════════════════════════════════════════════════════ */
import { t } from '../../../../i18n.js';
import { media } from '../../../../api.js';
import { toast, errorMessage } from '../../../../auth.js';
import { openMediaViewer } from '../../../../lib/media-viewer.js';

// Глобальный делегированный клик по «Открыть документ» — общий для
// owner/employee. Открываем в общем просмотрщике вложений (с кнопкой
// «Скачать»), а не в новой вкладке. Once-wired на window.
if (typeof window !== 'undefined' && !window.__remsContractDocOpenWired) {
  window.__remsContractDocOpenWired = true;
  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-ct-doc-id]');
    if (!btn) return;
    e.preventDefault();
    const id = Number(btn.dataset.ctDocId);
    if (id) openMediaViewer(id, { name: `contract-doc-${id}` });
  });
}

export function escapeHTML(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(); } catch { return String(iso); }
}

// Палитра для интерполяции цвета прогресс-бара (как в sessions.js):
// 1 = акцентный зелёный (полный срок), 0 = красный (срок почти кончился).
let _palette = null;
function getPalette() {
  if (_palette) return _palette;
  const parse = (s) => {
    s = (s || '').trim();
    if (s.startsWith('#')) {
      let h = s.slice(1);
      if (h.length === 3) h = h.split('').map(c => c + c).join('');
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    const m = s.match(/\d+/g);
    return m ? [Number(m[0]), Number(m[1]), Number(m[2])] : [0, 0, 0];
  };
  const cs = (typeof document !== 'undefined') ? getComputedStyle(document.documentElement) : null;
  _palette = {
    accent: parse(cs?.getPropertyValue('--clr-accent') || '#10b981'),
    error:  parse(cs?.getPropertyValue('--clr-error')  || '#ef4444'),
  };
  return _palette;
}
function progressColor(ratio) {
  const r = Math.max(0, Math.min(1, ratio));
  const { accent, error } = getPalette();
  const mix = (a, b) => Math.round(b * r + a * (1 - r));
  return `rgb(${mix(error[0], accent[0])}, ${mix(error[1], accent[1])}, ${mix(error[2], accent[2])})`;
}

/** HTML прогресс-бара срока контракта. Показываем только если есть
 *  end_date и контракт ещё в игре (не terminated). */
function contractProgressHTML(c) {
  if (!c.end_date || c.status === 'terminated') return '';
  const start = c.start_date ? new Date(c.start_date).getTime() : Date.now();
  const end   = new Date(c.end_date).getTime();
  if (!Number.isFinite(end)) return '';
  const now   = Date.now();
  const totalSpan = Math.max(1, end - start);
  const leftMs    = Math.max(0, end - now);
  const ratio     = Math.max(0, Math.min(1, leftMs / totalSpan));
  const pct       = Math.max(2, Math.round(ratio * 100));
  const color     = progressColor(ratio);
  const daysLeft  = Math.max(0, Math.floor(leftMs / 86400000));
  const leftLabel = leftMs <= 0
    ? t('contracts.progress_expired')
    : daysLeft >= 1
      ? `${daysLeft} ${t('contracts.days_short')}`
      : `< 1 ${t('contracts.days_short')}`;
  return `
    <div class="contract-progress-wrap">
      <div class="contract-progress-track">
        <div class="contract-progress-fill" style="width:${pct}%; background:${color};"></div>
      </div>
      <div class="contract-progress-meta">
        <span>${escapeHTML(t('contracts.progress_left'))}: ${escapeHTML(leftLabel)}</span>
        <span>${escapeHTML(fmtDate(c.end_date))}</span>
      </div>
    </div>`;
}

function roleLabel(role) {
  return role === 'client' ? t('contracts.role_client') : t('contracts.role_contractor');
}

/** Бейдж статуса контракта — ОДИН источник правды. Сайз/иконка как у
 *  бейджей «активность» и «ваша роль» в шапке организации (.badge.badge-icon). */
function statusBadge(c) {
  if (c.status === 'active')
    return `<span class="badge badge-icon badge-success"><i class="ph ph-check-circle"></i><span>${escapeHTML(t('contracts.status_active'))}</span></span>`;
  if (c.status === 'terminated')
    return `<span class="badge badge-icon badge-default"><i class="ph ph-x-circle"></i><span>${escapeHTML(t('contracts.status_terminated'))}</span></span>`;
  if (c.status === 'paused') {
    return c.terminate_awaiting_me
      ? `<span class="badge badge-icon badge-error"><i class="ph ph-link-break"></i><span>${escapeHTML(t('contracts.status_terminate_request'))}</span></span>`
      : `<span class="badge badge-icon badge-warning"><i class="ph ph-hourglass"></i><span>${escapeHTML(t('contracts.status_terminate_pending'))}</span></span>`;
  }
  return c.awaiting_me
    ? `<span class="badge badge-icon badge-warning"><i class="ph ph-bell-ringing"></i><span>${escapeHTML(t('contracts.status_awaiting_you'))}</span></span>`
    : `<span class="badge badge-icon badge-info"><i class="ph ph-hourglass"></i><span>${escapeHTML(t('contracts.status_awaiting_partner'))}</span></span>`;
}

/** SLA как 4 цветных плашки (как в SLA-блоке организации). */
function slaPillsHTML(sla) {
  if (!sla) return '';
  const items = [
    ['critical', sla.critical_h, t('profile.sla_critical')],
    ['high',     sla.high_h,     t('profile.sla_high')],
    ['medium',   sla.medium_h,   t('profile.sla_medium')],
    ['low',      sla.low_h,      t('profile.sla_low')],
  ];
  if (items.every(([, v]) => v == null)) return '';
  return `<div class="sla-pill-row">${items.map(([key, val, label]) => `
    <div class="sla-pill sla-${key}">
      <span class="sla-pill-label">${escapeHTML(label)}</span>
      <span class="sla-pill-val">${val == null ? '—' : `${val} ${escapeHTML(t('profile.hours_short'))}`}</span>
    </div>`).join('')}</div>`;
}

/** Иконки-действия — слева от статус-бейджа, с подсказкой на hover. */
function headerActionIcons(c, canManage) {
  if (!canManage || c.status === 'terminated') return '';
  const btn = (action, icon, tipKey, danger = false) =>
    `<button class="contract-icon-btn${danger ? ' contract-icon-btn--danger' : ''}" data-ct-action="${action}" data-ct-id="${c.id}" data-ct-tip="${escapeHTML(t(tipKey))}" aria-label="${escapeHTML(t(tipKey))}"><i class="ph ${icon}"></i></button>`;

  let icons = '';
  if (c.status === 'active') {
    icons += btn('edit',      'ph-pencil-simple', 'contracts.btn_edit');
    icons += btn('terminate', 'ph-link-break',    'contracts.btn_terminate', true);
  } else if (c.status === 'pending_client' || c.status === 'pending_contractor') {
    if (c.awaiting_me) {
      icons += btn('accept', 'ph-check', 'contracts.btn_accept');
      icons += btn('reject', 'ph-x',     'contracts.btn_reject', true);
    } else {
      icons += btn('edit',   'ph-pencil-simple', 'contracts.btn_edit');
      icons += btn('cancel', 'ph-x-circle',      'contracts.btn_cancel', true);
    }
  } else if (c.status === 'paused') {
    if (c.terminate_awaiting_me) {
      icons += btn('terminate-confirm', 'ph-check', 'contracts.btn_terminate_confirm', true);
      icons += btn('terminate-decline', 'ph-x',     'contracts.btn_terminate_decline');
    } else if (c.terminate_requested_by_me) {
      icons += btn('terminate-cancel', 'ph-arrow-u-up-left', 'contracts.btn_terminate_cancel');
      icons += btn('edit-instead',     'ph-pencil-simple',   'contracts.btn_edit_instead');
    }
  }
  return icons ? `<div class="contract-icon-actions">${icons}</div>` : '';
}

/** Единственная кнопка «Открыть контракт» — на всю ширину под SLA.
 *  Высота как у solo-кнопки «Запросить членство» (.btn без btn-sm). */
function openContractButton(c) {
  return `<div class="contract-actions-row contract-actions-row--single">
    <button class="btn btn-secondary contract-action-btn" data-ct-action="view" data-ct-id="${c.id}"><i class="ph ph-file-text"></i> <span>${escapeHTML(t('contracts.btn_open'))}</span></button>
  </div>`;
}

/** Бейдж моей роли — .badge.badge-icon как «роль» в шапке организации. */
function myRoleChip(c) {
  const role = c.my_role;
  const cls = role === 'client' ? 'badge-role-client' : 'badge-role-contractor';
  const icon = role === 'client' ? 'ph-buildings' : 'ph-wrench';
  return `<span class="badge badge-icon ${cls}"><i class="ph ${icon}"></i><span>${escapeHTML(roleLabel(role))}</span></span>`;
}

/** Роль партнёра — обычным текстом, серым. */
function partnerRoleLabel(c) {
  const r = c.my_role === 'client' ? 'contractor' : 'client';
  return roleLabel(r);
}

/** Компактная карточка действующего/ожидающего контракта.
 *  Никакого вертикального многострочного «label / value»: meta-строка
 *  всё инлайн (партнёр · роль · до даты), SLA — компактная плитка,
 *  описание — две строки с line-clamp. Прогресс-бар сразу под мета. */
function currentCardHTML(c, canManage) {
  const pausedReason = (c.status === 'paused' && c.termination_reason)
    ? `<div class="contract-reason"><span class="contract-reason-label">${escapeHTML(t('contracts.termination_reason'))}:</span> ${escapeHTML(c.termination_reason)}</div>` : '';
  // Мета: МОЯ роль — цветная плашка, партнёр — имя + (ID) + его роль ОБЫЧНЫМ текстом.
  const meta = [
    myRoleChip(c),
    `<span class="contract-meta-strong">${escapeHTML(c.partner?.name || '—')}</span><span class="contract-muted"> · ID ${c.partner?.id}</span><span class="contract-muted"> · ${escapeHTML(partnerRoleLabel(c))}</span>`,
  ].join('<span class="contract-dot">·</span>');

  // Awaiting-карточки — мягкая жёлтая подсветка + рамка слева.
  const isAwaitingUI = c.status === 'pending_client'
                    || c.status === 'pending_contractor'
                    || c.status === 'paused';
  const cardCls = `contract-card${isAwaitingUI ? ' contract-card--awaiting' : ''}`;
  const sla = slaPillsHTML(c.sla);

  return `
    <div class="${cardCls}" data-ct-card="${c.id}">
      <div class="contract-card-head">
        <span class="contract-card-name">${escapeHTML(c.name)}</span>
        <div class="contract-card-head-right">
          ${statusBadge(c)}
          ${headerActionIcons(c, canManage)}
        </div>
      </div>
      <div class="contract-meta">${meta}</div>
      ${contractProgressHTML(c)}
      ${sla}
      ${pausedReason}
      ${openContractButton(c)}
    </div>`;
}

/** Компактная карточка завершённого контракта (история). */
function terminatedCardHTML(c, canManage = true) {
  const by = c.terminated_by_me ? t('contracts.terminated_by_you') : t('contracts.terminated_by_partner');
  const metaParts = [
    myRoleChip(c),
    `<span class="contract-meta-strong">${escapeHTML(c.partner?.name || '—')}</span><span class="contract-muted"> · ID ${c.partner?.id}</span><span class="contract-muted"> · ${escapeHTML(partnerRoleLabel(c))}</span>`,
    c.terminated_at ? `<span class="contract-muted">${escapeHTML(t('contracts.terminated_at'))}: ${escapeHTML(fmtDate(c.terminated_at))}</span>` : '',
    `<span class="contract-muted">${escapeHTML(t('contracts.terminated_by'))}: ${escapeHTML(by)}</span>`,
  ].filter(Boolean);
  return `
    <div class="contract-card contract-card--terminated">
      <div class="contract-card-head">
        <span class="contract-card-name">${escapeHTML(c.name)}</span>
        ${statusBadge(c)}
      </div>
      <div class="contract-meta">${metaParts.join('<span class="contract-dot">·</span>')}</div>
      ${c.termination_reason ? `<div class="contract-reason"><span class="contract-reason-label">${escapeHTML(t('contracts.termination_reason'))}:</span> ${escapeHTML(c.termination_reason)}</div>` : ''}
      ${openContractButton(c)}
    </div>`;
}

/**
 * Полный HTML двух блоков (текущие + завершённые) для слота контрактов.
 * @param {{current:Array, terminated:Array}} data
 * @param {boolean} canManage  owner → true (кнопки), employee → false
 */
export function contractsBlocksHTML(data, canManage) {
  const current = data?.current || [];
  const terminated = data?.terminated || [];

  const currentBody = current.length
    ? current.map(c => currentCardHTML(c, canManage)).join('')
    : `<div class="empty-state empty-state--inline"><i class="ph ph-handshake"></i><span class="empty-state-text">${escapeHTML(t('contracts.empty_current'))}</span></div>`;

  const terminatedBody = terminated.length
    ? terminated.map(c => terminatedCardHTML(c, canManage)).join('')
    : `<div class="empty-state empty-state--inline"><i class="ph ph-archive"></i><span class="empty-state-text">${escapeHTML(t('contracts.empty_terminated'))}</span></div>`;

  return `
    <div class="card profile-card">
      <div class="profile-card-header profile-card-header--with-actions">
        <div class="profile-card-icon navy"><i class="ph-bold ph-handshake"></i></div>
        <h3 class="profile-card-title">${escapeHTML(t('contracts.current_block'))}</h3>
        <span class="profile-card-tooltip profile-card-tooltip--end" tabindex="0" data-tooltip-key="contracts.current_hint">
          <i class="ph ph-info"></i>
        </span>
      </div>
      <div class="profile-card-body contract-list">${currentBody}</div>
    </div>

    <div class="card profile-card" style="margin-top:1rem;">
      <div class="profile-card-header profile-card-header--with-actions">
        <div class="profile-card-icon slate"><i class="ph-bold ph-archive"></i></div>
        <h3 class="profile-card-title">${escapeHTML(t('contracts.terminated_block'))}</h3>
        <span class="profile-card-tooltip profile-card-tooltip--end" tabindex="0" data-tooltip-key="contracts.terminated_hint">
          <i class="ph ph-info"></i>
        </span>
      </div>
      <div class="profile-card-body contract-list">${terminatedBody}</div>
    </div>`;
}
