/* ═══════════════════════════════════════════════════════════════
   Shared equipment UI — рендер карточек техники (owner + employee).
   Карточка = помесь карточки коллеги и контракта:
     • слева иконка категории, фото (центрировано) и блок brand/model/notes
     • справа в углу — статус-бейдж + действия (edit / delete)
     • снизу — прогресс-бар гарантии (purchase_date → warranty_until)
     • мета-строка: категория · ответственный · инвентарный · серийный · место
   Весь текст переводится через t() — на смене языка оркестратор
   перерисовывает список.
   ═══════════════════════════════════════════════════════════════ */
import { t, getLang } from '../../../../i18n.js';

export function escapeHTML(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ru-RU'); }
  catch { return String(iso); }
}

/* Палитра для интерполяции цвета прогресс-бара гарантии (как у контрактов). */
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

/** Прогресс-бар гарантии: от даты покупки до warranty_until. */
function warrantyProgressHTML(eq) {
  if (!eq.warranty_until) return '';
  const end = new Date(eq.warranty_until).getTime();
  if (!Number.isFinite(end)) return '';
  const start = eq.purchase_date ? new Date(eq.purchase_date).getTime() : (end - 365 * 86400000);
  const now = Date.now();
  const totalSpan = Math.max(1, end - start);
  const leftMs    = Math.max(0, end - now);
  const ratio     = Math.max(0, Math.min(1, leftMs / totalSpan));
  const pct       = leftMs <= 0 ? 100 : Math.max(2, Math.round(ratio * 100));
  const expired   = leftMs <= 0;
  const color     = expired ? getPaletteErrorRgb() : progressColor(ratio);
  const daysLeft  = Math.max(0, Math.floor(leftMs / 86400000));
  const leftLabel = expired
    ? t('equipment.warranty_expired')
    : t('equipment.warranty_left', { time: `${daysLeft} ${t('equipment.days_short')}` });
  return `
    <div class="equipment-warranty-wrap">
      <div class="equipment-warranty-track">
        <div class="equipment-warranty-fill" style="width:${expired ? 100 : pct}%; background:${color};"></div>
      </div>
      <div class="equipment-warranty-meta">
        <span>${escapeHTML(t('equipment.warranty_label'))}: ${escapeHTML(leftLabel)}</span>
        <span>${escapeHTML(fmtDate(eq.warranty_until))}</span>
      </div>
    </div>`;
}
function getPaletteErrorRgb() {
  const { error } = getPalette();
  return `rgb(${error[0]}, ${error[1]}, ${error[2]})`;
}

/** Бейдж статуса техники — на подложке, как у контрактов. */
export function statusBadge(status) {
  const map = {
    operational: ['badge-success', 'ph-check-circle'],
    available:   ['badge-info',    'ph-circle-dashed'],
    assigned:    ['badge-info',    'ph-user-focus'],
    in_repair:   ['badge-warning', 'ph-wrench'],
    retired:     ['badge-default', 'ph-archive'],
  };
  const [cls, icon] = map[status] || ['badge-default', 'ph-question'];
  return `<span class="badge badge-icon ${cls}"><i class="ph ${icon}"></i><span>${escapeHTML(t('equipment.status.' + status))}</span></span>`;
}

/** Иконки-действия в углу карточки (как у контрактов). */
function actionIcons(eq, { canDelete }) {
  const btn = (action, icon, tipKey, danger = false) =>
    `<button class="contract-icon-btn${danger ? ' contract-icon-btn--danger' : ''}" data-eq-action="${action}" data-eq-id="${eq.id}" data-ct-tip="${escapeHTML(t(tipKey))}" aria-label="${escapeHTML(t(tipKey))}"><i class="ph ${icon}"></i></button>`;
  // «Новая заявка» — отдельная кнопка с НАДПИСЬЮ (без подсказки), цвет
  // акцентный зелёный. Открывает модалку заявки с этим оборудованием.
  const newReq = `<button class="btn btn-sm btn-primary eq-newreq-btn" data-eq-action="new-request" data-eq-id="${eq.id}"><i class="ph ph-clipboard-text"></i> <span>${escapeHTML(t('equipment.btn_new_request'))}</span></button>`;
  // edit / delete — серые icon-кнопки (delete краснеет на hover).
  let icons = btn('edit', 'ph-pencil-simple', 'equipment.btn_edit');
  if (canDelete) icons += btn('delete', 'ph-trash', 'equipment.btn_delete', true);
  return `${newReq}<div class="contract-icon-actions">${icons}</div>`;
}

