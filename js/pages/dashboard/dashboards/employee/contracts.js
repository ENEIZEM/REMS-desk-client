/* ═══════════════════════════════════════════════════════════════
   Employee Contracts — read-only список контрактов орги. Кнопка
   «Открыть контракт» доступна (модалка с текстом + ссылка на док
   — wiring в lib/общем компоненте).
   ═══════════════════════════════════════════════════════════════ */
import { contracts as contractsApi, media } from '../../../../api.js';
import { toast, errorMessage } from '../../../../auth.js';
import { applyTranslations, t, onLangChange } from '../../../../i18n.js';
import { openModal } from '../../ui-helpers.js';
import { contractsBlocksHTML } from '../_shared/contracts-ui.js';

let _current = [], _terminated = [];

export function mountEmployeeContracts(profile) {
  const slot = document.querySelector('#contracts-slot');
  if (!slot) return;
  const tabPanel = document.querySelector('#tab-contracts');
  if (tabPanel) tabPanel.classList.add('tab-fill');

  slot.innerHTML = `
    <div class="page-header">
      <h1 class="page-title" data-i18n="nav.contracts">Контракты</h1>
      <p class="page-desc" data-i18n="contracts.desc">Список контрактов вашей организации.</p>
    </div>
    <div id="employee-contracts-list"></div>
  `;
  applyTranslations();

  const list = slot.querySelector('#employee-contracts-list');
  list?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ct-action="view"]');
    if (!btn) return;
    const id = Number(btn.dataset.ctId);
    if (!id) return;
    openContractView(id);
  });

  if (!window.__remsEmployeeContractsLangWired) {
    window.__remsEmployeeContractsLangWired = true;
    onLangChange(() => {
      if (document.body.dataset.role !== 'employee') return;
      if (document.querySelector('#employee-contracts-list')) loadContracts();
    });
    window.addEventListener('rems:reload-contracts', () => {
      if (document.querySelector('#employee-contracts-list')) loadContracts();
    });
  }
  loadContracts();
}

async function loadContracts() {
  const list = document.querySelector('#employee-contracts-list');
  if (!list) return;
  try {
    const resp = await contractsApi.list();
    const data = resp.data || { current: [], terminated: [] };
    _current = data.current || [];
    _terminated = data.terminated || [];
    list.innerHTML = contractsBlocksHTML(data, false);  // read-only
  } catch (err) {
    toast(errorMessage(err), 'error');
  }
}

function openContractView(id) {
  const c = _current.find(x => x.id === id) || _terminated.find(x => x.id === id);
  if (!c) return;
  const nameEl = document.getElementById('cv-name');
  if (nameEl) nameEl.textContent = c.name;
  const descEl   = document.getElementById('cv-desc');
  const noDescEl = document.getElementById('cv-no-desc');
  if (c.description && c.description.trim()) {
    if (descEl)   { descEl.textContent = c.description; descEl.style.display = ''; }
    if (noDescEl) noDescEl.style.display = 'none';
  } else {
    if (descEl)   descEl.style.display = 'none';
    if (noDescEl) noDescEl.style.display = '';
  }
  const docBtn = document.getElementById('btn-cv-open-doc');
  if (docBtn) {
    if (c.doc?.id) {
      docBtn.style.display = '';
      docBtn.onclick = async () => {
        docBtn.classList.add('btn-loading');
        try { await media.openPrivate(c.doc.id); }
        catch (err) { toast(errorMessage(err), 'error'); }
        finally { docBtn.classList.remove('btn-loading'); }
      };
    } else docBtn.style.display = 'none';
  }
  openModal('contract-view-modal');
}
