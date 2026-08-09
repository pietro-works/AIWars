/*
 * AI WARS — webtab-client.js
 * API-less provider: plays through a chatbot WEB TAB (ChatGPT / Claude /
 * Gemini web UIs) via the AI Wars Bridge extension. Free, slower, fun.
 *
 *   AIWARS.WebTab.ping()                                   -> Promise<bool>
 *   AIWARS.WebTab.requestStance({bot, side, sessionKey})    -> Promise<{raw, parsed}>
 *   AIWARS.WebTab.requestOrders({bot, side, sessionKey, payload}) -> Promise<{raw}>
 *   AIWARS.WebTab.BOTS                                      -> [{id,label}...]
 *
 * Transport: window.postMessage to the bridge content script; the extension
 * opens/reuses one chatbot tab per (side, sessionKey), pastes the message,
 * and scrapes back the block the model wraps between AIWARS_RESULT <id> /
 * AIWARS_END. Ruleset (shared LLM system prompt + reply protocol) rides the
 * FIRST message of each session; later turns reuse the thread's context.
 *
 * Failure surface matches AIWARS.LLM: Error .name='LLMFailure',
 *   .kind='auth'      — bridge missing / bot page broken (not logged in...)
 *   .kind='exhausted' — reply timeout
 */
(function (g) {
  'use strict';

  const NS = g.AIWARS = g.AIWARS || {};

  const BOTS = [
    { id: 'chatgpt', label: 'CHATGPT WEB (FREE)' },
    { id: 'claude',  label: 'CLAUDE WEB (FREE)' },
    { id: 'gemini',  label: 'GEMINI WEB (FREE)' }
  ];
  const REPLY_TIMEOUT_MS = 240000;   /* web tabs are slow: tab boot + typing time */
  const OVERALL_TIMEOUT_MS = 300000;

  let seq = 0;
  const primed = {};   /* sessionKey -> true once rules were sent */

  function failure(kind, message) {
    const err = new Error(message);
    err.name = 'LLMFailure';
    err.kind = kind;
    return err;
  }

  function newId(prefix) {
    /* hyphens, not underscores: chatbot composers live-format markdown, and a
       lone _word_ run (this id always had an odd underscore count) renders as
       italics, silently eating characters from both the pasted marker and the
       model's own echoed reply text */
    return prefix + '-' + Date.now().toString(36) + '-' + (++seq) + '-' + Math.random().toString(36).slice(2, 7);
  }

  /* one round-trip to the bridge; resolves with the bridge's response object */
  function bridgeCall(msg, timeoutMs) {
    return new Promise(function (resolve, reject) {
      const id = newId('bc');
      let timer = null;
      function onMsg(ev) {
        if (ev.source !== g) return;
        const m = ev.data;
        if (!m || m.__aiwars_bridge !== 'res' || m.id !== id) return;
        g.removeEventListener('message', onMsg);
        clearTimeout(timer);
        resolve(m);
      }
      g.addEventListener('message', onMsg);
      timer = setTimeout(function () {
        g.removeEventListener('message', onMsg);
        reject(failure('exhausted', 'no reply from bridge in ' + timeoutMs + 'ms'));
      }, timeoutMs);
      // PACS0011 — page→bridge envelope; extension bridge.js/background.js read these fields BY NAME (no spread) — AGENTS.md (known sites, not exhaustive)
      g.postMessage(Object.assign({ __aiwars_bridge: 'req', id: id }, msg), '*');
    });
  }

  function ping() {
    return bridgeCall({ kind: 'ping' }, 1500).then(
      function (m) { return !!(m && m.ok); },
      function () { return false; }
    );
  }

  function rulesText(requestId) {
    // PACS0010 — source the system prompt from NS.LLM._buildSystemPrompt; never inline — AGENTS.md (known sites, not exhaustive)
    if (!NS.LLM || typeof NS.LLM._buildSystemPrompt !== 'function') {
      throw failure('auth', 'llm-client.js must load before webtab-client.js');
    }
    return [
      NS.LLM._buildSystemPrompt(),
      '',
      'WEB SESSION PROTOCOL — this chat thread is a live match. Each of my messages is one request',
      // PACS0012 — reply markers AIWARS_RESULT/AIWARS_END must byte-match extension/handoff.js regexes — AGENTS.md (known sites, not exhaustive)
      '(a stance request or a turn state). For EVERY reply: first line exactly `AIWARS_RESULT <request id>`',
      '(the id is given in each message), then your single JSON object, then a final line exactly `AIWARS_END`.',
      'Nothing else before, between, or after those lines.'
    ].join('\n');
  }

  function bodyText(requestId, contentJson) {
    return [
      'AIWARS REQUEST id=' + requestId,
      contentJson,
      'Reply now: line 1 `AIWARS_RESULT ' + requestId + '`, then your JSON object, then `AIWARS_END`.'
    ].join('\n');
  }

  async function requestRaw(opts, contentJson) {
    if (!opts || !opts.bot) throw failure('auth', 'missing web bot id');
    if (typeof g.postMessage !== 'function' || typeof g.document === 'undefined') {
      throw failure('auth', 'web tab provider requires a browser');
    }
    const requestId = newId('aw');
    const sessionKey = String(opts.sessionKey || 'default');
    const first = !primed[sessionKey];

    const m = await bridgeCall({
      kind: 'chat',
      requestId: requestId,
      bot: opts.bot,
      side: opts.side || 'A',
      sessionKey: sessionKey,
      rules: rulesText(requestId),          /* handoff uses it only on the tab's first paste */
      body: bodyText(requestId, contentJson),
      timeoutMs: REPLY_TIMEOUT_MS,
      /* absolute deadline shared with handoff's watcher: it always publishes
         (result or timeout) before this page-side backstop fires, so a slow
         tab boot can't leave an unconsumed late reply desyncing the thread */
      deadlineTs: Date.now() + OVERALL_TIMEOUT_MS - 5000
    }, OVERALL_TIMEOUT_MS);

    if (!m.ok) {
      const msg = String(m.error || 'web tab request failed');
      /* setup-shaped problems are auth (don't burn turns retrying);
         timing-shaped ones are exhausted */
      const kind = /timed out|busy|still running/i.test(msg) ? 'exhausted' : 'auth';
      throw failure(kind, msg);
    }
    if (first) primed[sessionKey] = true;
    return String(m.raw || '');
  }

  function lenientParse(text) {
    if (typeof text !== 'string') return null;
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try { return JSON.parse(text.slice(start, end + 1)); } catch (e) { return null; }
  }

  function requestStance(opts) {
    opts = opts || {};
    return requestRaw(opts, JSON.stringify({ request: 'stance', you_are: opts.side })).then(function (raw) {
      return { raw: raw, parsed: lenientParse(raw) };
    });
  }

  function requestOrders(opts) {
    opts = opts || {};
    return requestRaw(opts, JSON.stringify(opts.payload)).then(function (raw) {
      return { raw: raw };
    });
  }

  NS.WebTab = {
    ping: ping,
    requestStance: requestStance,
    requestOrders: requestOrders,
    BOTS: BOTS,
    REPLY_TIMEOUT_MS: REPLY_TIMEOUT_MS,
    OVERALL_TIMEOUT_MS: OVERALL_TIMEOUT_MS
  };

})(typeof window !== 'undefined' ? window : globalThis);