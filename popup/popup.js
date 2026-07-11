// Constants and Configuration
const CONFIG = {
  HELP_URL: 'https://github.com/taichikuji/Linker#user-guide',
  EXPORT_FILENAME: 'linker.json',
  MAX_SHORTCUT_LENGTH: 100,
  MAX_IMPORT_BYTES: 1024 * 1024,
  MAX_IMPORT_ENTRIES: 500,
  ALLOWED_PROTOCOLS: ['http:', 'https:']
};

const browserApi = globalThis.browser ?? globalThis.chrome;

// State Management
const state = {
  entries: {},
  toastTimeout: null,
  pendingConfirmation: null
};

// DOM Elements
const elements = {
  search: document.getElementById('search'),
  itemList: document.getElementById('item-list'),
  emptyState: document.getElementById('empty-state'),
  addSection: document.getElementById('add-section'),
  shortcutInput: document.getElementById('go-link'),
  urlInput: document.getElementById('full-link'),
  saveButton: document.getElementById('save'),
  helpButton: document.getElementById('btn-help'),
  importButton: document.getElementById('btn-import'),
  fileInput: document.getElementById('import-file'),
  exportButton: document.getElementById('btn-export'),
  entryTemplate: document.getElementById('shortcut-template'),
  toast: document.getElementById('toast'),
  toastMessage: document.getElementById('toast-message'),
  toastClose: document.getElementById('toast-close'),
  confirmModal: document.getElementById('confirm-modal'),
  confirmTitle: document.getElementById('confirm-title'),
  confirmOk: document.getElementById('confirm-ok'),
  confirmCancel: document.getElementById('confirm-cancel')
};

document.addEventListener('DOMContentLoaded', initialize);

browserApi.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && Object.keys(changes).length > 0) {
    loadEntries();
  }
});

async function initialize() {
  setupEventListeners();
  await Promise.all([loadEntries(), populateCurrentTabUrl()]);
}

function setupEventListeners() {
  elements.search.addEventListener('input', renderEntries);
  elements.shortcutInput.addEventListener('input', updateSaveButton);
  elements.saveButton.addEventListener('click', saveShortcut);
  elements.helpButton.addEventListener('click', openHelp);
  elements.importButton.addEventListener('click', () => elements.fileInput.click());
  elements.fileInput.addEventListener('change', importShortcuts);
  elements.exportButton.addEventListener('click', exportShortcuts);
  elements.toastClose.addEventListener('click', hideToast);
}

function isStoredEntry(value) {
  return Boolean(value && typeof value === 'object' && typeof value.url === 'string');
}

