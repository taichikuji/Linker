// Sync storage is the source of truth. The background worker converts entries
// into declarative redirect rules whenever this side panel changes storage.
const CONFIG = {
  HELP_URL: 'https://github.com/taichikuji/Linker/wiki/How-to-use-Linker',
  MAX_SHORTCUT_LENGTH: 100,
  MAX_IMPORT_BYTES: 100 * 1024,
  MAX_IMPORT_ENTRIES: 500,
  ALLOWED_PROTOCOLS: ['http:', 'https:'],
  VARIABLE_TOKEN: '{*}'
};

const MAX_REGEX_RULES = chrome.declarativeNetRequest.MAX_NUMBER_OF_REGEX_RULES;
const REGEX_RULE_WARNING_THRESHOLD = Math.max(0, MAX_REGEX_RULES - 100);

const state = {
  entries: {},
  editingShortcut: null,
  savedResult: null,
  testingShortcut: false,
  windowId: null,
  toastTimeout: null
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
  destinationHints: document.getElementById('destination-hints'),
  variableBadge: document.getElementById('variable-badge'),
  fallbackField: document.getElementById('fallback-field'),
  fallbackInput: document.getElementById('fallback-link'),
  saveButton: document.getElementById('save'),
  cancelEditButton: document.getElementById('cancel-edit'),
  savedActions: document.getElementById('saved-actions'),
  testButton: document.getElementById('test-shortcut'),
  savedEditButton: document.getElementById('edit-saved'),
  moreButton: document.getElementById('more-button'),
  actionsMenu: document.getElementById('actions-menu'),
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
  confirmDescription: document.getElementById('confirm-description'),
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
  if (state.editingShortcut) return;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!elements.addSection.open || state.editingShortcut) return;
    elements.urlInput.value = isValidTargetUrl(tab?.url) ? tab.url : '';
    updateVariableFields();
    renderDestinationHints();
  } catch (error) {
    console.error('Error reading the current tab:', error);
  }
}

function focusSearch() {
  elements.search.focus();
  elements.search.select();
}

async function prefillNewShortcut() {
  elements.urlInput.value = '';
  updateVariableFields();
  renderDestinationHints();
  try {
    if (await chrome.permissions.request({ permissions: ['tabs'] })) await prefillActiveTab();
  } catch (error) {
    console.error('Error requesting tab access:', error);
  }
}

function setupEventListeners() {
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !elements.confirmModal.open
      && elements.toast.matches(':popover-open')) hideToast();
    if (event.key.toLowerCase() !== 'f' || !(event.metaKey || event.ctrlKey)
      || event.altKey || event.shiftKey || elements.confirmModal.open) return;
    const target = event.target;
    if (target !== elements.search && (target.isContentEditable || target.matches?.('input, textarea, select'))) return;
    event.preventDefault();
    focusSearch();
  });
  elements.search.addEventListener('input', renderEntries);
  elements.search.addEventListener('keydown', event => {
    if (event.key === 'Enter') elements.itemList.querySelector('.shortcut-open')?.click();
  });
  elements.editorForm.addEventListener('submit', event => {
    event.preventDefault();
    return saveShortcut();
  });
  [elements.urlInput, elements.shortcutInput, elements.fallbackInput].forEach(input => {
    input.addEventListener('input', () => {
      clearSavedResult();
      updateVariableFields();
      renderDestinationHints();
    });
  });
  elements.addSection.querySelector('summary').addEventListener('click', async () => {
    if (elements.addSection.open || state.editingShortcut) return;
    clearSavedResult();
    await prefillNewShortcut();
  });
  elements.cancelEditButton.addEventListener('click', () => {
    resetForm();
    elements.addSection.open = false;
    elements.addSection.querySelector('summary').focus();
  });
  elements.testButton.addEventListener('click', testSavedShortcut);
  elements.savedEditButton.addEventListener('click', () => {
    if (state.savedResult) startEditing(state.savedResult.shortcut);
  });
  ['pointerenter', 'pointerleave', 'focusin'].forEach(type => {
    elements.toast.addEventListener(type, scheduleToastDismissal);
  });
  elements.toast.addEventListener('focusout', () => setTimeout(scheduleToastDismissal, 0));
  // Close the popover before its action opens a tab, file picker, or dialog.
  elements.actionsMenu.addEventListener('click', () => {
    elements.actionsMenu.hidePopover();
    elements.moreButton.focus();
  }, { capture: true });
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
    && !/[\s/?#&%\\]/u.test(shortcut)
    && new URL(`http://go/${shortcut}`).pathname === `/${shortcut}`;
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

  if (ruleCount >= MAX_REGEX_RULES) {
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
    const saved = state.savedResult;
    const current = saved && Object.hasOwn(state.entries, saved.shortcut)
      ? state.entries[saved.shortcut] : null;
    if (saved && (!current || current.url !== saved.entry.url
      || current.fallbackUrl !== saved.entry.fallbackUrl)) hideToast();
    renderEntries();
    updateCapacityWarning();
    renderDestinationHints();
  } catch (error) {
    console.error('Error loading shortcuts:', error);
    showToast('Could not load your shortcuts.', 'error');
  }
}

