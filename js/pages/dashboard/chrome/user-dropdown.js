/* ═══════════════════════════════════════════════════════════════
   Header avatar — мини-меню СКРЫТО (логика сохранена, не удалена):
   • клик по аватару в шапке ведёт в «Обзор» (solo → его домашняя);
   • «Выйти» переехала в низ сайдбара (красная на hover);
   • профиль / организация открываются вкладками сайдбара.
   Скрытые строки меню (#dd-profile / #dd-org-link / #btn-logout) и их
   обработчики оставлены на месте — меню просто не показывается, так что
   логику можно вернуть, сняв скрытие.
   ═══════════════════════════════════════════════════════════════ */
import { q } from '../dom-utils.js';
import { logout } from '../../../auth.js';

export function initUserDropdown({ switchTab }) {
  const userDropdown = q('#user-dropdown');
  // Меню всегда скрыто — больше не открывается ни по hover, ни по клику.
  userDropdown?.classList.add('hidden');

  // Клик по аватару в шапке → «Обзор» для всех ролей (solo → solo-home).
  q('#btn-user-menu')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const role = document.body.dataset.role;
    switchTab(role === 'solo' ? 'solo-home' : 'overview');
  });

  // ── Логика меню СОХРАНЕНА (элементы скрыты, обработчики живут) ──
  // Если меню снова понадобится — достаточно перестать скрывать #user-dropdown.
  q('#dd-profile')?.addEventListener('click',  () => { userDropdown?.classList.add('hidden'); switchTab('profile'); });
  q('#dd-org-link')?.addEventListener('click', () => { userDropdown?.classList.add('hidden'); switchTab('org'); });
  q('#btn-logout')?.addEventListener('click',  () => logout());

  // «Выйти» в низу сайдбара — основная точка выхода теперь здесь.
  q('#btn-sidebar-logout')?.addEventListener('click', () => logout());
}