function isValidShortcut(shortcut) {
  return shortcut.length > 0
    && shortcut.length <= CONFIG.MAX_SHORTCUT_LENGTH
    && !/[\s/?#&%\\]/u.test(shortcut);
}

function isValidTargetUrl(url) {
  try {
    return CONFIG.ALLOWED_PROTOCOLS.includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

async function loadEntries() {
  try {
    const stored = await browserApi.storage.sync.get(null);
    state.entries = Object.fromEntries(
      Object.entries(stored).filter(([, value]) => isStoredEntry(value))
    );
    renderEntries();
    updateSaveButton();
  } catch (error) {
    console.error('Error loading shortcuts:', error);
    showToast('Could not load your shortcuts.', 'error');
  }
}

function renderEntries() {
  const query = elements.search.value.trim().toLocaleLowerCase();
  const entries = Object.entries(state.entries)
    .sort(([left], [right]) => left.localeCompare(right))
    .filter(([shortcut, value]) => {
      const searchableText = `${shortcut} ${value.url}`.toLocaleLowerCase();
      return searchableText.includes(query);
    });

  elements.itemList.replaceChildren();

  if (entries.length === 0) {
    const hasShortcuts = Object.keys(state.entries).length > 0;
    elements.emptyState.textContent = hasShortcuts
      ? 'No shortcuts match your search.'
      : 'No shortcuts yet. Add your first one below.';
    elements.emptyState.hidden = false;
    return;
  }

  elements.emptyState.hidden = true;
  const fragment = document.createDocumentFragment();
  entries.forEach(entry => fragment.appendChild(createEntry(entry)));
  elements.itemList.appendChild(fragment);
}

function createEntry([shortcut, value]) {
  const row = elements.entryTemplate.content.firstElementChild.cloneNode(true);
  const openButton = row.querySelector('.shortcut-open');
  const deleteButton = row.querySelector('.shortcut-delete');
  const targetLabel = getTargetLabel(value.url);

  row.querySelector('.shortcut-icon').textContent = shortcut.charAt(0).toLocaleUpperCase();
  row.querySelector('.shortcut-name').textContent = `go/${shortcut}`;
  row.querySelector('.shortcut-url').textContent = targetLabel;
  openButton.setAttribute('aria-label', `Open go/${shortcut}: ${value.url}`);
  openButton.title = value.url;
  openButton.addEventListener('click', () => openShortcut(value.url));

  deleteButton.setAttribute('aria-label', `Delete go/${shortcut}`);
  deleteButton.addEventListener('click', () => deleteShortcut(shortcut));

  return row;
}

function getTargetLabel(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return url;
  }
}

function createExportData(entries) {
  return Object.fromEntries(
    Object.entries(entries).map(([shortcut, value]) => [shortcut, value.url])
  );
}

function parseImportData(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object of shortcuts and URLs.');
  }

  const sourceEntries = Object.entries(parsed);
  if (sourceEntries.length > CONFIG.MAX_IMPORT_ENTRIES) {
    throw new Error(`Import files can contain at most ${CONFIG.MAX_IMPORT_ENTRIES} shortcuts.`);
  }

  const validEntries = sourceEntries.flatMap(([rawShortcut, value]) => {
    const shortcut = rawShortcut.trim();
    const url = typeof value === 'string' ? value : value?.url;
    if (!isValidShortcut(shortcut) || !isValidTargetUrl(url)) return [];
    return [[shortcut, { url }]];
  });

  if (validEntries.length === 0) {
    throw new Error('No valid shortcuts were found in this file.');
  }

  return {
    entries: Object.fromEntries(validEntries),
    importedCount: validEntries.length,
    skippedCount: sourceEntries.length - validEntries.length
  };
}

async function populateCurrentTabUrl() {
  try {
    const [tab] = await browserApi.tabs.query({
      active: true,
      currentWindow: true,
      lastFocusedWindow: true
    });
    if (tab?.url) elements.urlInput.value = tab.url;
  } catch (error) {
    console.error('Error reading the active tab:', error);
  }
}

function updateSaveButton() {
  const shortcut = elements.shortcutInput.value.trim();
  elements.saveButton.textContent = state.entries[shortcut] ? 'Overwrite' : 'Save shortcut';
}

async function saveShortcut() {
  const shortcut = elements.shortcutInput.value.trim();
  const url = elements.urlInput.value.trim();

  if (!isValidShortcut(shortcut)) {
    showToast('Use a shortcut without spaces or URL punctuation.', 'error');
    elements.shortcutInput.focus();
    return;
  }

  if (!isValidTargetUrl(url)) {
    showToast('Enter a valid http or https URL.', 'error');
    elements.urlInput.focus();
    return;
  }

  try {
    await browserApi.storage.sync.set({
      [shortcut]: { url }
    });
    state.entries[shortcut] = { url };
    renderEntries();
    updateSaveButton();
    showToast(`Saved go/${shortcut}.`, 'success');
  } catch (error) {
    console.error('Error saving shortcut:', error);
    showToast('Could not save the shortcut. Sync storage may be full.', 'error');
  }
}

async function openShortcut(url) {
  if (!isValidTargetUrl(url)) {
    showToast('This saved shortcut has an invalid URL.', 'error');
    return;
  }

  try {
    await browserApi.tabs.create({ active: true, url });
  } catch (error) {
    console.error('Error opening shortcut:', error);
    showToast('Could not open the shortcut.', 'error');
  }
}

async function deleteShortcut(shortcut) {
  const confirmed = await showConfirmModal(`Delete go/${shortcut}?`);
  if (!confirmed) return;

  try {
    await browserApi.storage.sync.remove(shortcut);
    delete state.entries[shortcut];
    renderEntries();
    updateSaveButton();
    showToast(`Deleted go/${shortcut}.`, 'success');
  } catch (error) {
    console.error('Error deleting shortcut:', error);
    showToast('Could not delete the shortcut.', 'error');
  }
}

async function openHelp() {
  try {
    await browserApi.tabs.create({ active: true, url: CONFIG.HELP_URL });
  } catch (error) {
    console.error('Error opening help:', error);
    showToast('Could not open the help page.', 'error');
  }
}

function exportShortcuts() {
  try {
    const exportData = createExportData(state.entries);
    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: 'application/json'
    });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = CONFIG.EXPORT_FILENAME;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    showToast('Exported your shortcuts.', 'success');
  } catch (error) {
    console.error('Error exporting shortcuts:', error);
    showToast('Could not export your shortcuts.', 'error');
  }
}

