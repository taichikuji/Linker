// Constants and Configuration
const CONFIG = {
  STORAGE_NAMESPACE: 'sync',
  PREFILL_KEY_PREFIX: 'side-panel-prefill:',
  ALLOWED_PROTOCOLS: ['http:', 'https:'],
  RESOURCE_TYPES: ['main_frame'],
  VARIABLE_TOKEN: '{*}'
};

const MAX_REGEX_RULES = chrome.declarativeNetRequest.MAX_NUMBER_OF_REGEX_RULES ?? 1000;
let ruleSyncQueue = Promise.resolve();

/**
 * Returns true when a stored value contains a redirectable web URL.
 * In order to provide migration path from Linkify to Linker,
 * existing Linkify entries, which use the shape `{ url, rules }`, are also considered valid.
 * The fallback URL is required only for parameterized entries.
 */
function isValidStoredEntry(value) {
  if (!value || typeof value !== 'object' || typeof value.url !== 'string') {
    return false;
  }

  if (!isValidTargetUrl(value.url)) {
    return false;
  }

  return !hasVariable(value.url)
    || (typeof value.fallbackUrl === 'string' && isValidTargetUrl(value.fallbackUrl));
}

function isValidTargetUrl(url) {
  try {
    return CONFIG.ALLOWED_PROTOCOLS.includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function hasVariable(url) {
  return url.includes(CONFIG.VARIABLE_TOKEN);
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
  const stored = await chrome.storage[CONFIG.STORAGE_NAMESPACE].get(null);
  return Object.entries(stored)
    .filter(([, value]) => isValidStoredEntry(value))
    .sort(([left], [right]) => left.localeCompare(right));
}

/**
 * Builds one fallback rule for every shortcut. Parameterized entries get one
 * additional higher-priority rule that substitutes the trailing value into
 * each `{*}` token.
 */
function buildRedirectRules(entries) {
  let nextRuleId = 1;
  const rules = [];

  entries.forEach(([shortcut, value]) => {
    const directShortcut = escapeRegex(shortcut);
    const encodedShortcut = escapeRegex(encodeURIComponent(shortcut));
    const parameterized = hasVariable(value.url);
    const defaultUrl = parameterized ? value.fallbackUrl : value.url;

    if (parameterized) {
      const regexSubstitution = value.url.replaceAll(CONFIG.VARIABLE_TOKEN, '\\1\\2');

      rules.push({
        id: nextRuleId++,
        priority: 2,
        action: {
          type: 'redirect',
          redirect: { regexSubstitution }
        },
        condition: {
          regexFilter: `^(?:https?://go/${directShortcut}/([^?#]+?)/?$|https?://.*[?&][^#]*=go%2F${encodedShortcut}%2F([^&#]+)(?:[&#].*)?$)`,
          resourceTypes: CONFIG.RESOURCE_TYPES
        }
      });
    }

    rules.push({
      id: nextRuleId++,
      priority: 1,
      action: {
        type: 'redirect',
        redirect: { url: defaultUrl }
      },
      condition: {
        regexFilter: `^(?:https?://go/${directShortcut}/?$|https?://.*[?&][^#]*=go%2F${encodedShortcut}(?:&|$))`,
        resourceTypes: CONFIG.RESOURCE_TYPES
      }
    });
  });

  return rules;
}

/**
 * Atomically replaces Linker's dynamic redirect rules.
 */
async function updateRedirectRules() {
  const entries = await getStoredEntries();
  const newRules = buildRedirectRules(entries);

  if (newRules.length > MAX_REGEX_RULES) {
    throw new Error(
      `Generated ${newRules.length} regex rules; browser limit is ${MAX_REGEX_RULES}.`
    );
  }

  const oldRules = await chrome.declarativeNetRequest.getDynamicRules();

  await chrome.declarativeNetRequest.updateDynamicRules({
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

async function consumePendingPrefill(windowId) {
  if (!Number.isInteger(windowId)) return null;

  const key = `${CONFIG.PREFILL_KEY_PREFIX}${windowId}`;
  const stored = await chrome.storage.session.get(key);
  await chrome.storage.session.remove(key);

  const prefill = stored[key];
  return prefill
    && typeof prefill.id === 'string'
    && isValidTargetUrl(prefill.url)
    ? prefill
    : null;
}

async function openSidePanel(sourceTab) {
  try {
    if (!Number.isInteger(sourceTab?.windowId)) {
      throw new Error('The toolbar action did not provide a browser window.');
    }

    const windowId = sourceTab.windowId;
    const prefillKey = `${CONFIG.PREFILL_KEY_PREFIX}${windowId}`;
    const sourceUrl = isValidTargetUrl(sourceTab?.url) ? sourceTab.url : '';
    await chrome.sidePanel.open({ windowId });

    let message = { type: 'focus-search', windowId };
    if (sourceUrl) {
      const prefill = { id: crypto.randomUUID(), url: sourceUrl };
      await chrome.storage.session.set({ [prefillKey]: prefill });
      message = { type: 'prefill-url', windowId, ...prefill };
    } else {
      await chrome.storage.session.remove(prefillKey);
    }

    await chrome.runtime.sendMessage(message).catch(() => {});
  } catch (error) {
    console.error('Error opening Linker side panel:', error);
  }
}

chrome.runtime.onInstalled.addListener(() => scheduleRuleUpdate().catch(() => {}));
chrome.runtime.onStartup.addListener(() => scheduleRuleUpdate().catch(() => {}));
chrome.action.onClicked.addListener(openSidePanel);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'consume-prefill') return undefined;

  consumePendingPrefill(message.windowId)
    .then(sendResponse)
    .catch(error => {
      console.error('Error consuming side panel prefill:', error);
      sendResponse(null);
    });
  return true;
});

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === CONFIG.STORAGE_NAMESPACE && Object.keys(changes).length > 0) {
    scheduleRuleUpdate().catch(() => {
      chrome.runtime.sendMessage({ type: 'rule-update-failed' }).catch(() => {});
    });
  }
});

// Background contexts can start independently of browser startup events.
scheduleRuleUpdate().catch(() => {});
