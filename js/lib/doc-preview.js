/* ═══════════════════════════════════════════════════════════════
   Универсальная превью-модалка для документов / изображений.
   Атомарный модуль: сам инжектит свою разметку (один раз) и
   управляет всем циклом «выбрать → превью → сохранить / заменить /
   отменить». По UX повторяет media-attach (аватар/лого):
     • Сохранить — грузит файл в /api/upload/temp с указанным entityType
       и вызывает onSave({ mediaFileId, file }).
     • Заменить — открывает file-picker ещё раз.
     • Отменить — закрывает без изменений.
   Поддерживает PDF (через <iframe>), изображения (<img>) и
   общий fallback (иконка + имя файла).

   Использование:
     import { wireDocPreview } from '../../lib/doc-preview.js';
     const ctl = wireDocPreview({
       entityType: 'contract',
       allowedMime: ['application/pdf','image/jpeg','image/png','image/webp'],
       maxBytes: 15 * 1024 * 1024,
       onSave:   ({ mediaFileId, file }) => { ... },
       onCancel: () => { ... },
     });
     ctl.openWithFile(file);   // открыть с уже выбранным файлом
     ctl.openPicker();         // вызвать file picker, потом превью
     ctl.reopenPreview(file);  // показать существующий выбор повторно
   ═══════════════════════════════════════════════════════════════ */

import { media } from '../api.js';
import { t } from '../i18n.js';
import { toast, errorMessage } from '../auth.js';

const MODAL_ID = 'rems-doc-preview-modal';
const INPUT_ID = 'rems-doc-preview-input';

let _injected = false;
function ensureMarkup() {
  if (_injected) return;
  _injected = true;
  const m = document.createElement('div');
  m.className = 'modal-backdrop';
  m.id = MODAL_ID;
  m.innerHTML = `
    <div class="modal" style="max-width:680px;">
      <div class="modal-header">
        <div class="modal-card-icon"><i class="ph-bold ph-paperclip"></i></div>
        <div class="modal-header-text">
          <h3 class="modal-title" id="${MODAL_ID}-title" data-i18n="contracts.doc_preview_title">Предпросмотр документа</h3>
          <p class="modal-subtitle" id="${MODAL_ID}-hint" style="display:none;"></p>
        </div>
        <button class="modal-close" type="button" id="${MODAL_ID}-close"><i class="ph ph-x"></i></button>
      </div>
      <div class="modal-body" style="text-align:center;">
        <p class="form-hint" id="${MODAL_ID}-limits" style="margin:0 0 .75rem; font-size:var(--text-xs); color:var(--clr-text-muted);"></p>
        <div class="media-preview-frame doc-preview-frame">
          <img id="${MODAL_ID}-img" alt="" style="display:none; max-width:100%; max-height:60vh;">
          <iframe id="${MODAL_ID}-pdf" title="pdf" style="display:none; width:100%; height:60vh; border:0;"></iframe>
          <div id="${MODAL_ID}-fallback" class="contract-doc-fallback hidden">
            <i class="ph-duotone ph-file-text" style="font-size:3rem; color:var(--clr-text-muted);"></i>
            <p style="margin:.5rem 0 0; color:var(--clr-text-muted);" id="${MODAL_ID}-fallback-text">—</p>
          </div>
        </div>
        <p id="${MODAL_ID}-meta" style="margin-top:.6rem; font-size:var(--text-xs); color:var(--clr-text-muted);">—</p>
        <div class="alert alert-error" id="${MODAL_ID}-err"><i class="ph ph-warning-circle"></i><span id="${MODAL_ID}-err-text"></span></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary"   type="button" id="${MODAL_ID}-save"><i class="ph ph-check"></i> <span data-i18n="common.save">Сохранить</span></button>
        <button class="btn btn-navy"      type="button" id="${MODAL_ID}-replace"><i class="ph ph-arrows-clockwise"></i> <span data-i18n="profile.media_pick_other">Выбрать другое</span></button>
        <button class="btn btn-secondary" type="button" id="${MODAL_ID}-cancel" data-i18n="common.cancel">Отмена</button>
      </div>
    </div>`;
  document.body.appendChild(m);

  // Hidden file input (общий)
  const inp = document.createElement('input');
  inp.type = 'file'; inp.id = INPUT_ID;
  inp.style.position = 'fixed'; inp.style.left = '-9999px';
  document.body.appendChild(inp);
}

function fmtBytes(n) {
  if (!n) return '—';
  const mb = n / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;
}

let _activeCtl = null;

function openModalEl() { document.getElementById(MODAL_ID)?.classList.add('open'); }
function closeModalEl() { document.getElementById(MODAL_ID)?.classList.remove('open'); }

let _sharedWired = false;
function wireShared() {
  if (_sharedWired) return; _sharedWired = true;
  document.getElementById(`${MODAL_ID}-save`)?.addEventListener('click',    () => _activeCtl?._doSave());
  document.getElementById(`${MODAL_ID}-replace`)?.addEventListener('click', () => _activeCtl?._doReplace());
  document.getElementById(`${MODAL_ID}-cancel`)?.addEventListener('click',  () => _activeCtl?._doCancel());
  document.getElementById(`${MODAL_ID}-close`)?.addEventListener('click',   () => _activeCtl?._doCancel());
}

