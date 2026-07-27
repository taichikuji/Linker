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

function runBackground(apiNamespace, existingTabs = []) {
  const listeners = {};
  const createdTabs = [];
  const updatedTabs = [];
  const sentMessages = [];
  const focusedWindows = [];
  let resolveUpdate;
  const updated = new Promise(resolve => {
    resolveUpdate = resolve;
  });

  const api = {
    declarativeNetRequest: {
      MAX_NUMBER_OF_REGEX_RULES: 1000,
      getDynamicRules: async () => [{ id: 99 }],
      updateDynamicRules: async options => {
        resolveUpdate(JSON.parse(JSON.stringify(options)));
      }
    },
    runtime: {
      getURL: path => `moz-extension://linker/${path}`,
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
    [apiNamespace]: api,
    URL,
    console
  });
  vm.runInContext(backgroundSource, context);

  return {
    listeners,
    updated,
    createdTabs,
    updatedTabs,
    sentMessages,
    focusedWindows
  };
}

for (const apiNamespace of ['browser', 'chrome']) {
  test(`background initializes through the ${apiNamespace} API`, async () => {
    const { listeners, updated, createdTabs } = runBackground(apiNamespace);
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
      url: 'moz-extension://linker/src/manager/manager.html#https%3A%2F%2Fexample.com%2Fpath%3Fq%3D1'
    }]);
  });
}

test('toolbar click focuses an existing Firefox manager tab', async () => {
  const managerUrl = 'moz-extension://linker/src/manager/manager.html';
  const result = runBackground('browser', [{
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

test('manifest declares Chromium and Firefox background contexts', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(
    manifest.background.service_worker,
    'src/background/service-worker.js'
  );
  assert.deepEqual(
    manifest.background.scripts,
    ['src/background/service-worker.js']
  );
  assert.equal(manifest.action.default_popup, undefined);
  assert.deepEqual(manifest.browser_specific_settings.gecko, {
    id: 'linker@taichikuji.github.io',
    strict_min_version: '133.0',
    data_collection_permissions: {
      required: ['none']
    }
  });
});
