**Languages**: [English](README.md) | [Русский](README.ru.md)

# REMS-desk — Фронтенд (клиент)

Веб-клиент **REMS-desk** — системы учёта заявок на ремонт и обслуживание
оргтехники. Это приложение на **чистом JavaScript (ES-модули) без сборщика и без
зависимостей** + HTML + CSS. Одни и те же статические файлы обслуживают и
маркетинговый лендинг, и ролевой дашборд (руководитель / сотрудник / одиночка).
В проде файлы раздаёт сам [бэкенд](https://github.com/ENEIZEM/REMS-desk-core)
(Express `express.static`), поэтому **отдельного хостинга фронта нет**.

- Сайт: https://rems-desk.ru
- Репозиторий бэкенда (API + БД + раздаёт этот клиент): https://github.com/ENEIZEM/REMS-desk-core

---

## Оглавление
- [Для обычных пользователей](#для-обычных-пользователей)
- [Для разработчиков](#для-разработчиков)
- [Для администратора](#для-администратора-меня)
- [Принципы разработки](#принципы-разработки)
- [Сторонние ресурсы и библиотеки](#сторонние-ресурсы-и-библиотеки)
- [Запуск и тестирование](#запуск-и-тестирование)
- [Полный разбор файлов и папок](#полный-разбор-файлов-и-папок)

---

## Для обычных пользователей

REMS-desk помогает организации вести процесс ремонта техники от заявки до закрытия:

- **Регистрация / вход** по email (SMS реализован, но скрыт флагом), 6-значный
  код подтверждения, пароль и 6-значный PIN (спрашивается при возврате).
- **Три роли**, определяются автоматически:
  - **Руководитель** — управляет организацией, сотрудниками, каталогом техники,
    контрактами с партнёрами и видит все заявки.
  - **Сотрудник** — работает с заявками, видит каталог техники и коллег.
  - **Одиночка** — пользователь без организации; может запросить членство или
    принять приглашение.
- **Заявки** — создание, взятие в работу, ведение и закрытие; приоритеты,
  два срока SLA (реакция + устранение), дорожная карта статусов, вложения.
- **Каталог** — учёт техники с фото, категориями, прогрессом гарантии.
- **Партнёры / контракты** — руководитель заводит межорганизационные контракты
  со своей матрицей SLA и документом контракта.
- **Уведомления** — лента в приложении, угловые тосты, звук и (опционально)
  системные уведомления ОС/браузера, когда вкладка в фоне.
- **Языки** — полный русский / английский интерфейс, переключается в любой момент.
- **Приватность** — никаких трекинг-cookie; только `localStorage` (токен сессии,
  язык, флаги UI). На лендинге об этом сообщает разовый тост.

## Для разработчиков

**Стек:** чистые ES-модули (без сборки и фреймворка), CSS-переменные, `fetch`,
WebSocket через Socket.IO, `Intl` для i18n.

**Раздача и борьба с кешем.** Каждая страница — обычный HTML. Бэкенд раздаёт эти
файлы и в dev переписывает локальные `src`/`href` на `?v=BOOT_ID` (свой на каждый
запуск) + вкидывает «убийцу» service-worker'ов. HTML-партиалы собираются на
сервере через `<!--#include "...">` (см. `pages/partials`).

**Страницы.**
- [index.html](index.html) — лендинг (герой + анимация Vanta, живое превью
  дашборда, секции фич/статистики/футер, тост про куки).
- [pages/login.html](pages/login.html), [pages/register.html](pages/register.html) — вход/регистрация.
- [pages/dashboard.html](pages/dashboard.html) — оболочка SPA-дашборда: панели
  вкладок + chrome (навбар, сайдбар→нижний навбар на мобиле, модалки).

**Архитектура JS.** Точки входа по страницам (`js/pages/*.js`). Дашборд стартует
из [js/pages/dashboard/index.js](js/pages/dashboard/index.js): подключает chrome
и делегирует **роль-роутеру**, который монтирует нужный дашборд (руководитель /
сотрудник / одиночка). Общие задачи — в маленьких узкоспециализированных модулях
с внедрением зависимостей (например, `switchTab` передаётся в chrome-модули, а не
импортируется глобально).

**Сеть.** [js/api.js](js/api.js) — типизированная обёртка REST,
[js/auth.js](js/auth.js) — токен сессии / выход, [js/socket.js](js/socket.js) —
realtime-канал. Все URL относительные → клиент работает на любом origin.

**i18n.** [js/i18n.js](js/i18n.js) грузит [locales/ru.json](locales/ru.json) /
[locales/en.json](locales/en.json), переводит атрибуты `data-i18n*` и даёт `t()`,
`setLang()`, `onLangChange()`. Ключи ошибок бэка 1:1 совпадают со структурой
локалей, поэтому `t(error_key)` резолвится напрямую.

**Адаптивность.** Текучий chrome почти без брейкпоинтов (см.
[css/chrome.css](css/chrome.css) и [css/responsive.css](css/responsive.css)):
поля навбара/контента сужаются симметрично; ниже 768px сайдбар становится нижним
навбаром, шапка — как на лендинге, уведомления — в модалке.

## Для администратора (меня)

- **Хостинг:** один сервис Railway на весь репозиторий — бэкенд собирается,
  запускается и раздаёт эту папку `frontend/` как статику. **Отдельного
  статик-хоста нет.** Настройка Railway — в README бэкенда.
- **Единственный деплой-переключатель, влияющий на клиент** — публичный адрес
  (`FRONTEND_URL` на бэке): указать `https://rems-desk.ru`. Сам клиент править не
  нужно — все его URL относительные.
- **Капабилити-флаги** ([js/config.js](js/config.js)) приходят с бэка
  (`GET /api/config`). `sms:false` прячет телефонный UI; `email:true` включает
  реальные письма. Безопасные дефолты прячут неготовые каналы даже если конфиг
  не загрузился.
- **Бренд / доставляемость писем**, настроенные снаружи:
  [bimi/logo-bimi.svg](bimi/logo-bimi.svg) (логотип BIMI рядом с письмами) и
  [assets/og-image.png](assets/og-image.png) (превью при шаринге).

## Принципы разработки

- **Без сборки и зависимостей.** Исходники как есть; браузер исполняет ES-модули
  напрямую. Клиент легко аудировать и хостить где угодно.
- **Модульность / атомарность.** Много маленьких файлов с одной ответственностью;
  композиция вместо наследования; зависимости передаются (DI), а не берутся
  глобально.
- **CSS-манифест.** [style.css](style.css) — тонкий манифест с `@import` файлов из
  [css/](css/); токены дизайна — в [css/tokens.css](css/tokens.css) (CSS-переменные),
  никаких хардкод-цветов/отступов в компонентах.
- **Серверные HTML-инклюды.** Страницы собираются из партиалов через
  `<!--#include-->`, разворачивает бэкенд — один готовый документ, без клиентского
  движка шаблонов.
- **Капабилити-флаги, а не проверки окружения.** Доступность фич — по явным
  флагам с бэка, никогда не по `dev`/`prod`.
- **Stateless-клиент, дружелюбный к RLS.** Клиент хранит только JWT; вся
  авторизация — на сервере (PostgreSQL Row-Level Security).

## Сторонние ресурсы и библиотеки

| Что | Откуда | Зачем | Файлы |
|-----|--------|-------|-------|
| **Phosphor Icons** | self-hosted (без CDN), https://phosphoricons.com | все иконки UI (`<i class="ph ...">`) | [vendor/phosphor/](vendor/phosphor/) |
| **Vanta.js WAVES** + **three.js** | self-hosted, https://www.vantajs.com / https://threejs.org | анимация фона героя на лендинге | [vendor/](vendor/) (`vanta.waves.min.js`, `three.min.js`) |
| Шрифт **Onest** | self-hosted, https://github.com/Solbera-Lab/Onest | фирменная типографика | [fonts/onest.css](fonts/onest.css) + файлы шрифта |
| **Socket.IO client** | отдаёт бэкенд по `/socket.io/socket.io.js` | realtime-уведомления | подключается в `pages/dashboard.html` |

Всё **self-hosted** — приложение работает без внешних CDN.

## Запуск и тестирование

Клиент раздаётся бэкендом, поэтому штатный способ запуска — поднять бэкенд (он
раздаёт `../frontend`). См. README бэкенда (`npm run dev`). Отдельной сборки или
тестов у клиента нет (нет сборщика и фреймворка). Чисто статику можно отдать любым
static-сервером, но без бэкенда API-вызовы работать не будут.

## Полный разбор файлов и папок

### Корень
| Путь | Назначение |
|------|------------|
| [index.html](index.html) | Лендинг (герой, анимация Vanta, превью дашборда, фичи, статистика, футер, тост про куки). Здесь же **SEO `<head>`**: title/description/keywords/canonical, Open Graph + Twitter, Schema.org JSON-LD. |
| [style.css](style.css) | CSS-манифест — `@import` всех файлов из `css/`. |
| [sitemap.xml](sitemap.xml) | Карта сайта для поисковиков (главная + вход/регистрация; приватные/авторизованные страницы исключены). Отдаётся по `/sitemap.xml`. |
| [robots.txt](robots.txt) | Правила краулеров — разрешить публичные страницы, запретить `/api/`, дашборд, uploads; ссылка на sitemap. Отдаётся по `/robots.txt`. |
| [README.md](README.md) / [README.ru.md](README.ru.md) | Эта документация (EN / RU). |
| [LICENSE](LICENSE) | Лицензия. |

> **Про SEO:** код делает сайт индексируемым. Чтобы реально появиться в выдаче,
> один раз зарегистрируй домен в Google Search Console, Яндекс.Вебмастере и Bing
> Webmaster Tools и отправь `sitemap.xml`.

### [assets/](assets/) — бренд и PWA
| Файл | Назначение |
|------|------------|
| [logo.svg](assets/logo.svg) | Основной знак. |
| [logo-full.svg](assets/logo-full.svg) | Полный знак (навбар на ПК). |
| [logo-compact.svg](assets/logo-compact.svg) | Компактный знак (навбар на мобиле/узких). |
| [logo-icon.svg](assets/logo-icon.svg) | Только квадратная иконка-бейдж. |
| [favicon.ico](assets/favicon.ico), [favicon.svg](assets/favicon.svg), [favicon-16x16.png](assets/favicon-16x16.png), [favicon-32x32.png](assets/favicon-32x32.png) | Фавиконки. |
| [apple-touch-icon.png](assets/apple-touch-icon.png), [android-chrome-192x192.png](assets/android-chrome-192x192.png), [android-chrome-512x512.png](assets/android-chrome-512x512.png) | Иконки PWA/мобилы (и для системных уведомлений). |
| [site.webmanifest](assets/site.webmanifest) | Манифест PWA. |
| [og-image.png](assets/og-image.png) | Превью для соцсетей / Open Graph. |

### [bimi/](bimi/)
| Файл | Назначение |
|------|------------|
| [logo-bimi.svg](bimi/logo-bimi.svg) | Логотип по спецификации BIMI — отображение знака рядом с письмами (DNS/Cloudflare настроены снаружи). |

### [css/](css/) — стили (импортируются `style.css`)
| Файл | Назначение |
|------|------------|
| [tokens.css](css/tokens.css) | Токены дизайна — CSS-переменные цвета/отступов/радиусов/типографики. |
| [base.css](css/base.css) | Сбросы и базовые стили элементов. |
| [buttons.css](css/buttons.css) | Система кнопок (варианты, иконки-кнопки). |
| [forms.css](css/forms.css) | Поля ввода, селекты, состояния валидации. |
| [components.css](css/components.css) | Общие компоненты (карточки, бейджи, чипы, аватары). |
| [chrome.css](css/chrome.css) | Chrome приложения — текучий навбар, сайдбар, поля контента, scrim. |
| [nav.css](css/nav.css) | Навигация / пункты сайдбара. |
| [modal.css](css/modal.css) | Модальные окна и подложки. |
| [feedback.css](css/feedback.css) | Тосты и скелетоны. |
| [notifications.css](css/notifications.css) | Лента уведомлений и угловые карточки-тосты. |
| [profile.css](css/profile.css) | Вкладки профиля/организации, list-fill блоки, лента заявок, пикеры, подсказки. |
| [auth.css](css/auth.css) | Экраны входа / регистрации / PIN-lock. |
| [landing.css](css/landing.css) | Секции лендинга (текст героя, фичи, футер, мобильное превью). |
| [empty-state.css](css/empty-state.css) | Иллюстрации пустых состояний. |
| [misc.css](css/misc.css) | Переключатель языка и мелочи. |
| [responsive.css](css/responsive.css) | Все адаптивные правила, вкл. мобильную навигацию дашборда, под-фильтры заявок, роль-видимость. |

### [fonts/](fonts/)
| Файл | Назначение |
|------|------------|
| [onest.css](fonts/onest.css) | `@font-face` для self-hosted шрифта Onest (+ файлы шрифта рядом). |

### [vendor/](vendor/) — self-hosted сторонние библиотеки
| Путь | Назначение |
|------|------------|
| [vendor/phosphor/](vendor/phosphor/) | CSS Phosphor Icons (`regular`, `bold`, `fill`, `duotone`) + веб-шрифты. |
| `vendor/three.min.js`, `vendor/vanta.waves.min.js` | three.js + Vanta WAVES для анимации героя. |

### [locales/](locales/)
| Файл | Назначение |
|------|------------|
| [ru.json](locales/ru.json) / [en.json](locales/en.json) | Все строки UI + переводы ключей ошибок бэка (структура совпадает с `error_key`). |

### [sounds/](sounds/)
| Файл | Назначение |
|------|------------|
| [notification.mp3](sounds/notification.mp3) | Звук уведомления (праймится на первом жесте — политика автоплея). |

### [pages/](pages/) — HTML, кроме лендинга
| Файл | Назначение |
|------|------------|
| [dashboard.html](pages/dashboard.html) | Оболочка дашборда: пред-paint лоадер, PIN-lock, навбар, сайдбар, все панели вкладок, инклюды модалок. |
| [login.html](pages/login.html) | Вход (+ сброс пароля/PIN). |
| [register.html](pages/register.html) | Пошаговая регистрация. |

### [pages/partials/dashboard/](pages/partials/dashboard/) — серверные фрагменты
| Файл | Назначение |
|------|------------|
| [account.html](pages/partials/dashboard/account.html) | Разметка раздела аккаунта. |
| [contacts.html](pages/partials/dashboard/contacts.html) | Модалки смены контактов. |
| [contracts.html](pages/partials/dashboard/contracts.html) | Модалки контрактов (создать/просмотр/правка). |
| [equipment.html](pages/partials/dashboard/equipment.html) | Модалки техники (создать/правка/фото). |
| [members.html](pages/partials/dashboard/members.html) | Управление участниками / приглашения. |
| [membership.html](pages/partials/dashboard/membership.html) | Модалки вступления / выхода / приглашений. |
| [requests.html](pages/partials/dashboard/requests.html) | Модалки заявок (создать/детали/дорожная карта). |
| [sessions.html](pages/partials/dashboard/sessions.html) | Разметка активных сессий. |

### [js/](js/) — модули верхнего уровня
| Файл | Назначение |
|------|------------|
| [api.js](js/api.js) | REST-клиент — по методу на группу эндпоинтов; относительные URL. |
| [auth.js](js/auth.js) | Хранение токена сессии, `logout()`, тост-хелпер, маппинг ошибок. |
| [config.js](js/config.js) | Капабилити-флаги (`email`/`sms`) из `GET /api/config`. |
| [i18n.js](js/i18n.js) | Загрузка локалей, `t()`, `setLang()`, обвязка переключателя, перевод DOM. |
| [socket.js](js/socket.js) | Подключение Socket.IO + хендшейк авторизации для realtime. |
| [device-id.js](js/device-id.js) | Стабильный id устройства (random, `localStorage`) — без фингерпринтинга и CDN. |
| [form-guard.js](js/form-guard.js) | Защита от повторной отправки форм. |
| [media-attach.js](js/media-attach.js) | Общий виджет прикрепления файлов (temp-upload → confirm). |

### [js/lib/](js/lib/) — переиспользуемые примитивы UI
| Файл | Назначение |
|------|------------|
| [char-counter.js](js/lib/char-counter.js) | Счётчики символов под полями модалок. |
| [code-input.js](js/lib/code-input.js) | Сегментированный ввод кода подтверждения. |
| [doc-preview.js](js/lib/doc-preview.js) | Плитка-превью документа/файла. |
| [lazy-loader.js](js/lib/lazy-loader.js) | Навешивает loading/error UI на асинхронные загрузчики. |
| [media-viewer.js](js/lib/media-viewer.js) | Полноэкранный просмотр изображений. |
| [page-loader.js](js/lib/page-loader.js) | Управление пред-paint лоадером. |
| [pin-gate.js](js/lib/pin-gate.js) | Разовый пропуск PIN (сразу после входа/регистрации). |

### [js/pages/](js/pages/) — точки входа страниц
| Файл | Назначение |
|------|------------|
| [login.js](js/pages/login.js) | Логика входа + сбросы. |
| [register.js](js/pages/register.js) | Пошаговая регистрация (вкл. повторное предъявление кода). |

### [js/pages/dashboard/](js/pages/dashboard/) — ядро дашборда
| Файл | Назначение |
|------|------------|
| [index.js](js/pages/dashboard/index.js) | Старт дашборда: гейт auth/PIN, переключение вкладок, обвязка chrome, socket-события. |
| [role-router.js](js/pages/dashboard/role-router.js) | Определяет роль и монтирует нужный дашборд. |
| [notifications.js](js/pages/dashboard/notifications.js) | Состояние уведомлений, рендер ленты, угловые тосты, звук, OS-уведомления. |
| [members.js](js/pages/dashboard/members.js) | Логика вкладки участников (список, ожидающие, одобрить/отклонить, приглашение). |
| [sessions.js](js/pages/dashboard/sessions.js) | Список активных сессий + отзыв. |
| [pin-lock.js](js/pages/dashboard/pin-lock.js) | Оверлей PIN-lock при возврате. |
| [format.js](js/pages/dashboard/format.js) | Хелперы форматирования (даты, инициалы, аватары, лейблы ролей). |
| [badges.js](js/pages/dashboard/badges.js) | Хелперы бейджей статуса/роли. |
| [dom-utils.js](js/pages/dashboard/dom-utils.js) | `q()` и мелкие DOM-хелперы. |
| [ui-helpers.js](js/pages/dashboard/ui-helpers.js) | Открытие/закрытие модалок, вставка лангсвитчера в модалки. |

### [js/pages/dashboard/chrome/](js/pages/dashboard/chrome/) — части оболочки
| Файл | Назначение |
|------|------------|
| [sidebar.js](js/pages/dashboard/chrome/sidebar.js) | Тоггл сайдбара, авто-сворот на узких, scrim. |
| [user-dropdown.js](js/pages/dashboard/chrome/user-dropdown.js) | Меню аватара; профиль/орг/выход (вкл. выход внизу профиля). |
| [notifications-button.js](js/pages/dashboard/chrome/notifications-button.js) | Колокольчик → модалка уведомлений (мобила) / обзор (ПК); запрос OS-разрешения. |
| [subfilter-wrap.js](js/pages/dashboard/chrome/subfilter-wrap.js) | Помечает перенесённые группы под-фильтров, чтобы убрать ведущий сепаратор. |

### [js/pages/dashboard/dashboards/_shared/](js/pages/dashboard/dashboards/_shared/) — кросс-ролевое
| Файл | Назначение |
|------|------------|
| [requests.js](js/pages/dashboard/dashboards/_shared/requests.js) | Лента заявок: загрузка, фильтр, сегмент, рендер, дорожная карта. |
| [requests-ui.js](js/pages/dashboard/dashboards/_shared/requests-ui.js) | Рендер карточки/чипа/SLA заявки. |
| [equipment.js](js/pages/dashboard/dashboards/_shared/equipment.js) | Данные техники + логика каталога. |
| [equipment-ui.js](js/pages/dashboard/dashboards/_shared/equipment-ui.js) | Рендер карточки/статуса техники. |
| [contracts-ui.js](js/pages/dashboard/dashboards/_shared/contracts-ui.js) | Рендер карточки/матрицы SLA контракта. |
| [role-helpers.js](js/pages/dashboard/dashboards/_shared/role-helpers.js) | Хелперы `show()`/`hide()`/`remove()` роль-видимости. |

### [js/pages/dashboard/dashboards/owner/](js/pages/dashboard/dashboards/owner/)
| Файл | Назначение |
|------|------------|
| [index.js](js/pages/dashboard/dashboards/owner/index.js) | Оркестратор руководителя. |
| [overview.js](js/pages/dashboard/dashboards/owner/overview.js) | Обзор руководителя (плитки, под-фильтры, рабочая зона заявок). |
| [requests.js](js/pages/dashboard/dashboards/owner/requests.js) | Вкладка заявок руководителя. |
| [catalog.js](js/pages/dashboard/dashboards/owner/catalog.js) | Каталог техники (CRUD). |
| [partners.js](js/pages/dashboard/dashboards/owner/partners.js) | Вкладка партнёров/контрактов. |
| [contracts.js](js/pages/dashboard/dashboards/owner/contracts.js) | Модалки создания/правки контракта. |
| [team.js](js/pages/dashboard/dashboards/owner/team.js) | Управление сотрудниками. |

### [js/pages/dashboard/dashboards/employee/](js/pages/dashboard/dashboards/employee/)
| Файл | Назначение |
|------|------------|
| [index.js](js/pages/dashboard/dashboards/employee/index.js) | Оркестратор сотрудника. |
| [overview.js](js/pages/dashboard/dashboards/employee/overview.js) | Обзор сотрудника (членство, личная статистика, выход из орг). |
| [requests.js](js/pages/dashboard/dashboards/employee/requests.js) | Вкладка заявок сотрудника (лента + уведомления). |
| [catalog.js](js/pages/dashboard/dashboards/employee/catalog.js) | Каталог техники (только чтение). |
| [contracts.js](js/pages/dashboard/dashboards/employee/contracts.js) | Контракты (только чтение). |
| [team.js](js/pages/dashboard/dashboards/employee/team.js) | Список коллег. |

### [js/pages/dashboard/dashboards/solo/](js/pages/dashboard/dashboards/solo/)
| Файл | Назначение |
|------|------------|
| [index.js](js/pages/dashboard/dashboards/solo/index.js) | Оркестратор одиночки. |
| [home.js](js/pages/dashboard/dashboards/solo/home.js) | Главная одиночки (запрос членства / приём приглашения / уведомления). |
| [join-modal.js](js/pages/dashboard/dashboards/solo/join-modal.js) | Модалка вступления в организацию. |

### [js/pages/dashboard/modals/](js/pages/dashboard/modals/)
| Файл | Назначение |
|------|------------|
| [change-password.js](js/pages/dashboard/modals/change-password.js) | Смена пароля. |
| [change-pin.js](js/pages/dashboard/modals/change-pin.js) | Смена PIN. |
| [change-contact.js](js/pages/dashboard/modals/change-contact.js) | Смена email/телефона. |
| [detach-contact.js](js/pages/dashboard/modals/detach-contact.js) | Отвязка контактного канала. |
| [field-edit.js](js/pages/dashboard/modals/field-edit.js) | Универсальная модалка правки одного поля. |

### [js/pages/dashboard/tabs/](js/pages/dashboard/tabs/)
| Файл | Назначение |
|------|------------|
| [profile.js](js/pages/dashboard/tabs/profile.js) | Рендер вкладки личного профиля. |
| [organization.js](js/pages/dashboard/tabs/organization.js) | Вкладка организации (инфо, матрица SLA, лимиты). |
