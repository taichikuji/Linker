const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
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
const managerHtml = readFileSync(
  join(root, 'src/manager/manager.html'),
  'utf8'
);
const managerCss = readFileSync(
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

function sendRuntimeMessage(listener, message) {
  return new Promise(resolve => {
    assert.equal(listener(message, {}, resolve), true);
  });
}

function runBackground(options = {}) {
  const listeners = {};
  const createdTabs = [];
  const runtimeMessages = [];
  const openedPanels = [];
  const browserOperations = [];
  let sessionEntries = clone(options.sessionEntries ?? {});
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
        if (ruleUpdateCalls === options.failRuleUpdateAt) {
          throw new Error('Rule update failed');
        }
        resolveUpdate(clone(details));
      }
    },
    runtime: {
      sendMessage: async message => runtimeMessages.push(clone(message)),
      onMessage: eventSlot(listeners, 'runtimeMessage'),
      onInstalled: {
        addListener: listener => {
          listeners.installed = listener;
        }
      },
      onStartup: {
        addListener: listener => {
          listeners.startup = listener;
        }
      }
    },
    action: {
      onClicked: {
        addListener: listener => {
          listeners.actionClicked = listener;
        }
      }
    },
    storage: {
      session: {
        get: async key => key == null
          ? clone(sessionEntries)
          : { [key]: clone(sessionEntries[key]) },
        remove: async key => {
          browserOperations.push('session:remove');
          delete sessionEntries[key];
        },
        set: async values => {
          browserOperations.push('session:set');
          sessionEntries = { ...sessionEntries, ...clone(values) };
        }
      },
      sync: {
        get: async () => ({
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
        browserOperations.push('sidePanel:open');
        openedPanels.push(clone(details));
      }
    },
    tabs: {
      create: async options => {
        createdTabs.push(JSON.parse(JSON.stringify(options)));
      }
    }
  };

  const context = vm.createContext({
    chrome: api,
    crypto: { randomUUID: () => 'prefill-1' },
    URL,
    console: { error: (...args) => errors.push(args) }
  });
  vm.runInContext(backgroundSource, context);

  return {
    listeners,
    updated,
    createdTabs,
    runtimeMessages,
    errors,
    openedPanels,
    browserOperations,
    getSessionEntries: () => clone(sessionEntries)
  };
}

function runManager(initialEntries = {}, options = {}) {
  const listeners = {};
  const elements = new Map();
  const openedTabs = [];
  const runtimeMessages = [];
  let entries = clone(initialEntries);

  const document = {
    activeElement: null,
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    createDocumentFragment() {
      return { children: [], appendChild(child) { this.children.push(child); } };
    },
    createElement() {
      return createElement();
    },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement());
      return elements.get(id);
    }
  };

  function createElement() {
    const eventListeners = {};
    const classes = new Set(['hidden']);
    const queried = new Map();
    return {
      children: [],
      classList: {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        contains: name => classes.has(name)
      },
      dataset: {},
      files: [],
      hidden: false,
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
        this.children.push(child);
      },
      click() {
        return this.onclick?.();
      },
      cloneNode() {
        return createElement();
      },
      focus() {
        document.activeElement = this;
      },
      querySelector(selector) {
        if (!queried.has(selector)) queried.set(selector, createElement());
        return queried.get(selector);
      },
      replaceChildren(...children) {
        this.children = children;
      },
      scrollIntoView() {},
      select() {},
      setAttribute(name, value) {
        this[name] = value;
      }
    };
  }

  const template = document.getElementById('shortcut-template');
  template.content = { firstElementChild: createElement() };

  const api = {
    declarativeNetRequest: {
      MAX_NUMBER_OF_REGEX_RULES: 1000
    },
    runtime: {
      sendMessage: async message => {
        runtimeMessages.push(clone(message));
        return message.type === 'consume-prefill'
          ? clone(options.pendingPrefill ?? null)
          : undefined;
      },
      onMessage: eventSlot(listeners, 'runtimeMessage')
    },
    storage: {
      sync: {
        MAX_ITEMS: 512,
        QUOTA_BYTES: 102400,
        QUOTA_BYTES_PER_ITEM: 8192,
        get: async () => clone(entries),
        getBytesInUse: async keys => {
          const selected = keys == null
            ? entries
            : Object.fromEntries([keys].flat().filter(key => key in entries).map(key => [key, entries[key]]));
          return Object.entries(selected).reduce(
            (bytes, [key, value]) => bytes + key.length + JSON.stringify(value).length,
            0
          );
        },
        remove: async key => {
          delete entries[key];
        },
        set: async values => {
          if (options.failStorage) throw new Error('Storage failed');
          entries = { ...entries, ...clone(values) };
        }
      },
      onChanged: eventSlot(listeners, 'storageChanged')
    },
    tabs: {
      create: async details => openedTabs.push(clone(details))
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
    console,
    document,
    setTimeout: () => 0
  });
  vm.runInContext(managerSource, context);

  return {
    context,
    elements,
    listeners,
    openedTabs,
    runtimeMessages,
    getEntries: () => clone(entries)
  };
}

