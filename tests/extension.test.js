const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('bun:test');
const vm = require('node:vm');

const root = join(__dirname, '..');
const backgroundSource = readFileSync(
  join(root, 'src/background/service-worker.js'),
  'utf8'
);
const managerSource = readFileSync(
  join(root, 'src/manager/manager.js'),
  'utf8'
);
const managerStyles = readFileSync(
  join(root, 'src/manager/manager.css'),
  'utf8'
);
const clone = value => JSON.parse(JSON.stringify(value));

function eventSlot(listeners, name) {
  return {
    addListener(listener) {
      listeners[name] = listener;
    }
  };
}

function runBackground(options = {}) {
  const listeners = {};
  const runtimeMessages = [];
  const openedPanels = [];
  const navigations = [];
  const appliedUpdates = [];
  const errors = [];
  let ruleUpdateCalls = 0;
  let resolveUpdate;
  const updated = new Promise(resolve => {
    resolveUpdate = resolve;
  });

  const api = {
    declarativeNetRequest: {
      MAX_NUMBER_OF_REGEX_RULES: 1000,
      getDynamicRules: async () => [{ id: 99 }],
      updateDynamicRules: async details => {
        ruleUpdateCalls += 1;
        await options.beforeRuleUpdate?.(clone(details), ruleUpdateCalls);
        if (ruleUpdateCalls === options.failRuleUpdateAt) {
          throw new Error('Rule update failed');
        }
        appliedUpdates.push(clone(details));
        resolveUpdate(clone(details));
      }
    },
    runtime: {
      onMessage: eventSlot(listeners, 'runtimeMessage'),
      sendMessage: async message => runtimeMessages.push(clone(message))
    },
    action: {
      onClicked: {
        addListener: listener => {
          listeners.actionClicked = listener;
        }
      }
    },
    omnibox: {
      onInputChanged: eventSlot(listeners, 'omniboxInputChanged'),
      onInputEntered: eventSlot(listeners, 'omniboxInputEntered')
    },
    tabs: {
      update: async details => navigations.push(['update', clone(details)]),
      create: async details => {
        if (options.failTabCreate) throw new Error('Tab could not be opened');
        navigations.push(['create', clone(details)]);
      }
    },
    storage: {
      sync: {
        get: async () => options.getEntries?.() ?? options.entries ?? ({
          gh: { url: 'https://github.com/' },
          issue: {
            url: 'https://github.com/taichikuji/Linker/issues/{*}',
            fallbackUrl: 'https://github.com/taichikuji/Linker/issues'
          },
          ignored: { url: 'javascript:alert(1)' }
        })
      },
      onChanged: {
        addListener: listener => {
          listeners.storageChanged = listener;
        }
      }
    },
    sidePanel: {
      open: async details => {
        openedPanels.push(clone(details));
      }
    }
  };

  const context = vm.createContext({
    chrome: api,
    URL,
    console: { error: (...args) => errors.push(args) }
  });
  vm.runInContext(backgroundSource, context);

  return {
    listeners,
    updated,
    runtimeMessages,
    errors,
    openedPanels,
    navigations,
    appliedUpdates,
    getRuleUpdateCalls: () => ruleUpdateCalls
  };
}

function runManager(initialEntries = {}, options = {}) {
  const listeners = {};
  const elements = new Map();
  const tabQueries = [];
  const permissionRequests = [];
  const openedTabs = [];
  const runtimeMessages = [];
  const errors = [];
  let entries = clone(initialEntries);

  const document = {
    activeElement: null,
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    createDocumentFragment() {
      return { nodeType: 11, children: [], appendChild(child) { this.children.push(child); } };
    },
    createElement(tagName) {
      return createElement(tagName);
    },
    createTextNode(textContent) {
      return { nodeType: 3, textContent };
    },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement());
      return elements.get(id);
    }
  };

  function createElement(tagName = 'div') {
    const eventListeners = {};
    const classes = new Set(['hidden']);
    const queried = new Map();
    return {
      tagName: tagName.toUpperCase(),
      children: [],
      classList: {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        contains: name => classes.has(name)
      },
      dataset: {},
      files: [],
      hidden: false,
      disabled: false,
      value: '',
      addEventListener(type, listener) {
        eventListeners[type] = listener;
      },
      removeEventListener(type) {
        delete eventListeners[type];
      },
      async dispatch(type, event = {}) {
        return eventListeners[type]?.({ preventDefault() {}, target: this, ...event });
      },
      appendChild(child) {
        this.children.push(...(child.nodeType === 11 ? child.children : [child]));
      },
      click() {
        return eventListeners.click?.({ target: this }) ?? this.onclick?.();
      },
      close(value = '') {
        this.open = false;
        this.returnValue = value;
        return eventListeners.close?.({ target: this });
      },
      cloneNode() {
        return createElement();
      },
      focus() {
        document.activeElement = this;
      },
      querySelector(selector) {
        if (this === elements.get('item-list')) return this.children[0]?.querySelector(selector) ?? null;
        if (!queried.has(selector)) queried.set(selector, createElement());
        return queried.get(selector);
      },
      replaceChildren(...children) {
        this.children = children;
      },
      select() {
        this.selectionStart = 0;
        this.selectionEnd = this.value.length;
      },
      showModal() {
        this.open = true;
      },
      showPopover() {
        this.popoverOpen = true;
      },
      hidePopover() {
        this.popoverOpen = false;
      },
      matches(selector) {
        return selector === ':popover-open' && Boolean(this.popoverOpen);
      },
      toggleAttribute(name, force) {
        this[name] = force;
      },
      setAttribute(name, value) {
        this[name] = value;
      }
    };
  }

  const template = document.getElementById('shortcut-template');
  template.content = { firstElementChild: createElement() };
  document.getElementById('destination-hints').hidden = true;
  document.getElementById('saved-result').hidden = true;

  const api = {
    declarativeNetRequest: {
      MAX_NUMBER_OF_REGEX_RULES: 1000
    },
    permissions: {
      request: async details => {
        permissionRequests.push(clone(details));
        return options.tabsGranted ?? true;
      }
    },
    runtime: {
      getURL: path => `chrome-extension://linker/${path}`,
      sendMessage: async message => {
        runtimeMessages.push(clone(message));
        return options.sendMessage ? options.sendMessage(clone(message)) : { ok: true };
      },
      onMessage: eventSlot(listeners, 'runtimeMessage')
    },
    storage: {
      sync: {
        get: async () => clone(entries),
        remove: async key => {
          delete entries[key];
        },
        set: async values => {
          if (options.failStorageSet) throw new Error('Storage write failed');
          entries = { ...entries, ...clone(values) };
        }
      },
      onChanged: eventSlot(listeners, 'storageChanged')
    },
    tabs: {
      create: async details => openedTabs.push(clone(details)),
      query: async details => {
        tabQueries.push(clone(details));
        return options.activeTab ? [clone(options.activeTab)] : [];
      }
    },
    windows: {
      getCurrent: async () => ({ id: options.windowId ?? 9 })
    }
  };

  const context = vm.createContext({
    chrome: api,
    Blob,
    URL,
    clearTimeout() {},
    console: { error: (...args) => errors.push(args) },
    document,
    setTimeout: () => 0
  });
  vm.runInContext(managerSource, context);

  return {
    context,
    elements,
    listeners,
    tabQueries,
    permissionRequests,
    openedTabs,
    runtimeMessages,
    errors,
    getEntries: () => clone(entries),
    setEntries: value => { entries = clone(value); }
  };
}

