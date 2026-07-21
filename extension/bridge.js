/* AI Wars Bridge — game-page content script.
   Thin postMessage relay between the AI Wars page and the extension.
   The page never touches chrome.* APIs; it talks to this script with
   window.postMessage and gets results the same way.

   Page -> bridge:  { __aiwars_bridge:'req', id, kind:'ping'|'chat',
                      bot, side, sessionKey, rules, body, timeoutMs }
   Bridge -> page:  { __aiwars_bridge:'res', id, ok, raw?, error? }

   Results from the chatbot tab arrive via chrome.storage.local under
   `aiwars_result_<requestId>` (written by handoff.js), which survives the
   background worker being killed while a slow model is still typing. */

'use strict';

(function () {
  const pending = new Map();   /* requestId -> { pageId } */

  function reply(pageId, payload) {
    window.postMessage(Object.assign({ __aiwars_bridge: 'res', id: pageId }, payload), '*');
  }

  function consumeResult(requestId, result) {
    const p = pending.get(requestId);
    if (!p) return;
    pending.delete(requestId);
    chrome.storage.local.remove('aiwars_result_' + requestId);
    if (result && result.ok) reply(p.pageId, { ok: true, raw: result.raw || '' });
    else reply(p.pageId, { ok: false, error: (result && result.error) || 'chatbot tab reported failure' });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const key of Object.keys(changes)) {
      if (!key.startsWith('aiwars_result_')) continue;
      const v = changes[key].newValue;
      if (v) consumeResult(key.slice('aiwars_result_'.length), v);
    }
  });

  window.addEventListener('message', ev => {
    if (ev.source !== window) return;
    const m = ev.data;
    // PACS0011 — reads the page envelope fields by name (no spread); mirror any field rename from webtab-client.js — AGENTS.md
    if (!m || m.__aiwars_bridge !== 'req') return;

    if (m.kind === 'ping') {
      /* prove the FULL path (worker reachable), not just that this script was
         injected once — an orphaned content script after an extension reload
         would otherwise answer ok and every chat would hang */
      try {
        chrome.runtime.sendMessage({ action: 'aiwars.ping' }).then(ack => {
          if (ack && ack.ok) reply(m.id, { ok: true, raw: 'aiwars-bridge/0.1.0' });
          else reply(m.id, { ok: false, error: 'bridge worker unreachable' });
        }).catch(() => reply(m.id, { ok: false, error: 'extension reloaded — refresh this page' }));
      } catch (e) {
        reply(m.id, { ok: false, error: 'extension reloaded — refresh this page' });
      }
      return;
    }
    if (m.kind !== 'chat') return;

    const requestId = String(m.requestId || '');
    /* chrome.* throws SYNCHRONOUSLY in an invalidated context (extension
       reloaded under a live page) — fail the request in milliseconds instead
       of letting the page wait out its full timeout */
    try {
      pending.set(requestId, { pageId: m.id });

      /* the result may already be in storage if we raced the listener */
      chrome.storage.local.get('aiwars_result_' + requestId).then(o => {
        const v = o['aiwars_result_' + requestId];
        if (v) consumeResult(requestId, v);
      });

      chrome.runtime.sendMessage({
        action: 'aiwars.chat',
        requestId,
        bot: m.bot,
        side: m.side,
        sessionKey: m.sessionKey,
        rules: m.rules,
        body: m.body,
        timeoutMs: m.timeoutMs,
        deadlineTs: m.deadlineTs
      }).then(ack => {
        if (!ack || !ack.ok) {
          pending.delete(requestId);
          reply(m.id, { ok: false, error: (ack && ack.error) || 'bridge dispatch failed' });
        }
        /* on ok: result arrives later via storage listener */
      }).catch(err => {
        pending.delete(requestId);
        reply(m.id, { ok: false, error: err.message || String(err) });
      });
    } catch (e) {
      pending.delete(requestId);
      reply(m.id, { ok: false, error: 'extension context invalidated — reload the page' });
    }
  });
})();