async function importShortcuts(event) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    if (file.size > CONFIG.MAX_IMPORT_BYTES) {
      throw new Error('Import file is larger than 1 MB.');
    }

    const parsed = JSON.parse(await file.text());
    const imported = parseImportData(parsed);
    await browserApi.storage.sync.set(imported.entries);
    state.entries = { ...state.entries, ...imported.entries };
    renderEntries();
    updateSaveButton();

    const suffix = imported.skippedCount > 0
      ? ` Skipped ${imported.skippedCount} invalid.`
      : '';
    showToast(
      `Imported ${imported.importedCount} shortcut${imported.importedCount === 1 ? '' : 's'}.${suffix}`,
      'success'
    );
  } catch (error) {
    console.error('Error importing shortcuts:', error);
    showToast(error.message || 'Could not import that file.', 'error');
  } finally {
    event.target.value = '';
  }
}

function showToast(message, type = 'success') {
  elements.toastMessage.textContent = message;
  elements.toast.dataset.type = type;
  elements.toast.classList.remove('hidden');

  if (state.toastTimeout) clearTimeout(state.toastTimeout);
  state.toastTimeout = setTimeout(hideToast, 3500);
}

function hideToast() {
  elements.toast.classList.add('hidden');
  if (state.toastTimeout) clearTimeout(state.toastTimeout);
  state.toastTimeout = null;
}

function showConfirmModal(message) {
  if (state.pendingConfirmation) state.pendingConfirmation(false);

  return new Promise(resolve => {
    const previousFocus = document.activeElement;
    elements.confirmTitle.textContent = message;
    elements.confirmModal.classList.remove('hidden');
    elements.confirmCancel.focus();

    const cleanup = result => {
      elements.confirmModal.classList.add('hidden');
      elements.confirmOk.onclick = null;
      elements.confirmCancel.onclick = null;
      elements.confirmModal.removeEventListener('keydown', handleKeydown);
      state.pendingConfirmation = null;
      previousFocus?.focus();
      resolve(result);
    };

    const handleKeydown = event => {
      if (event.key === 'Escape') cleanup(false);
      if (event.key !== 'Tab') return;

      if (event.shiftKey && document.activeElement === elements.confirmCancel) {
        event.preventDefault();
        elements.confirmOk.focus();
      } else if (!event.shiftKey && document.activeElement === elements.confirmOk) {
        event.preventDefault();
        elements.confirmCancel.focus();
      }
    };

    state.pendingConfirmation = cleanup;
    elements.confirmModal.addEventListener('keydown', handleKeydown);
    elements.confirmOk.onclick = () => cleanup(true);
    elements.confirmCancel.onclick = () => cleanup(false);
  });
}