function sendBackgroundMessage(result, message) {
  return new Promise(resolve => {
    const keepOpen = result.listeners.runtimeMessage(message, {}, response => resolve(clone(response)));
    assert.equal(keepOpen, true);
  });
}

async function toggleEditor(result) {
  const section = result.elements.get('add-section');
  const clicking = section.querySelector('summary').dispatch('click');
  section.open = !section.open;
  await clicking;
}

async function saveManagerShortcut(result, shortcut, url = 'https://example.com/docs') {
  if (Object.hasOwn(result.getEntries(), shortcut)) {
    vm.runInContext(`startEditing(${JSON.stringify(shortcut)})`, result.context);
  } else if (!result.elements.get('saved-result').hidden) {
    await result.elements.get('add-another').click();
  }
  result.elements.get('add-section').open = true;
  result.elements.get('go-link').value = shortcut;
  result.elements.get('full-link').value = url;
  await result.elements.get('full-link').dispatch('input');
  await result.elements.get('editor-form').dispatch('submit');
}

test('destination hints match parsed URLs while preserving paths, queries, and fragments', async () => {
  const destination = 'https://example.com/docs?view=all#top';
  const result = runManager({
    zulu: { url: destination },
    alpha: { url: 'https://EXAMPLE.com:443/docs?view=all#top' }
  });
  await vm.runInContext('initialize()', result.context);
  const input = result.elements.get('full-link');
  const hints = result.elements.get('destination-hints');

  for (const url of [destination, ' https://EXAMPLE.com:443/docs?view=all#top ']) {
    input.value = url;
    await input.dispatch('input');
    assert.equal(hints.hidden, false);
    assert.deepEqual(hints.children.map(row => row.children[0].textContent), [
      'Already saved as go/alpha', 'Already saved as go/zulu'
    ]);
    assert.equal(input.value, url);
  }
  for (const url of [
    '', 'not a URL', 'javascript:alert(1)', 'http://example.com/docs?view=all#top',
    'https://example.com/docs/?view=all#top', 'https://example.com/Docs?view=all#top',
    'https://example.com/docs?view=other#top', 'https://example.com/docs?view=all#other',
    'https://example.com/docs?view=all', 'https://example.com/elsewhere'
  ]) {
    input.value = url;
    await input.dispatch('input');
    assert.equal(hints.hidden, true, url);
    assert.equal(hints.children.length, 0, url);
  }
  assert.deepEqual(result.getEntries(), {
    zulu: { url: destination }, alpha: { url: 'https://EXAMPLE.com:443/docs?view=all#top' }
  });
});

test('destination hints distinguish literal templates and default destinations and render text safely', async () => {
  const result = runManager({
    issue: { url: 'https://example.com/issues/{*}', fallbackUrl: 'https://example.com/issues' },
    'a<b&c': { url: 'https://example.com/issues' }
  });
  await vm.runInContext('initialize()', result.context);
  const input = result.elements.get('full-link');
  const hints = result.elements.get('destination-hints');

  input.value = 'https://example.com/issues';
  await input.dispatch('input');
  assert.deepEqual(hints.children.map(row => row.children[0].textContent), [
    'Already saved as go/a<b&c', 'Default destination for go/issue'
  ]);
  assert.equal(hints.children[0].children[0].tagName, 'SPAN');
  assert.equal(hints.children[0].children[0].children.length, 0);
  input.value = 'https://example.com/issues/{*}';
  await input.dispatch('input');
  assert.deepEqual(hints.children.map(row => row.children[0].textContent), ['Already saved as go/issue']);
  input.value = 'https://example.com/issues/123';
  await input.dispatch('input');
  assert.equal(hints.hidden, true);
});

test('destination hints edit existing shortcuts, exclude the current edit, and allow another name', async () => {
  const result = runManager({ docs: { url: 'https://example.com/docs' } });
  await vm.runInContext('initialize()', result.context);
  const input = result.elements.get('full-link');
  const hints = result.elements.get('destination-hints');
  input.value = 'https://example.com/docs';
  await input.dispatch('input');
  const edit = hints.children[0].children[1];
  assert.equal(edit.type, 'button');
  assert.equal(edit['aria-label'], 'Edit go/docs');
  await edit.click();
  assert.equal(result.elements.get('form-title').textContent, 'Edit go/docs');
  assert.equal(result.context.document.activeElement, input);
  assert.equal(hints.hidden, true);

  await result.elements.get('cancel-edit').dispatch('click');
  await saveManagerShortcut(result, 'another');
  assert.deepEqual(result.getEntries(), {
    docs: { url: 'https://example.com/docs' }, another: { url: 'https://example.com/docs' }
  });
});

test('destination hints refresh after prefill, sync, and starting an edit without changing the draft', async () => {
  const result = runManager({ docs: { url: 'https://example.com/docs' } }, {
    activeTab: { url: 'https://example.com/docs' }
  });
  await vm.runInContext('initialize()', result.context);
  await toggleEditor(result);
  const hints = result.elements.get('destination-hints');
  assert.equal(hints.children[0].children[0].textContent, 'Already saved as go/docs');
  result.setEntries({
    replacement: { url: 'https://example.com/docs' },
    elsewhere: { url: 'https://example.com/other' }
  });
  result.listeners.storageChanged({ docs: { newValue: null } }, 'sync');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hints.children[0].children[0].textContent, 'Already saved as go/replacement');
  assert.equal(result.elements.get('full-link').value, 'https://example.com/docs');
  vm.runInContext("startEditing('elsewhere')", result.context);
  assert.equal(hints.hidden, true);
});