function renderDestinationHints() {
  elements.destinationHints.replaceChildren();
  elements.destinationHints.hidden = true;
  if (state.savedResult || !isValidTargetUrl(elements.urlInput.value)) return;

  const destination = new URL(elements.urlInput.value).href;
  Object.entries(state.entries)
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([shortcut, value]) => {
      if (shortcut === state.editingShortcut) return;
      const exact = new URL(value.url).href === destination;
      const defaultMatch = hasVariable(value.url)
        && new URL(value.fallbackUrl).href === destination;
      if (!exact && !defaultMatch) return;

      const row = document.createElement('li');
      const label = document.createElement('span');
      const edit = document.createElement('button');
      label.textContent = `${exact ? 'Already saved as' : 'Default destination for'} go/${shortcut}`;
      edit.type = 'button';
      edit.textContent = 'Edit';
      edit.setAttribute('aria-label', `Edit go/${shortcut}`);
      edit.addEventListener('click', () => startEditing(shortcut));
      row.appendChild(label);
      row.appendChild(edit);
      elements.destinationHints.appendChild(row);
    });
  elements.destinationHints.hidden = elements.destinationHints.children.length === 0;
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

// Keep shortcut names and imported text out of HTML parsing.
function highlightText(element, value) {
  const query = elements.search.value.trim();
  element.textContent = value;
  if (!query) return;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = value.split(new RegExp(`(${escaped})`, 'gi'));
  element.replaceChildren(...parts.map((part, index) => index % 2
    ? Object.assign(document.createElement('mark'), { textContent: part })
    : document.createTextNode(part)));
}

