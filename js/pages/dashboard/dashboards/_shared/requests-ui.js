/* ═══════════════════════════════════════════════════════════════
   Shared requests UI — карточки заявок + дорожная карта (rail + история).
   Цвета статусов синхронизированы с лендингом (см. .req-badge-* в CSS).
   ═══════════════════════════════════════════════════════════════ */
import { t, getLang } from '../../../../i18n.js';

export function escapeHTML(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtDateTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(getLang() === 'en' ? 'en-US' : 'ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return String(iso); }
}
function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ru-RU'); } catch { return String(iso); }
}

// Основная цепочка статусов (для rail). cancelled — терминальный, вне цепи.
export const STATUS_ORDER = ['new', 'assigned', 'in_progress', 'done', 'closed'];

const STATUS_ICON = {
  new: 'ph-sparkle', assigned: 'ph-user-focus', in_progress: 'ph-wrench',
  done: 'ph-check-circle', closed: 'ph-lock-simple', cancelled: 'ph-x-circle',
};

export function statusLabel(s) { return t('requests.status.' + s); }

export function statusBadge(s) {
  return `<span class="badge badge-icon req-badge-${s}"><i class="ph ${STATUS_ICON[s] || 'ph-question'}"></i><span>${escapeHTML(statusLabel(s))}</span></span>`;
}

const PRIORITY_ICON = { low: 'ph-arrow-down', medium: 'ph-equals', high: 'ph-arrow-up', critical: 'ph-warning' };
export function priorityBadge(p) {
  return `<span class="badge badge-icon req-prio-${p}"><i class="ph ${PRIORITY_ICON[p] || 'ph-equals'}"></i><span>${escapeHTML(t('requests.priority.' + p))}</span></span>`;
}

function partiesLine(r) {
  if (r.is_internal) return `<span class="contract-muted"><i class="ph ph-buildings"></i> ${escapeHTML(t('requests.internal_tag'))}</span>`;
  return `<span class="contract-muted"><i class="ph ph-handshake"></i> ${escapeHTML(r.client_org_name || '—')} → ${escapeHTML(r.contractor_org_name || '—')}</span>`;
}

/** Карточка заявки (помесь карточки коллеги/контракта). */
export function requestCardHTML(r) {
  const eq = r.equipment
    ? `<span class="contract-muted"><i class="ph ${r.equipment.category_icon || 'ph-desktop'}"></i> ${escapeHTML([r.equipment.brand, r.equipment.model].filter(Boolean).join(' ') || r.equipment.inventory_number || '—')}</span>`
    : '';
  const assignee = r.assignee_name
    ? `<span class="contract-muted"><i class="ph ph-user"></i> ${escapeHTML(r.assignee_name)}</span>`
    : `<span class="contract-muted">${escapeHTML(t('requests.unassigned'))}</span>`;
  const due = r.due_date ? `<span class="contract-muted"><i class="ph ph-calendar"></i> ${escapeHTML(fmtDate(r.due_date))}</span>` : '';
  const meta = [partiesLine(r), eq, assignee, due].filter(Boolean).join('<span class="contract-dot">·</span>');
  return `
    <div class="request-card" data-rq-card="${r.id}">
      <div class="request-card-head">
        <span class="request-card-number">${escapeHTML(r.request_number)}</span>
        <div class="request-card-head-right">${priorityBadge(r.priority)}${statusBadge(r.status)}</div>
      </div>
      <div class="request-card-desc">${escapeHTML(r.description)}</div>
      <div class="request-card-meta">${meta}</div>
      <div class="contract-actions-row contract-actions-row--single">
        <button class="btn btn-secondary contract-action-btn" data-rq-open="${r.id}"><i class="ph ph-map-trifold"></i> <span>${escapeHTML(t('requests.open'))}</span></button>
      </div>
    </div>`;
}