test('successful saves replace the whole editor with persistent Test, Edit, and Add another actions', async () => {
  const result = runManager();
  await vm.runInContext('initialize()', result.context);
  await saveManagerShortcut(result, 'docs');
  assert.equal(result.elements.get('saved-result').hidden, false);
  assert.equal(result.elements.get('saved-message').textContent, 'Saved go/docs.');
  assert.equal(result.elements.get('toast').matches(':popover-open'), false);
  assert.equal(result.elements.get('add-section').hidden, true);
  assert.equal(result.elements.get('add-section').open, false);
  assert.equal(result.context.document.activeElement, result.elements.get('test-shortcut'));
  assert.equal(result.elements.get('go-link').value, '');
  assert.equal(result.elements.get('full-link').value, 'https://example.com/docs');
  assert.equal(result.elements.get('destination-hints').hidden, true);

  await result.elements.get('search').dispatch('input');
  assert.equal(result.elements.get('saved-result').hidden, false);
  assert.equal(result.elements.get('add-section').hidden, true);
  await result.elements.get('edit-saved').click();
  assert.equal(result.elements.get('saved-result').hidden, true);
  assert.equal(result.elements.get('add-section').hidden, false);
  assert.equal(result.elements.get('add-section').open, true);
  assert.equal(result.elements.get('go-link').value, 'docs');
  await result.elements.get('editor-form').dispatch('submit');
  assert.equal(result.elements.get('saved-message').textContent, 'Updated go/docs.');

  await result.elements.get('add-another').click();
  assert.equal(result.elements.get('saved-result').hidden, true);
  assert.equal(result.elements.get('add-section').hidden, false);
  assert.equal(result.elements.get('add-section').open, true);
  assert.equal(result.elements.get('go-link').value, '');
  await result.elements.get('cancel-edit').dispatch('click');
  assert.equal(result.elements.get('saved-result').hidden, true);
  assert.equal(result.elements.get('destination-hints').hidden, true);
});

test('saved results clear only when their shortcut changes through sync or another edit begins', async () => {
  const result = runManager();
  await vm.runInContext('initialize()', result.context);
  for (const changedEntries of [
    { docs: { url: 'https://example.com/changed' } },
    {},
    { renamed: { url: 'https://example.com/docs' } },
    { docs: { url: 'https://example.com/issues/{*}', fallbackUrl: 'https://example.com/issues' } }
  ]) {
    await saveManagerShortcut(result, 'docs');
    result.setEntries({ ...result.getEntries(), unrelated: { url: 'https://example.com/other' } });
    result.listeners.storageChanged({ unrelated: {} }, 'sync');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(result.elements.get('saved-result').hidden, false);
    result.setEntries(changedEntries);
    result.listeners.storageChanged({ docs: {} }, 'sync');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(result.elements.get('saved-result').hidden, true);
    assert.equal(result.elements.get('add-section').hidden, false);
    assert.equal(result.elements.get('add-section').open, false);
  }
  await saveManagerShortcut(result, 'another');
  vm.runInContext("startEditing('docs')", result.context);
  assert.equal(result.elements.get('saved-result').hidden, true);
  assert.equal(result.elements.get('add-section').hidden, false);
  assert.equal(result.elements.get('add-section').open, true);
});

test('Add another clears the previous fields and respects optional active-tab access', async () => {
  for (const granted of [true, false]) {
    const result = runManager({}, {
      tabsGranted: granted,
      activeTab: { url: 'https://example.com/current' }
    });
    await vm.runInContext('initialize()', result.context);
    result.elements.get('fallback-link').value = 'https://example.com/issues';
    await saveManagerShortcut(result, 'issues', 'https://example.com/issues/{*}');
    await result.elements.get('add-another').click();

    assert.equal(result.elements.get('saved-result').hidden, true);
    assert.equal(result.elements.get('add-section').hidden, false);
    assert.equal(result.elements.get('add-section').open, true);
    assert.equal(result.elements.get('go-link').value, '');
    assert.equal(result.elements.get('fallback-link').value, '');
    assert.equal(result.elements.get('full-link').value, granted ? 'https://example.com/current' : '');
    assert.equal(result.elements.get('variable-badge').hidden, true);
    assert.equal(result.context.document.activeElement, result.elements.get('full-link'));
    assert.deepEqual(result.permissionRequests, [{ permissions: ['tabs'] }]);
    assert.equal(result.tabQueries.length, granted ? 1 : 0);
    await saveManagerShortcut(result, 'next', 'https://example.com/new');
    assert.equal(result.elements.get('saved-message').textContent, 'Saved go/next.');
    assert.equal(result.elements.get('add-section').hidden, true);
  }
});

test('failed saves keep the editor and draft available for retry', async () => {
  const options = { failStorageSet: true };
  const result = runManager({}, options);
  await vm.runInContext('initialize()', result.context);
  await saveManagerShortcut(result, 'draft');
  assert.equal(result.elements.get('saved-result').hidden, true);
  assert.equal(result.elements.get('add-section').hidden, false);
  assert.equal(result.elements.get('add-section').open, true);
  assert.equal(result.elements.get('go-link').value, 'draft');
  assert.equal(result.elements.get('full-link').value, 'https://example.com/docs');
  assert.equal(result.elements.get('toast').matches(':popover-open'), true);
  assert.deepEqual(result.getEntries(), {});
  options.failStorageSet = false;
  await result.elements.get('editor-form').dispatch('submit');
  assert.equal(result.elements.get('saved-result').hidden, false);
  assert.equal(result.elements.get('add-section').hidden, true);
  assert.equal(result.elements.get('toast').matches(':popover-open'), false);
});

