/* ═══════════════════════════════════════════════════════════════
   Универсальный просмотрщик вложений (фото техники, вложения заявок,
   документ контракта). Само-инжектит модалку поверх всех остальных
   (высокий z-index — чтобы не оказаться ПОД другой модалкой). Показывает
   изображение или PDF (iframe), есть кнопка «Скачать» и «Закрыть».
   ═══════════════════════════════════════════════════════════════ */
import { media } from '../api.js';
import { toast, errorMessage } from '../auth.js';
import { applyTranslations } from '../i18n.js';

const ID = 'rems-media-viewer';
let _injected = false, _wired = false, _blobUrl = null, _downloadUrl = null, _fileName = 'file';

function ensure() {
  if (_injected) return;
  _injected = true;
  const m = document.createElement('div');
  m.className = 'modal-backdrop media-viewer-backdrop';
  m.id = ID;
  m.innerHTML = `
    <div class="modal modal-photo">
      <div class="modal-header">
        <div class="modal-header-text"><h3 class="modal-title" data-i18n="common.attachment_view">Просмотр вложения</h3></div>
        <button class="modal-close" type="button" id="${ID}-close"><i class="ph ph-x"></i></button>
      </div>
      <div class="modal-body equipment-photo-view">
        <img id="${ID}-img" src="" alt="" style="display:none;">
        <iframe id="${ID}-pdf" title="pdf" style="display:none; width:100%; height:70vh; border:0;"></iframe>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" type="button" id="${ID}-download"><i class="ph ph-download-simple"></i> <span data-i18n="common.download">Скачать</span></button>
        <button class="btn btn-secondary" type="button" id="${ID}-closebtn" data-i18n="common.close">Закрыть</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  applyTranslations();   // перевести только что вставленные data-i18n
}

function close() {
  document.getElementById(ID)?.classList.remove('open');
  if (_blobUrl) { try { URL.revokeObjectURL(_blobUrl); } catch {} _blobUrl = null; }
  _downloadUrl = null;
}

function wire() {
  if (_wired) return;
  _wired = true;
  document.getElementById(`${ID}-close`)?.addEventListener('click', close);
  document.getElementById(`${ID}-closebtn`)?.addEventListener('click', close);
  document.getElementById(`${ID}-download`)?.addEventListener('click', () => {
    if (!_downloadUrl) return;
    const a = document.createElement('a');
    a.href = _downloadUrl; a.download = _fileName;
    document.body.appendChild(a); a.click(); a.remove();
  });
}

/**
 * Открыть просмотрщик для приватного медиафайла.
 * @param {number} mediaFileId
 * @param {{ name?: string }} [opts]
 */
export async function openMediaViewer(mediaFileId, opts = {}) {
  ensure(); wire();
  _fileName = opts.name || `attachment-${mediaFileId}`;
  const img = document.getElementById(`${ID}-img`);
  const pdf = document.getElementById(`${ID}-pdf`);
  if (img) { img.style.display = 'none'; img.src = ''; }
  if (pdf) { pdf.style.display = 'none'; pdf.src = ''; }
  document.getElementById(ID)?.classList.add('open');
  try {
    const { blob, url } = await media.loadPrivateBlob(mediaFileId);
    if (_blobUrl) { try { URL.revokeObjectURL(_blobUrl); } catch {} }
    _blobUrl = url;
    _downloadUrl = url;
    if (blob.type === 'application/pdf') {
      if (pdf) { pdf.src = url; pdf.style.display = ''; }
    } else if (img) {
      img.src = url; img.style.display = '';
    }
  } catch (err) {
    toast(errorMessage(err), 'error');
    close();
  }
}

/**
 * Открыть просмотрщик для ПУБЛИЧНОГО изображения по прямому URL (аватары,
 * логотипы — раздаются как статика, без приватного blob-фетча).
 * @param {string} url
 * @param {{ name?: string }} [opts]
 */
export function openImageViewer(url, opts = {}) {
  if (!url) return;
  ensure(); wire();
  _fileName = opts.name || 'image';
  const img = document.getElementById(`${ID}-img`);
  const pdf = document.getElementById(`${ID}-pdf`);
  if (pdf) { pdf.style.display = 'none'; pdf.src = ''; }
  // публичный URL — не blob; сбрасываем прошлый blob, чтобы close() не ревокал чужое
  if (_blobUrl) { try { URL.revokeObjectURL(_blobUrl); } catch {} _blobUrl = null; }
  _downloadUrl = url;
  if (img) { img.src = url; img.style.display = ''; }
  document.getElementById(ID)?.classList.add('open');
}
