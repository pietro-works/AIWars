/* AI Wars Bridge — background service worker.
   Tab manager + job dispatcher. The game page (via bridge.js) asks for a chat
   turn against a bot; we find-or-create the chatbot tab for that match side,
   hand the job to handoff.js in that tab, and get out of the way — results
   travel back through chrome.storage.local (see handoff.js), which survives
   this worker being killed mid-wait.

   Session model: one chatbot tab per (game tab, side) pair. The tab IS the
   conversation — turns of the same match paste into the same thread so the
   model keeps context. A new match (new sessionKey) closes the old tab and
   opens a fresh one. Mechanics follow WireFlow's autopilot handoff. */

'use strict';

const BOT_URLS = {
  chatgpt: 'https://chatgpt.com/',
  claude: 'https://claude.ai/new',
  gemini: 'https://gemini.google.com/app'
};

/* sessions: `${gameTabId}:${side}` -> { sessionKey, tabId, bot }
   Kept in chrome.storage.session so a worker restart mid-match does not
   orphan the conversation tab (storage.session dies with the browser). */

async function getSessions() {
  const o = await chrome.storage.session.get('aiwars_sessions');
  return o.aiwars_sessions || {};
}
async function setSessions(s) {
  await chrome.storage.session.set({ aiwars_sessions: s });
}

/* serialize session-map read-modify-write: two game tabs (or an aborted
   match overlapping a new one) racing get->mutate->set would drop entries
   and orphan chatbot tabs */
let sessionChain = Promise.resolve();
function locked(fn) {
  const p = sessionChain.then(fn, fn);
  sessionChain = p.then(() => {}, () => {});
  return p;
}

/* results published by handoff.js that nobody consumed (tab closed, game
   reloaded) would otherwise sit in chrome.storage.local forever */
async function sweepStaleResults() {
  try {
    const all = await chrome.storage.local.get(null);
    const now = Date.now();
    const dead = Object.keys(all).filter(k =>
      k.startsWith('aiwars_result_') && (!all[k] || !all[k].ts || now - all[k].ts > 10 * 60 * 1000));
    if (dead.length) await chrome.storage.local.remove(dead);
  } catch (e) { /* best effort */ }
}
chrome.runtime.onStartup.addListener(sweepStaleResults);
chrome.runtime.onInstalled.addListener(() => {
  sweepStaleResults();
  chrome.alarms.create('aiwars-sweep', { periodInMinutes: 15 });
});
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'aiwars-sweep') sweepStaleResults(); });

/* a closed chatbot tab invalidates its session entry */
chrome.tabs.onRemoved.addListener(tabId => {
  locked(async () => {
    const sessions = await getSessions();
    let dirty = false;
    for (const k of Object.keys(sessions)) {
      if (sessions[k] && sessions[k].tabId === tabId) { delete sessions[k]; dirty = true; }
    }
    if (dirty) await setSessions(sessions);
  });
});

async function tabExists(tabId) {
  if (typeof tabId !== 'number') return false;
  try { await chrome.tabs.get(tabId); return true; } catch (e) { return false; }
}

async function closeTabQuiet(tabId) {
  try { await chrome.tabs.remove(tabId); } catch (e) { /* already gone */ }
}

function waitTabComplete(tabId, timeoutMs) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(onUpd); resolve(); } };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId).then(t => { if (t.status === 'complete') finish(); }).catch(finish);
    setTimeout(finish, timeoutMs);
  });
}

/* Ensure the chatbot tab for this session exists; create unfocused so the
   game stays visible. Returns tabId. */
async function ensureSessionTab(gameTabId, side, bot, sessionKey) {
  return locked(async () => {
    const key = gameTabId + ':' + side;
    const sessions = await getSessions();
    const cur = sessions[key];

    if (cur && cur.sessionKey === sessionKey && cur.bot === bot && await tabExists(cur.tabId)) {
      return cur.tabId;
    }
    /* new match on this side (or tab died): retire the old tab */
    if (cur && await tabExists(cur.tabId)) await closeTabQuiet(cur.tabId);

    const url = BOT_URLS[bot];
    if (!url) throw new Error('unknown bot: ' + bot);
    const tab = await chrome.tabs.create({ url, active: false });
    sessions[key] = { sessionKey, tabId: tab.id, bot };
    await setSessions(sessions);
    await waitTabComplete(tab.id, 20000);
    return tab.id;
  });
}

/* Deliver the job to handoff.js. Retry ONLY while the content script is not
   reachable (sendMessage throws) or the tab is transiently busy
   (ack.retryable). A terminal ack means handoff already PUBLISHED the error
   result the game will consume — re-pasting the same requestId would push a
   phantom exchange into the chatbot thread after the game moved on. */
async function dispatchToTab(tabId, job) {
  const deadline = Date.now() + 25000;
  let lastErr = 'no attempts';
  while (Date.now() < deadline) {
    try {
      const ack = await chrome.tabs.sendMessage(tabId, { action: 'aiwars.paste', job });
      if (ack && ack.ok) return true;
      if (ack && ack.terminal) return false;   /* result already published by handoff */
      lastErr = (ack && ack.error) || 'handoff refused job';
    } catch (e) {
      lastErr = e.message || String(e); /* content script not ready yet */
    }
    await new Promise(r => setTimeout(r, 800));
  }
  throw new Error('could not hand job to chatbot tab: ' + lastErr);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  if (msg.action === 'aiwars.ping') { sendResponse({ ok: true }); return false; }
  if (msg.action !== 'aiwars.chat') return false;
  const gameTabId = sender.tab ? sender.tab.id : -1;
  (async () => {
    const tabId = await ensureSessionTab(gameTabId, msg.side, msg.bot, msg.sessionKey);
    await dispatchToTab(tabId, {
      // PACS0011 — forwards page-envelope fields by name; mirror any rename from webtab-client.js — AGENTS.md
      requestId: msg.requestId,
      rules: msg.rules,
      body: msg.body,
      timeoutMs: msg.timeoutMs,
      deadlineTs: msg.deadlineTs
    });
    return { ok: true };
  })().then(sendResponse, err => sendResponse({ ok: false, error: err.message || String(err) }));
  return true;  /* async sendResponse */
});