test('More actions closes before Help, Import, and Export and restores its trigger focus', async () => {
  const result = runManager({ docs: { url: 'https://example.com/docs' } });
  await vm.runInContext('initialize()', result.context);
  const menu = result.elements.get('actions-menu');
  let filePickerOpened = false;
  result.elements.get('import-file').click = () => { filePickerOpened = true; };
  for (const action of ['btn-help', 'btn-import', 'btn-export']) {
    menu.showPopover();
    // The browser dispatches the parent's capture listener before the button action.
    await menu.dispatch('click');
    assert.equal(menu.matches(':popover-open'), false);
    assert.equal(result.context.document.activeElement, result.elements.get('more-button'));
    await result.elements.get(action).click();
  }
  assert.equal(filePickerOpened, true);
  assert.deepEqual(result.openedTabs, [{ active: true, url: 'https://github.com/taichikuji/Linker/wiki/How-to-use-Linker' }]);
  assert.equal(result.elements.get('toast-message').textContent, 'Exported your shortcuts.');
  assert.equal(result.elements.get('toast').matches(':popover-open'), true);
  await result.elements.get('toast-close').click();
  assert.equal(result.elements.get('toast').matches(':popover-open'), false);
});

test('confirmation dialogs retain cancellation and focus restoration with title and description', async () => {
  const result = runManager();
  await vm.runInContext('initialize()', result.context);
  const opener = result.elements.get('more-button');
  opener.focus();
  const deleting = vm.runInContext("showConfirmModal('Delete go/docs?')", result.context);
  assert.equal(result.elements.get('confirm-title').textContent, 'Delete shortcut?');
  assert.equal(result.elements.get('confirm-description').textContent, 'Delete go/docs?');
  assert.equal(result.elements.get('confirm-ok').className, 'danger filled');
  assert.equal(result.elements.get('confirm-icon').hidden, false);
  assert.equal(result.context.document.activeElement, result.elements.get('confirm-cancel'));
  result.elements.get('confirm-modal').close();
  assert.equal(await deleting, false);
  assert.equal(result.context.document.activeElement, opener);

  const replacing = vm.runInContext("showConfirmModal('Replace 1 shortcut?', {confirmLabel: 'Import', danger: false})", result.context);
  assert.equal(result.elements.get('confirm-title').textContent, 'Replace shortcuts?');
  assert.equal(result.elements.get('confirm-ok').className, 'primary filled');
  assert.equal(result.elements.get('confirm-icon').hidden, true);
  await result.elements.get('confirm-ok').click();
  assert.equal(await replacing, true);
  assert.equal(result.context.document.activeElement, opener);
});

