const CONFIG = {
  HELP_URL: 'https://github.com/taichikuji/Linker#functionality',
  MAX_SHORTCUT_LENGTH: 100,
  MAX_IMPORT_BYTES: 100 * 1024,
  MAX_IMPORT_ENTRIES: 500,
  ALLOWED_PROTOCOLS: ['http:', 'https:'],
  VARIABLE_TOKEN: '{*}'
};

const MAX_REGEX_RULES = chrome.declarativeNetRequest.MAX_NUMBER_OF_REGEX_RULES ?? 1000;
const REGEX_RULE_WARNING_THRESHOLD = Math.max(0, MAX_REGEX_RULES - 100);
const SYNC_MAX_ITEMS = chrome.storage.sync.MAX_ITEMS ?? 512;
const SYNC_QUOTA_BYTES = chrome.storage.sync.QUOTA_BYTES ?? 102400;
const SYNC_QUOTA_BYTES_PER_ITEM = chrome.storage.sync.QUOTA_BYTES_PER_ITEM ?? 8192;

const state = {
  entries: {},
  editingShortcut: null,
  windowId: null,
  toastTimeout: null,
  pendingConfirmation: null
};

const elements = {
  search: document.getElementById('search'),
  capacityWarning: document.getElementById('capacity-warning'),
  itemList: document.getElementById('item-list'),
  emptyState: document.getElementById('empty-state'),
  addSection: document.getElementById('add-section'),
  editorForm: document.getElementById('editor-form'),
  formTitle: document.getElementById('form-title'),
  shortcutInput: document.getElementById('go-link'),
  urlInput: document.getElementById('full-link'),
  variableBadge: document.getElementById('variable-badge'),
  fallbackField: document.getElementById('fallback-field'),
  fallbackInput: document.getElementById('fallback-link'),
  saveButton: document.getElementById('save'),
  cancelEditButton: document.getElementById('cancel-edit'),
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
  confirmIcon: document.getElementById('confirm-icon'),
  confirmLabel: document.getElementById('confirm-label'),
  confirmCancel: document.getElementById('confirm-cancel')
};

document.addEventListener('DOMContentLoaded', initialize);

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && Object.keys(changes).length > 0) loadEntries();
});

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'focus-search' && message.windowId === state.windowId) {
    focusSearch();
  }
  if (message?.type === 'rule-update-failed') {
    showToast('Shortcuts were saved, but browser routing could not be updated.', 'error');
  }
});

async function initialize() {
  setupEventListeners();
  state.windowId = (await chrome.windows.getCurrent()).id;
  await loadEntries();
  focusSearch();
}

async function prefillActiveTab() {
  if (state.editingShortcut || elements.urlInput.value || elements.shortcutInput.value) return;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!isValidTargetUrl(tab?.url)) return;
    elements.urlInput.value = tab.url;
    updateVariableFields();
  } catch (error) {
    console.error('Error reading the current tab:', error);
  }
}

function focusSearch() {
  elements.search.focus();
  elements.search.select();
}

function setupEventListeners() {
  elements.search.addEventListener('input', renderEntries);
  elements.search.addEventListener('keydown', event => {
    if (event.key === 'Enter') elements.itemList.querySelector('.shortcut-open')?.click();
  });
  elements.editorForm.addEventListener('submit', event => {
    event.preventDefault();
    return saveShortcut();
  });
  elements.urlInput.addEventListener('input', updateVariableFields);
  elements.addSection.addEventListener('toggle', () => elements.addSection.open && prefillActiveTab());
  elements.cancelEditButton.addEventListener('click', resetForm);
  elements.helpButton.addEventListener('click', openHelp);
  elements.importButton.addEventListener('click', () => elements.fileInput.click());
  elements.fileInput.addEventListener('change', importShortcuts);
  elements.exportButton.addEventListener('click', exportShortcuts);
  elements.toastClose.addEventListener('click', hideToast);
}

function isStoredEntry(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && isValidTargetUrl(value.url)
    && (!hasVariable(value.url) || isValidTargetUrl(value.fallbackUrl))
  );
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

function countRedirectRules(entries) {
  return Object.values(entries).reduce(
    (count, value) => count + (hasVariable(value.url) ? 2 : 1),
    0
  );
}

function updateCapacityWarning() {
  const ruleCount = countRedirectRules(state.entries);
  let message = '';
  let type = 'warning';

  if (ruleCount > MAX_REGEX_RULES) {
    type = 'error';
    message = `Browser limit exceeded: ${ruleCount}/${MAX_REGEX_RULES} redirect rules. Delete shortcuts to restore routing.`;
  } else if (ruleCount === MAX_REGEX_RULES) {
    type = 'error';
    message = `Browser limit reached: ${ruleCount}/${MAX_REGEX_RULES} redirect rules. Delete a shortcut before adding another.`;
  } else if (ruleCount >= REGEX_RULE_WARNING_THRESHOLD) {
    message = `Approaching browser limit: ${ruleCount}/${MAX_REGEX_RULES} redirect rules used.`;
  }

  elements.capacityWarning.textContent = message;
  elements.capacityWarning.dataset.type = type;
  elements.capacityWarning.hidden = !message;
}

