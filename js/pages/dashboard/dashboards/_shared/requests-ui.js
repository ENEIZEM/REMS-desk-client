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

// Срочность — ЕДИНСТВЕННЫЙ «горячий» канал карточки. Активный SLA-час:
//   • new                     → срок ВЗЯТИЯ  (response_due, от created_at)
//   • assigned / in_progress  → срок РЕШЕНИЯ (due_date, от assigned_at)
//   • терминальные / нет срока → none (ничего не подсвечиваем)
// Уровень: overdue (просрочено) → soon (<25% времени) → ok → none.
// Деградирует мягко: если миграция SLA не применена (нет response_due/
// due_date) — вернётся none, карточка просто без пилла срочности.
// Конец активного SLA-окна (ms) или null, если срока нет (терминальные /
// немигрированная БД). Вынесено, чтобы переиспользовать в сортировке секций.
function activeDeadlineMs(r) {
  if (r.status === 'new' && r.response_due) return new Date(r.response_due).getTime();
  if ((r.status === 'assigned' || r.status === 'in_progress') && r.due_date) return new Date(r.due_date).getTime();
  return null;
}
/** Остаток до дедлайна в ms (отрицательный = просрочено, Infinity = нет срока).
 *  Для сортировки секций «по срочности»: просроченные и горящие — вверху. */
export function slaRemainingMs(r) {
  const end = activeDeadlineMs(r);
  return end == null ? Infinity : end - Date.now();
}

export function urgencyOf(r) {
  let end = null, start = null, kind = null;
  if (r.status === 'new' && r.response_due) { end = r.response_due; start = r.created_at; kind = 'response'; }
  else if ((r.status === 'assigned' || r.status === 'in_progress') && r.due_date) { end = r.due_date; start = r.assigned_at || r.created_at; kind = 'resolution'; }
  if (!end) return { level: 'none', text: '' };
  const now = Date.now(), endMs = new Date(end).getTime();
  const remaining = endMs - now;
  if (remaining <= 0) return { level: 'overdue', text: t('requests.sla.overdue', { t: fmtSpan(-remaining) }) };
  const startMs = start ? new Date(start).getTime() : endMs - 24 * 3600e3;
  const fracLeft = remaining / Math.max(endMs - startMs, 1);
  const text = kind === 'response'
    ? t('requests.sla.take', { t: fmtSpan(remaining) })
    : t('requests.sla.left', { t: fmtSpan(remaining) });
  return { level: fracLeft <= 0.25 ? 'soon' : 'ok', text };
}

/** Единый чип времени для карточки/шапки с ДВУМЯ числами:
 *   • new                      → «взять за <остаток> · дано <окно реакции>»
 *   • assigned / in_progress   → «<остаток> до срока · дано <окно решения>»
 *   • просрочено               → «просрочено <X> · дано <окно>»
 *   • closed                   → «закрыто за <факт> · дано <окно>» (зел./красн.)
 *   • cancelled                → «Отменена»
 *  Возвращает { level, text } (level → класс rq-due-*) или null. */
