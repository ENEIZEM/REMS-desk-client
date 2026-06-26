**Languages**: English | [Русский](README.ru.md)

# REMS-desk — Frontend (client)

Web client for **REMS-desk**, a system for tracking office-equipment repair &
maintenance requests. It is a **dependency-free, no-bundler** vanilla
JavaScript (ES modules) + HTML + CSS application. The same static files power
the marketing landing page and the role-based dashboard (owner / employee /
solo). In production the files are served by the [backend](https://github.com/ENEIZEM/REMS-desk)
itself (Express `express.static`), so there is **no separate frontend host**.

- Live site: https://rems-desk.ru
- Backend repository (API + DB + serves this client): https://github.com/ENEIZEM/REMS-desk

---

## Table of contents
- [For end users](#for-end-users)
- [For developers](#for-developers)
- [For the administrator](#for-the-administrator-me)
- [Engineering principles](#engineering-principles)
- [Third-party assets & libraries](#third-party-assets--libraries)
- [Running & testing](#running--testing)
- [Full file & folder reference](#full-file--folder-reference)

---

## For end users

REMS-desk helps an organization run its equipment-repair workflow end to end:

- **Sign up / sign in** with email (SMS is built but disabled by a feature flag),
  a 6-digit verification code, a password and a 6-digit PIN (re-asked on return).
- **Three roles**, auto-detected from your account:
  - **Owner** — manages the organization, employees, equipment catalog, partner
    contracts and sees all requests.
  - **Employee** — handles requests, sees the equipment catalog and colleagues.
  - **Solo** — a user without an organization; can create a personal home,
    request membership or accept an invitation.
- **Requests** — create, take, progress and close repair requests with
  priorities, two-clock SLA (response + resolution), a road-map of statuses,
  and photo/document attachments.
- **Catalog** — register equipment with photos, categories, warranty progress.
- **Partners / contracts** — owners set up inter-organization contracts with
  their own SLA matrix and contract documents.
- **Notifications** — in-app feed, corner toasts, sound, and (optional)
  native OS/browser notifications when the tab is in the background.
- **Languages** — full Russian / English UI, switchable at any time.
- **Privacy** — no tracking cookies; only `localStorage` is used (session token,
  language, UI flags). A one-time notice says so on the landing page.

## For developers

**Stack:** plain ES modules (no build step, no framework), CSS custom
properties, `fetch`, WebSocket via Socket.IO client, `Intl` for i18n.

**How it is served & cache-busted.** Every page is plain HTML. The backend
serves these files and, in dev, rewrites local `src`/`href` with a per-boot
`?v=BOOT_ID` cache-buster and injects a service-worker killer. HTML partials are
assembled server-side via `<!--#include "...">` directives (see `pages/partials`).

**Pages.**
- [index.html](index.html) — marketing landing (hero + Vanta animation, live
  dashboard preview mock, feature/stat/footer sections, cookie notice).
- [pages/login.html](pages/login.html), [pages/register.html](pages/register.html) — auth flows.
- [pages/dashboard.html](pages/dashboard.html) — the single-page dashboard shell;
  tab panels + chrome (navbar, sidebar→bottom-nav on mobile, modals).

**JS architecture.** Entry points per page (`js/pages/*.js`). The dashboard
boots from [js/pages/dashboard/index.js](js/pages/dashboard/index.js), which wires
chrome modules and delegates to a **role router** that mounts the right
dashboard (owner / employee / solo). Shared concerns live in small,
single-purpose modules injected by dependency (e.g. `switchTab` is passed into
chrome modules rather than imported globally).

**Networking.** [js/api.js](js/api.js) is the typed REST wrapper, [js/auth.js](js/auth.js)
handles the session token / logout, [js/socket.js](js/socket.js) the realtime
channel. All API URLs are relative, so the client works on any origin.

**i18n.** [js/i18n.js](js/i18n.js) loads [locales/ru.json](locales/ru.json) /
[locales/en.json](locales/en.json), translates `data-i18n*` attributes, and
exposes `t()`, `setLang()`, `onLangChange()`. Backend error keys mirror the
locale JSON structure 1:1, so `t(error_key)` resolves directly.

**Responsive model.** Fluid, breakpoint-light chrome (see [css/chrome.css](css/chrome.css)
and [css/responsive.css](css/responsive.css)): the navbar/content margins shrink
symmetrically; below 768px the dashboard sidebar becomes a bottom nav, the header
matches the landing header, and notifications move into a modal.

## For the administrator (me)

- **Hosting:** one Railway service for the whole repo — the backend builds and
  runs, and serves this `frontend/` folder as static files. There is **no
  separate static host**. See the backend README for the Railway setup.
- **The only deploy-time switch that touches the client** is the public URL
  (`FRONTEND_URL` on the backend) — point it at `https://rems-desk.ru`. The
  client itself needs no edits because all of its API/asset URLs are relative.
- **Capability flags** ([js/config.js](js/config.js)) come from the backend
  (`GET /api/config`). `sms:false` hides phone UI everywhere; `email:true`
  enables real email. Safe defaults hide unfinished channels even if the config
  fetch fails.
- **Brand / email-deliverability assets** that you configured externally:
  [bimi/logo-bimi.svg](bimi/logo-bimi.svg) (BIMI logo shown next to emails) and
  [assets/og-image.png](assets/og-image.png) (social preview).

## Engineering principles

- **No build, no dependencies.** Ship the source as-is; the browser runs ES
  modules directly. This keeps the client auditable and host-agnostic.
- **Modular / atomic.** Many small files with one responsibility each;
  composition over inheritance; dependencies passed in (DI) rather than reached
  for globally.
- **CSS manifest.** [style.css](style.css) is a thin manifest that `@import`s the
  files in [css/](css/); design tokens live in [css/tokens.css](css/tokens.css)
  (CSS custom properties) — no hard-coded colors/spacing in components.
- **Server-side HTML includes.** Pages are composed from partials via
  `<!--#include-->`, expanded by the backend — one assembled document, no client
  templating engine.
- **Capability flags, not environment checks.** Feature availability is driven by
  explicit flags from the backend, never by `dev`/`prod` sniffing.
- **RLS-friendly, stateless client.** The client holds only a JWT; all
  authorization is enforced server-side (PostgreSQL Row-Level Security).

## Third-party assets & libraries

| What | Where it comes from | Used for | Files |
|------|--------------------|----------|-------|
| **Phosphor Icons** | self-hosted (no CDN), from https://phosphoricons.com | all UI icons (`<i class="ph ...">`) | [vendor/phosphor/](vendor/phosphor/) |
| **Vanta.js WAVES** + **three.js** | self-hosted, https://www.vantajs.com / https://threejs.org | animated hero background on the landing | [vendor/](vendor/) (`vanta.waves.min.js`, `three.min.js`) |
| **Onest** font | self-hosted, https://github.com/Solbera-Lab/Onest | brand typography | [fonts/onest.css](fonts/onest.css) + font files |
| **Socket.IO client** | served by backend at `/socket.io/socket.io.js` | realtime notifications | loaded in `pages/dashboard.html` |

Everything is **self-hosted** — the app runs with no external CDN.

## Running & testing

The client is served by the backend, so the normal way to run it is to start
the backend (it serves `../frontend`). See the backend README for `npm run dev`.
There is no separate build or test command for the client (no bundler, no
framework). To preview just the static files you may serve this folder with any
static server, but API calls will fail without the backend.

## Full file & folder reference

### Root
| Path | Purpose |
|------|---------|
| [index.html](index.html) | Marketing landing page (hero, Vanta animation, dashboard preview, features, stats, footer, cookie notice). Also holds the **SEO `<head>`**: title/description/keywords/canonical, Open Graph + Twitter cards, and Schema.org JSON-LD. |
| [style.css](style.css) | CSS manifest — `@import`s every file in `css/`. |
| [sitemap.xml](sitemap.xml) | Search-engine sitemap (home + login/register; private/auth pages excluded). Served at `/sitemap.xml`. |
| [robots.txt](robots.txt) | Crawler rules — allow public pages, disallow `/api/`, dashboard, uploads; links the sitemap. Served at `/robots.txt`. |
| [README.md](README.md) / [README.ru.md](README.ru.md) | This documentation (EN / RU). |
| [LICENSE](LICENSE) | License. |

> **SEO note:** the code makes the site indexable. To actually appear in
> results, register the domain once in Google Search Console, Yandex Webmaster
> and Bing Webmaster Tools and submit `sitemap.xml`.

### [assets/](assets/) — brand & PWA assets
| File | Purpose |
|------|---------|
| [logo.svg](assets/logo.svg) | Primary wordmark. |
| [logo-full.svg](assets/logo-full.svg) | Full wordmark (desktop navbar). |
| [logo-compact.svg](assets/logo-compact.svg) | Compact wordmark (mobile/narrow navbar). |
| [logo-icon.svg](assets/logo-icon.svg) | Square badge icon only. |
| [favicon.ico](assets/favicon.ico), [favicon.svg](assets/favicon.svg), [favicon-16x16.png](assets/favicon-16x16.png), [favicon-32x32.png](assets/favicon-32x32.png) | Favicons. |
| [apple-touch-icon.png](assets/apple-touch-icon.png), [android-chrome-192x192.png](assets/android-chrome-192x192.png), [android-chrome-512x512.png](assets/android-chrome-512x512.png) | PWA / mobile icons (also used by OS notifications). |
| [site.webmanifest](assets/site.webmanifest) | PWA manifest. |
| [og-image.png](assets/og-image.png) | Social/Open-Graph preview image. |

### [bimi/](bimi/)
| File | Purpose |
|------|---------|
| [logo-bimi.svg](bimi/logo-bimi.svg) | BIMI-spec logo for showing the brand mark next to emails (DNS/Cloudflare configured externally). |

### [css/](css/) — styles (imported by `style.css`)
| File | Purpose |
|------|---------|
| [tokens.css](css/tokens.css) | Design tokens — color/spacing/radius/typography CSS variables. |
| [base.css](css/base.css) | Resets and base element styles. |
| [buttons.css](css/buttons.css) | Button system (variants, icon buttons). |
| [forms.css](css/forms.css) | Inputs, selects, validation states. |
| [components.css](css/components.css) | Shared components (cards, badges, chips, avatars). |
| [chrome.css](css/chrome.css) | App chrome — fluid navbar, sidebar, content margins, sidebar scrim. |
| [nav.css](css/nav.css) | Navigation / sidebar items. |
| [modal.css](css/modal.css) | Modal dialogs and backdrops. |
| [feedback.css](css/feedback.css) | Toasts and skeletons. |
| [notifications.css](css/notifications.css) | Notification feed and corner-toast cards. |
| [profile.css](css/profile.css) | Profile/organization tabs, list-fill blocks, request feed, pickers, tooltips. |
| [auth.css](css/auth.css) | Login / register / PIN-lock screens. |
| [landing.css](css/landing.css) | Landing-page sections (hero text, features, footer, mobile preview). |
| [empty-state.css](css/empty-state.css) | Empty-state illustrations. |
| [misc.css](css/misc.css) | Language switcher and small one-offs. |
| [responsive.css](css/responsive.css) | All responsive rules incl. mobile dashboard nav, request sub-filters, role-based visibility. |

### [fonts/](fonts/)
| File | Purpose |
|------|---------|
| [onest.css](fonts/onest.css) | `@font-face` declarations for the self-hosted Onest font (+ font files alongside). |

### [vendor/](vendor/) — self-hosted third-party libs
| Path | Purpose |
|------|---------|
| [vendor/phosphor/](vendor/phosphor/) | Phosphor Icons CSS (`regular`, `bold`, `fill`, `duotone`) + webfonts. |
| `vendor/three.min.js`, `vendor/vanta.waves.min.js` | three.js + Vanta WAVES for the hero animation. |

### [locales/](locales/)
| File | Purpose |
|------|---------|
| [ru.json](locales/ru.json) / [en.json](locales/en.json) | All UI strings + backend error-key translations (structure mirrors backend `error_key`s). |

### [sounds/](sounds/)
| File | Purpose |
|------|---------|
| [notification.mp3](sounds/notification.mp3) | Notification sound (primed on first user gesture to satisfy autoplay policy). |

### [pages/](pages/) — non-landing HTML
| File | Purpose |
|------|---------|
| [dashboard.html](pages/dashboard.html) | Dashboard shell: pre-paint loader, PIN-lock overlay, navbar, sidebar, all tab panels, modal includes. |
| [login.html](pages/login.html) | Login (+ password/PIN reset flows). |
| [register.html](pages/register.html) | Multi-step registration. |

### [pages/partials/dashboard/](pages/partials/dashboard/) — server-included fragments
| File | Purpose |
|------|---------|
| [account.html](pages/partials/dashboard/account.html) | Account section markup. |
| [contacts.html](pages/partials/dashboard/contacts.html) | Contact-change modals. |
| [contracts.html](pages/partials/dashboard/contracts.html) | Contract create/view/edit modals. |
| [equipment.html](pages/partials/dashboard/equipment.html) | Equipment create/edit/photo modals. |
| [members.html](pages/partials/dashboard/members.html) | Member management / invite modals. |
| [membership.html](pages/partials/dashboard/membership.html) | Join / leave / invitation modals. |
| [requests.html](pages/partials/dashboard/requests.html) | Request create/detail/road-map modals. |
| [sessions.html](pages/partials/dashboard/sessions.html) | Active-sessions markup. |

### [js/](js/) — top-level modules
| File | Purpose |
|------|---------|
| [api.js](js/api.js) | REST client — one method per backend endpoint group; relative URLs. |
| [auth.js](js/auth.js) | Session token storage, `logout()`, toast helper, error mapping. |
| [config.js](js/config.js) | Capability flags (`email`/`sms`) loaded from `GET /api/config`. |
| [i18n.js](js/i18n.js) | Locale loading, `t()`, `setLang()`, switcher wiring, DOM translation. |
| [socket.js](js/socket.js) | Socket.IO connection + auth handshake for realtime events. |
| [device-id.js](js/device-id.js) | Stable per-device id (random, `localStorage`) — no fingerprinting, no CDN. |
| [form-guard.js](js/form-guard.js) | Guards against duplicate/last-submit form resubmission. |
| [media-attach.js](js/media-attach.js) | Shared file-attach widget (temp upload → confirm) used by modals. |

### [js/lib/](js/lib/) — reusable UI primitives
| File | Purpose |
|------|---------|
| [char-counter.js](js/lib/char-counter.js) | Live character counters under modal fields. |
| [code-input.js](js/lib/code-input.js) | Segmented verification-code input. |
| [doc-preview.js](js/lib/doc-preview.js) | Document/file preview tile. |
| [lazy-loader.js](js/lib/lazy-loader.js) | Attaches loading/error UI to async loaders. |
| [media-viewer.js](js/lib/media-viewer.js) | Full-screen image viewer. |
| [page-loader.js](js/lib/page-loader.js) | Pre-paint page loader control. |
| [pin-gate.js](js/lib/pin-gate.js) | One-shot PIN pass (skip PIN right after login/register). |

### [js/pages/](js/pages/) — page entry points
| File | Purpose |
|------|---------|
| [login.js](js/pages/login.js) | Login page logic + reset flows. |
| [register.js](js/pages/register.js) | Multi-step registration (incl. re-submitting the verified code). |

### [js/pages/dashboard/](js/pages/dashboard/) — dashboard core
| File | Purpose |
|------|---------|
| [index.js](js/pages/dashboard/index.js) | Dashboard boot: auth/PIN gate, tab switching, chrome wiring, socket events. |
| [role-router.js](js/pages/dashboard/role-router.js) | Detects role and mounts the matching dashboard. |
| [notifications.js](js/pages/dashboard/notifications.js) | Notification state, feed render, corner toasts, sound, OS notifications. |
| [members.js](js/pages/dashboard/members.js) | Members tab logic (list, pending, approve/reject, invite). |
| [sessions.js](js/pages/dashboard/sessions.js) | Active sessions list + revoke. |
| [pin-lock.js](js/pages/dashboard/pin-lock.js) | PIN-lock overlay on return. |
| [format.js](js/pages/dashboard/format.js) | Formatting helpers (dates, initials, avatars, role labels). |
| [badges.js](js/pages/dashboard/badges.js) | Status/role badge helpers. |
| [dom-utils.js](js/pages/dashboard/dom-utils.js) | `q()` and small DOM helpers. |
| [ui-helpers.js](js/pages/dashboard/ui-helpers.js) | Modal open/close, modal lang-switcher injection. |

### [js/pages/dashboard/chrome/](js/pages/dashboard/chrome/) — shell pieces
| File | Purpose |
|------|---------|
| [sidebar.js](js/pages/dashboard/chrome/sidebar.js) | Sidebar toggle, narrow-screen auto-collapse, scrim. |
| [user-dropdown.js](js/pages/dashboard/chrome/user-dropdown.js) | Avatar menu; profile/org/logout links (incl. profile-bottom logout). |
| [notifications-button.js](js/pages/dashboard/chrome/notifications-button.js) | Bell → notifications modal (mobile) / overview (desktop); OS-permission request. |
| [subfilter-wrap.js](js/pages/dashboard/chrome/subfilter-wrap.js) | Marks wrapped request sub-filter groups to drop the leading separator. |

### [js/pages/dashboard/dashboards/_shared/](js/pages/dashboard/dashboards/_shared/) — cross-role logic
| File | Purpose |
|------|---------|
| [requests.js](js/pages/dashboard/dashboards/_shared/requests.js) | Request feed: load, filter, segment, render, road-map. |
| [requests-ui.js](js/pages/dashboard/dashboards/_shared/requests-ui.js) | Request card / chip / SLA rendering. |
| [equipment.js](js/pages/dashboard/dashboards/_shared/equipment.js) | Equipment data + catalog logic. |
| [equipment-ui.js](js/pages/dashboard/dashboards/_shared/equipment-ui.js) | Equipment card / status rendering. |
| [contracts-ui.js](js/pages/dashboard/dashboards/_shared/contracts-ui.js) | Contract card / SLA-matrix rendering. |
| [role-helpers.js](js/pages/dashboard/dashboards/_shared/role-helpers.js) | `show()`/`hide()`/`remove()` role-visibility helpers. |

### [js/pages/dashboard/dashboards/owner/](js/pages/dashboard/dashboards/owner/)
| File | Purpose |
|------|---------|
| [index.js](js/pages/dashboard/dashboards/owner/index.js) | Owner orchestrator. |
| [overview.js](js/pages/dashboard/dashboards/owner/overview.js) | Owner overview (tiles, sub-filters, request work area). |
| [requests.js](js/pages/dashboard/dashboards/owner/requests.js) | Owner requests tab. |
| [catalog.js](js/pages/dashboard/dashboards/owner/catalog.js) | Equipment catalog (CRUD). |
| [partners.js](js/pages/dashboard/dashboards/owner/partners.js) | Partners/contracts tab. |
| [contracts.js](js/pages/dashboard/dashboards/owner/contracts.js) | Contract create/edit modals. |
| [team.js](js/pages/dashboard/dashboards/owner/team.js) | Employees/colleagues management. |

### [js/pages/dashboard/dashboards/employee/](js/pages/dashboard/dashboards/employee/)
| File | Purpose |
|------|---------|
| [index.js](js/pages/dashboard/dashboards/employee/index.js) | Employee orchestrator. |
| [overview.js](js/pages/dashboard/dashboards/employee/overview.js) | Employee overview (membership card, personal stats, leave-org). |
| [requests.js](js/pages/dashboard/dashboards/employee/requests.js) | Employee requests tab (feed + notifications). |
| [catalog.js](js/pages/dashboard/dashboards/employee/catalog.js) | Read-only equipment catalog. |
| [contracts.js](js/pages/dashboard/dashboards/employee/contracts.js) | Read-only contracts. |
| [team.js](js/pages/dashboard/dashboards/employee/team.js) | Colleagues list. |

### [js/pages/dashboard/dashboards/solo/](js/pages/dashboard/dashboards/solo/)
| File | Purpose |
|------|---------|
| [index.js](js/pages/dashboard/dashboards/solo/index.js) | Solo orchestrator. |
| [home.js](js/pages/dashboard/dashboards/solo/home.js) | Solo home (request membership / accept invite / notifications). |
| [join-modal.js](js/pages/dashboard/dashboards/solo/join-modal.js) | Join-an-organization modal. |

### [js/pages/dashboard/modals/](js/pages/dashboard/modals/)
| File | Purpose |
|------|---------|
| [change-password.js](js/pages/dashboard/modals/change-password.js) | Change-password flow. |
| [change-pin.js](js/pages/dashboard/modals/change-pin.js) | Change-PIN flow. |
| [change-contact.js](js/pages/dashboard/modals/change-contact.js) | Change email/phone flow. |
| [detach-contact.js](js/pages/dashboard/modals/detach-contact.js) | Detach a contact channel. |
| [field-edit.js](js/pages/dashboard/modals/field-edit.js) | Generic single-field edit modal. |

### [js/pages/dashboard/tabs/](js/pages/dashboard/tabs/)
| File | Purpose |
|------|---------|
| [profile.js](js/pages/dashboard/tabs/profile.js) | Personal profile tab rendering. |
| [organization.js](js/pages/dashboard/tabs/organization.js) | Organization tab (info, SLA matrix, limits). |
