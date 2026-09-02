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

function runBackground(options = {}) {
  const listeners = {};
  const createdTabs = [];
  const runtimeMessages = [];
  const openedPanels = [];
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
    getRuleUpdateCalls: () => ruleUpdateCalls
  };
}

function runManager(initialEntries = {}, options = {}) {
  const listeners = {};
  const elements = new Map();
  const openedTabs = [];
  const tabQueries = [];
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
        if (!queried.has(selector)) queried.set(selector, createElement());
        return queried.get(selector);
      },
      replaceChildren(...children) {
        this.children = children;
      },
      select() {},
      showModal() {
        this.open = true;
      },
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
      query: async details => {
        tabQueries.push(clone(details));
        return options.activeTab ? [clone(options.activeTab)] : [];
      },
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
    tabQueries,
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

test('manager keeps shortcuts visible and the editor collapsed by default', () => {
  assert.match(
    managerHtml,
    /<section class="shortcut-panel" aria-label="Saved shortcuts">/
  );
  assert.doesNotMatch(managerHtml, /<details id="shortcut-section"/);
  assert.match(
    managerHtml,
    /<details id="add-section" class="editor-panel">/
  );
  assert.equal((managerHtml.match(/<summary class="panel-summary">/g) ?? []).length, 1);
  assert.match(managerHtml, /<search aria-label="Search shortcuts">/);
  assert.match(managerHtml, /<dialog id="confirm-modal"/);
  assert.doesNotMatch(managerHtml, /novalidate/);
});

test('manager preserves its compact v2 visual identity in the side panel', () => {
  assert.match(managerHtml, /Your shortcuts, one hop away/);
  assert.match(managerCss, /\.brand p\s*{\s*display:\s*none;/);
  assert.match(managerHtml, /<symbol id="icon-down"/);
  assert.equal((managerHtml.match(/<use href="#icon-down"><\/use>/g) ?? []).length, 1);
  assert.doesNotMatch(managerHtml, /class="disclosure-marker"/);
  assert.match(
    managerCss,
    /\.shortcut-panel,\s*\.editor-panel\s*{[^}]*overflow:\s*clip;/s
  );
  assert.match(
    managerCss,
    /\.shortcut-panel\s*{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s
  );
  assert.match(
    managerCss,
    /\.panel-summary\s*{[^}]*padding:\s*12px 20px;/s
  );
  assert.match(
    managerCss,
    /\.summary-title\s*{[^}]*font-size:\s*14px;[^}]*font-weight:\s*600;/s
  );
});

test('opening the editor reads the current URL and saves it', async () => {
  const sourceUrl = 'https://example.com/path?q=1';
  const result = runManager({}, {
    activeTab: { url: sourceUrl }
  });
  const editorSection = result.elements.get('add-section');

  await vm.runInContext('initialize()', result.context);
  editorSection.open = true;
  await editorSection.dispatch('toggle');

  const urlInput = result.elements.get('full-link');
  const shortcutInput = result.elements.get('go-link');
  assert.deepEqual(result.tabQueries, [{ active: true, currentWindow: true }]);
  assert.equal(urlInput.value, sourceUrl);
  assert.equal(editorSection.open, true);

  shortcutInput.value = 'EXAMPLE';
  await result.elements.get('editor-form').dispatch('submit');

  assert.deepEqual(result.getEntries(), {
    example: { url: sourceUrl }
  });
  assert.equal(editorSection.open, true);
});

test('toolbar click opens the side panel and focuses search', async () => {
  const result = runBackground();

  await result.updated;
  await result.listeners.actionClicked({
    windowId: 9,
    url: 'https://example.com/current'
  });

  assert.deepEqual(result.openedPanels, [{ windowId: 9 }]);
  assert.deepEqual(result.createdTabs, []);
  assert.deepEqual(result.runtimeMessages, [{
    type: 'focus-search',
    windowId: 9
  }]);
});

test('opening the editor ignores internal browser URLs', async () => {
  const result = runManager({}, { activeTab: { url: 'chrome://extensions' } });
  await vm.runInContext('initialize()', result.context);

  const editorSection = result.elements.get('add-section');
  editorSection.open = true;
  await editorSection.dispatch('toggle');

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

test('editing opens the editor and cancel resets it', async () => {
  const result = runManager({ gh: { url: 'https://github.com/' } });
  const editorSection = result.elements.get('add-section');
  editorSection.open = false;

  await vm.runInContext('initialize()', result.context);
  vm.runInContext("startEditing('gh')", result.context);

  assert.equal(editorSection.open, true);
  assert.equal(result.context.document.activeElement, result.elements.get('full-link'));

  await result.elements.get('cancel-edit').dispatch('click');

  assert.equal(editorSection.open, true);
  assert.equal(result.elements.get('full-link').value, '');
  assert.equal(result.elements.get('form-title').textContent, 'Add new shortcut');
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

test('opening the editor preserves an existing draft', async () => {
  const result = runManager({}, { activeTab: { url: 'https://example.com/current' } });
  await vm.runInContext('initialize()', result.context);
  result.elements.get('full-link').value = 'https://example.com/draft';

  const editorSection = result.elements.get('add-section');
  editorSection.open = true;
  await editorSection.dispatch('toggle');

  assert.equal(result.elements.get('full-link').value, 'https://example.com/draft');
  assert.deepEqual(result.tabQueries, []);
});

test('side panel ignores focus messages for other windows', async () => {
  const result = runManager();
  await vm.runInContext('initialize()', result.context);
  result.elements.get('go-link').focus();

  result.listeners.runtimeMessage({ type: 'focus-search', windowId: 10 });

  assert.equal(result.context.document.activeElement, result.elements.get('go-link'));
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
  assert.equal(manifest.version, '2.1.3');
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
  assert.equal(manifest.permissions.includes('unlimitedStorage'), false);
});
