/* ═══════════════════════════════════════════════════════════════
   Members tab — owner review queue (pending approve/reject), approved
   directory, remove-member + member-decision modals, and the invite
   flow. Extracted from the dashboard orchestrator; the current user's
   profile is injected via initMembers({ getProfile }).

   Renders TWO lists:
     • #pending-list  → owner-only review queue with Approve/Reject
                        buttons inline on each row
     • #approved-list → directory of approved members (owner first,
                        rest alphabetical).
   Each row uses the same identity-card layout as the profile/org
   header strip: avatar + name + masked email/phone + department +
   "В организации с <date>".
   ═══════════════════════════════════════════════════════════════ */
import { members } from '../../api.js';
import { toast, errorMessage } from '../../auth.js';
import { t, getLang } from '../../i18n.js';
import { wireFormGuard } from '../../form-guard.js';
import { openModal, closeModal, setLoading, setFieldError } from './ui-helpers.js';
import { initials } from './format.js';
import { attachLoader } from '../../lib/lazy-loader.js';
import { q, escapeHTML } from './dom-utils.js';
import { phoneChannelEnabled } from '../../config.js';

// Current user profile — injected at boot via initMembers().
let _getProfile = () => null;

function formatJoinDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ru-RU', {
    day: '2-digit', month: 'long', year: 'numeric',
  });
}

function memberRowHTML(m, opts = {}) {
  const me        = _getProfile();
  const isPending = opts.pending === true;
  const isOwner   = m.org_role === 'owner';
  const isSelf    = me?.id != null && Number(me.id) === Number(m.id);

  // Avatar tile: image if URL present, otherwise initials.
  const avatarHTML = m.avatar?.url
    ? `<img src="${escapeHTML(m.avatar.url)}" alt="">`
    : `<span>${escapeHTML(initials(m.full_name))}</span>`;

  // Contact line — prefer email, fall back to phone. Both pre-masked.
  const contact = m.email_masked || m.phone_masked || '—';

  // Secondary meta line: department · (joined-date | applied-date).
  const dateKey = isPending ? 'members.applied_at' : 'members.joined_at';
  const dateStr = t(dateKey, { date: formatJoinDate(m.joined_at) });
  const dept    = m.department || t('members.no_department');

  // "Это вы" chip — теперь в ПРАВОМ столбце (тот же слот что и
  // remove-trash у owner'а), чтобы все per-row controls были
  // выровнены вертикально. Из имени убран.
  const selfBadge = '';
  const selfChipRight = (isSelf && !isPending)
    ? `<span class="members-row-self" data-ct-tip="${t('members.you')}" aria-label="${t('members.you')}"><i class="ph-bold ph-user"></i></span>`
    : '';

  // Stats pills — only meaningful on approved rows; pending users
  // haven't been assigned any requests yet.
  const stats = !isPending && m.stats ? `
    <div class="members-row-stats">
      <span class="members-stat is-active" title="${t('members.stat_active')}">
        <span class="members-stat-num">${m.stats.active ?? 0}</span>
        <span>${t('members.stat_active')}</span>
      </span>
      <span class="members-stat is-closed" title="${t('members.stat_closed')}">
        <span class="members-stat-num">${m.stats.closed ?? 0}</span>
        <span>${t('members.stat_closed')}</span>
      </span>
    </div>` : '';

  // Right-side action cluster. Pending → Approve / Reject; Approved →
  // role chip + (for the owner viewing OTHERS) a remove button.
  const canRemove = !isPending && !isSelf && !isOwner && me?.org_role === 'owner';
  let rightHTML;
  if (isPending) {
    rightHTML = `
      <div class="members-row-actions">
        <button class="btn btn-secondary btn-sm btn-approve" data-id="${m.id}">
          <i class="ph ph-check"></i>
          <span>${t('members.approve')}</span>
        </button>
        <button class="btn btn-danger btn-sm btn-reject" data-id="${m.id}">
          <i class="ph ph-x"></i>
          <span>${t('members.reject')}</span>
        </button>
      </div>`;
  } else {
    rightHTML = `
      <div class="members-row-actions">
        <span class="badge ${isOwner ? 'badge-role-owner' : 'badge-role-employee'}">${t(isOwner ? 'roles.owner' : 'roles.employee')}</span>
        ${selfChipRight ? selfChipRight : ''}
        ${canRemove ? `
          <button class="members-row-delete btn-remove" data-id="${m.id}" data-name="${escapeHTML(m.full_name)}"
                  data-ct-tip="${t('members.remove')}" aria-label="${t('members.remove')}">
            <i class="ph-bold ph-trash"></i>
          </button>` : ''}
      </div>`;
  }

  // Текст инвайта/заявки. Показываем ТОЛЬКО на pending (approved
  // юзеры уже не нуждаются в этой context-line).
  const inviteMsg = isPending && m.invite_message
    ? `<div class="members-row-invite-msg" title="${escapeHTML(m.invite_message)}">
         <i class="ph ph-chat-circle-text"></i>
         <span>${escapeHTML(m.invite_message)}</span>
       </div>`
    : '';

  return `
    <div class="members-row" data-id="${m.id}">
      <div class="avatar avatar-md members-row-avatar">${avatarHTML}</div>
      <div class="members-row-text">
        <div class="members-row-name">
          ${escapeHTML(m.full_name)}
          ${selfBadge}
        </div>
        <div class="members-row-contact">${escapeHTML(contact)}</div>
        <div class="members-row-meta">
          <span>${escapeHTML(dept)}</span>
          <span class="members-row-sep">·</span>
          <span>${escapeHTML(dateStr)}</span>
        </div>
        ${inviteMsg}
      </div>
      ${stats}
      ${rightHTML}
    </div>`;
}