export function requestListHTML(list) {
  if (!list || !list.length) {
    return `<div class="empty-state empty-state--inline"><i class="ph ph-clipboard"></i><span class="empty-state-text">${escapeHTML(t('requests.empty'))}</span></div>`;
  }
  return list.map(requestCardHTML).join('');
}

/* ── Дорожная карта: вертикальный rail статусов ─────────────────── */
export function railHTML(history, currentStatus) {
  const cancelled = currentStatus === 'cancelled';
  // Индекс достигнутого статуса (по истории, исключая cancelled).
  let reached = 0;
  for (const h of (history || [])) {
    const idx = STATUS_ORDER.indexOf(h.new_status);
    if (idx > reached) reached = idx;
  }
  const curIdx = STATUS_ORDER.indexOf(currentStatus);
  const activeIdx = curIdx >= 0 ? curIdx : reached;
  const steps = STATUS_ORDER.map((s, i) => {
    const done = i < activeIdx || (cancelled && i <= reached);
    const active = !cancelled && i === activeIdx;
    return `
      <div class="rrm-rail-step ${done ? 'is-done' : ''} ${active ? 'is-active' : ''} req-rail-${s}" data-rail-status="${s}">
        <div class="rrm-rail-dot"><i class="ph ${STATUS_ICON[s]}"></i></div>
        <div class="rrm-rail-label">${escapeHTML(statusLabel(s))}</div>
      </div>`;
  }).join('');
  const cancelledNode = cancelled
    ? `<div class="rrm-rail-step is-active req-rail-cancelled" data-rail-status="cancelled">
         <div class="rrm-rail-dot"><i class="ph ${STATUS_ICON.cancelled}"></i></div>
         <div class="rrm-rail-label">${escapeHTML(statusLabel('cancelled'))}</div>
       </div>` : '';
  return `<div class="rrm-rail-inner ${cancelled ? 'is-cancelled' : ''}">${steps}${cancelledNode}</div>`;
}

/* ── История (timeline). Каждая запись помечена data-status для scroll-spy.
   Вложения: изображения — миниатюрой (грузит requests.js), иначе чип. ── */
export function historyHTML(history) {
  if (!history || !history.length) {
    return `<div class="empty-state empty-state--inline"><i class="ph ph-clock-counter-clockwise"></i><span class="empty-state-text">${escapeHTML(t('requests.history_empty'))}</span></div>`;
  }
  return history.map(h => {
    const sideLbl = t('requests.side_' + h.changed_by);
    const att = (h.attachments || []).map(a => attachmentHTML(a)).join('');
    const title = h.old_status === h.new_status
      ? t('requests.event_created')
      : t('requests.event_status', { status: statusLabel(h.new_status) });
    return `
      <div class="rrm-event req-rail-${h.new_status}" data-event-status="${h.new_status}">
        <div class="rrm-event-dot"><i class="ph ${STATUS_ICON[h.new_status]}"></i></div>
        <div class="rrm-event-body">
          <div class="rrm-event-head">
            <span class="rrm-event-title">${escapeHTML(title)}</span>
            <span class="rrm-event-time">${escapeHTML(fmtDateTime(h.changed_at))}</span>
          </div>
          <div class="rrm-event-side">${escapeHTML(sideLbl)}</div>
          ${h.comment ? `<div class="rrm-event-comment">${escapeHTML(h.comment)}</div>` : ''}
          ${att ? `<div class="rrm-event-att">${att}</div>` : ''}
        </div>
      </div>`;
  }).join('');
}

function attachmentHTML(a) {
  const isImg = (a.mime_type || '').startsWith('image/');
  if (isImg) {
    return `<div class="rrm-att rrm-att--img" data-rq-att-view="${a.media_file_id}" role="button" tabindex="0"><img data-rq-att-id="${a.media_file_id}" alt=""></div>`;
  }
  return `<button class="rrm-att rrm-att--file" data-rq-att-open="${a.media_file_id}"><i class="ph ph-file-text"></i> <span>${escapeHTML(t('requests.attachment'))}</span></button>`;
}
