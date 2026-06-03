/* ═══════════════════════════════════════════════════════════════
   REMS — HTTP API client
   All paths are verified against backend/src/index.ts route mounts.

   Route map (backend/src/index.ts):
     /api/auth              ← verification + usersAuth + usersPin
     /api/profile           ← usersProfile
     /api/users/membership  ← usersMembership
     /api/orgs/profile      ← orgsProfile
     /api/orgs/members      ← orgsMembers
     /api/notifications     ← notifications
     /api/upload            ← upload (authenticated)
═══════════════════════════════════════════════════════════════ */

import { getDeviceId, getDeviceIdSync } from './device-id.js';

const API_BASE = '/api';

// ── Core request helper ──────────────────────────────────────────
async function request(method, path, body, opts = {}) {
  const token = localStorage.getItem('rems_token');

  const headers = {};
  if (body !== undefined)  headers['Content-Type'] = 'application/json';
  if (token)               headers['Authorization'] = `Bearer ${token}`;

  // Stable per-device id (random + localStorage). Backend hashes and stores.
  headers['X-Device-Id'] = await getDeviceId();

  if (opts.extraHeaders) Object.assign(headers, opts.extraHeaders);

  const res  = await fetch(API_BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));

  // Token rotation: if the server sends a fresh token, persist it
  if (data?.data?.token) localStorage.setItem('rems_token', data.data.token);

  if (!res.ok) {
    const err      = new Error(data?.message || data?.error_key || 'Request failed');
    err.status     = res.status;
    err.error_key  = data?.error_key;
    err.data       = data;
    // Авто-логаут ТОЛЬКО при session/token/device-ошибках. Прочие 401
    // (invalid_credentials в change-password, code_invalid и т.п.) — это
    // ошибки на конкретной операции, а НЕ протухший сеанс; редирект на
    // login здесь только злил бы юзера.
    if (res.status === 401 && token && !opts.skipAuthRedirect && isSessionError(data?.error_key)) {
      handleUnauthorized();
    }
    throw err;
  }

  return data;
}

const SESSION_ERROR_KEYS = new Set([
  'errors.auth.token_missing',
  'errors.auth.token_expired',
  'errors.auth.token_invalid',
  'errors.auth.session_not_found',
  'errors.auth.session_revoked',
  'errors.auth.session_expired',
  'errors.auth.session_mismatch',
  'errors.auth.device_mismatch',
  'errors.auth.device_fingerprint_missing',
]);
function isSessionError(key) {
  return typeof key === 'string' && SESSION_ERROR_KEYS.has(key);
}

// Single-shot redirect guard: несколько параллельных запросов могут вернуть 401
// одновременно — нам нужен только один редирект.
let _unauthorizedHandled = false;
function handleUnauthorized() {
  if (_unauthorizedHandled) return;
  _unauthorizedHandled = true;
  try { localStorage.removeItem('rems_token'); } catch {}
  const fromPages = location.pathname.toLowerCase().includes('/pages/');
  location.href = (fromPages ? '..' : '.') + '/pages/login.html';
}

// ── Multipart upload (no JSON content-type) ──────────────────────
async function upload(path, formData) {
  const token = localStorage.getItem('rems_token');
  const did   = await getDeviceId();

  const headers = { 'X-Device-Id': did };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res  = await fetch(API_BASE + path, { method: 'POST', headers, body: formData });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err      = new Error(data?.message || data?.error_key || 'Upload failed');
    err.status     = res.status;
    err.error_key  = data?.error_key;
    err.data       = data;
    if (res.status === 401 && token && isSessionError(data?.error_key)) handleUnauthorized();
    throw err;
  }
  return data;
}

// ─────────────────────────────────────────────────────────────────
// AUTH   →  /api/auth/*
// Verification: POST /api/auth/code   { target, type, purpose }
//               POST /api/auth/verify { target, code, purpose }
// Users auth:   POST /api/auth/register, /login, /logout, /accept-invite
// PIN:          POST /api/auth/set-pin, /api/auth/verify-pin
// ─────────────────────────────────────────────────────────────────

/** Detect whether a contact string is an email or a phone number. */
function detectContactType(contact) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) ? 'email' : 'phone';
}

