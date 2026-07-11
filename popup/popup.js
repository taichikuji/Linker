// Constants and Configuration
const CONFIG = {
  HELP_URL: 'https://github.com/taichikuji/Linker#user-guide',
  EXPORT_FILENAME: 'linker.json',
  MAX_SHORTCUT_LENGTH: 100,
  MAX_IMPORT_BYTES: 1024 * 1024,
  MAX_IMPORT_ENTRIES: 500,
  ALLOWED_PROTOCOLS: ['http:', 'https:'],
  VARIABLE_TOKEN: '{*}'
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
  variableBadge: document.getElementById('variable-badge'),
  fallbackField: document.getElementById('fallback-field'),
  fallbackInput: document.getElementById('fallback-link'),
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
  updateVariableFields();
}

function setupEventListeners() {
  elements.search.addEventListener('input', renderEntries);
  elements.shortcutInput.addEventListener('input', updateSaveButton);
  elements.urlInput.addEventListener('input', updateVariableFields);
  elements.saveButton.addEventListener('click', saveShortcut);
  elements.helpButton.addEventListener('click', openHelp);
  elements.importButton.addEventListener('click', () => elements.fileInput.click());
  elements.fileInput.addEventListener('change', importShortcuts);
  elements.exportButton.addEventListener('click', exportShortcuts);
  elements.toastClose.addEventListener('click', hideToast);
}

function isStoredEntry(value) {
  if (!value || typeof value !== 'object' || !isValidTargetUrl(value.url)) {
    return false;
  }

  if (hasVariable(value.url) && !isValidTargetUrl(value.fallbackUrl)) {
    return false;
  }

  return true;
}

function isValidShortcut(shortcut) {
  return shortcut.length > 0
    && shortcut.length <= CONFIG.MAX_SHORTCUT_LENGTH
    && !/[\s/?#&%\\]/u.test(shortcut);
}

function isValidTargetUrl(url) {
  if (typeof url !== 'string') return false;

  try {
    return CONFIG.ALLOWED_PROTOCOLS.includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function hasVariable(url) {
  return url.includes(CONFIG.VARIABLE_TOKEN);
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
      const searchableText = [
        shortcut,
        value.url,
        value.fallbackUrl
      ].filter(Boolean).join(' ').toLocaleLowerCase();
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
  const parameterized = hasVariable(value.url);
  const openUrl = parameterized ? value.fallbackUrl : value.url;
  const targetLabel = getTargetLabel(openUrl);

  row.querySelector('.shortcut-icon').textContent = shortcut.charAt(0).toLocaleUpperCase();
  row.querySelector('.shortcut-name').textContent = `go/${shortcut}`;
  row.querySelector('.variable-badge').hidden = !parameterized;
  row.querySelector('.shortcut-url').textContent = targetLabel;
  openButton.setAttribute(
    'aria-label',
    `Open ${parameterized ? 'parameterized shortcut ' : ''}go/${shortcut}: ${openUrl}`
  );
  openButton.title = openUrl;
  openButton.addEventListener('click', () => openShortcut(openUrl));

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
    Object.entries(entries).map(([shortcut, value]) => {
      const exportedValue = { url: value.url };

      if (hasVariable(value.url)) {
        exportedValue.fallbackUrl = value.fallbackUrl;
      }

      return [
        shortcut,
        Object.keys(exportedValue).length === 1 ? value.url : exportedValue
      ];
    })
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
    const rawUrl = typeof value === 'string' ? value : value?.url;
    const rawFallbackUrl = typeof value === 'object' ? value?.fallbackUrl : undefined;
    const url = typeof rawUrl === 'string' ? rawUrl.trim() : rawUrl;
    const fallbackUrl = typeof rawFallbackUrl === 'string'
      ? rawFallbackUrl.trim()
      : rawFallbackUrl;

    if (!isValidShortcut(shortcut) || !isValidTargetUrl(url)) return [];
    if (hasVariable(url) && !isValidTargetUrl(fallbackUrl)) return [];

    const entry = { url };
    if (hasVariable(url)) entry.fallbackUrl = fallbackUrl;

    return [[shortcut, entry]];
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

function updateVariableFields() {
  const parameterized = hasVariable(elements.urlInput.value);
  elements.variableBadge.hidden = !parameterized;
  elements.fallbackField.hidden = !parameterized;
  elements.fallbackInput.disabled = !parameterized;
  elements.fallbackInput.required = parameterized;
}

async function saveShortcut() {
  const shortcut = elements.shortcutInput.value.trim();
  const url = elements.urlInput.value.trim();
  const fallbackUrl = elements.fallbackInput.value.trim();

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

  if (hasVariable(url) && !isValidTargetUrl(fallbackUrl)) {
    showToast('Enter a valid default URL for an empty variable.', 'error');
    elements.fallbackInput.focus();
    return;
  }

  const entry = { url };
  if (hasVariable(url)) entry.fallbackUrl = fallbackUrl;

  try {
    await browserApi.storage.sync.set({
      [shortcut]: entry
    });
    state.entries[shortcut] = entry;
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
