const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = join(__dirname, '..');
const backgroundSource = readFileSync(join(root, 'src/background/service-worker.js'), 'utf8');
const managerSource = readFileSync(join(root, 'src/manager/manager.js'), 'utf8');
const managerHtml = readFileSync(join(root, 'src/manager/manager.html'), 'utf8');

function eventSlot(listeners, name) {
  return { addListener(listener) { listeners[name] = listener; } };
}

function runBackground() {
  const listeners = {};
  const openedPanels = [];
  let resolveUpdate;
  const updated = new Promise(resolve => { resolveUpdate = resolve; });

  vm.runInContext(backgroundSource, vm.createContext({
    URL,
    console,
    chrome: {
      declarativeNetRequest: {
        MAX_NUMBER_OF_REGEX_RULES: 1000,
        getDynamicRules: async () => [],
        updateDynamicRules: async details => resolveUpdate(details)
      },
      runtime: {
        sendMessage: async () => {},
        onInstalled: eventSlot(listeners, 'installed'),
        onStartup: eventSlot(listeners, 'startup')
      },
      action: { onClicked: eventSlot(listeners, 'actionClicked') },
      sidePanel: { open: async details => openedPanels.push(details) },
      storage: {
        sync: {
          get: async () => ({
            gh: { url: 'https://github.com/' },
            issue: {
              url: 'https://github.com/taichikuji/Linker/issues/{*}',
              fallbackUrl: 'https://github.com/taichikuji/Linker/issues'
            }
          })
        },
        onChanged: eventSlot(listeners, 'storageChanged')
      }
    }
  }));

  return { listeners, openedPanels, updated };
}

function runManager() {
  const listeners = {};
  const element = () => ({ addEventListener() {}, classList: { add() {}, remove() {} } });
  const context = vm.createContext({
    Blob,
    URL,
    clearTimeout() {},
    console,
    setTimeout() {},
    document: { addEventListener() {}, getElementById: element },
    chrome: {
      declarativeNetRequest: { MAX_NUMBER_OF_REGEX_RULES: 1000 },
      runtime: { onMessage: eventSlot(listeners, 'runtimeMessage') },
      storage: {
        sync: { MAX_ITEMS: 512, QUOTA_BYTES: 102400, QUOTA_BYTES_PER_ITEM: 8192 },
        onChanged: eventSlot(listeners, 'storageChanged')
      }
    }
  });

  vm.runInContext(managerSource, context);
  return context;
}

test('routes saved shortcuts and opens the side panel', async () => {
  const result = runBackground();
  const update = await result.updated;

  assert.equal(update.addRules.length, 3);
  assert.equal(update.addRules[0].action.redirect.url, 'https://github.com/');
  assert.equal(update.addRules[1].priority, 2);

  await result.listeners.actionClicked({ windowId: 9 });
  assert.equal(result.openedPanels[0].windowId, 9);
});

test('validates imported shortcuts and uses native manager semantics', () => {
  const imported = JSON.parse(vm.runInContext(`JSON.stringify(parseImportData({
    docs: 'https://example.com/docs/',
    issue: { url: 'https://github.com/issues/{*}', fallbackUrl: 'https://github.com/issues' },
    unsafe: 'javascript:alert(1)'
  }))`, runManager()));

  assert.deepEqual(Object.keys(imported.entries), ['docs', 'issue']);
  assert.equal(imported.skippedCount, 1);
  assert.match(managerHtml, /<search aria-label="Search shortcuts">/);
  assert.match(managerHtml, /<dialog id="confirm-modal"/);
  assert.doesNotMatch(managerHtml, /novalidate/);
});

test('manifest references valid release assets without a browser-version pin', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

  assert.equal(manifest.version, '2.1.1');
  assert.equal(manifest.minimum_chrome_version, undefined);
  assert.equal(manifest.manifest_version, 3);
  Object.values(manifest.icons).forEach(path => assert.equal(existsSync(join(root, path)), true));
});