export async function loadMembers() {
  const tabEl = q('#tab-members');
  const stopLoader = tabEl ? attachLoader({ container: tabEl }) : null;
  try {
    const data = await members.list();
    const approved = data.data?.approved || [];
    const pending  = data.data?.pending  || [];

    // ── Pending section (owner-only — backend returns [] for non-owners). ──
    const pendingSection = q('#pending-section');
    const pendingList    = q('#pending-list');
    if (pendingList) {
      if (!pending.length) {
        if (pendingSection) pendingSection.style.display = 'none';
      } else {
        if (pendingSection) pendingSection.style.display = '';
        pendingList.innerHTML = pending.map(m => memberRowHTML(m, { pending: true })).join('');
        pendingList.querySelectorAll('.btn-approve').forEach(btn => btn.addEventListener('click', () => manageMember(btn.dataset.id, 'approved')));
        pendingList.querySelectorAll('.btn-reject') .forEach(btn => btn.addEventListener('click', () => manageMember(btn.dataset.id, 'rejected')));
      }
    }

    // ── Approved directory. Always shown (empty-state if 0 — shouldn't
    //    happen since the caller themselves is in the list, but keep
    //    the fallback for safety). ──
    const approvedList = q('#approved-list');
    const countBadge   = q('#approved-count');
    if (approvedList) {
      if (!approved.length) {
        approvedList.innerHTML = `
          <div class="empty-state">
            <i class="ph ph-users"></i>
            <p class="empty-state-title">${t('members.empty')}</p>
          </div>`;
      } else {
        approvedList.innerHTML = approved.map(m => memberRowHTML(m)).join('');
        // Wire the per-row remove buttons. Native confirm() is fine
        // for now — a custom modal can replace it later if the rest
        // of the UI gets polished further.
        approvedList.querySelectorAll('.btn-remove').forEach(btn => {
          btn.addEventListener('click', () => removeMember(btn.dataset.id, btn.dataset.name));
        });
      }
    }
    if (countBadge) countBadge.textContent = String(approved.length);
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    stopLoader?.();
  }
}

/* Pending target for the remove-member modal. Set on open by
   `removeMember()`, consumed by the modal's confirm-button click. */