/** Подсветка совпадений поиска (raw → escaped + <mark>). */
function hl(raw, term) {
  const safe = escapeHTML(raw ?? '');
  if (!term) return safe;
  const safeTerm = escapeHTML(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!safeTerm) return safe;
  return safe.replace(new RegExp(`(${safeTerm})`, 'gi'), '<span class="eq-hl">$1</span>');
}

/** Совпадает ли техника с поисковым запросом (по всем текстовым полям). */
export function matchesEquipment(eq, term) {
  if (!term) return true;
  const q = term.toLowerCase();
  const catName = eq.category_name ? t(eq.category_name) : '';
  return [eq.brand, eq.model, eq.notes, eq.inventory_number, eq.serial_number,
          eq.location, eq.responsible_name, catName]
    .some(v => String(v ?? '').toLowerCase().includes(q));
}

/** Одна карточка техники. opts.search — подсветка совпадений. */
export function equipmentCardHTML(eq, { selfId, isOwner, search } = {}) {
  const canDelete = !!isOwner || (eq.responsible_user_id != null && Number(eq.responsible_user_id) === Number(selfId));
  const catIcon = eq.category_icon || 'ph-dots-three-outline';
  const catName = eq.category_name ? t(eq.category_name) : t('equipment.categories.other.name');

  // Фото справа на всю высоту карточки. Кликабельно → модалка просмотра
  // (data-eq-photo-view). Без фото — плашка с иконкой категории (не кликабельна).
  const photoHTML = eq.photo?.id
    ? `<div class="equipment-card-photo" data-eq-photo-view="${eq.photo.id}" role="button" tabindex="0" title="${escapeHTML(t('equipment.photo_view'))}"><img data-eq-photo-id="${eq.photo.id}" alt=""></div>`
    : `<div class="equipment-card-photo equipment-card-photo--empty"><i class="ph-duotone ${catIcon}"></i></div>`;

  const title = (eq.brand && eq.brand.trim()) ? eq.brand : (eq.model || t('equipment.untitled'));
  const modelLine = eq.model ? `<div class="equipment-card-model">${hl(eq.model, search)}</div>` : '';
  const notesLine = eq.notes ? `<div class="equipment-card-notes">${hl(eq.notes, search)}</div>` : '';

  // Мета-строка: категория · ответственный · инвентарный · серийный · место.
  const metaParts = [
    `<span class="equipment-meta-cat"><i class="ph ${catIcon}"></i> ${hl(catName, search)}</span>`,
    eq.responsible_name ? `<span class="contract-muted"><i class="ph ph-user"></i> ${hl(eq.responsible_name, search)}</span>` : '',
    `<span class="contract-muted">${escapeHTML(t('equipment.inventory_short'))}: ${hl(eq.inventory_number, search)}</span>`,
    eq.serial_number ? `<span class="contract-muted">${escapeHTML(t('equipment.serial_short'))}: ${hl(eq.serial_number, search)}</span>` : '',
    eq.location ? `<span class="contract-muted"><i class="ph ph-map-pin"></i> ${hl(eq.location, search)}</span>` : '',
  ].filter(Boolean);

  return `
    <div class="equipment-card eq-tone-${escapeHTML(eq.status || 'operational')}" data-eq-card="${eq.id}">
      <div class="equipment-card-top">
        ${photoHTML}
        <div class="equipment-card-main">
          <div class="equipment-card-head">
            <div class="equipment-card-text">
              <div class="equipment-card-brand">${hl(title, search)}</div>
              ${modelLine}
              ${notesLine}
            </div>
            <div class="equipment-card-head-right">
              ${statusBadge(eq.status)}
              ${actionIcons(eq, { canDelete })}
            </div>
          </div>
          <div class="equipment-card-meta">${metaParts.join('<span class="contract-dot">·</span>')}</div>
        </div>
      </div>
      ${warrantyProgressHTML(eq)}
    </div>`;
}

/** HTML всего списка (или empty-state). */
export function equipmentListHTML(list, opts = {}) {
  if (!list || !list.length) {
    const emptyKey = opts.search ? 'equipment.search_empty' : 'equipment.empty';
    const icon = opts.search ? 'ph-magnifying-glass' : 'ph-desktop-tower';
    return `<div class="empty-state empty-state--inline">
      <i class="ph ${icon}"></i>
      <span class="empty-state-text">${escapeHTML(t(emptyKey))}</span>
    </div>`;
  }
  return list.map(eq => equipmentCardHTML(eq, opts)).join('');
}