export const auth = {
  /**
   * Request a verification code.
   * Backend contract: POST /api/auth/code { target, type, purpose, organization_id? }.
   * organization_id is sent only on registration into an existing organisation —
   * backend performs eager validity / capacity checks BEFORE issuing the code,
   * so the frontend never advances past step 1 with an invalid org_id.
   */
  sendCode: (contact, purpose = 'register', organizationId = null) => request('POST', '/auth/code', {
    target:  contact,
    type:    detectContactType(contact),
    purpose,
    ...(organizationId != null && { organization_id: organizationId }),
  }),

  /** Verify a code. Backend: POST /api/auth/verify { target, code, purpose }. */
  verifyCode: (contact, code, purpose = 'register') => request('POST', '/auth/verify', {
    target: contact,
    code,
    purpose,
  }),

  register: (payload) => request('POST', '/auth/register', payload),
  /** email can be email or phone — backend checks both. password OR pin required. */
  login: (email, password, pin) => request('POST', '/auth/login', {
    email,
    ...(password != null && { password }),
    ...(pin      != null && { pin }),
  }),
  logout:       ()                  => request('POST', '/auth/logout',        {}),
  acceptInvite: (token, payload)    => request('POST', '/auth/accept-invite', { token, ...payload }),

  /**
   * Forgot-password финальный шаг. Перед этим вызови:
   *   auth.sendCode(contact, 'reset_password')
   * Бэк отвечает 200 даже если контакта нет (anti-enumeration), поэтому
   * UX «отправили код, если адрес зарегистрирован» — нейтральный.
   * payload: { target, code, new_password, new_password_confirm }
   */
  resetPassword: (payload) => request('POST', '/auth/reset-password', payload),

  /** Превью проверки кода на шаге 2 «забыли пароль/PIN». Не консьюмит код. */
  resetVerifyCode: (target, code) => request('POST', '/auth/reset-verify-code', { target, code }),

  /**
   * Forgot-PIN финальный шаг. Тот же purpose='reset_password' для кода —
   * identity-proof одинаков. Ревокает все сессии на успехе.
   * payload: { target, code, new_pin, new_pin_confirm }
   */
  resetPin: (payload) => request('POST', '/auth/reset-pin', payload),
  /** Set or change PIN. payload: { pin, pin_confirm, current_pin? } */
  setPin:       (payload)           => request('POST', '/auth/set-pin',       payload),
  verifyPin:    (pin)               => request('POST', '/auth/verify-pin',    { pin }),
};

// ─────────────────────────────────────────────────────────────────
// USER PROFILE  →  /api/profile/*
// GET  /api/profile/me
// POST /api/profile/change-password
// POST /api/profile/change-email
// POST /api/profile/change-phone
// POST /api/profile/send-code
// POST /api/profile/avatar/confirm
// ─────────────────────────────────────────────────────────────────
export const profile = {
  get:      () => request('GET',   '/profile/me'),
  /** payload: { full_name?, department?, language_code? } */
  update:   (payload) => request('PATCH', '/profile/me', payload),
  sessions: () => request('GET',   '/profile/sessions'),
  /** Отозвать чужую (не текущую) сессию. id из profile.sessions(). */
  revokeSession: (id) => request('DELETE', `/profile/sessions/${encodeURIComponent(id)}`),

  /** payload: { old_password, new_password, new_password_confirm, verification_code, verification_target } */
  changePassword: (payload) => request('POST', '/profile/change-password', payload),

  /** payload: { new_email, verification_code, verification_target } */
  changeEmail: (payload) => request('POST', '/profile/change-email', payload),

  /** payload: { new_phone, verification_code, verification_target } */
  changePhone: (payload) => request('POST', '/profile/change-phone', payload),

  /**
   * Detach (open up) email or phone. The backend supports two proof paths
   * via the optional fields below:
   *   payload: { target_type, verification_code, verification_target } — code path
   *   payload: { target_type, password, current_email, current_phone }  — password fallback
   */
  detachContact: (payload) => request('POST', '/profile/detach-contact', payload),

  /** payload: { target, type: 'email'|'phone', purpose: 'change_password'|'change_email'|'change_phone' } */
  sendCode: (payload) => request('POST', '/profile/send-code', payload),

  /** Confirm a temp upload as the user's avatar. mediaFileId from POST /api/upload/temp response. */
  confirmAvatar: (mediaFileId) => request('POST', '/profile/avatar/confirm', { media_file_id: mediaFileId }),
  deleteAvatar:  ()             => request('DELETE', '/profile/avatar'),
};

