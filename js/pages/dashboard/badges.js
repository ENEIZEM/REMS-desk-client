/* ═══════════════════════════════════════════════════════════════
   Badge / chip descriptors and renderers shared across the
   dashboard tabs (Profile, Organization, navbar dropdown).

   Each descriptor returns: { key (i18n), chip (CSS modifier for
   .row-chip AND legacy .badge variant), badge (legacy pill class
   for the IDENTITY strip), icon (Phosphor variant — "ph-…") }.
   The chip+badge separation lets the prominent identity strip
   keep its filled pill while in-row contexts (role/status/type)
   render as text+icon chips per the redesign spec.
   ═══════════════════════════════════════════════════════════════ */

import { t } from '../../i18n.js';

export function statusBadge(status) {
  switch (status) {
    case 'approved':  return { key: 'membership.status_approved',  chip: 'chip-success', badge: 'badge-success', icon: 'ph-check-circle' };
    case 'pending':   return { key: 'membership.status_pending',   chip: 'chip-warning', badge: 'badge-warning', icon: 'ph-hourglass-medium' };
    case 'rejected':  return { key: 'membership.status_rejected',  chip: 'chip-error',   badge: 'badge-error',   icon: 'ph-x-circle' };
    case 'suspended': return { key: 'membership.status_suspended', chip: 'chip-default', badge: 'badge-default', icon: 'ph-pause-circle' };
    default:          return { key: 'membership.status_unknown',   chip: 'chip-default', badge: 'badge-default', icon: 'ph-question' };
  }
}

export function orgStatusBadge(isActive) {
  return isActive
    ? { key: 'profile.org_status_active',   chip: 'chip-success', badge: 'badge-success', icon: 'ph-check-circle' }
    : { key: 'profile.org_status_inactive', chip: 'chip-default', badge: 'badge-default', icon: 'ph-prohibit' };
}

// `orgTypeBadge` was removed alongside the organizations.occupation
// column — the customer / contractor distinction now lives on each
// contract row between two organisations, not as an attribute of the
// org itself.

export function roleBadgeDescriptor(role) {
  switch (role) {
    case 'owner':     return { key: 'roles.owner',     chip: 'chip-owner',     badge: 'badge-role-owner',     icon: 'ph-shield-star' };
    case 'employee':  return { key: 'roles.employee',  chip: 'chip-employee',  badge: 'badge-role-employee',  icon: 'ph-user' };
    case 'sys_admin': return { key: 'roles.sys_admin', chip: 'chip-sys-admin', badge: 'badge-role-sys-admin', icon: 'ph-crown-simple' };
    default:
      return { key: 'membership.status_unknown', chip: 'chip-default', badge: 'badge-default', icon: 'ph-user' };
  }
}

// Бейдж «Администрация сайта» — для организации, которой владеет
// sys_admin. Тот же indigo-тон и корона, что у роли sys_admin, но своя
// надпись (организация, а не человек).
export function siteAdminOrgDescriptor() {
  return { key: 'profile.org_site_admin', chip: 'chip-sys-admin', badge: 'badge-role-sys-admin', icon: 'ph-crown-simple' };
}

// Render an old-style filled badge pill (identity strip).
// The header strip USES THE REGULAR Phosphor variant (not duotone) per
// the redesign — solid icons read better against the filled pill.
// IMPORTANT: data-i18n lives on the INNER <span> only — applyTranslations()
// uses textContent = t(...), which would otherwise wipe the icon child.
export function renderIconBadge(el, desc) {
  if (!el || !desc) return;
  el.className = `badge badge-icon ${desc.badge || desc.cls || 'badge-default'}`;
  el.removeAttribute('data-i18n');
  el.innerHTML = `<i class="ph ${desc.icon}"></i><span data-i18n="${desc.key}">${t(desc.key)}</span>`;
}

// Container-less chip: thematic-coloured text + DUOTONE icon.
// Used for in-row, read-only fields. The chip's `.row-chip` CSS owns the
// font-size + weight; duotone gives the icons a slightly softer look so
// they don't compete with the text against a plain row background.
export function renderRowChip(el, desc) {
  if (!el || !desc) return;
  el.className = `row-chip ${desc.chip || 'chip-default'}`;
  el.removeAttribute('data-i18n');
  el.innerHTML = `<span data-i18n="${desc.key}">${t(desc.key)}</span><i class="ph-duotone ${desc.icon}"></i>`;
}
