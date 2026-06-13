/* ═══════════════════════════════════════════════════════════════
   REMS — Media-attach helper (avatar & org-logo)
   ───────────────────────────────────────────────────────────────
   Reusable "pick → validate → preview → confirm → upload" pipeline.

   Improvements over the previous draft:
     • Limits (file types, max size) are shown as a hint at the TOP of
       the modal — no surprise on save.
     • The picked file is validated BEFORE the preview opens; on
       failure we surface an inline alert and DON'T proceed.
     • Preview frame uses a contrasting checker pattern so light-on-
       light images don't disappear; the crop overlay actually shows
       the kept area in full colour and dims the rest.
     • For 1:1 crops (avatar, org logo) we crop client-side to a
       square canvas BEFORE uploading — storage gets the cropped
       image, not the original rectangle.
     • Modal header carries an icon (camera-bold) and a properly-
       aligned close button — matches the rest of the dashboard
       modals.
     • Optional "Удалить" red button — fires deleteFn() when the
       caller signals there is an existing photo via hasExisting().

   Usage:
       wireMediaAttach({
         input:        '#avatar-input',
         trigger:      '#btn-change-avatar',
         entityType:   'user',
         confirm:      (id) => profile.confirmAvatar(id),
         deleteFn:     ()   => profile.deleteAvatar(),
         hasExisting:  ()   => !!_userProfile?.avatar?.url,
         onSuccess:    ()   => loadProfile(),
         titleKey:     'profile.media_avatar_title',
         hintKey:      'profile.media_avatar_hint',
         cropPreview:  'circle',
         getLimits:    () => _orgData?.limits ?? null,
         t, toast, errorMessage,
       });
   ═══════════════════════════════════════════════════════════════ */

import { media } from './api.js';

function q(sel) { return document.querySelector(sel); }

const ALLOWED_MIME = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;   // 10 MB hard fallback

// Pretty-print bytes as MB.
function fmtBytes(n) {
  if (!n) return '—';
  const mb = n / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;
}

