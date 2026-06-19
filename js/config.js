// frontend/js/config.js
//
// Капабилити-флаги фронта. Источник истины — backend (.env → GET /api/config),
// чтобы фронт и бэк не расходились. Значения по умолчанию БЕЗОПАСНЫЕ (телефон
// скрыт), поэтому даже если /api/config недоступен, нерабочий канал не торчит.
//
// smsEnabled — подключён ли SMS как канал (регистрация/вход/инвайт/привязка).
// Это капабилити по флагу FEATURE_SMS на бэке (НЕ окружение dev/prod): пока
// SMS-провайдера нет, телефонный UI прячется и в dev, и в prod. Бэкенд-логика
// телефона цела — включается флагом FEATURE_SMS=true.

export const FEATURES = {
  email: true,
  sms:   false,
};

let _loaded = null;

/**
 * Один раз подтягивает флаги с backend и обновляет FEATURES. Возвращает
 * промис (идемпотентно). Страницы должны await'ить ДО построения UI,
 * который зависит от флагов (рядом с initI18n).
 */
export function loadFeatures() {
  if (_loaded) return _loaded;
  _loaded = (async () => {
    try {
      const r = await fetch('/api/config', { headers: { Accept: 'application/json' } });
      if (r.ok) {
        const j = await r.json();
        const f = (j && j.features) || {};
        if (typeof f.email === 'boolean') FEATURES.email = f.email;
        if (typeof f.sms === 'boolean')   FEATURES.sms = f.sms;
      }
    } catch { /* безопасный дефолт: телефон остаётся скрытым */ }
    return FEATURES;
  })();
  return _loaded;
}

/** Доступен ли телефон как канал (регистрация/вход/инвайт/привязка). */
export const phoneChannelEnabled = () => FEATURES.sms === true;
