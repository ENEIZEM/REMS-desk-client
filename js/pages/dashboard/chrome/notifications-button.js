/* ═══════════════════════════════════════════════════════════════
   Notifications bell — jumps to the OVERVIEW tab (full feed lives there
   since the dedicated notifications tab was removed) and scrolls the
   notifications card into view. Role-aware: solo users have their feed
   in the solo-home tab instead.
   ═══════════════════════════════════════════════════════════════ */
import { q } from '../dom-utils.js';
import { renderNotificationsList, requestOSNotificationPermission } from '../notifications.js';
import { openModal } from '../ui-helpers.js';

const MOBILE_MQ = '(max-width: 768px)';

export function initNotificationsButton({ switchTab }) {
  q('#btn-notifications')?.addEventListener('click', () => {
    // Клик по колокольчику = жест: просим (один раз) разрешение на системные
    // уведомления. Дальше фоновые уведомления будут падать в центр ОС/браузера.
    requestOSNotificationPermission();
    // Мобила/узкие экраны: уведомления — ОТДЕЛЬНАЯ модалка (сайдбара с
    // лентой-в-обзоре там нет, навигация снизу). Рендерим текущую ленту в
    // тело модалки и открываем её.
    if (window.matchMedia?.(MOBILE_MQ)?.matches) {
      const slot = document.querySelector('#notif-modal-list');
      if (slot) renderNotificationsList(slot);
      openModal('notifications-modal');
      return;
    }

    // Десктоп: прыжок на ленту внутри обзора (как было).
    // Role-aware: solo-юзер не имеет вкладки 'overview' — его лента живёт
    // в 'solo-home' (#solo-notifs-slot).
    const isSolo   = document.body.dataset.role === 'solo';
    const tabName  = isSolo ? 'solo-home' : 'overview';
    const notifSel = isSolo ? '#solo-notifs-slot' : '#employee-notifs-slot';
    switchTab(tabName);
    // Defer one frame so switchTab's DOM updates are applied before we
    // scroll — otherwise the panel is still display:none.
    requestAnimationFrame(() => {
      document.querySelector(notifSel)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
}