async function loadEntries() {
  try {
    const stored = await chrome.storage.sync.get(null);
    state.entries = Object.fromEntries(
      Object.entries(stored).filter(([, value]) => isStoredEntry(value))
    );
    renderEntries();
    updateCapacityWarning();
  } catch (error) {
    console.error('Error loading shortcuts:', error);
    showToast('Could not load your shortcuts.', 'error');
  }
}

function renderEntries() {
  const query = elements.search.value.trim().toLocaleLowerCase();
  const entries = Object.entries(state.entries)
    .sort(([left], [right]) => left.localeCompare(right))
    .filter(([shortcut, value]) => [
      shortcut,
      value.url,
      value.fallbackUrl
    ].filter(Boolean).join(' ').toLocaleLowerCase().includes(query));

  elements.itemList.replaceChildren();

  if (entries.length === 0) {
    elements.emptyState.textContent = Object.keys(state.entries).length > 0
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
  const editButton = row.querySelector('.shortcut-edit');
  const deleteButton = row.querySelector('.shortcut-delete');
  const parameterized = hasVariable(value.url);
  const openUrl = parameterized ? value.fallbackUrl : value.url;

  row.querySelector('.shortcut-icon').textContent = shortcut.charAt(0).toLocaleUpperCase();
  row.querySelector('.shortcut-name').textContent = `go/${shortcut}`;
  row.querySelector('.variable-badge').hidden = !parameterized;
  row.querySelector('.shortcut-url').textContent = getTargetLabel(openUrl);
  openButton.setAttribute(
    'aria-label',
    `Open ${parameterized ? 'parameterized shortcut ' : ''}go/${shortcut}: ${openUrl}`
  );
  openButton.title = openUrl;
  openButton.addEventListener('click', () => openShortcut(openUrl));

  editButton.setAttribute('aria-label', `Edit go/${shortcut}`);
  editButton.addEventListener('click', () => startEditing(shortcut));
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

function startEditing(shortcut) {
  const entry = state.entries[shortcut];
  if (!entry) return;

  state.editingShortcut = shortcut;
  elements.shortcutInput.value = shortcut;
  elements.urlInput.value = entry.url;
  elements.fallbackInput.value = entry.fallbackUrl ?? '';
  elements.formTitle.textContent = `Edit go/${shortcut}`;
  elements.saveButton.textContent = 'Save changes';
  elements.cancelEditButton.hidden = false;
  updateVariableFields();
  elements.addSection.open = true;
  elements.urlInput.focus();
}

function resetForm() {
  state.editingShortcut = null;
  elements.shortcutInput.value = '';
  elements.urlInput.value = '';
  elements.fallbackInput.value = '';
  elements.formTitle.textContent = 'Add new shortcut';
  elements.saveButton.textContent = 'Save shortcut';
  elements.cancelEditButton.hidden = true;
  updateVariableFields();
}

function updateVariableFields() {
  const parameterized = hasVariable(elements.urlInput.value);
  elements.variableBadge.hidden = !parameterized;
  elements.fallbackField.hidden = !parameterized;
  elements.fallbackInput.disabled = !parameterized;
  elements.fallbackInput.required = parameterized;
}

async function saveShortcut() {
  const originalShortcut = state.editingShortcut;
  const shortcut = elements.shortcutInput.value.trim().toLowerCase();
  const url = elements.urlInput.value.trim();
  const fallbackUrl = elements.fallbackInput.value.trim();

  if (!isValidShortcut(shortcut)) {
    showToast('Use a shortcut without spaces or URL punctuation.', 'error');
    elements.shortcutInput.focus();
    return;
  }

  if (state.entries[shortcut] && shortcut !== originalShortcut) {
    showToast(`go/${shortcut} already exists. Edit that shortcut instead.`, 'error');
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

  const nextEntries = { ...state.entries };
  if (originalShortcut && originalShortcut !== shortcut) delete nextEntries[originalShortcut];
  nextEntries[shortcut] = entry;

  if (countRedirectRules(nextEntries) > MAX_REGEX_RULES) {
    showToast(`Cannot save: browser limit is ${MAX_REGEX_RULES} redirect rules.`, 'error');
    return;
  }

  try {
    await chrome.storage.sync.set({ [shortcut]: entry });
    if (originalShortcut && originalShortcut !== shortcut) {
      await chrome.storage.sync.remove(originalShortcut);
    }

    state.entries = nextEntries;
    renderEntries();
    updateCapacityWarning();
    resetForm();
    showToast(`${originalShortcut ? 'Updated' : 'Saved'} go/${shortcut}.`, 'success');
  } catch (error) {
    console.error('Error saving shortcut:', error);
    await loadEntries();
    showToast('Could not save the shortcut. Sync storage may be full.', 'error');
  }
}

async function openShortcut(url) {
  try {
    await chrome.tabs.create({ active: true, url });
  } catch (error) {
    console.error('Error opening shortcut:', error);
    showToast('Could not open the shortcut.', 'error');
  }
}

async function deleteShortcut(shortcut) {
  const confirmed = await showConfirmModal(`Delete go/${shortcut}?`);
  if (!confirmed) return;

  try {
    await chrome.storage.sync.remove(shortcut);
    delete state.entries[shortcut];
    if (state.editingShortcut === shortcut) resetForm();
    renderEntries();
    updateCapacityWarning();
    showToast(`Deleted go/${shortcut}.`, 'success');
  } catch (error) {
    console.error('Error deleting shortcut:', error);
    showToast('Could not delete the shortcut.', 'error');
  }
}

async function openHelp() {
  try {
    await chrome.tabs.create({ active: true, url: CONFIG.HELP_URL });
  } catch (error) {
    console.error('Error opening help:', error);
    showToast('Could not open the help page.', 'error');
  }
}

function createExportData(entries) {
  return Object.fromEntries(
    Object.entries(entries).map(([shortcut, value]) => {
      if (!hasVariable(value.url)) return [shortcut, value.url];
      return [shortcut, { url: value.url, fallbackUrl: value.fallbackUrl }];
    })
  );
}

function exportShortcuts() {
  try {
    const blob = new Blob([JSON.stringify(createExportData(state.entries), null, 2)], {
      type: 'application/json'
    });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = `linker-export-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    showToast('Exported your shortcuts.', 'success');
  } catch (error) {
    console.error('Error exporting shortcuts:', error);
    showToast('Could not export your shortcuts.', 'error');
  }
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
    const shortcut = rawShortcut.trim().toLowerCase();
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

  const entries = Object.fromEntries(validEntries);
  const importedCount = Object.keys(entries).length;
  return {
    entries,
    importedCount,
    skippedCount: sourceEntries.length - importedCount
  };
}

function serializedEntryBytes(shortcut, entry) {
  return new Blob([shortcut, JSON.stringify(entry)]).size;
}

async function ensureImportFitsSyncStorage(importedEntries) {
  const shortcuts = Object.keys(importedEntries);
  const oversized = shortcuts.find(shortcut =>
    serializedEntryBytes(shortcut, importedEntries[shortcut]) > SYNC_QUOTA_BYTES_PER_ITEM
  );
  if (oversized) throw new Error(`go/${oversized} is too large for browser sync storage.`);

  const stored = await chrome.storage.sync.get(null);
  const projectedItems = new Set([...Object.keys(stored), ...shortcuts]).size;
  if (projectedItems > SYNC_MAX_ITEMS) {
    throw new Error(`Import exceeds the browser limit of ${SYNC_MAX_ITEMS} synced shortcuts.`);
  }

  const [usedBytes, replacedBytes] = await Promise.all([
    chrome.storage.sync.getBytesInUse(null),
    chrome.storage.sync.getBytesInUse(shortcuts)
  ]);
  const importedBytes = Object.entries(importedEntries).reduce(
    (bytes, [shortcut, entry]) => bytes + serializedEntryBytes(shortcut, entry),
    0
  );
  if (usedBytes - replacedBytes + importedBytes > SYNC_QUOTA_BYTES) {
    throw new Error('Import exceeds the browser sync-storage quota.');
  }
}

async function importShortcuts(event) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    if (file.size > CONFIG.MAX_IMPORT_BYTES) {
      throw new Error('Import file is larger than 100 KB.');
    }

    const imported = parseImportData(JSON.parse(await file.text()));
    const nextEntries = { ...state.entries, ...imported.entries };

    if (countRedirectRules(nextEntries) > MAX_REGEX_RULES) {
      throw new Error(`Import exceeds the browser limit of ${MAX_REGEX_RULES} redirect rules.`);
    }
    await ensureImportFitsSyncStorage(imported.entries);

    const replacementCount = Object.keys(imported.entries)
      .filter(shortcut => shortcut in state.entries)
      .length;
    if (replacementCount > 0) {
      const confirmed = await showConfirmModal(
        `Import will replace ${replacementCount} existing shortcut${replacementCount === 1 ? '' : 's'}. Continue?`,
        { confirmLabel: 'Import', danger: false }
      );
      if (!confirmed) return;
    }

    await chrome.storage.sync.set(imported.entries);
    state.entries = nextEntries;
    renderEntries();
    updateCapacityWarning();

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

function showConfirmModal(message, { confirmLabel = 'Delete', danger = true } = {}) {
  if (state.pendingConfirmation) state.pendingConfirmation(false);

  return new Promise(resolve => {
    const previousFocus = document.activeElement;
    elements.confirmTitle.textContent = message;
    elements.confirmLabel.textContent = confirmLabel;
    elements.confirmIcon.hidden = !danger;
    elements.confirmOk.className = danger ? 'danger-button' : 'primary-button';
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
