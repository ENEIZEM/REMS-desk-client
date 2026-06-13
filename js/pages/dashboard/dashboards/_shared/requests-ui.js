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

const STATUS_ICON = {
  new: 'ph-hand-palm', assigned: 'ph-user-focus', in_progress: 'ph-wrench',
  done: 'ph-check-circle', closed: 'ph-lock-simple', cancelled: 'ph-x-circle',
};

export function statusLabel(s) { return t('requests.status.' + s); }

// Чип статуса. Для 'new' показываем «Свободна» (requests.unassigned) —
// новая заявка == свободна в пуле; раньше это дублировалось отдельной
// меткой в мете. Цвета чипа/карточки для 'new' — акцентные (бирюза).
export function statusBadge(s) {
  const label = s === 'new' ? t('requests.unassigned') : statusLabel(s);
  return `<span class="badge badge-icon req-badge-${s}"><i class="ph ${STATUS_ICON[s] || 'ph-question'}"></i><span>${escapeHTML(label)}</span></span>`;
}

const PRIORITY_ICON = { low: 'ph-arrow-down', medium: 'ph-equals', high: 'ph-arrow-up', critical: 'ph-warning' };
export function priorityBadge(p) {
  return `<span class="badge badge-icon req-prio-${p}"><i class="ph ${PRIORITY_ICON[p] || 'ph-equals'}"></i><span>${escapeHTML(t('requests.priority.' + p))}</span></span>`;
}

function partiesLine(r) {
  if (r.is_internal) return '';
  return `<span class="contract-muted"><i class="ph ph-handshake"></i> ${escapeHTML(r.client_org_name || '—')} <i class="ph ph-arrow-right rq-parties-arrow"></i> ${escapeHTML(r.contractor_org_name || '—')}</span>`;
}

/** Чип типа заявки (внутренняя / по контракту) — используется в карточке
 *  и в шапке сводки дорожной карты. */
export function typeChipHTML(r) {
  return r.is_internal
    ? `<span class="request-type-chip"><i class="ph ph-buildings"></i><span>${escapeHTML(t('requests.type_internal'))}</span></span>`
    : `<span class="request-type-chip request-type-chip--contract"><i class="ph ph-handshake"></i><span>${escapeHTML(t('requests.type_contract'))}</span></span>`;
}

/** Карточка заявки. Кликабельна целиком (data-rq-open на корне):
 *  слева цветная статус-полоса, в шапке — иконка-тайл статуса, номер и
 *  тип-чип; в подвале — мета и аффорданс «Дорожная карта ›». */
export function requestCardHTML(r) {
  const eq = r.equipment
    ? `<span class="contract-muted"><i class="ph ${r.equipment.category_icon || 'ph-desktop'}"></i> ${escapeHTML([r.equipment.brand, r.equipment.model].filter(Boolean).join(' ') || r.equipment.inventory_number || '—')}</span>`
    : '';
  // Исполнитель в мете — только если назначен. «Свободна» больше НЕ
  // дублируем в мете: для new это уже сказано чипом статуса.
  const assignee = r.assignee_name
    ? `<span class="contract-muted"><i class="ph ph-user"></i> ${escapeHTML(r.assignee_name)}</span>`
    : '';
  const due = r.due_date ? `<span class="contract-muted"><i class="ph ph-calendar"></i> ${escapeHTML(fmtDate(r.due_date))}</span>` : '';
  const meta = [partiesLine(r), eq, assignee, due].filter(Boolean).join('<span class="contract-dot">·</span>');
  const terminal = r.status === 'closed' || r.status === 'cancelled';
  return `
    <div class="request-card req-tone-${r.status}${terminal ? ' request-card--terminal' : ''}" data-rq-card="${r.id}" data-rq-open="${r.id}" role="button" tabindex="0"
         aria-label="${escapeHTML(r.request_number)}">
      <div class="request-card-head">
        <div class="request-card-id">
          <span class="request-card-status-ico"><i class="ph-bold ${STATUS_ICON[r.status] || 'ph-clipboard-text'}"></i></span>
          <span class="request-card-number">${escapeHTML(r.request_number)}</span>
          ${typeChipHTML(r)}
        </div>
        <div class="request-card-head-right">${priorityBadge(r.priority)}${statusBadge(r.status)}</div>
      </div>
      <div class="request-card-desc">${escapeHTML(r.description)}</div>
      ${cardAttachmentsHTML(r.last_attachments)}
      <div class="request-card-foot">
        <div class="request-card-meta">${meta}</div>
        <span class="request-card-open"><span>${escapeHTML(t('requests.open'))}</span><i class="ph-bold ph-caret-right"></i></span>
      </div>
    </div>`;
}