export function wireDocPreview({
  entityType,
  allowedMime = ['application/pdf','image/jpeg','image/png','image/webp','image/jpg'],
  maxBytes = 15 * 1024 * 1024,
  titleKey, hintKey,
  onSave, onCancel,
} = {}) {
  ensureMarkup();
  wireShared();
  const inp = document.getElementById(INPUT_ID);

  // Человекочитаемая строка ограничений: «До 15 MB · JPG · PNG · WEBP · PDF».
  function limitsText() {
    const types = [...new Set(allowedMime.map(m => {
      if (m === 'application/pdf') return 'PDF';
      return (m.split('/')[1] || '').toUpperCase().replace('JPEG', 'JPG');
    }).filter(Boolean))].join(' · ');
    const sizeTmpl = t('profile.media_limits_hint') || 'До {size} · {types}';
    return sizeTmpl.replace('{size}', `${(maxBytes / 1024 / 1024).toFixed(0)} MB`).replace('{types}', types);
  }

  let _file = null;
  let _objUrl = null;

  function showError(msg) {
    const a = document.getElementById(`${MODAL_ID}-err`);
    const tEl = document.getElementById(`${MODAL_ID}-err-text`);
    if (!a || !tEl) return;
    tEl.textContent = msg; a.classList.add('show');
  }
  function hideError() {
    document.getElementById(`${MODAL_ID}-err`)?.classList.remove('show');
  }
  function clearUrl() { if (_objUrl) URL.revokeObjectURL(_objUrl); _objUrl = null; }

  function validate(f) {
    if (!allowedMime.includes(f.type)) return t('errors.upload.invalid_mime') || 'Неподдерживаемый формат файла.';
    if (f.size > maxBytes) {
      const tmpl = t('errors.upload.file_too_large') || 'Файл больше допустимого ({max}).';
      return tmpl.replace('{max}', `${(maxBytes/1024/1024).toFixed(0)} MB`).replace('{actual}', fmtBytes(f.size));
    }
    return null;
  }

  function showPreview(file) {
    _file = file;
    clearUrl();
    _objUrl = URL.createObjectURL(file);
    const img = document.getElementById(`${MODAL_ID}-img`);
    const pdf = document.getElementById(`${MODAL_ID}-pdf`);
    const fb  = document.getElementById(`${MODAL_ID}-fallback`);
    const meta = document.getElementById(`${MODAL_ID}-meta`);
    const fbText = document.getElementById(`${MODAL_ID}-fallback-text`);
    // Заголовок / подсказка / ограничения (как у медиа-аттача аватара/лого).
    const titleEl = document.getElementById(`${MODAL_ID}-title`);
    if (titleEl && titleKey) { titleEl.setAttribute('data-i18n', titleKey); titleEl.textContent = t(titleKey); }
    const hintEl = document.getElementById(`${MODAL_ID}-hint`);
    if (hintEl) {
      if (hintKey) { hintEl.setAttribute('data-i18n', hintKey); hintEl.textContent = t(hintKey); hintEl.style.display = ''; }
      else { hintEl.textContent = ''; hintEl.style.display = 'none'; }
    }
    const limEl = document.getElementById(`${MODAL_ID}-limits`);
    if (limEl) limEl.textContent = limitsText();
    if (img) { img.style.display = 'none'; img.src = ''; }
    if (pdf) { pdf.style.display = 'none'; pdf.src = ''; }
    fb?.classList.add('hidden');
    if (meta) meta.textContent = `${file.name} · ${fmtBytes(file.size)}`;
    if (file.type === 'application/pdf') {
      if (pdf) { pdf.src = _objUrl; pdf.style.display = ''; }
    } else if (file.type.startsWith('image/')) {
      if (img) { img.src = _objUrl; img.style.display = ''; }
    } else {
      fb?.classList.remove('hidden');
      if (fbText) fbText.textContent = file.name;
    }
    hideError();
    _activeCtl = ctl;
    openModalEl();
  }

  // Один общий input — переподписываем при openPicker.
  function bindOnce() {
    inp.onchange = (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      const err = validate(f);
      if (err) { toast(err, 'error'); inp.value = ''; return; }
      showPreview(f);
      inp.value = '';
    };
  }

  const ctl = {
    openPicker() {
      bindOnce();
      // Перед picker'ом восстанавливаем Save — новый файл потребует загрузки.
      document.getElementById(`${MODAL_ID}-save`)?.style.removeProperty('display');
      inp.accept = allowedMime.join(',');
      inp.click();
    },
    openWithFile(file) {
      const err = validate(file);
      if (err) { toast(err, 'error'); return; }
      // Save виден — это новый файл, после Save загрузится.
      document.getElementById(`${MODAL_ID}-save`)?.style.removeProperty('display');
      showPreview(file);
    },
    reopenPreview(file) {
      // Показ уже сохранённого файла: Save скрываем, оставляем
      // «Заменить» и «Отмена» — иначе re-Save повторит uploadTemp.
      _activeCtl = ctl;
      const saveBtn = document.getElementById(`${MODAL_ID}-save`);
      if (saveBtn) saveBtn.style.display = 'none';
      showPreview(file);
    },
    async _doSave() {
      if (!_file) return;
      const btn = document.getElementById(`${MODAL_ID}-save`);
      btn?.classList.add('btn-loading'); if (btn) btn.disabled = true;
      try {
        const up = await media.uploadTemp(_file, entityType);
        const mediaFileId = up.data?.media_file_id ?? null;
        if (!mediaFileId) throw new Error('no media_file_id');
        closeModalEl();
        onSave?.({ mediaFileId, file: _file });
        _file = null; clearUrl();
      } catch (err) {
        showError(errorMessage(err));
      } finally {
        btn?.classList.remove('btn-loading'); if (btn) btn.disabled = false;
      }
    },
    _doReplace() {
      bindOnce();
      // Заменяем файл → восстановить Save, чтобы загрузить новый.
      document.getElementById(`${MODAL_ID}-save`)?.style.removeProperty('display');
      inp.accept = allowedMime.join(',');
      inp.click();
    },
    _doCancel()  { closeModalEl(); _file = null; clearUrl(); onCancel?.(); },
  };
  return ctl;
}