test('shortcut tests wait for applied rules and open direct and default go routes', async () => {
  let release;
  const paused = new Promise(resolve => { release = resolve; });
  const result = runBackground({ beforeRuleUpdate: async (details, call) => {
    if (call === 2) await paused;
  } });
  await result.updated;
  const response = sendBackgroundMessage(result, { type: 'test-shortcut', shortcut: 'gh' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(result.navigations, []);
  release();
  assert.deepEqual(await response, { ok: true });
  assert.deepEqual(await sendBackgroundMessage(result, { type: 'test-shortcut', shortcut: 'issue' }), { ok: true });
  assert.deepEqual(result.navigations, [
    ['create', { active: true, url: 'http://go/gh' }],
    ['create', { active: true, url: 'http://go/issue' }]
  ]);
  const fallback = result.appliedUpdates.at(-1).addRules.find(rule =>
    new RegExp(rule.condition.regexFilter).test('http://go/issue'));
  assert.equal(fallback.action.redirect.url, 'https://github.com/taichikuji/Linker/issues');
});

test('shortcut tests reject malformed, unavailable, and invalid stored shortcuts without navigation', async () => {
  const result = runBackground({ entries: {
    valid: { url: 'https://example.com' },
    unsafe: { url: 'javascript:alert(1)' },
    noDefault: { url: 'https://example.com/{*}' },
    'bad/path': { url: 'https://example.com' }
  } });
  await result.updated;
  for (const shortcut of [
    undefined, null, 42, {}, [], '', 'a'.repeat(101), 'bad/path', '.', '..',
    'bad?query', 'bad#fragment', 'bad%20path', 'bad\\path', 'bad path',
    'bad\tpath', 'bad&path', 'é', 'missing', 'unsafe', 'noDefault', 'constructor'
  ]) {
    const response = await sendBackgroundMessage(result, { type: 'test-shortcut', shortcut });
    assert.equal(response.ok, false, String(shortcut));
    assert.equal(typeof response.error, 'string');
  }
  assert.deepEqual(result.navigations, []);
  assert.equal(result.listeners.runtimeMessage({ type: 'unrelated' }, {}, () => {
    assert.fail('Unrelated messages must not receive a test response');
  }), undefined);
});

test('shortcut tests use the queued rebuild snapshot when a shortcut disappears before installation', async () => {
  let release;
  const paused = new Promise(resolve => { release = resolve; });
  const options = {
    entries: { docs: { url: 'https://example.com' } },
    beforeRuleUpdate: async (details, call) => { if (call === 1) await paused; }
  };
  const result = runBackground(options);
  const response = sendBackgroundMessage(result, { type: 'test-shortcut', shortcut: 'docs' });
  options.entries = {};
  release();
  assert.equal((await response).ok, false);
  assert.deepEqual(result.navigations, []);
});

test('shortcut tests report routing and tab failures and recover on retry', async () => {
  const options = { failRuleUpdateAt: 2, failTabCreate: true };
  const result = runBackground(options);
  await result.updated;
  const message = { type: 'test-shortcut', shortcut: 'gh' };
  assert.deepEqual(await sendBackgroundMessage(result, message), { ok: false, error: 'Rule update failed' });
  assert.deepEqual(await sendBackgroundMessage(result, message), { ok: false, error: 'Tab could not be opened' });
  assert.deepEqual(result.navigations, []);
  options.failTabCreate = false;
  assert.deepEqual(await sendBackgroundMessage(result, message), { ok: true });
  assert.deepEqual(result.navigations, [['create', { active: true, url: 'http://go/gh' }]]);
});

test('post-save Test waits, prevents double clicks, preserves failures, and retries without tab permissions', async () => {
  let background;
  let release;
  const paused = new Promise(resolve => { release = resolve; });
  const result = runManager({}, {
    tabsGranted: false,
    sendMessage: message => sendBackgroundMessage(background, message)
  });
  background = runBackground({
    getEntries: result.getEntries,
    failRuleUpdateAt: 2,
    beforeRuleUpdate: async (details, call) => { if (call === 2) await paused; }
  });
  await background.updated;
  await vm.runInContext('initialize()', result.context);
  await saveManagerShortcut(result, 'docs');
  const button = result.elements.get('test-shortcut');
  const pending = button.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(button.disabled, true);
  await button.click();
  assert.equal(result.runtimeMessages.length, 1);
  assert.deepEqual(background.navigations, []);
  release();
  await pending;
  assert.equal(button.disabled, false);
  assert.equal(result.elements.get('saved-result').hidden, false);
  assert.equal(result.elements.get('toast-message').textContent, 'Rule update failed');
  assert.equal(result.elements.get('toast').dataset.type, 'error');
  await button.click();
  assert.equal(button.disabled, false);
  assert.deepEqual(background.navigations, [['create', { active: true, url: 'http://go/docs' }]]);
  assert.deepEqual(result.permissionRequests, []);
  assert.equal(result.elements.get('saved-message').textContent, 'Saved go/docs.');
});

test('post-save Test handles a disconnected worker or missing response and remains retryable', async () => {
  const options = { sendMessage: async () => { throw new Error('Worker unavailable'); } };
  const result = runManager({}, options);
  await vm.runInContext('initialize()', result.context);
  await saveManagerShortcut(result, 'docs');
  const button = result.elements.get('test-shortcut');
  await button.click();
  assert.equal(result.elements.get('toast-message').textContent, 'Worker unavailable');
  options.sendMessage = async () => undefined;
  await button.click();
  assert.equal(result.elements.get('toast-message').textContent, 'Could not test the shortcut.');
  assert.equal(button.disabled, false);
  assert.equal(result.elements.get('saved-result').hidden, false);
});

test('background initializes through the Chromium extension API', async () => {
  const { listeners, updated } = runBackground();
  const update = await updated;

  assert.equal(typeof listeners.storageChanged, 'function');
  assert.equal(typeof listeners.actionClicked, 'function');
  assert.deepEqual(update.removeRuleIds, [99]);
  assert.equal(update.addRules.length, 3);

  assert.deepEqual(update.addRules[0], {
    id: 1,
    priority: 1,
    action: {
      type: 'redirect',
      redirect: { url: 'https://github.com/' }
    },
    condition: {
      regexFilter: '^https?://go/gh/?(?:[?#].*)?$',
      resourceTypes: ['main_frame']
    }
  });

  assert.equal(update.addRules[1].priority, 2);
  assert.equal(
    update.addRules[1].action.redirect.regexSubstitution,
    'https://github.com/taichikuji/Linker/issues/\\1'
  );
  assert.equal(
    update.addRules[2].action.redirect.url,
    'https://github.com/taichikuji/Linker/issues'
  );
});

test('redirect rules ignore query strings and fragments without changing the destination', async () => {
  const { addRules } = await runBackground().updated;
  const redirects = [
    ['gh', 'https://github.com/'],
    ['gh/', 'https://github.com/'],
    ['issue', 'https://github.com/taichikuji/Linker/issues'],
    ['issue/', 'https://github.com/taichikuji/Linker/issues'],
    ['issue/123', 'https://github.com/taichikuji/Linker/issues/123'],
    ['issue/123/', 'https://github.com/taichikuji/Linker/issues/123'],
    ['issue/team/123/', 'https://github.com/taichikuji/Linker/issues/team/123'],
    ['issue/a%3Fb%23c', 'https://github.com/taichikuji/Linker/issues/a%3Fb%23c']
  ];

  for (const [path, destination] of redirects) {
    for (const protocol of ['http:', 'https:']) {
      for (const suffix of ['', '?', '#', '?src=slack', '#section', '?next=/other#section']) {
        const url = `${protocol}//go/${path}${suffix}`;
        const rule = addRules.toSorted((a, b) => b.priority - a.priority)
          .find(rule => new RegExp(rule.condition.regexFilter).test(url));
        assert.ok(rule, url);
        const redirect = rule.action.redirect;
        const capture = new RegExp(rule.condition.regexFilter).exec(url)[1];
        assert.equal(redirect.url ?? redirect.regexSubstitution.replaceAll('\\1', capture), destination, url);
      }
    }
  }
});

test('redirect rules reject unknown shortcuts, extra direct paths, and other hosts', async () => {
  const { addRules } = await runBackground().updated;
  for (const url of [
    'http://go/missing?src=slack',
    'http://go/gh/extra?src=slack',
    'http://go/gh//?src=slack',
    'http://go/gh-other?src=slack',
    'https://example.com/path://go/gh',
    'https://example.com/?tracking=go%2Fgh&next=1',
    'https://go.example.com/gh?src=slack',
    'https://go@other.example/gh?src=slack',
    'ftp://go/gh?src=slack'
  ]) {
    assert.equal(addRules.some(rule => new RegExp(rule.condition.regexFilter).test(url)), false, url);
  }
});

test('manager validates import and export through the Chromium extension API', async () => {
  const result = runManager({
    gh: { url: 'https://github.com/' },
    issue: {
      url: 'https://github.com/issues/{*}',
      fallbackUrl: 'https://github.com/issues'
    }
  });

  await vm.runInContext('initialize()', result.context);

  const imported = JSON.parse(vm.runInContext(`JSON.stringify(parseImportData({
    docs: 'https://example.com/docs/',
    issue: { url: 'https://github.com/issues/{*}', fallbackUrl: 'https://github.com/issues' },
    'café': 'https://example.com/',
    '.': 'https://example.com/',
    'a^b': 'https://example.com/',
    unsafe: 'javascript:alert(1)'
  }))`, result.context));
  assert.deepEqual(Object.keys(imported.entries), ['docs', 'issue']);
  assert.equal(imported.skippedCount, 4);

  const exported = JSON.parse(vm.runInContext(
    'JSON.stringify(createExportData(state.entries))',
    result.context
  ));
  assert.deepEqual(exported, {
    gh: 'https://github.com/',
    issue: {
      url: 'https://github.com/issues/{*}',
      fallbackUrl: 'https://github.com/issues'
    }
  });
});

test('manager renders browser-cached favicons with shortcut-letter fallbacks', () => {
  const result = runManager();
  const iconRule = managerStyles.match(/\.shortcut-icon \{([^}]*)\}/)?.[1];
  const fallbackRule = managerStyles.match(/\.shortcut-icon-fallback \{([^}]*)\}/)?.[1];
  const directRow = vm.runInContext(
    "createEntry(['docs', { url: 'https://example.com/docs' }])",
    result.context
  );
  const directIcon = directRow.querySelector('.shortcut-icon');
  const [directFavicon] = directIcon.children;

  assert.equal(directFavicon.className, 'shortcut-favicon');
  assert.equal(directFavicon.alt, '');
  assert.doesNotMatch(iconRule, /background:/);
  assert.match(fallbackRule, /background:/);
  assert.equal(directIcon.classList.contains('shortcut-icon-fallback'), false);
  assert.equal(
    directFavicon.src,
    'chrome-extension://linker/_favicon/?pageUrl=https%3A%2F%2Fexample.com%2Fdocs&size=32'
  );

  directFavicon.onerror();
  assert.equal(directIcon.children.length, 0);
  assert.equal(directIcon.classList.contains('shortcut-icon-fallback'), true);
  assert.equal(directIcon.textContent, 'D');

  const parameterizedRow = vm.runInContext(`createEntry(['issue', {
    url: 'https://github.com/issues/{*}',
    fallbackUrl: 'https://github.com/issues'
  }])`, result.context);
  const [parameterizedFavicon] = parameterizedRow.querySelector('.shortcut-icon').children;

  assert.equal(
    parameterizedFavicon.src,
    'chrome-extension://linker/_favicon/?pageUrl=https%3A%2F%2Fgithub.com%2Fissues&size=32'
  );
});

