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

const clone = value => JSON.parse(JSON.stringify(value));

function eventSlot(listeners, name) {
  return {
    addListener(listener) {
      listeners[name] = listener;
    }
  };
}

function runBackground(existingTabs = [], options = {}) {
  const listeners = {};
  const createdTabs = [];
  const updatedTabs = [];
  const sentMessages = [];
  const runtimeMessages = [];
  const focusedWindows = [];
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
      getURL: path => `chrome-extension://linker/${path}`,
      sendMessage: async message => runtimeMessages.push(clone(message)),
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
    tabs: {
      query: async () => existingTabs,
      create: async options => {
        createdTabs.push(JSON.parse(JSON.stringify(options)));
      },
      update: async (id, options) => {
        updatedTabs.push([id, JSON.parse(JSON.stringify(options))]);
      },
      sendMessage: async (id, message) => {
        sentMessages.push([id, JSON.parse(JSON.stringify(message))]);
      }
    },
    windows: {
      update: async (id, options) => {
        focusedWindows.push([id, JSON.parse(JSON.stringify(options))]);
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
    updatedTabs,
    sentMessages,
    runtimeMessages,
    errors,
    focusedWindows
  };
}

function runManager(initialEntries = {}, options = {}) {
  const listeners = {};
  const elements = new Map();
  const openedTabs = [];
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
    }
  };

  const context = vm.createContext({
    chrome: api,
    Blob,
    URL,
    clearTimeout() {},
    console,
    document,
    history: { replaceState() {} },
    location: {
      hash: options.hash ?? '',
      pathname: '/src/manager/manager.html'
    },
    setTimeout: () => 0
  });
  vm.runInContext(managerSource, context);

  return {
    context,
    elements,
    listeners,
    openedTabs,
    getEntries: () => clone(entries)
  };
}

test('background initializes through the Chromium extension API', async () => {
  const { listeners, updated, createdTabs } = runBackground();
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

  await listeners.actionClicked({ url: 'https://example.com/path?q=1' });
  assert.deepEqual(createdTabs, [{
    active: true,
    url: 'chrome-extension://linker/src/manager/manager.html#https%3A%2F%2Fexample.com%2Fpath%3Fq%3D1'
  }]);
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

test('manager prefills and saves through the Chromium extension API', async () => {
  const sourceUrl = 'https://example.com/path?q=1';
  const result = runManager({}, {
    hash: `#${encodeURIComponent(sourceUrl)}`
  });

  await vm.runInContext('initialize()', result.context);

  const urlInput = result.elements.get('full-link');
  const shortcutInput = result.elements.get('go-link');
  assert.equal(urlInput.value, sourceUrl);
  assert.equal(result.context.document.activeElement, result.elements.get('search'));

  shortcutInput.value = 'EXAMPLE';
  await result.elements.get('editor-form').dispatch('submit');

  assert.deepEqual(result.getEntries(), {
    example: { url: sourceUrl }
  });
});

test('toolbar click focuses an existing manager tab', async () => {
  const managerUrl = 'chrome-extension://linker/src/manager/manager.html';
  const result = runBackground([{
    id: 7,
    url: managerUrl,
    windowId: 9
  }]);

  await result.updated;
  await result.listeners.actionClicked({});

  assert.deepEqual(result.createdTabs, []);
  assert.deepEqual(result.updatedTabs, [[7, { active: true }]]);
  assert.deepEqual(result.focusedWindows, [[9, { focused: true }]]);
  assert.deepEqual(result.sentMessages, [[7, { type: 'focus-search' }]]);
});

test('toolbar click prefills an existing manager from the current page', async () => {
  const managerUrl = 'chrome-extension://linker/src/manager/manager.html';
  const result = runBackground([{ id: 7, url: managerUrl, windowId: 9 }]);

  await result.updated;
  await result.listeners.actionClicked({ url: 'https://example.com/current' });

  assert.deepEqual(result.sentMessages, [[7, {
    type: 'prefill-url',
    url: 'https://example.com/current'
  }]]);
});

test('routing failures are reported to the manager', async () => {
  const result = runBackground([], { failRuleUpdateAt: 2 });
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

test('existing manager prefills the current URL while returning focus to search', async () => {
  const result = runManager();
  await vm.runInContext('initialize()', result.context);
  result.elements.get('go-link').focus();

  result.listeners.runtimeMessage({
    type: 'prefill-url',
    url: 'https://example.com/current'
  });

  assert.equal(result.elements.get('full-link').value, 'https://example.com/current');
  assert.equal(result.context.document.activeElement, result.elements.get('search'));
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
  assert.equal(
    manifest.background.service_worker,
    'src/background/service-worker.js'
  );
  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(manifest.permissions.includes('unlimitedStorage'), false);
});
