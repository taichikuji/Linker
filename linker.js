// Constants and Configuration
const CONFIG = {
  STORAGE_NAMESPACE: 'sync',
  ALLOWED_PROTOCOLS: ['http:', 'https:'],
  RESOURCE_TYPES: ['main_frame']
};

const browserApi = globalThis.browser ?? globalThis.chrome;
let ruleSyncQueue = Promise.resolve();

/**
 * Returns true when a stored value contains a redirectable web URL.
 * Existing Linkify entries use the shape `{ url, rules }`; the `rules`
 * property remains optional because it was only ever a placeholder.
 */
function isValidStoredEntry(value) {
  if (!value || typeof value !== 'object' || typeof value.url !== 'string') {
    return false;
  }

  try {
    return CONFIG.ALLOWED_PROTOCOLS.includes(new URL(value.url).protocol);
  } catch {
    return false;
  }
}

/**
 * Escapes text before inserting it into a declarativeNetRequest RE2 pattern.
 */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reads all compatible Linkify/Linker entries from sync storage.
 */
async function getStoredEntries() {
  const stored = await browserApi.storage[CONFIG.STORAGE_NAMESPACE].get(null);
  return Object.entries(stored)
    .filter(([, value]) => isValidStoredEntry(value))
    .sort(([left], [right]) => left.localeCompare(right));
}

/**
 * Builds the two historical redirect rules for every shortcut:
 * direct navigation to go/<shortcut> and search-engine fallback URLs.
 */
function buildRedirectRules(entries) {
  let nextRuleId = 1;
  const rules = [];

  entries.forEach(([shortcut, value]) => {
    const directShortcut = escapeRegex(shortcut);
    const encodedShortcut = escapeRegex(encodeURIComponent(shortcut));

    rules.push(
      {
        id: nextRuleId,
        priority: 1,
        action: {
          type: 'redirect',
          redirect: { url: value.url }
        },
        condition: {
          regexFilter: `^https?://go/${directShortcut}/?$`,
          resourceTypes: CONFIG.RESOURCE_TYPES
        }
      },
      {
        id: nextRuleId + 1,
        priority: 1,
        action: {
          type: 'redirect',
          redirect: { url: value.url }
        },
        condition: {
          regexFilter: `^https?://.*[?&][^#]*=go%2F${encodedShortcut}(&|$)`,
          resourceTypes: CONFIG.RESOURCE_TYPES
        }
      }
    );

    nextRuleId += 2;
  });

  return rules;
}

/**
 * Atomically replaces Linker's dynamic redirect rules.
 */
async function updateRedirectRules() {
  const entries = await getStoredEntries();
  const newRules = buildRedirectRules(entries);
  const oldRules = await browserApi.declarativeNetRequest.getDynamicRules();

  await browserApi.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: oldRules.map(rule => rule.id),
    addRules: newRules
  });
}

/**
 * Serializes updates so rapid sync-storage changes cannot install stale rules.
 */
function scheduleRuleUpdate() {
  const next = ruleSyncQueue.then(updateRedirectRules, updateRedirectRules);
  ruleSyncQueue = next.catch(error => {
    console.error('Error updating Linker redirect rules:', error);
  });
  return next;
}

browserApi.runtime.onInstalled.addListener(scheduleRuleUpdate);
browserApi.runtime.onStartup.addListener(scheduleRuleUpdate);

browserApi.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === CONFIG.STORAGE_NAMESPACE && Object.keys(changes).length > 0) {
    scheduleRuleUpdate();
  }
});

self.addEventListener('activate', event => {
  event.waitUntil(scheduleRuleUpdate());
});

// Service workers can be restarted independently of browser startup events.
scheduleRuleUpdate();
