// Tests for the browse page's relay to the claude.ai content script.
//
// browse.js is a classic script with top-level DOM access, so it cannot be
// imported. The relay block is sliced out of the real source and evaluated with
// its globals injected — the same file that ships, not a copy — because every
// defect found in three rounds of review lived in exactly this glue, and none of
// it had any coverage.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { orderClaudeTabs, chooseRelayTab } = require('../chrome/utils.js');
const BROWSE = fs.readFileSync(path.join(here, '../chrome/browse.js'), 'utf8');

const RELAY_SOURCE = (() => {
  const start = BROWSE.indexOf('const RELAY_PING_TIMEOUT_MS');
  const marker = BROWSE.indexOf('async function sendMessageToClaudeTab(action, data) {');
  const end = BROWSE.indexOf('\n}\n', marker) + 3;
  if (start < 0 || marker < 0) throw new Error('relay block not found in browse.js');
  return BROWSE.slice(start, end);
})();

// Mirrors Chrome's accounting: lastError must be READ inside the callback, or
// the browser logs "Unchecked runtime.lastError". A stub that merely assigns a
// property cannot detect that, which is what the earlier scratch harness missed.
function makeChrome(plan) {
  const unchecked = [];
  let slot = null;

  const runtime = {};
  Object.defineProperty(runtime, 'lastError', {
    configurable: true,
    get() {
      if (slot) slot.read = true;
      return slot ? slot.value : undefined;
    },
  });

  const dispatch = (message, fn) => {
    slot = { value: message ? { message } : undefined, read: false };
    try {
      fn();
    } finally {
      if (slot.value && !slot.read) unchecked.push(slot.value.message);
      slot = null;
    }
  };

  const chrome = {
    runtime,
    unchecked,
    calls: { query: 0, ping: 0, work: 0 },
    tabs: {
      query(queryInfo, callback) {
        chrome.calls.query++;
        const result = plan.query(queryInfo);
        if (result === 'hang') return;             // callback erased, never fires
        if (result === 'throw') throw new Error('Extension context invalidated.');
        setTimeout(() => dispatch(result.error, () => callback(result.tabs)), 0);
      },
      sendMessage(tabId, message, callback) {
        const tab = plan.tabs[tabId];
        if (message.action === 'ping') chrome.calls.ping++; else chrome.calls.work++;
        if (tab.sendThrows) throw new Error('Extension context invalidated.');
        const behaviour = message.action === 'ping' ? tab.ping : tab.work;
        if (behaviour === 'silent') return;        // channel held open, no reply
        const delay = behaviour.delay || 0;
        setTimeout(() => dispatch(behaviour.error, () => callback(behaviour.response)), delay);
      },
    },
  };
  return chrome;
}

function loadRelay(chrome) {
  const factory = new Function(
    'chrome', 'console', 'MAX_RETRY_ATTEMPTS', 'MAX_RETRY_DELAY_MS',
    'orderClaudeTabs', 'chooseRelayTab',
    RELAY_SOURCE + `
    return { sendMessageToClaudeTab, queryTabs, sendToTab, relayTimeoutFor,
             RELAY_PING_TIMEOUT_MS, RELAY_QUERY_TIMEOUT_MS,
             RELAY_DEFAULT_TIMEOUT_MS, RELAY_RETRY_TIMEOUT_MS };`);
  return factory(chrome, { warn() {}, log() {} }, 6, 60000, orderClaudeTabs, chooseRelayTab);
}

const liveTab = (id, win = 1) => ({
  id, windowId: win, discarded: false, frozen: false, status: 'complete',
});

const ok = { response: { success: true }, error: null };
const noReceiver = { response: undefined, error: 'Could not establish connection. Receiving end does not exist.' };

// Drives real promises while fake timers advance, then returns the settled state.
async function settle(promise, ms) {
  const outcome = promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
  await vi.advanceTimersByTimeAsync(ms);
  return outcome;
}