function createEntry([shortcut, value]) {
  const row = elements.entryTemplate.content.firstElementChild.cloneNode(true);
  const openButton = row.querySelector('.shortcut-open');
  const editButton = row.querySelector('.shortcut-edit');
  const deleteButton = row.querySelector('.shortcut-delete');
  const parameterized = hasVariable(value.url);
  const openUrl = parameterized ? value.fallbackUrl : value.url;
  const icon = row.querySelector('.shortcut-icon');
  const favicon = document.createElement('img');

  favicon.className = 'shortcut-favicon';
  favicon.alt = '';
  favicon.src = chrome.runtime.getURL(`_favicon/?pageUrl=${encodeURIComponent(openUrl)}&size=32`);
  favicon.onerror = () => {
    icon.replaceChildren();
    icon.classList.add('shortcut-icon-fallback');
    icon.textContent = shortcut.charAt(0).toLocaleUpperCase();
  };
  icon.appendChild(favicon);
  highlightText(row.querySelector('.shortcut-name'), `go/${shortcut}`);
  row.querySelector('.variable-badge').hidden = !parameterized;
  highlightText(row.querySelector('.shortcut-url'), getTargetLabel(openUrl));
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
  const parsed = new URL(url);
  return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`;
}

function startEditing(shortcut) {
  const entry = state.entries[shortcut];
  if (!entry) return;

  clearSavedResult();
  state.editingShortcut = shortcut;
  elements.shortcutInput.value = shortcut;
  elements.urlInput.value = entry.url;
  elements.fallbackInput.value = entry.fallbackUrl ?? '';
  elements.formTitle.textContent = `Edit go/${shortcut}`;
  elements.saveButton.textContent = 'Save changes';
  updateVariableFields();
  renderDestinationHints();
  elements.addSection.open = true;
  elements.urlInput.focus();
}

function resetForm() {
  clearSavedResult();
  elements.destinationHints.replaceChildren();
  elements.destinationHints.hidden = true;
  state.editingShortcut = null;
  elements.shortcutInput.value = '';
  elements.fallbackInput.value = '';
  elements.formTitle.textContent = 'Add new shortcut';
  elements.saveButton.textContent = 'Save shortcut';
}

function clearSavedResult() {
  if (state.savedResult) hideToast();
}

async function testSavedShortcut() {
  if (!state.savedResult || state.testingShortcut) return;
  const saved = state.savedResult;
  state.testingShortcut = true;
  elements.testButton.disabled = true;
  scheduleToastDismissal();
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'test-shortcut', shortcut: saved.shortcut
    });
    if (!response?.ok) throw new Error(response?.error || 'Could not test the shortcut.');
    if (state.savedResult === saved) hideToast();
  } catch (error) {
    if (state.savedResult === saved) {
      showToast(error.message || 'Could not test the shortcut.', 'error', saved);
    }
  } finally {
    state.testingShortcut = false;
    elements.testButton.disabled = false;
    scheduleToastDismissal();
  }
}

function updateVariableFields() {
  // A parameterized URL needs a second, non-parameterized destination for go/name.
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
    showToast('Use a URL-safe shortcut without spaces or accents.', 'error');
    elements.shortcutInput.focus();
    return;
  }

  if (Object.hasOwn(state.entries, shortcut) && shortcut !== originalShortcut) {
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

  const nextEntries = { ...state.entries, [shortcut]: entry };
  if (originalShortcut && originalShortcut !== shortcut) delete nextEntries[originalShortcut];

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
    elements.addSection.open = false;
    focusSearch();
    showToast(`${originalShortcut ? 'Updated' : 'Saved'} go/${shortcut}.`, 'success', { shortcut, entry });
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
    const replacementCount = Object.keys(imported.entries)
      .filter(shortcut => Object.hasOwn(state.entries, shortcut))
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

function showToast(message, type = 'success', saved = null) {
  if (!saved && elements.savedActions.contains(document.activeElement)) focusSearch();
  state.savedResult = saved;
  elements.savedActions.hidden = !saved;
  if (saved) {
    elements.testButton.setAttribute('aria-label', `Test shortcut go/${saved.shortcut}`);
    elements.savedEditButton.setAttribute('aria-label', `Edit go/${saved.shortcut}`);
  }
  elements.toastMessage.textContent = message;
  elements.toast.dataset.type = type;
  elements.toast.showPopover();
  scheduleToastDismissal();
}

function scheduleToastDismissal() {
  clearTimeout(state.toastTimeout);
  state.toastTimeout = null;
  if (!elements.toast.matches(':popover-open') || state.testingShortcut
    || elements.toast.matches(':hover, :focus-within')) return;
  state.toastTimeout = setTimeout(hideToast, state.savedResult ? 8000 : 3500);
}

function hideToast() {
  const restoreFocus = elements.toast.contains(document.activeElement);
  elements.toast.hidePopover();
  clearTimeout(state.toastTimeout);
  state.toastTimeout = null;
  state.savedResult = null;
  elements.savedActions.hidden = true;
  if (restoreFocus) focusSearch();
}

function showConfirmModal(message, { confirmLabel = 'Delete', danger = true } = {}) {
  return new Promise(resolve => {
    const previousFocus = document.activeElement;
    elements.confirmTitle.textContent = danger ? 'Delete shortcut?' : 'Replace shortcuts?';
    elements.confirmDescription.textContent = message;
    elements.confirmLabel.textContent = confirmLabel;
    elements.confirmIcon.toggleAttribute('hidden', !danger);
    elements.confirmOk.className = danger ? 'danger filled' : 'primary filled';
    elements.confirmModal.returnValue = '';

    const finish = result => {
      elements.confirmOk.onclick = null;
      elements.confirmCancel.onclick = null;
      elements.confirmModal.removeEventListener('close', handleClose);
      previousFocus?.focus();
      resolve(result);
    };

    // Native dialog emits close for buttons and Escape; returnValue identifies confirmation.
    const handleClose = () => {
      finish(elements.confirmModal.returnValue === 'confirm');
    };

    const close = value => elements.confirmModal.close(value);

    elements.confirmModal.addEventListener('close', handleClose);
    elements.confirmOk.onclick = () => close('confirm');
    elements.confirmCancel.onclick = () => close('cancel');
    elements.confirmModal.showModal();
    elements.confirmCancel.focus();
  });
}