// ─────────────────────────────────────────────────────────────────
// MEMBERSHIP  →  /api/users/membership/*
// ─────────────────────────────────────────────────────────────────
export const membership = {
  status:  () => request('GET',  '/users/membership/status'),
  reapply: () => request('POST', '/users/membership/reapply', {}),
  /** Solo-юзер запрашивает membership в орге по ID. message — опционально. */
  join:    (organization_id, message) => request('POST', '/users/membership/join', {
    organization_id,
    ...(message ? { message } : {}),
  }),
  /** Отменить pending-заявку. Юзер возвращается в чистое solo состояние. */
  cancel:  () => request('DELETE', '/users/membership/me'),
  /** Approved-сотрудник покидает свою орг (не для owner). reason — опционально. */
  leave:   (reason) => request('POST', '/users/membership/leave', { ...(reason ? { reason } : {}) }),
  /** Принять / отклонить приглашение от орги (для приглашённого solo). */
  acceptInvitation: () => request('POST', '/users/membership/accept-invitation', {}),
};

// ─────────────────────────────────────────────────────────────────
// ORGANISATION PROFILE  →  /api/orgs/profile/*
// GET   /api/orgs/profile/me
// PATCH /api/orgs/profile/settings  (owner only; body: { organization_name })
// POST  /api/orgs/profile/logo/confirm
// ─────────────────────────────────────────────────────────────────
export const org = {
  getProfile: () => request('GET', '/orgs/profile/me'),

  /** payload: { organization_name } */
  updateSettings: (payload) => request('PATCH', '/orgs/profile/settings', payload),

  /** payload: { internal_sla_critical_h?, internal_sla_high_h?, internal_sla_medium_h?, internal_sla_low_h? }
   *  Permission: owner or manager. */
  updateLimits:   (payload) => request('PATCH', '/orgs/profile/limits', payload),

  /** Confirm a temp upload as the org logo. */
  confirmLogo: (mediaFileId) => request('POST', '/orgs/profile/logo/confirm', { media_file_id: mediaFileId }),
  deleteLogo:  ()             => request('DELETE', '/orgs/profile/logo'),
};

// ─────────────────────────────────────────────────────────────────
// ORGANISATION MEMBERS  →  /api/orgs/members/*
// GET   /api/orgs/members/pending
// POST  /api/orgs/members/invite   body: { contact, requested_role }
// PATCH /api/orgs/members/manage   body: { userId, action }
// ─────────────────────────────────────────────────────────────────
export const members = {
  /** GET full directory: { approved, pending } arrays. */
  list:        () => request('GET', '/orgs/members'),

  /** Owner-only pending queue (legacy modal flow). */
  listPending: () => request('GET', '/orgs/members/pending'),

  /** contact: email, phone, or numeric userId string. Role is always
      employee — the invite endpoint no longer accepts a role param. */
  invite: (contact, message) => request('POST', '/orgs/members/invite', {
    contact,
    ...(message ? { message } : {}),
  }),

  /** action: 'approved'|'rejected'|'suspended'. message — опц. текст
      решения, увидит соискатель в уведомлении. */
  manage: (userId, action, message) =>
    request('PATCH', '/orgs/members/manage', {
      userId, action, ...(message ? { message } : {}),
    }),

  /** Owner-only hard-detach from the org. Marks membership as rejected;
      historical request/audit references stay intact. reason — опц. текст,
      попадёт в уведомление исключённому. */
  remove: (userId, reason) => request('DELETE', `/orgs/members/${userId}`,
    reason ? { reason } : undefined),
};

