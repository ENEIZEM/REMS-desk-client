/* ═══════════════════════════════════════════════════════════════
   REMS — i18n module
   Translations live in /locales/{lang}.json
   Usage:
     import { t, setLang, getLang, initI18n } from './i18n.js';
     await initI18n();
     t('auth.login.title')  → "Вход в систему"
   ═══════════════════════════════════════════════════════════════ */

const LS_LANG       = 'rems_lang';
const SUPPORTED     = ['ru', 'en'];
const DEFAULT_LANG  = 'ru';

// ── State ─────────────────────────────────────────────────────────
let _lang  = SUPPORTED.includes(localStorage.getItem(LS_LANG) ?? '')
  ? localStorage.getItem(LS_LANG)
  : DEFAULT_LANG;

let _data  = {};                     // active translations object
const _cache     = {};               // lang → parsed JSON
const _listeners = new Set();        // onLangChange callbacks

// ── Fetch one locale file, cache result ───────────────────────────
// Never throws — on any network/parse/timeout error returns {} so the
// page still works (keys are used as fallback labels).
async function fetchLang(lang) {
  if (_cache[lang]) return _cache[lang];
  try {
    const ctrl    = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 4000);   // 4 s max
    let res;
    try {
      res = await fetch(`/locales/${lang}.json`, { signal: ctrl.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _cache[lang] = data;
    return data;
  } catch (e) {
    console.warn(`[i18n] Could not load /locales/${lang}.json — ${e.message}`);
    _cache[lang] = {};   // cache empty so we don't retry every call
    return {};
  }
}

// ── Deep-get by dot path ──────────────────────────────────────────
function deepGet(obj, path) {
  return path.split('.').reduce((cur, key) => (cur != null ? cur[key] : undefined), obj);
}

// ─────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────

/** Get current language code ('ru' | 'en') */
export function getLang() { return _lang; }

/**
 * Translate a dot-notation key.
 *
 * Two modes:
 *   t('common.save')                                  → "Сохранить"
 *   t('notifications.types.new_session', { ua: ... }) → interpolates
 *     {{ua}}, {{any.path}} etc. against the data object. Missing
 *     placeholders are left as-is so they're easy to spot in the UI.
 *
 * Falls back to the key string itself if the key is missing from the
 * locale bundle.
 */
export function t(key, data) {
  const val = deepGet(_data, key);
  const tmpl = typeof val === 'string' ? val : key;
  if (!data) return tmpl;
  // Replace every `{{path.to.field}}` with deepGet(data, path.to.field).
  // Unknown paths leave the placeholder untouched (helpful for debug
  // and so the developer can spot a missing key right in the UI).
  return tmpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const v = deepGet(data, path);
    return v === undefined || v === null ? `{{${path}}}` : String(v);
  });
}

/** Subscribe to language changes. Returns unsubscribe fn. */
export function onLangChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/**
 * Change active language, persist preference, re-translate DOM.
 * Safe to call multiple times with the same lang (no-op).
 */
export async function setLang(lang) {
  if (!SUPPORTED.includes(lang)) return;
  if (lang === _lang && Object.keys(_data).length) return;

  _data = await fetchLang(lang);
  _lang = lang;
  localStorage.setItem(LS_LANG, lang);
  // Синхронизируем <html lang> — от него зависит локаль НАТИВНЫХ виджетов
  // (формат и плейсхолдер <input type="date">, календарь-пикер). Без этого
  // дата в модалках оставалась в исходной локали при переключении языка.
  try { document.documentElement.lang = lang; } catch {}

  applyTranslations();
  _updateSwitcher();
  _listeners.forEach(fn => fn(lang));
}

/**
 * Initialise i18n: fetch current language, translate DOM, wire up switcher.
 * Call once at the top of each page (top-level await in ES module).
 */
export async function initI18n() {
  _data = await fetchLang(_lang);
  try { document.documentElement.lang = _lang; } catch {}
  applyTranslations();
  _updateSwitcher();

  // Wire language-switcher buttons (delegated — works even if buttons
  // appear after initI18n() is called)
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.lang-btn[data-lang]');
    if (!btn) return;
    await setLang(btn.dataset.lang);
  });
}

/**
 * Apply translations to all elements with data-i18n* attributes.
 *   data-i18n          → element.textContent
 *   data-i18n-ph       → input.placeholder
 *   data-i18n-title    → element.title
 *   data-i18n-aria     → element.ariaLabel
 */
export function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    el.placeholder = t(el.getAttribute('data-i18n-ph'));
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.getAttribute('data-i18n-title'));
  });
  document.querySelectorAll('[data-i18n-aria]').forEach(el => {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
  });
  // data-tooltip-key → data-tooltip-text (CSS .profile-card-tooltip::after
  // читает data-tooltip-text). Делаем здесь, чтобы подсказки в динамически
  // перерисованных блоках (team/equipment/contracts, ре-маунты) получали
  // текст и единый стиль, а не только при первой загрузке профиля.
  document.querySelectorAll('[data-tooltip-key]').forEach(el => {
    el.setAttribute('data-tooltip-text', t(el.getAttribute('data-tooltip-key')));
  });
}

function _updateSwitcher() {
  document.querySelectorAll('.lang-btn[data-lang]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === _lang);
  });
}

// API error → i18n string
//
// Backend emits error_key values that mirror the structure of the locale
// JSON files (e.g. 'errors.auth.invalid_credentials'). We just call t(key)
// directly. If the key is not in the locale, t() returns the key itself —
// in that case fall back to the server-side message or a generic error.
export function apiError(err) {
  if (!err) return t('errors.server_error');
  const key = err?.error_key;
  if (!key) return err?.message || t('errors.server_error');
  const translated = t(key);
  return translated !== key ? translated : (err?.message || t('errors.server_error'));
}