test('background initializes through the Chromium extension API', async () => {
  const { listeners, updated } = runBackground();
  const update = await updated;

  assert.equal(typeof listeners.installed, 'function');
  assert.equal(typeof listeners.startup, 'function');
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
      regexFilter: '^(?:https?://go/gh/?$|https?://.*[?&][^#]*=go%2Fgh(?:&|$))',
      resourceTypes: ['main_frame']
    }
  });

  assert.equal(update.addRules[1].priority, 2);
  assert.equal(
    update.addRules[1].action.redirect.regexSubstitution,
    'https://github.com/taichikuji/Linker/issues/\\1\\2'
  );
  assert.equal(
    update.addRules[2].action.redirect.url,
    'https://github.com/taichikuji/Linker/issues'
  );
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
    unsafe: 'javascript:alert(1)'
  }))`, result.context));
  assert.deepEqual(Object.keys(imported.entries), ['docs', 'issue']);
  assert.equal(imported.skippedCount, 1);

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

test('manager exposes shortcuts and editor as native disclosures', () => {
  assert.match(
    managerHtml,
    /<details id="shortcut-section" class="shortcut-panel" open>/
  );
  assert.match(
    managerHtml,
    /<details id="add-section" class="editor-panel">/
  );
  assert.equal((managerHtml.match(/<summary class="panel-summary">/g) ?? []).length, 2);
});

test('manager preserves its compact v2 visual identity in the side panel', () => {
  assert.match(managerHtml, /Your shortcuts, one hop away/);
  assert.doesNotMatch(managerCss, /\.brand p\s*{\s*display:\s*none;/);
  assert.match(managerHtml, /<symbol id="icon-down"/);
  assert.equal((managerHtml.match(/<use href="#icon-down"><\/use>/g) ?? []).length, 2);
  assert.doesNotMatch(managerHtml, /class="disclosure-marker"/);
  assert.match(
    managerCss,
    /\.panel-summary\s*{[^}]*padding:\s*12px 20px;/s
  );
  assert.match(
    managerCss,
    /\.summary-title\s*{[^}]*font-size:\s*14px;[^}]*font-weight:\s*600;/s
  );
});

test('cold side panel consumes the current URL prefill and saves it', async () => {
  const sourceUrl = 'https://example.com/path?q=1';
  const result = runManager({}, {
    windowId: 9,
    pendingPrefill: { id: 'prefill-1', url: sourceUrl }
  });

  await vm.runInContext('initialize()', result.context);

  const urlInput = result.elements.get('full-link');
  const shortcutInput = result.elements.get('go-link');
  assert.deepEqual(result.runtimeMessages, [{
    type: 'consume-prefill',
    windowId: 9
  }]);
  assert.equal(urlInput.value, sourceUrl);
  assert.equal(result.context.document.activeElement, result.elements.get('search'));
  assert.equal(result.elements.get('shortcut-section').open, true);
  assert.equal(result.elements.get('add-section').open, false);

  result.elements.get('shortcut-section').open = false;
  result.elements.get('add-section').open = true;
  shortcutInput.value = 'EXAMPLE';
  await result.elements.get('editor-form').dispatch('submit');

  assert.deepEqual(result.getEntries(), {
    example: { url: sourceUrl }
  });
  assert.equal(result.elements.get('shortcut-section').open, true);
  assert.equal(result.elements.get('add-section').open, false);
});

test('toolbar click opens the side panel and stages the current URL', async () => {
  const result = runBackground();

  await result.updated;
  await result.listeners.actionClicked({
    windowId: 9,
    url: 'https://example.com/current'
  });

  assert.deepEqual(result.openedPanels, [{ windowId: 9 }]);
  assert.deepEqual(result.browserOperations.slice(0, 2), [
    'sidePanel:open',
    'session:set'
  ]);
  assert.deepEqual(result.createdTabs, []);
  assert.deepEqual(result.getSessionEntries(), {
    'side-panel-prefill:9': {
      id: 'prefill-1',
      url: 'https://example.com/current'
    }
  });
  assert.deepEqual(result.runtimeMessages, [{
    type: 'prefill-url',
    id: 'prefill-1',
    windowId: 9,
    url: 'https://example.com/current'
  }]);
});

test('toolbar click clears stale prefill for non-web pages', async () => {
  const result = runBackground({
    sessionEntries: {
      'side-panel-prefill:9': { id: 'stale', url: 'https://example.com/old' }
    }
  });

  await result.updated;
  await result.listeners.actionClicked({ windowId: 9, url: 'chrome://extensions' });

  assert.deepEqual(result.openedPanels, [{ windowId: 9 }]);
  assert.deepEqual(result.getSessionEntries(), {});
  assert.deepEqual(result.runtimeMessages, [{ type: 'focus-search', windowId: 9 }]);
});

test('manager can consume a pending side-panel prefill once', async () => {
  const result = runBackground({
    sessionEntries: {
      'side-panel-prefill:9': { id: 'prefill-1', url: 'https://example.com/current' }
    }
  });
  await result.updated;

  const prefill = await sendRuntimeMessage(result.listeners.runtimeMessage, {
    type: 'consume-prefill',
    windowId: 9
  });

  assert.deepEqual(prefill, { id: 'prefill-1', url: 'https://example.com/current' });
  assert.deepEqual(result.getSessionEntries(), {});
});

test('routing failures are reported to the manager', async () => {
  const result = runBackground({ failRuleUpdateAt: 2 });
  await result.updated;

  result.listeners.storageChanged({ gh: { newValue: {} } }, 'sync');
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(result.runtimeMessages, [{ type: 'rule-update-failed' }]);
  assert.equal(result.errors.length, 1);
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

test('editing opens the editor and cancel returns to shortcuts', async () => {
  const result = runManager({ gh: { url: 'https://github.com/' } });
  const shortcutSection = result.elements.get('shortcut-section');
  const editorSection = result.elements.get('add-section');
  shortcutSection.open = true;

  await vm.runInContext('initialize()', result.context);
  vm.runInContext("startEditing('gh')", result.context);

  assert.equal(shortcutSection.open, false);
  assert.equal(editorSection.open, true);
  assert.equal(result.context.document.activeElement, result.elements.get('full-link'));

  await result.elements.get('cancel-edit').dispatch('click');

  assert.equal(shortcutSection.open, true);
  assert.equal(editorSection.open, false);
  assert.equal(result.context.document.activeElement, result.elements.get('search'));
});

test('opening either disclosure collapses the other without clearing drafts', async () => {
  const result = runManager();
  const shortcutSection = result.elements.get('shortcut-section');
  const editorSection = result.elements.get('add-section');
  shortcutSection.open = true;

  await vm.runInContext('initialize()', result.context);
  result.elements.get('full-link').value = 'https://example.com/draft';

  editorSection.open = true;
  await editorSection.dispatch('toggle');
  assert.equal(shortcutSection.open, false);

  shortcutSection.open = true;
  await shortcutSection.dispatch('toggle');
  assert.equal(editorSection.open, false);
  assert.equal(result.elements.get('full-link').value, 'https://example.com/draft');
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

test('open side panel prefills its window while returning focus to search', async () => {
  const result = runManager();
  await vm.runInContext('initialize()', result.context);
  result.elements.get('go-link').focus();

  result.listeners.runtimeMessage({
    type: 'prefill-url',
    id: 'prefill-2',
    windowId: 9,
    url: 'https://example.com/current'
  });
  result.listeners.runtimeMessage({
    type: 'prefill-url',
    id: 'prefill-2',
    windowId: 9,
    url: 'https://example.com/current'
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(result.elements.get('full-link').value, 'https://example.com/current');
  assert.equal(result.context.document.activeElement, result.elements.get('search'));
  assert.deepEqual(result.runtimeMessages, [
    { type: 'consume-prefill', windowId: 9 },
    { type: 'consume-prefill', windowId: 9 }
  ]);
});

test('side panel ignores other windows and preserves an existing draft', async () => {
  const result = runManager();
  await vm.runInContext('initialize()', result.context);
  result.elements.get('full-link').value = 'https://example.com/draft';

  result.listeners.runtimeMessage({
    type: 'prefill-url',
    id: 'wrong-window',
    windowId: 10,
    url: 'https://example.com/ignored'
  });
  result.listeners.runtimeMessage({
    type: 'prefill-url',
    id: 'prefill-2',
    windowId: 9,
    url: 'https://example.com/current'
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(result.elements.get('full-link').value, 'https://example.com/draft');
  assert.equal(
    result.elements.get('toast-message').textContent,
    'Current shortcut draft preserved.'
  );
  assert.deepEqual(result.runtimeMessages, [
    { type: 'consume-prefill', windowId: 9 },
    { type: 'consume-prefill', windowId: 9 }
  ]);
});

test('manager rejects sync items that exceed the per-item quota', async () => {
  const result = runManager();
  const oversizedUrl = `https://example.com/${'x'.repeat(9000)}`;

  await assert.rejects(
    vm.runInContext(
      `ensureImportFitsSyncStorage({ huge: { url: ${JSON.stringify(oversizedUrl)} } })`,
      result.context
    ),
    /too large for browser sync storage/
  );
});

test('manifest defines a Chromium MV3 service worker', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '2.1.0');
  assert.equal(
    manifest.background.service_worker,
    'src/background/service-worker.js'
  );
  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(manifest.minimum_chrome_version, '116');
  assert.equal(
    manifest.side_panel.default_path,
    'src/manager/manager.html'
  );
  assert.equal(manifest.permissions.includes('sidePanel'), true);
  assert.equal(manifest.permissions.includes('unlimitedStorage'), false);
});