test('search highlights literal case-insensitive text without creating HTML', () => {
  const result = runManager();
  for (const [query, text, matches] of [
    [' [a.*] ', '<img src=x> [A.*] a.*', ['[A.*]']],
    ['<img', '<img src=x onerror=alert(1)> <IMG', ['<img', '<IMG']],
    ['docs', 'Docs docs DOCS', ['Docs', 'docs', 'DOCS']],
    ['.', 'a.b.c', ['.', '.']],
    ['.*+?^${}()|[\\]', 'Literal .*+?^${}()|[\\] query', ['.*+?^${}()|[\\]']],
    ['missing', 'No matching text', []]
  ]) {
    result.elements.get('search').value = query;
    result.context.label = result.context.document.createElement('span');
    result.context.text = text;
    vm.runInContext('highlightText(label, text)', result.context);
    const children = result.context.label.children;
    assert.equal(children.map(child => child.textContent).join(''), text);
    assert.deepEqual(children.filter(child => child.tagName === 'MARK').map(child => child.textContent), matches);
    assert.ok(children.every(child => child.nodeType === 3 || child.tagName === 'MARK'));
  }
});

test('search keeps sorting, URL-only matches, Enter navigation, and clear/empty states', async () => {
  const result = runManager({
    zebra: { url: 'https://example.com/Docs?hidden=secret' },
    docs: { url: 'https://example.com/docs' },
    issue: { url: 'https://example.com/{*}?hidden=secret', fallbackUrl: 'https://example.com/default' }
  });
  await vm.runInContext('initialize()', result.context);
  const search = result.elements.get('search');
  const rows = () => result.elements.get('item-list').children;
  search.value = 'DOCS';
  await search.dispatch('input');
  assert.deepEqual(rows().map(row => row.querySelector('.shortcut-name').textContent), ['go/docs', 'go/zebra']);
  assert.deepEqual(rows()[0].querySelector('.shortcut-name').children.filter(child => child.tagName === 'MARK').map(child => child.textContent), ['docs']);
  assert.deepEqual(rows()[1].querySelector('.shortcut-url').children.filter(child => child.tagName === 'MARK').map(child => child.textContent), ['Docs']);
  await search.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(result.openedTabs, [{ active: true, url: 'https://example.com/docs' }]);

  search.value = 'secret';
  await search.dispatch('input');
  assert.equal(rows().length, 2);
  assert.ok(rows().every(row => ['.shortcut-name', '.shortcut-url'].every(selector =>
    row.querySelector(selector).children.every(child => child.tagName !== 'MARK'))));
  await search.dispatch('keydown', { key: 'Enter' });
  assert.equal(result.openedTabs.at(-1).url, 'https://example.com/default');

  search.value = 'missing';
  await search.dispatch('input');
  assert.equal(rows().length, 0);
  assert.equal(result.elements.get('empty-state').textContent, 'No shortcuts match your search.');
  await search.dispatch('keydown', { key: 'Enter' });
  assert.equal(result.openedTabs.length, 2);
  search.value = '';
  await search.dispatch('input');
  assert.equal(rows().length, 3);
  assert.equal(result.elements.get('empty-state').hidden, true);
  assert.ok(rows().every(row => row.querySelector('.shortcut-name').children.length === 0));
});

