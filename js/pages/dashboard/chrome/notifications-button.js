/* ═══════════════════════════════════════════════════════════════
   Notifications bell — jumps to the OVERVIEW tab (full feed lives there
   since the dedicated notifications tab was removed) and scrolls the
   notifications card into view. Role-aware: solo users have their feed
   in the solo-home tab instead.
   ═══════════════════════════════════════════════════════════════ */
import { q } from '../dom-utils.js';

export function initNotificationsButton({ switchTab }) {
  q('#btn-notifications')?.addEventListener('click', () => {
    // Role-aware: solo-юзер не имеет вкладки 'overview' — его лента живёт
    // в 'solo-home' (#solo-notifs-slot). Раньше тут был жёсткий
    // switchTab('overview'), что для solo вело «в никуда».
    const isSolo   = document.body.dataset.role === 'solo';
    const tabName  = isSolo ? 'solo-home' : 'overview';
    // owner/employee рендерят ленту в свой overview-slot (#employee-notifs-slot),
    // solo — в #solo-notifs-slot. Старый общий #overview-notifs удалён.
    const notifSel = isSolo ? '#solo-notifs-slot' : '#employee-notifs-slot';
    switchTab(tabName);
    // Defer one frame so switchTab's DOM updates are applied before we
    // scroll — otherwise the panel is still display:none.
    requestAnimationFrame(() => {
      document.querySelector(notifSel)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
}