export function timeChip(r) {
  const span = (a, b) => (a && b) ? fmtSpan(new Date(b).getTime() - new Date(a).getTime()) : null;
  if (r.status === 'cancelled') return { level: 'cancelled', text: t('requests.status.cancelled') };
  if (r.status === 'closed') {
    if (r.assigned_at && r.due_date) {
      const given  = new Date(r.due_date).getTime() - new Date(r.assigned_at).getTime();
      const actual = (r.closed_at ? new Date(r.closed_at).getTime() : Date.now()) - new Date(r.assigned_at).getTime();
      return {
        level: actual > given ? 'overdue' : 'done',
        text:  t('requests.sla.closed_in', { t: fmtSpan(actual), g: fmtSpan(given) }),
      };
    }
    return { level: 'done', text: t('requests.status.closed') };
  }
  const u = urgencyOf(r);
  if (u.level === 'none') return null;
  const given = r.status === 'new' ? span(r.created_at, r.response_due) : span(r.assigned_at, r.due_date);
  return { level: u.level, text: given ? `${u.text} · ${t('requests.sla.given_short', { g: given })}` : u.text };
}
// Двухкомпонентный формат («1ч 30м», «2д 3ч») — без грубого округления:
// 50ч → «2д 2ч», 1.5ч → «1ч 30м». До часа — минуты.
function fmtSpan(ms) {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${Math.max(totalMin, 1)}${t('requests.sla.u_m')}`;
  const h = Math.floor(ms / 3600000);
  if (h < 48) {
    const rm = Math.round((ms % 3600000) / 60000);
    return rm ? `${h}${t('requests.sla.u_h')} ${rm}${t('requests.sla.u_m')}` : `${h}${t('requests.sla.u_h')}`;
  }
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? `${d}${t('requests.sla.u_d')} ${rh}${t('requests.sla.u_h')}` : `${d}${t('requests.sla.u_d')}`;
}

// Индикатор «обновлено»: карточка помечается, если по заявке есть
// непросмотренные изменения. Источник правды — УВЕДОМЛЕНИЯ (per-user,
// серверные): каждое изменение шлёт уведомление с request_id, а при
// открытии дорожной карты на нём ставится флаг data.request_seen
// (отдельно от read_at колокольчика). Проверку инжектит requests.js
// через setRequestUnseenChecker(fn) → notifications.hasUnseenForRequest.
// Раньше состояние «просмотрено» хранилось в localStorage (per-device,
// терялось при очистке кэша, не синхронилось между устройствами).
let _viewerId = null;
export function setRequestViewer(id) { _viewerId = id != null ? Number(id) : null; }

let _unseenChecker = null;
export function setRequestUnseenChecker(fn) { _unseenChecker = typeof fn === 'function' ? fn : null; }
function isRequestUpdated(r) {
  return _unseenChecker ? !!_unseenChecker(r.id) : false;
}

// Иконки статусов — СТАНДАРТИЗОВАНЫ с уведомлениями (notifications.js
// requestStatusIcon): создана/new=clipboard-text, взята=hand-grab,
// в работе=wrench, выполнена=check-circle, закрыта=lock-simple, отменена=x-circle.
const STATUS_ICON = {
  new: 'ph-clipboard-text', assigned: 'ph-hand-grabbing', in_progress: 'ph-wrench',
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

/** Карточка заявки. Кликабельна целиком (data-rq-open на корне).
 *  ДВЕ ОСИ РАЗВЕДЕНЫ ПО КАНАЛАМ (редизайн 2026-06):
 *   • СРОЧНОСТЬ — единственный «горячий» сигнал: левая кромка + пилл
 *     остатка времени (серый → янтарь → красный по активному SLA-часу).
 *   • СТАТУС — тихий: маленькая точка-категория (зелёная=свободна,
 *     синяя=готова, нейтральная=в работе, серая=закрыта) + текст-метка.
 *   Приоритет с карточки убран — он лишь вход в расчёт срока (виден в детали).
 */
export function requestCardHTML(r) {
  const u = urgencyOf(r);
  const terminal = r.status === 'closed' || r.status === 'cancelled';
  // Техника: бренд/модель + инвентарный № + расположение (ключевые поля
  // прямо в ленте — полный блок в дорожной карте).
  let eq = '';
  if (r.equipment) {
    const eqName = [r.equipment.brand, r.equipment.model].filter(Boolean).join(' ') || r.equipment.inventory_number || '—';
    const eqBits = [
      eqName,
      ([r.equipment.brand, r.equipment.model].filter(Boolean).length && r.equipment.inventory_number) ? `№${r.equipment.inventory_number}` : '',
      r.equipment.location ? `<i class="ph ph-map-pin"></i> ${escapeHTML(r.equipment.location)}` : '',
    ].filter(Boolean);
    eq = `<span class="contract-muted"><i class="ph ${r.equipment.category_icon || 'ph-desktop'}"></i> ${eqBits.map((b, i) => i === 0 ? escapeHTML(b) : b).join(' · ')}</span>`;
  }
  const assignee = r.assignee_name
    ? `<span class="contract-muted"><i class="ph ph-user"></i> ${escapeHTML(r.assignee_name)}</span>`
    : '';
  const meta = [partiesLine(r), eq, assignee].filter(Boolean).join('<span class="contract-dot">·</span>');

  const statusText = r.status === 'new'
    ? (_viewerId != null && Number(r.author_id) === _viewerId ? t('requests.created_by_you') : t('requests.unassigned'))
    : statusLabel(r.status);
  // Чип времени с ДВУМЯ числами (остаток/факт + отведённый срок).
  const tc = timeChip(r);
  const dueIcon = tc?.level === 'overdue' ? 'ph-alarm' : (tc?.level === 'done' ? 'ph-check' : 'ph-clock');
  const duePill = tc
    ? `<span class="rq-due rq-due-${tc.level}"><i class="ph ${dueIcon}"></i> ${escapeHTML(tc.text)}</span>`
    : '';
  // Индикатор «обновлено» — заявка изменилась с момента последнего просмотра.
  const updated = isRequestUpdated(r);
  const updatedPill = updated
    ? `<span class="rq-updated" title="${escapeHTML(t('requests.updated'))}"><i class="ph-fill ph-bell-ringing"></i> ${escapeHTML(t('requests.updated'))}</span>`
    : '';

  return `
    <div class="request-card rq-urg-${u.level}${terminal ? ' request-card--terminal' : ''}${updated ? ' request-card--updated' : ''}" data-rq-card="${r.id}" data-rq-open="${r.id}" role="button" tabindex="0"
         aria-label="${escapeHTML(r.request_number)}">
      <div class="request-card-head">
        <div class="request-card-id">
          <span class="rq-dot rq-dot-${r.status}" aria-hidden="true"></span>
          <span class="request-card-number">${escapeHTML(r.request_number)}</span>
          ${typeChipHTML(r)}
          <span class="rq-status-label">${escapeHTML(statusText)}</span>
        </div>
        <div class="request-card-head-right">${updatedPill}${duePill}</div>
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
export function historyHTML(history, names = {}) {
  if (!history || !history.length) {
    return `<div class="empty-state empty-state--inline"><i class="ph ph-clock-counter-clockwise"></i><span class="empty-state-text">${escapeHTML(t('requests.history_empty'))}</span></div>`;
  }
  // Сторона события выводится из нового статуса (детерминированно), а не из
  // status_history.changed_by — у части старых заявок оно проставлено
  // неверно (везде «заказчик»). Исполнительские переходы — assigned/
  // in_progress/done, остальные (new/closed/cancelled) — на стороне заказчика.
  const CONTRACTOR_STATUSES = ['assigned', 'in_progress', 'done'];
  return history.map(h => {
    const side = CONTRACTOR_STATUSES.includes(h.new_status) ? 'contractor' : 'customer';
    const sideName = side === 'contractor' ? names.assignee : names.author;
    // В чипе — только ФИО (цвет чипа кодирует сторону: оранжевый=заказчик,
    // розовый=исполнитель). Если имени нет — фолбэк на роль.
    const sideLbl = sideName || t('requests.side_' + side);
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
            <span class="rrm-side-chip rrm-side-${side}">${escapeHTML(sideLbl)}</span>
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
