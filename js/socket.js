/* ═══════════════════════════════════════════════════════════════
   REMS — Socket.IO client module
   Connects with JWT + device-id auth.
   Emits two events to listeners registered via on():
     • 'user:notification' — personal notification for this user
     • 'org:notification'  — broadcast to the whole organisation

   Usage:
     import { connectSocket, on } from '../js/socket.js';
     await connectSocket();
     on('org:notification', payload => { ... refetch members ... });
═══════════════════════════════════════════════════════════════ */

import { getDeviceId } from './device-id.js';

let _socket  = null;
const _buses = {};   // event name → Set of handler functions

// ── Internal event bus ───────────────────────────────────────────
function _emit(event, data) {
  (_buses[event] || new Set()).forEach(fn => {
    try { fn(data); } catch (e) { console.error('[socket] handler error', e); }
  });
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Connect to the Socket.IO server.
 * Idempotent — calling multiple times is safe.
 * Returns the socket or null if no token is available.
 */
export async function connectSocket() {
  if (_socket?.connected) return _socket;

  const token = localStorage.getItem('rems_token');
  if (!token) return null;

  const did = await getDeviceId();

  // io() is provided by the Socket.IO CDN script in the HTML head.
  // Connecting to same origin (no URL needed).
  _socket = io({
    auth: {
      token,
      device_id: did,
    },
    transports: ['websocket', 'polling'],
    reconnectionAttempts: 5,
    reconnectionDelay:    2000,
  });

  _socket.on('connect', () => {
    console.log('[socket] connected:', _socket.id);
  });

  _socket.on('user:notification', (payload) => {
    console.log('[socket] user:notification', payload);
    _emit('user:notification', payload);
  });

  _socket.on('org:notification', (payload) => {
    console.log('[socket] org:notification', payload);
    _emit('org:notification', payload);
  });

  // Live-синхронизация реестра техники (см. emitEquipmentChange на бэке).
  _socket.on('equipment:changed', (payload) => {
    _emit('equipment:changed', payload);
  });

  // Live-синхронизация ленты заявок.
  _socket.on('requests:changed', (payload) => {
    _emit('requests:changed', payload);
  });

  _socket.on('connect_error', (err) => {
    // DEVICE_MISMATCH / SESSION_REVOKED → force logout
    if (['DEVICE_MISMATCH', 'SESSION_REVOKED', 'SESSION_EXPIRED'].includes(err.message)) {
      console.warn('[socket] auth rejected:', err.message);
      _emit('auth:error', err.message);
    } else {
      console.warn('[socket] connect_error:', err.message);
    }
  });

  _socket.on('disconnect', (reason) => {
    console.log('[socket] disconnected:', reason);
  });

  return _socket;
}

/** Disconnect and clean up. */
export function disconnectSocket() {
  if (_socket) {
    _socket.disconnect();
    _socket = null;
  }
}

/**
 * Subscribe to a socket event.
 * Returns an unsubscribe function.
 *
 * @param {'user:notification' | 'org:notification' | 'auth:error'} event
 * @param {Function} handler
 */
export function on(event, handler) {
  if (!_buses[event]) _buses[event] = new Set();
  _buses[event].add(handler);
  return () => off(event, handler);
}

/** Unsubscribe a specific handler. */
export function off(event, handler) {
  _buses[event]?.delete(handler);
}

/** True if currently connected. */
export function isConnected() {
  return !!_socket?.connected;
}