// ── Shared modal (injected once) ────────────────────────────────
let _modalInjected = false;
function ensureModal(t) {
  if (_modalInjected) return;
  _modalInjected = true;

  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.id = 'media-preview-modal';
  modal.innerHTML = `
    <div class="modal" style="max-width:560px;">
      <div class="modal-header">
        <div class="modal-card-icon"><i class="ph-bold ph-camera"></i></div>
        <div class="modal-header-text">
          <h3 class="modal-title" id="media-preview-title">${t('profile.media_preview_title') || 'Предпросмотр'}</h3>
          <p class="modal-subtitle" id="media-preview-hint"></p>
        </div>
        <button class="modal-close" type="button" id="btn-media-close">
          <i class="ph ph-x"></i>
        </button>
      </div>
      <div class="modal-body" style="text-align:center;">
        <p id="media-preview-limits" class="form-hint" style="margin:0 0 .75rem; font-size:var(--text-xs);"></p>
        <div id="media-preview-frame" class="media-preview-frame">
          <img id="media-preview-image" alt="">
          <div id="media-preview-overlay" class="media-crop-overlay" style="display:none;"></div>
        </div>
        <p id="media-preview-meta" style="margin-top:.6rem; font-size:var(--text-xs); color:var(--clr-text-muted);"></p>
        <div class="alert alert-error" id="media-preview-error"><i class="ph ph-warning-circle"></i><span id="media-preview-error-text"></span></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="btn-media-confirm" type="button">
          <i class="ph ph-check"></i>
          <span data-i18n="common.save">${t('common.save') || 'Сохранить'}</span>
        </button>
        <button class="btn btn-navy" id="btn-media-replace" type="button">
          <i class="ph ph-arrows-clockwise"></i>
          <span data-i18n="profile.media_pick_other">${t('profile.media_pick_other') || 'Выбрать другое'}</span>
        </button>
        <button class="btn btn-danger" id="btn-media-delete" type="button" style="display:none;">
          <i class="ph ph-trash"></i>
          <span data-i18n="profile.media_delete">${t('profile.media_delete') || 'Удалить текущее фото'}</span>
        </button>
        <button class="btn btn-secondary" id="btn-media-cancel" type="button" data-i18n="common.cancel">${t('common.cancel') || 'Отмена'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

// ── Client-side crop ─────────────────────────────────────────────
// Crops the image to a centred square (the largest one that fits),
// then exports a Blob preserving the original mime (or JPEG fallback).
async function cropToSquare(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload  = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth  - side) / 2;
    const sy = (img.naturalHeight - side) / 2;
    const canvas = document.createElement('canvas');
    canvas.width  = side;
    canvas.height = side;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, sx, sy, side, side, 0, 0, side, side);
    const mime = file.type === 'image/png' ? 'image/png'
              : file.type === 'image/webp' ? 'image/webp'
              : 'image/jpeg';
    const blob = await new Promise((res, rej) => {
      canvas.toBlob(b => b ? res(b) : rej(new Error('canvas.toBlob failed')), mime, 0.92);
    });
    // Re-wrap as a File so the FormData (multer) sees a familiar object.
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.' + (mime.split('/')[1] || 'jpg'), {
      type: mime,
      lastModified: Date.now(),
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ─── Public API ──────────────────────────────────────────────────
export function wireMediaAttach({
  input, trigger, entityType,
  confirm, deleteFn, hasExisting,
  onSuccess,
  titleKey, hintKey,
  cropPreview = false,
  getLimits,
  t, toast, errorMessage,
}) {
  const inputEl   = typeof input   === 'string' ? q(input)   : input;
  const triggerEl = typeof trigger === 'string' ? q(trigger) : trigger;
  if (!inputEl) return { open: () => {} };

  ensureModal(t);

  let pendingFile = null;
  let pendingUrl  = null;

  function getMaxBytes() {
    return Number(getLimits?.()?.max_image_upload_size_bytes) || DEFAULT_MAX_BYTES;
  }

  function renderLimitsHint() {
    const limit = getMaxBytes();
    const types = 'JPG · PNG · WEBP';
    const txt   = (t('profile.media_limits_hint') || 'До {size} · {types}')
      .replace('{size}',  fmtBytes(limit))
      .replace('{types}', types);
    const el = q('#media-preview-limits');
    if (el) el.textContent = txt;
  }

  // Validate BEFORE preview. Reject early — never opens the modal with
  // a doomed file. Returns null on success, or a localized error string.
  function validateFile(file) {
    if (!ALLOWED_MIME.includes(file.type)) {
      return (t('errors.upload.invalid_file_type') ||
              'Неподдерживаемый формат файла. Разрешены: JPG, PNG, WEBP.');
    }
    const max = getMaxBytes();
    if (file.size > max) {
      const params = { max: fmtBytes(max), actual: fmtBytes(file.size) };
      const tmpl   = t('errors.upload.file_too_large') || 'Файл больше допустимого размера ({max}). Размер вашего: {actual}.';
      return tmpl.replace('{max}', params.max).replace('{actual}', params.actual);
    }
    return null;
  }

  function showPreview(file) {
    pendingFile = file;
    if (pendingUrl) URL.revokeObjectURL(pendingUrl);
    pendingUrl = URL.createObjectURL(file);
    _activeController = controller;

    q('#media-preview-image').src = pendingUrl;
    // Восстановить элементы, которые мог скрыть delete-only режим
    // (openForDelete) — иначе после него превью открывалось бы пустым.
    q('#media-preview-frame')?.classList.remove('hidden');
    q('#btn-media-confirm')?.style.removeProperty('display');
    q('#btn-media-replace')?.style.removeProperty('display');
    q('#media-preview-meta').textContent =
      `${file.name} · ${fmtBytes(file.size)}`;
    q('#media-preview-title').textContent =
      titleKey ? (t(titleKey) || t('profile.media_preview_title') || 'Предпросмотр')
               : (t('profile.media_preview_title') || 'Предпросмотр');
    const hintEl = q('#media-preview-hint');
    if (hintEl) {
      if (hintKey) { hintEl.textContent = t(hintKey) || ''; hintEl.style.display = ''; }
      else         { hintEl.textContent = '';            hintEl.style.display = 'none'; }
    }
    renderLimitsHint();

    // Crop overlay setup. The .crop-circle / .crop-square mask covers
    // EVERYTHING that will be cut away with the dark tint; the kept
    // region stays full-colour.
    const overlay = q('#media-preview-overlay');
    if (overlay) {
      overlay.classList.remove('crop-circle', 'crop-square');
      if (cropPreview === 'circle' || cropPreview === 'square') {
        overlay.classList.add('crop-' + cropPreview);
        overlay.style.display = '';
      } else {
        overlay.style.display = 'none';
      }
    }

    // Image rendering: when we're going to crop to a centred square,
    // mirror that on screen via object-fit: cover so the user sees the
    // SAME framing they'll get after save. Without that the preview
    // showed the whole image squeezed inside the frame and lied about
    // what would survive the crop.
    const imgEl = q('#media-preview-image');
    if (imgEl) {
      if (cropPreview === 'circle' || cropPreview === 'square') {
        imgEl.classList.add('media-preview-cover');
      } else {
        imgEl.classList.remove('media-preview-cover');
      }
    }

    // Toggle delete button — visible only when we have an existing
    // photo AND the caller wired a deleteFn for us to call.
    const delBtn = q('#btn-media-delete');
    if (delBtn) {
      const showDelete = !!deleteFn && !!hasExisting?.();
      delBtn.style.display = showDelete ? '' : 'none';
    }

    q('#media-preview-error')?.classList.remove('show');
    q('#media-preview-modal')?.classList.add('open');
  }

  function closeModal() {
    q('#media-preview-modal')?.classList.remove('open');
  }
  function reset() {
    pendingFile = null;
    if (pendingUrl) URL.revokeObjectURL(pendingUrl);
    pendingUrl = null;
    inputEl.value = '';
  }

  // File-picker change. If validation fails, surface a toast and
  // also do nothing (don't open the modal, don't keep the file).
  inputEl.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const err = validateFile(file);
    if (err) {
      toast(err, 'error');
      inputEl.value = '';
      return;
    }
    showPreview(file);
  });

  triggerEl?.addEventListener('click', () => inputEl.click());
  installSharedFooterHandlers();

  const controller = {
    open: () => inputEl.click(),
    async confirmSelected() {
      if (!pendingFile) return;
      const btn = q('#btn-media-confirm');
      setBusy(btn, true);
      try {
        // Crop client-side when the caller asked for a 1:1 preview so
        // we don't ship the discarded pixels to storage.
        const toSend = (cropPreview === 'circle' || cropPreview === 'square')
          ? await cropToSquare(pendingFile)
          : pendingFile;
        const up = await media.uploadTemp(toSend, entityType);
        await confirm(up.data.media_file_id);
        closeModal();
        reset();
        onSuccess?.();
      } catch (err) {
        showError(errorMessage(err));
      } finally {
        setBusy(btn, false);
      }
    },
    replaceSelected() { inputEl.click(); },
    cancelSelected()  { closeModal(); reset(); },
    async deleteCurrent() {
      if (!deleteFn) return;
      const btn = q('#btn-media-delete');
      setBusy(btn, true);
      try {
        await deleteFn();
        closeModal();
        reset();
        onSuccess?.();
      } catch (err) {
        showError(errorMessage(err));
      } finally {
        setBusy(btn, false);
      }
    },
    // Reveal the delete button without picking a file (caller can
    // bind this to the "Trash" action on the avatar tile itself).
    openForDelete() {
      // Reuse the modal in a "delete-only" mode: hide the preview
      // pane and the Save / Replace buttons.
      pendingFile = null;
      _activeController = controller;
      q('#media-preview-image').src = '';
      q('#media-preview-meta').textContent = '';
      q('#media-preview-frame').classList.add('hidden');
      q('#media-preview-limits').textContent = '';
      q('#media-preview-error')?.classList.remove('show');
      q('#btn-media-confirm').style.display = 'none';
      q('#btn-media-replace').style.display = 'none';
      const delBtn = q('#btn-media-delete');
      if (delBtn) delBtn.style.display = '';
      q('#media-preview-modal')?.classList.add('open');
    },
  };

  return controller;
}

// ── Shared footer wiring (idempotent) ────────────────────────────
let _activeController = null;
let _sharedHandlersInstalled = false;
function installSharedFooterHandlers() {
  if (_sharedHandlersInstalled) return;
  _sharedHandlersInstalled = true;
  queueMicrotask(() => {
    q('#btn-media-confirm')?.addEventListener('click', () => _activeController?.confirmSelected());
    q('#btn-media-replace')?.addEventListener('click', () => _activeController?.replaceSelected());
    q('#btn-media-cancel') ?.addEventListener('click', () => _activeController?.cancelSelected());
    q('#btn-media-close')  ?.addEventListener('click', () => _activeController?.cancelSelected());
    q('#btn-media-delete') ?.addEventListener('click', () => _activeController?.deleteCurrent());
  });
}

function setBusy(btn, on) {
  if (!btn) return;
  btn.disabled = on;
  btn.classList.toggle('btn-loading', on);
}
function showError(msg) {
  const alert = q('#media-preview-error');
  const text  = q('#media-preview-error-text');
  if (!alert || !text) return;
  text.textContent = msg;
  alert.classList.add('show');
}