test('Cmd/Ctrl+F selects search while preserving editable fields and dialogs', async () => {
  const result = runManager();
  await vm.runInContext('initialize()', result.context);
  const search = result.elements.get('search');
  const button = result.elements.get('btn-help');
  search.value = 'docs';
  for (const modifier of ['ctrlKey', 'metaKey']) {
    button.focus();
    let prevented = false;
    result.listeners.keydown({ key: 'f', [modifier]: true, target: button, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(result.context.document.activeElement, search);
    assert.equal(search.selectionStart, 0);
    assert.equal(search.selectionEnd, 4);
  }
  for (const options of [
    { target: search, ctrlKey: true, shiftKey: true },
    { target: button, ctrlKey: true, altKey: true },
    { target: button },
    { target: { matches: selector => selector.includes('input') }, ctrlKey: true },
    { target: { isContentEditable: true }, metaKey: true },
    { target: button, ctrlKey: true, modal: true }
  ]) {
    button.focus();
    result.elements.get('confirm-modal').open = options.modal;
    let prevented = false;
    result.listeners.keydown({ key: 'f', ...options, preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
    assert.equal(result.context.document.activeElement, button);
  }
});

test('opening the editor reads the current URL and saves it', async () => {
  const sourceUrl = 'https://example.com/path?q=1';
  const result = runManager({}, {
    activeTab: { url: sourceUrl }
  });
  const editorSection = result.elements.get('add-section');

  await vm.runInContext('initialize()', result.context);
  await toggleEditor(result);

  const urlInput = result.elements.get('full-link');
  const shortcutInput = result.elements.get('go-link');
  assert.deepEqual(result.tabQueries, [{ active: true, currentWindow: true }]);
  assert.deepEqual(result.permissionRequests, [{ permissions: ['tabs'] }]);
  assert.equal(urlInput.value, sourceUrl);
  assert.equal(editorSection.open, true);

  shortcutInput.value = 'EXAMPLE';
  await result.elements.get('editor-form').dispatch('submit');

  assert.deepEqual(result.getEntries(), {
    example: { url: sourceUrl }
  });
  assert.equal(editorSection.open, false);
  assert.equal(editorSection.hidden, true);
});

test('declining tab access leaves the editor usable and closing does not ask again', async () => {
  const result = runManager({}, {
    activeTab: { url: 'https://example.com/current' },
    tabsGranted: false
  });
  await vm.runInContext('initialize()', result.context);

  const urlInput = result.elements.get('full-link');
  urlInput.value = 'https://example.com/old';
  await toggleEditor(result);

  assert.equal(urlInput.value, '');
  assert.deepEqual(result.tabQueries, []);
  assert.deepEqual(result.permissionRequests, [{ permissions: ['tabs'] }]);

  await toggleEditor(result);
  assert.equal(result.elements.get('add-section').open, false);
  assert.deepEqual(result.permissionRequests, [{ permissions: ['tabs'] }]);
  await toggleEditor(result);

  urlInput.value = 'https://example.com/manual';
  result.elements.get('go-link').value = 'manual';
  await result.elements.get('editor-form').dispatch('submit');
  assert.deepEqual(result.getEntries(), {
    manual: { url: 'https://example.com/manual' }
  });

  assert.equal(result.elements.get('add-section').open, false);
  assert.equal(result.elements.get('add-section').hidden, true);
  assert.equal(result.permissionRequests.length, 2);
  assert.equal(urlInput.value, 'https://example.com/manual');
});

test('toolbar click opens the side panel and focuses search', async () => {
  const result = runBackground();

  await result.updated;
  await result.listeners.actionClicked({
    windowId: 9,
    url: 'https://example.com/current'
  });

  assert.deepEqual(result.openedPanels, [{ windowId: 9 }]);
  assert.deepEqual(result.runtimeMessages, [{
    type: 'focus-search',
    windowId: 9
  }]);
});

test('omnibox keyword opens local shortcuts in the requested tab', async () => {
  const result = runBackground();
  await result.updated;

  await result.listeners.omniboxInputEntered(' GH ', 'currentTab');
  await result.listeners.omniboxInputEntered('issue/123', 'newForegroundTab');
  await result.listeners.omniboxInputEntered('issue', 'newBackgroundTab');
  await result.listeners.omniboxInputEntered('missing', 'currentTab');
  await result.listeners.omniboxInputEntered('gh/extra', 'currentTab');
  await result.listeners.omniboxInputEntered('issue/../missing', 'currentTab');

  assert.deepEqual(result.navigations, [
    ['update', { url: 'http://go/GH' }],
    ['create', { url: 'http://go/issue/123', active: true }],
    ['create', { url: 'http://go/issue', active: false }]
  ]);
});

test('omnibox ignores query strings and fragments for direct, fallback, and parameterized shortcuts', async () => {
  const result = runBackground();
  await result.updated;

  for (const path of ['GH', 'gh/', 'issue', 'issue/', 'issue/123', 'issue/123/', 'issue/team/123/']) {
    for (const suffix of ['?', '#', '?src=slack', '#section', '?next=/other#section']) {
      await result.listeners.omniboxInputEntered(` ${path}${suffix} `, 'currentTab');
      assert.deepEqual(result.navigations.at(-1), ['update', { url: `http://go/${path}` }]);
    }
  }
  assert.equal(result.navigations.length, 35);
});

test('omnibox still rejects unsupported and normalized paths with query strings', async () => {
  const result = runBackground();
  await result.updated;

  for (const input of [
    '', '?src=slack', '#section', 'missing?src=slack', 'gh/extra?src=slack',
    'gh//?src=slack', 'issue/../missing?src=slack', 'issue/%2e%2e/gh#section',
    'issue/123/..#section', 'issue\\123?src=slack', 'issue/a b?src=slack',
    'issue/a\tb?src=slack', 'issue/a\nb#section'
  ]) {
    await result.listeners.omniboxInputEntered(input, 'currentTab');
  }
  assert.deepEqual(result.navigations, []);
});

test('omnibox suggests saved shortcuts matching the typed prefix', async () => {
  const result = runBackground({ entries: {
    docs: { url: 'https://example.com/?a=1&b=2' },
    done: { url: 'https://example.com/done' },
    ignored: { url: 'javascript:alert(1)' }
  } });
  await result.updated;

  let suggestions;
  await result.listeners.omniboxInputChanged('DO', results => {
    suggestions = clone(results);
  });

  assert.deepEqual(suggestions, [
    { content: 'docs', description: 'go/docs — https://example.com/?a=1&amp;b=2' },
    { content: 'done', description: 'go/done — https://example.com/done' }
  ]);

  await result.listeners.omniboxInputChanged('missing', results => {
    suggestions = clone(results);
  });
  assert.deepEqual(suggestions, []);
});

test('opening the editor ignores internal browser URLs', async () => {
  const result = runManager({}, { activeTab: { url: 'chrome://extensions' } });
  await vm.runInContext('initialize()', result.context);

  const editorSection = result.elements.get('add-section');
  await toggleEditor(result);

  assert.equal(result.elements.get('full-link').value, '');
});

test('routing failures are reported to the manager', async () => {
  const result = runBackground({ failRuleUpdateAt: 2 });
  await result.updated;

  result.listeners.storageChanged({ gh: { newValue: {} } }, 'sync');
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(result.runtimeMessages, [{ type: 'rule-update-failed' }]);
  assert.equal(result.errors.length, 1);
});

test('routing updates continue after a failed rebuild', async () => {
  const result = runBackground({ failRuleUpdateAt: 2 });
  await result.updated;

  result.listeners.storageChanged({ first: { newValue: {} } }, 'sync');
  await new Promise(resolve => setImmediate(resolve));
  result.listeners.storageChanged({ second: { newValue: {} } }, 'sync');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(result.getRuleUpdateCalls(), 3);
});

test('manager confirms normalized import replacements', async () => {
  const result = runManager({ gh: { url: 'https://github.com/' } });
  await vm.runInContext('initialize()', result.context);

  result.elements.get('import-file').files = [{
    size: 100,
    text: async () => JSON.stringify({ GH: 'https://example.com/' })
  }];
  const importing = result.elements.get('import-file').dispatch('change');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(result.elements.get('confirm-label').textContent, 'Import');
  result.elements.get('confirm-ok').click();
  await importing;

  assert.deepEqual(result.getEntries(), { gh: { url: 'https://example.com/' } });
});

test('built-in object names can be saved and imported as shortcuts', async () => {
  const result = runManager();
  await vm.runInContext('initialize()', result.context);
  result.elements.get('go-link').value = 'constructor';
  result.elements.get('full-link').value = 'https://example.com/';
  await result.elements.get('editor-form').dispatch('submit');
  assert.deepEqual(result.getEntries(), { constructor: { url: 'https://example.com/' } });

  result.elements.get('go-link').value = '__proto__';
  await result.elements.get('editor-form').dispatch('submit');
  assert.equal(vm.runInContext("Object.hasOwn(state.entries, '__proto__')", result.context), true);

  const importingManager = runManager();
  await vm.runInContext('initialize()', importingManager.context);
  importingManager.elements.get('import-file').files = [{
    size: 100,
    text: async () => JSON.stringify({ constructor: 'https://example.com/other' })
  }];
  const importing = importingManager.elements.get('import-file').dispatch('change');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(Boolean(importingManager.elements.get('confirm-modal').open), false);
  await importing;
  assert.deepEqual(importingManager.getEntries(), {
    constructor: { url: 'https://example.com/other' }
  });
});

test('cancel closes an edit without touching its destination, then reopens for a new shortcut', async () => {
  const activeTab = { url: 'https://example.com/current' };
  const result = runManager({ gh: { url: 'https://github.com/' } }, { activeTab });
  const editorSection = result.elements.get('add-section');
  editorSection.open = false;

  await vm.runInContext('initialize()', result.context);
  vm.runInContext("startEditing('gh')", result.context);

  assert.equal(editorSection.open, true);
  assert.equal(result.context.document.activeElement, result.elements.get('full-link'));

  const urlInput = result.elements.get('full-link');
  Object.defineProperty(urlInput, 'value', {
    configurable: true,
    get() { throw new Error('Cancel must not read the destination'); },
    set() { throw new Error('Cancel must not write the destination'); }
  });
  await result.elements.get('cancel-edit').dispatch('click');

  assert.equal(editorSection.open, false);
  assert.equal(result.elements.get('form-title').textContent, 'Add new shortcut');
  assert.equal(result.context.document.activeElement, editorSection.querySelector('summary'));
  Object.defineProperty(urlInput, 'value', { configurable: true, writable: true, value: 'https://github.com/' });

  for (const url of ['https://example.com/current', 'https://example.com/latest']) {
    activeTab.url = url;
    await toggleEditor(result);
    assert.equal(urlInput.value, url);
    assert.equal(result.elements.get('cancel-edit').hidden, false);
    await result.elements.get('cancel-edit').dispatch('click');
    assert.equal(editorSection.open, false);
    assert.equal(urlInput.value, url);
  }

  await toggleEditor(result);
  result.elements.get('go-link').value = 'new';
  await result.elements.get('editor-form').dispatch('submit');
  assert.deepEqual(result.getEntries(), {
    gh: { url: 'https://github.com/' },
    new: { url: activeTab.url }
  });
  assert.doesNotMatch(readFileSync(join(root, 'src/manager/manager.html'), 'utf8'), /<button[^>]*id="cancel-edit"[^>]*\bhidden\b/);
});

test('toolbar click focuses search without opening the editor or clearing drafts', async () => {
  const result = runManager();
  const editorSection = result.elements.get('add-section');

  await vm.runInContext('initialize()', result.context);
  result.elements.get('full-link').value = 'https://example.com/draft';
  editorSection.open = false;

  result.listeners.runtimeMessage({ type: 'focus-search', windowId: 9 });

  assert.equal(editorSection.open, false);
  assert.equal(result.elements.get('full-link').value, 'https://example.com/draft');
  assert.equal(result.context.document.activeElement, result.elements.get('search'));
  assert.deepEqual(result.permissionRequests, []);
});

test('manager displays background routing failures', async () => {
  const result = runManager();
  await vm.runInContext('initialize()', result.context);

  result.listeners.runtimeMessage({ type: 'rule-update-failed' });

  assert.equal(
    result.elements.get('toast-message').textContent,
    'Shortcuts were saved, but browser routing could not be updated.'
  );
  assert.equal(result.elements.get('toast').dataset.type, 'error');
});

test('opening the editor refreshes the destination from the active tab', async () => {
  const result = runManager({}, { activeTab: { url: 'https://example.com/current' } });
  await vm.runInContext('initialize()', result.context);
  result.elements.get('full-link').value = 'https://example.com/draft';

  const editorSection = result.elements.get('add-section');
  await toggleEditor(result);

  assert.equal(result.elements.get('full-link').value, 'https://example.com/current');
  assert.deepEqual(result.tabQueries, [{ active: true, currentWindow: true }]);
});

test('side panel ignores focus messages for other windows', async () => {
  const result = runManager();
  await vm.runInContext('initialize()', result.context);
  result.elements.get('go-link').focus();

  result.listeners.runtimeMessage({ type: 'focus-search', windowId: 10 });

  assert.equal(result.context.document.activeElement, result.elements.get('go-link'));
});

test('manifest defines a Chromium MV3 service worker', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(
    manifest.background.service_worker,
    'src/background/service-worker.js'
  );
  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(manifest.minimum_chrome_version, undefined);
  assert.equal(
    manifest.side_panel.default_path,
    'src/manager/manager.html'
  );
  assert.equal(manifest.permissions.includes('sidePanel'), true);
  assert.equal(manifest.permissions.includes('favicon'), true);
  assert.equal(manifest.permissions.includes('tabs'), false);
  assert.deepEqual(manifest.optional_permissions, ['tabs']);
  assert.equal(manifest.omnibox.keyword, 'go/');
  assert.deepEqual(manifest.host_permissions, ['*://go/*']);
  assert.equal(manifest.permissions.includes('unlimitedStorage'), false);
});