// ─────────────────────────────────────────────────────────────────
// CONTRACTS  →  /api/orgs/contracts/*
// GET   /api/orgs/contracts                       — { current, terminated }
// POST  /api/orgs/contracts                       — owner предлагает контракт
// PATCH /api/orgs/contracts/:id/respond           — accept | reject (вторая сторона)
// PATCH /api/orgs/contracts/:id                   — edit (требует re-consent)
// POST  /api/orgs/contracts/:id/terminate         — запрос разрыва (с причиной)
// PATCH /api/orgs/contracts/:id/terminate-respond — confirm | decline разрыва
// ─────────────────────────────────────────────────────────────────
export const contracts = {
  /** Списки контрактов организации: { current, terminated }. */
  list: () => request('GET', '/orgs/contracts'),

  /** Быстрая проверка партнёра перед открытием формы создания/правки.
   *  200 → { id, name }; 4xx → корректный error_key (not_found / inactive /
   *  cannot_contract_self / already_exists). */
  checkPartner: (id) => request('GET', `/orgs/contracts/partner-check/${id}`),

  /**
   * Предложить контракт другой организации (owner).
   * payload: {
   *   partner_org_id, my_role:'client'|'contractor', contract_name,
   *   contract_description?, end_date?, contract_doc_media_id?,
   *   sla_critical_response_h?, sla_high_response_h?,
   *   sla_medium_response_h?, sla_low_response_h?
   * }
   */
  create: (payload) => request('POST', '/orgs/contracts', payload),

  /** Принять/отклонить входящий контракт. action: 'accept'|'reject'.
   *  reason — опц. текст для второй стороны. */
  respond: (id, action, reason) =>
    request('PATCH', `/orgs/contracts/${id}/respond`, reason ? { action, reason } : { action }),

  /** Изменить характеристики (owner). Любая правка → повторное согласие. */
  update: (id, payload) => request('PATCH', `/orgs/contracts/${id}`, payload),

  /** Отменить СВОЙ pending-запрос (новую заявку или редактирование).
   *  reason — опц. текст для второй стороны. */
  cancel: (id, reason) =>
    request('DELETE', `/orgs/contracts/${id}`, reason ? { reason } : undefined),

  /** Запросить разрыв с причиной (owner). */
  terminate: (id, reason) => request('POST', `/orgs/contracts/${id}/terminate`, reason ? { reason } : {}),

  /** Ответить на запрос разрыва. action: 'confirm'|'decline'. */
  terminateRespond: (id, action) => request('PATCH', `/orgs/contracts/${id}/terminate-respond`, { action }),

  /** Инициатор отзывает СВОЙ запрос разрыва (paused → active). */
  terminateCancel: (id) => request('DELETE', `/orgs/contracts/${id}/terminate-request`),
};

// ─────────────────────────────────────────────────────────────────
// NOTIFICATIONS  →  /api/notifications
// GET   /api/notifications
// PATCH /api/notifications/:id/read   (one at a time)
// ─────────────────────────────────────────────────────────────────
export const notifications = {
  getAll: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request('GET', `/notifications${qs ? '?' + qs : ''}`);
  },

  /** Mark a single notification as read (idempotent). */
  markRead:   (id) => request('PATCH', `/notifications/${id}/read`),

  /** Mark a single notification as unread again (resets read_at). */
  markUnread: (id) => request('PATCH', `/notifications/${id}/unread`),

  /**
   * Mark ALL of the user's unread notifications as read in one
   * backend round-trip. Replaces the previous Promise.all-of-N-PATCH
   * approach; the server now owns the bulk transition. Resolves to
   * `{ marked_count }`.
   */
  markAllRead: () => request('PATCH', `/notifications/mark-all-read`),
};

// ─────────────────────────────────────────────────────────────────
// UPLOAD  →  /api/upload/*
// POST   /api/upload/temp           (multipart; requires auth)
// GET    /api/upload/:id/file       (serve private file)
// DELETE /api/upload/:id
//
// entity_type values:
//   'user' | 'organization' | 'equipment' | 'request_attachments'
//   'fault_category' | 'equipment_category'
// ─────────────────────────────────────────────────────────────────
export const media = {
  /**
   * Upload a file to the temp folder.
   * Returns { data: { media_file_id, preview_url, mime_type, width?, height?, ... } }
   */
  uploadTemp: (file, entityType = 'user') => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('entity_type', entityType);
    return upload('/upload/temp', fd);
  },

  /** Delete a media file by ID. */
  delete: (mediaFileId) => request('DELETE', `/upload/${mediaFileId}`),

  /** Build URL for a private file served via the authenticated endpoint. */
  privateUrl: (mediaFileId) => `${API_BASE}/upload/${mediaFileId}/file`,

  /**
   * Открыть приватный медиафайл в новой вкладке. Эндпоинт защищён
   * `authenticateToken` — обычный `<a href>` не положит Bearer-заголовок
   * и получит 401. Здесь сами fetch'им с auth, делаем blob URL и
   * открываем его в новом окне.
   */
  openPrivate: async (mediaFileId) => {
    const token = localStorage.getItem('rems_token');
    const did   = await getDeviceId();
    const headers = { 'X-Device-Id': did };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}/upload/${mediaFileId}/file`, { headers });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err  = new Error(body?.error_key || `HTTP ${res.status}`);
      err.error_key = body?.error_key;
      err.status    = res.status;
      throw err;
    }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    // Освобождаем blob чуть позже — браузер уже взял ссылку.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
};

// ─────────────────────────────────────────────────────────────────
// Convenience helpers (re-exported for consumers that don't need all modules)
// ─────────────────────────────────────────────────────────────────
export const isLoggedIn  = ()  => !!localStorage.getItem('rems_token');
export const clearSession = () => localStorage.removeItem('rems_token');
export { getDeviceId, getDeviceIdSync };