describe('browse page relay', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('relays through a healthy tab', async () => {
    const chrome = makeChrome({
      query: () => ({ tabs: [liveTab(1)], error: null }),
      tabs: { 1: { ping: ok, work: { response: { success: true, data: 'x' }, error: null } } },
    });
    const relay = loadRelay(chrome);
    const result = await settle(relay.sendMessageToClaudeTab('loadConversations', {}), 5000);
    expect(result.ok).toBe(true);
    expect(result.value.data).toBe('x');
    expect(chrome.unchecked).toEqual([]);
  });

  it('gives an unretried action a short budget and the retrying one a long budget', async () => {
    // The conversation list retries a 429 honouring Retry-After; detectOrgId and
    // loadProjects are single fetches. One budget cannot fit both, and applying
    // the retry-derived figure to detectOrgId let the original complaint — a page
    // stuck on "Fetching organization ID..." — last for minutes.
    const relay = loadRelay(makeChrome({ query: () => ({ tabs: [], error: null }), tabs: {} }));
    expect(relay.relayTimeoutFor('detectOrgId')).toBe(relay.RELAY_DEFAULT_TIMEOUT_MS);
    expect(relay.relayTimeoutFor('loadProjects')).toBe(relay.RELAY_DEFAULT_TIMEOUT_MS);
    expect(relay.relayTimeoutFor('loadConversations')).toBe(relay.RELAY_RETRY_TIMEOUT_MS);
    expect(relay.RELAY_DEFAULT_TIMEOUT_MS).toBeLessThan(relay.RELAY_RETRY_TIMEOUT_MS);
  });

  it('covers the sleeping AND the requests between sleeps in the retry budget', async () => {
    // 6 * 60s of backoff is only the sleeping; abandoning a call that is still
    // making progress and blaming the tab is the failure this exists to remove.
    const relay = loadRelay(makeChrome({ query: () => ({ tabs: [], error: null }), tabs: {} }));
    expect(relay.RELAY_RETRY_TIMEOUT_MS).toBeGreaterThan(6 * 60000);
  });

  it('abandons an unretried action well before the retry budget', async () => {
    const chrome = makeChrome({
      query: () => ({ tabs: [liveTab(1)], error: null }),
      tabs: { 1: { ping: ok, work: 'silent' } },
    });
    const relay = loadRelay(chrome);
    const result = await settle(relay.sendMessageToClaudeTab('detectOrgId', {}),
      relay.RELAY_DEFAULT_TIMEOUT_MS + 1000);
    expect(result.ok).toBe(false);
    expect(result.error.message).toMatch(/Reload your claude\.ai tab/);
  });

  it('routes around a wedged tab to a healthy one', async () => {
    const chrome = makeChrome({
      query: (q) => q.currentWindow
        ? ({ tabs: [liveTab(1)], error: null })
        : ({ tabs: [liveTab(1), liveTab(2, 2)], error: null }),
      tabs: { 1: { ping: 'silent' }, 2: { ping: ok, work: { response: { success: true, from: 2 }, error: null } } },
    });
    const relay = loadRelay(chrome);
    const result = await settle(relay.sendMessageToClaudeTab('loadConversations', {}), 5000);
    expect(result.ok).toBe(true);
    expect(result.value.from).toBe(2);
  });

  it('prefers a healthy tab over one with no content script', async () => {
    // "Receiving end does not exist" was once treated as proof the plumbing
    // worked, so a dead tab could be chosen ahead of a working one.
    const chrome = makeChrome({
      query: (q) => q.currentWindow
        ? ({ tabs: [liveTab(1)], error: null })
        : ({ tabs: [liveTab(1), liveTab(2, 2)], error: null }),
      tabs: { 1: { ping: noReceiver }, 2: { ping: ok, work: { response: { success: true, from: 2 }, error: null } } },
    });
    const relay = loadRelay(chrome);
    const result = await settle(relay.sendMessageToClaudeTab('loadConversations', {}), 5000);
    expect(result.ok).toBe(true);
    expect(result.value.from).toBe(2);
    expect(chrome.unchecked).toEqual([]);
  });

  it('probes unresponsive tabs concurrently, not one after another', async () => {
    // Serially this costs candidates x ping budget, which is ordinary after a
    // session restore leaves several slept claude.ai tabs.
    const tabs = {};
    const list = [];
    for (let id = 1; id <= 5; id++) { tabs[id] = { ping: 'silent' }; list.push(liveTab(id)); }
    const chrome = makeChrome({ query: () => ({ tabs: list, error: null }), tabs });
    const relay = loadRelay(chrome);

    const pending = relay.sendMessageToClaudeTab('loadConversations', {})
      .then(() => 'resolved', () => 'rejected');
    // One ping budget plus slack: serial probing would still be waiting.
    await vi.advanceTimersByTimeAsync(relay.RELAY_PING_TIMEOUT_MS + 100);
    await expect(pending).resolves.toBe('rejected');
    expect(chrome.calls.ping).toBe(5);
  });

  it('names waking a tab as well as reloading it when nothing answers', async () => {
    const chrome = makeChrome({
      query: () => ({ tabs: [liveTab(1)], error: null }),
      tabs: { 1: { ping: 'silent' } },
    });
    const relay = loadRelay(chrome);
    const result = await settle(relay.sendMessageToClaudeTab('loadConversations', {}), 5000);
    expect(result.ok).toBe(false);
    expect(result.error.message).toMatch(/asleep/);
    expect(result.error.message).toMatch(/reload/i);
  });

  it('does not hang when a tab query callback is never invoked', async () => {
    // An extension reload erases in-flight API requests without calling back.
    // Discovery had no timer, so the page span forever — the very symptom this
    // mechanism exists to remove.
    const chrome = makeChrome({ query: () => 'hang', tabs: {} });
    const relay = loadRelay(chrome);
    const result = await settle(relay.sendMessageToClaudeTab('loadConversations', {}),
      relay.RELAY_QUERY_TIMEOUT_MS + 1000);
    expect(result.ok).toBe(false);
    expect(result.error.message).toMatch(/Could not look for a claude\.ai tab/);
  });

  it('reports why the lookup failed instead of blaming the user', async () => {
    const chrome = makeChrome({
      query: () => ({ tabs: [], error: 'Tabs cannot be queried right now.' }),
      tabs: {},
    });
    const relay = loadRelay(chrome);
    const result = await settle(relay.sendMessageToClaudeTab('loadConversations', {}), 5000);
    expect(result.ok).toBe(false);
    expect(result.error.message).toMatch(/Tabs cannot be queried right now/);
    expect(result.error.message).not.toMatch(/open a claude\.ai tab first/);
    expect(chrome.unchecked).toEqual([]);
  });

  it('asks the user to open a tab only when none is actually open', async () => {
    const chrome = makeChrome({ query: () => ({ tabs: [], error: null }), tabs: {} });
    const relay = loadRelay(chrome);
    const result = await settle(relay.sendMessageToClaudeTab('loadConversations', {}), 5000);
    expect(result.ok).toBe(false);
    expect(result.error.message).toMatch(/open a claude\.ai tab first/);
  });

  it('survives a query that throws synchronously', async () => {
    const chrome = makeChrome({ query: () => 'throw', tabs: {} });
    const relay = loadRelay(chrome);
    const result = await settle(relay.sendMessageToClaudeTab('loadConversations', {}), 5000);
    expect(result.ok).toBe(false);
    expect(result.error.message).toMatch(/Extension context invalidated/);
  });

  it('rejects and clears its timer when sendMessage throws synchronously', async () => {
    // Tested on sendToTab directly and without advancing the clock: letting the
    // clock run would fire the leaked timer, and a count of zero afterwards
    // would prove nothing at all.
    const chrome = makeChrome({
      query: () => ({ tabs: [], error: null }),
      tabs: { 1: { sendThrows: true } },
    });
    const relay = loadRelay(chrome);
    const armed = vi.getTimerCount();
    await expect(relay.sendToTab(1, { action: 'ping' }, relay.RELAY_PING_TIMEOUT_MS))
      .rejects.toThrow(/Extension context invalidated/);
    // A bare throw out of the executor rejects the promise too, but leaves the
    // timeout armed; only routing it through finish clears it.
    expect(vi.getTimerCount()).toBe(armed);
  });

  it('surfaces a handler error without claiming the tab is broken', async () => {
    const chrome = makeChrome({
      query: () => ({ tabs: [liveTab(1)], error: null }),
      tabs: { 1: { ping: ok, work: { response: { success: false, error: 'HTTP 500' }, error: null } } },
    });
    const relay = loadRelay(chrome);
    const result = await settle(relay.sendMessageToClaudeTab('loadConversations', {}), 5000);
    expect(result.ok).toBe(false);
    expect(result.error.message).toBe('HTTP 500');
  });
});