let _pendingRemoveMemberId = null;

function removeMember(userId, name) {
  if (!userId) return;
  _pendingRemoveMemberId = userId;
  const nameEl = q('#remove-member-name');
  if (nameEl) nameEl.textContent = name || '—';
  const reasonEl = q('#remove-member-reason');
  if (reasonEl) reasonEl.value = '';   // сброс при каждом открытии
  openModal('remove-member-modal');
}

/* ── Member decision modal (approve / reject join-request) ──────────
   owner/team.js диспатчит 'rems:member-decision' с {id, name, message}
   когда owner кликает «Рассмотреть» на pending-плашке. Открываем
   #member-decision-modal, показываем сообщение соискателя, даём
   написать опц. текст решения. Accept/Reject → members.manage(). */
let _pendingDecisionId = null;

async function submitMemberDecision(action) {
  const id = _pendingDecisionId;
  if (!id) return;
  const acceptBtn = q('#btn-member-decision-accept');
  const rejectBtn = q('#btn-member-decision-reject');
  const message = (q('#member-decision-text')?.value || '').trim().slice(0, 500);
  setLoading(acceptBtn, true);
  setLoading(rejectBtn, true);
  try {
    await members.manage(id, action, message);
    closeModal('member-decision-modal');
    toast(t(action === 'approved' ? 'members.approved_toast' : 'members.rejected_toast'), 'ok');
    _pendingDecisionId = null;
    loadMembers();
    // owner/team.js рендерит собственный список — просим перерисоваться.
    window.dispatchEvent(new CustomEvent('rems:reload-members'));
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    setLoading(acceptBtn, false);
    setLoading(rejectBtn, false);
  }
}

async function manageMember(userId, action) {
  try {
    await members.manage(userId, action);
    const msg = getLang() === 'en'
      ? (action === 'approved' ? 'Approved' : 'Rejected')
      : (action === 'approved' ? 'Одобрено' : 'Отклонено');
    toast(msg, 'ok');
    loadMembers();
  } catch (err) { toast(errorMessage(err), 'error'); }
}

// Form-guard reference (set in initMembers).
let _inviteGuard = null;
let _inviteMsgEl = null;
let _inviteMsgCnt = null;