export function requestListHTML(list) {
  if (!list || !list.length) {
    return `<div class="empty-state empty-state--inline"><i class="ph ph-clipboard"></i><span class="empty-state-text">${escapeHTML(t('requests.empty'))}</span></div>`;
  }
  return list.map(requestCardHTML).join('');
}

/* ── История (timeline) — единственная «дорожная карта» модалки:
   цепочка событий с иконками статусов, ролью актора в строке
   заголовка, комментариями и вложениями каждого перехода. ─────────── */
export function historyHTML(history) {
  if (!history || !history.length) {
    return `<div class="empty-state empty-state--inline"><i class="ph ph-clock-counter-clockwise"></i><span class="empty-state-text">${escapeHTML(t('requests.history_empty'))}</span></div>`;
  }
  return history.map(h => {
    const sideLbl = t('requests.side_' + h.changed_by);
    const att = (h.attachments || []).map(a => attachmentHTML(a)).join('');
    // Информативный заголовок события вместо «Статус: X». Для создания —
    // «Заявка создана»; для переходов — действие (requests.events.<status>),
    // c фолбэком на ярлык статуса, если ключа нет.
    const title = h.old_status === h.new_status
      ? t('requests.event_created')
      : (t('requests.events.' + h.new_status) !== 'requests.events.' + h.new_status
          ? t('requests.events.' + h.new_status)
          : statusLabel(h.new_status));
    // Сообщение и вложения — в одном визуальном контейнере (.rrm-event-detail).
    const detail = (h.comment || att)
      ? `<div class="rrm-event-detail">
           ${h.comment ? `<div class="rrm-event-comment">${escapeHTML(h.comment)}</div>` : ''}
           ${att ? `<div class="rrm-event-att">${att}</div>` : ''}
         </div>`
      : '';
    return `
      <div class="rrm-event req-rail-${h.new_status}" data-event-status="${h.new_status}">
        <div class="rrm-event-dot"><i class="ph ${STATUS_ICON[h.new_status]}"></i></div>
        <div class="rrm-event-body">
          <div class="rrm-event-head">
            <span class="rrm-event-title">${escapeHTML(title)}</span>
            <span class="rrm-side-chip rrm-side-${h.changed_by}">${escapeHTML(sideLbl)}</span>
            <span class="rrm-event-time">${escapeHTML(fmtDateTime(h.changed_at))}</span>
          </div>
          ${detail}
        </div>
      </div>`;
  }).join('');
}

function attachmentHTML(a) {
  const isImg = (a.mime_type || '').startsWith('image/');
  if (isImg) {
    return `<div class="rrm-att rrm-att--img" data-rq-att-view="${a.media_file_id}" role="button" tabindex="0" title="${escapeHTML(t('requests.attachment'))}"><img data-rq-att-id="${a.media_file_id}" alt=""></div>`;
  }
  // Документ — такой же квадрат, как фото, но с иконкой PDF внутри
  // (как тайлы в модалке создания заявки).
  return `<div class="rrm-att rrm-att--doc" data-rq-att-open="${a.media_file_id}" role="button" tabindex="0" title="${escapeHTML(t('requests.attachment'))}"><i class="ph-duotone ph-file-pdf"></i></div>`;
}

/** Мини-рейка вложений последнего статуса — для карточки заявки.
 *  До 4 миниатюр + счётчик «+N». Клик по вложению открывает просмотрщик
 *  (делегирование в requests.js проверяет вложение РАНЬШЕ data-rq-open). */
export function cardAttachmentsHTML(list) {
  if (!Array.isArray(list) || !list.length) return '';
  const shown = list.slice(0, 4).map(attachmentHTML).join('');
  const more = list.length > 4 ? `<span class="rq-att-more">+${list.length - 4}</span>` : '';
  return `<div class="request-card-att">${shown}${more}</div>`;
}
