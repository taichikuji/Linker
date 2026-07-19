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
const popupSource = readFileSync(join(root, 'src/popup/popup.js'), 'utf8');

function runBackground(apiNamespace) {
  const listeners = {};
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
    }
  };

  const context = vm.createContext({
    [apiNamespace]: api,
    URL,
    console
  });
  vm.runInContext(backgroundSource, context);

  return { listeners, updated };
}

function runOpenImport(apiNamespace, search = '') {
  let filePickerOpened = false;
  let tabUrl;
  const fileInput = {
    click: () => {
      filePickerOpened = true;
    }
  };
  const api = {
    declarativeNetRequest: { MAX_NUMBER_OF_REGEX_RULES: 1000 },
    storage: { onChanged: { addListener() {} } },
    tabs: {
      create: ({ url }) => {
        tabUrl = url;
      }
    }
  };
  const context = vm.createContext({
    [apiNamespace]: api,
    console,
    document: {
      addEventListener() {},
      getElementById: id => id === 'import-file' ? fileInput : {}
    },
    location: {
      href: `moz-extension://linker/src/popup/popup.html${search}`,
      search
    },
    URL
  });

  vm.runInContext(popupSource, context);
  vm.runInContext('openImport()', context);
  return { filePickerOpened, tabUrl };
}

for (const apiNamespace of ['browser', 'chrome']) {
  test(`background initializes through the ${apiNamespace} API`, async () => {
    const { listeners, updated } = runBackground(apiNamespace);
    const update = await updated;

    assert.equal(typeof listeners.installed, 'function');
    assert.equal(typeof listeners.startup, 'function');
    assert.equal(typeof listeners.storageChanged, 'function');
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
}

test('Firefox opens imports outside the toolbar popup', () => {
  const firefoxPopup = runOpenImport('browser');
  const firefoxTab = runOpenImport('browser', '?import');
  const chromiumPopup = runOpenImport('chrome');

  assert.equal(
    firefoxPopup.tabUrl,
    'moz-extension://linker/src/popup/popup.html?import'
  );
  assert.equal(firefoxPopup.filePickerOpened, false);
  assert.equal(firefoxTab.filePickerOpened, true);
  assert.equal(chromiumPopup.filePickerOpened, true);
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
  assert.deepEqual(manifest.browser_specific_settings.gecko, {
    id: 'linker@taichikuji.github.io',
    strict_min_version: '133.0',
    data_collection_permissions: {
      required: ['none']
    }
  });
});