export function initMembers({ getProfile }) {
  if (typeof getProfile === 'function') _getProfile = getProfile;

  q('#btn-remove-member-confirm')?.addEventListener('click', async () => {
    const id = _pendingRemoveMemberId;
    if (!id) return;
    const btn = q('#btn-remove-member-confirm');
    const reason = (q('#remove-member-reason')?.value || '').trim().slice(0, 500);
    setLoading(btn, true);
    try {
      await members.remove(id, reason);
      closeModal('remove-member-modal');
      toast(t('members.removed_toast'), 'ok');
      _pendingRemoveMemberId = null;
      loadMembers();
      // owner/team.js рендерит свой собственный список — сигналим ему
      // перерисоваться (loadMembers пишет в legacy #approved-list,
      // которого в owner-team-разметке нет).
      window.dispatchEvent(new CustomEvent('rems:reload-members'));
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  // Owner Ресурсы (owner/team.js) просит открыть модалку исключения —
  // переиспользуем общий removeMember() flow с модалкой #remove-member-modal.
  window.addEventListener('rems:remove-member', (e) => {
    const { id, name } = e.detail || {};
    removeMember(id, name);
  });

  window.addEventListener('rems:member-decision', (e) => {
    const { id, name, message } = e.detail || {};
    if (!id) return;
    _pendingDecisionId = id;
    const nameEl = q('#member-decision-name');
    if (nameEl) nameEl.textContent = name || '—';
    // Сообщение соискателя — показываем блок только если оно есть.
    const msgWrap = q('#member-decision-applicant-msg');
    const msgText = q('#member-decision-applicant-msg-text');
    const trimmed = (message || '').trim();
    if (msgWrap) msgWrap.style.display = trimmed ? '' : 'none';
    if (msgText) msgText.textContent = trimmed;
    // Сброс текста решения при каждом открытии.
    const txt = q('#member-decision-text');
    if (txt) txt.value = '';
    openModal('member-decision-modal');
  });

  q('#btn-member-decision-accept')?.addEventListener('click', () => submitMemberDecision('approved'));
  q('#btn-member-decision-reject')?.addEventListener('click', () => submitMemberDecision('rejected'));

  // Form-guard: серая кнопка пока контакт не введён.
  _inviteGuard = wireFormGuard({
    button:   '#btn-invite-confirm',
    required: [{ sel: '#invite-contact', kind: 'text' }],
  });

  // Пока SMS не подключён — приглашение только по email (или ID): убираем
  // «телефон» из подписи поля и подзаголовка. Плейсхолдер уже email@…,
  // бэкенд по-прежнему принял бы телефон — логику не режем.
  if (!phoneChannelEnabled()) {
    const lbl = q('[data-i18n="members.invite_contact_label"]');
    if (lbl) lbl.setAttribute('data-i18n', 'members.invite_contact_label_email');
    const sub = q('[data-i18n="members.invite_subtitle"]');
    if (sub) { sub.setAttribute('data-i18n', 'members.invite_subtitle_email'); sub.textContent = t('members.invite_subtitle_email'); }
    if (lbl) lbl.textContent = t('members.invite_contact_label_email');
  }

  q('#btn-invite')?.addEventListener('click', () => {
    // Чистим поля от прошлого инвайта и пересчитываем guard, иначе
    // кнопка осталась бы «зелёной» (refresh слушает только input/change).
    if (q('#invite-contact')) q('#invite-contact').value = '';
    if (q('#invite-message')) q('#invite-message').value = '';
    const cnt = q('#invite-message-count');
    if (cnt) cnt.textContent = '0';
    q('#err-invite-contact')?.classList.remove('show');
    q('#err-invite')?.classList.add('hidden');
    _inviteGuard?.refresh();
    openModal('invite-modal');
  });

  // Live-счётчик для invite-message (как в join-modal).
  _inviteMsgEl = q('#invite-message');
  _inviteMsgCnt = q('#invite-message-count');
  _inviteMsgEl?.addEventListener('input', () => {
    if (_inviteMsgCnt) _inviteMsgCnt.textContent = String(_inviteMsgEl.value.length);
  });

  q('#btn-invite-confirm')?.addEventListener('click', async () => {
    const contact = q('#invite-contact')?.value.trim();
    const message = (q('#invite-message')?.value || '').trim();

    q('#err-invite-contact')?.classList.remove('show');
    q('#err-invite')?.classList.add('hidden');

    if (!contact) { setFieldError('err-invite-contact', t('errors.required')); return; }

    const btn = q('#btn-invite-confirm');
    setLoading(btn, true);
    try {
      // Все приглашения вступают как employee — outerside the invite flow,
      // и инвайтить «нового владельца» нельзя. Бэкенд игнорирует second arg.
      await members.invite(contact, message || undefined);
      closeModal('invite-modal');
      toast(t('toasts.invitation_sent'), 'ok');
      if (q('#invite-contact')) q('#invite-contact').value = '';
      if (_inviteMsgEl) _inviteMsgEl.value = '';
      if (_inviteMsgCnt) _inviteMsgCnt.textContent = '0';
      // Обновляем списки: legacy members tab И owner «Ресурсы» (team.js
      // слушает rems:reload-members). Так новый инвайт/приглашённый
      // сотрудник появляется сразу, без перезагрузки страницы.
      loadMembers().catch(() => {});
      window.dispatchEvent(new CustomEvent('rems:reload-members'));
    } catch (err) {
      const errEl = q('#err-invite');
      if (errEl)  { errEl.classList.remove('hidden'); errEl.classList.add('show'); }
      const txt = q('#err-invite-text');
      if (txt)    txt.textContent = errorMessage(err);
    } finally { setLoading(btn, false); }
  });
}
