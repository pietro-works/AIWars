/*
 * AI WARS — openai-client.js
 * OpenAI BYOK client (browser-only at runtime; loads harmlessly in Node).
 * Mirrors AIWARS.LLM's public shape and failure contract:
 *
 *   AIWARS.OpenAI.requestStance({apiKey, model, side})    -> Promise<{raw, parsed}>
 *   AIWARS.OpenAI.requestOrders({apiKey, model, payload})  -> Promise<{raw}>
 *
 * POSTs https://api.openai.com/v1/chat/completions with the shared ruleset
 * system prompt (from AIWARS.LLM) and response_format json_object, so the
 * reply is a single valid JSON object. No max-token / temperature params —
 * they vary by model family (o-series rejects both) and the answers are
 * small; omitting them keeps every model id usable.
 *
 * Failure surface matches LLM: throws Error .name='LLMFailure' with
 *   .kind='auth'      — 400/401/403/404 / missing config; never retried
 *   .kind='exhausted' — timeout / network / 429 / 5xx after retries
 * The key is scrubbed from every error message.
 */
(function (g) {
  'use strict';

  const NS = g.AIWARS = g.AIWARS || {};

  const API_URL = 'https://api.openai.com/v1/chat/completions';
  const BACKOFF_MS = [1000, 3000];

  function failure(kind, message) {
    const err = new Error(message);
    err.name = 'LLMFailure';
    err.kind = kind;
    return err;
  }

  function scrub(apiKey, msg) {
    let out = String(msg == null ? '' : msg);
    if (typeof apiKey === 'string' && apiKey.length > 3) out = out.split(apiKey).join('[redacted-key]');
    return out;
  }

  function systemPrompt() {
    // PACS0010 — defer to NS.LLM._buildSystemPrompt; never inline a ruleset — AGENTS.md (known sites, not exhaustive)
    if (NS.LLM && typeof NS.LLM._buildSystemPrompt === 'function') return NS.LLM._buildSystemPrompt();
    throw failure('auth', 'llm-client.js must load before openai-client.js (shared system prompt)');
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function readApiError(res) {
    try {
      const body = await res.text();
      try {
        const j = JSON.parse(body);
        if (j && j.error && j.error.message) return String(j.error.message).slice(0, 300);
      } catch (e) { /* not json */ }
      return body ? String(body).slice(0, 300) : '';
    } catch (e) { return ''; }
  }

  async function attemptOnce(apiKey, model, userText, timeoutMs) {
    const controller = new g.AbortController();
    const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    let res;
    try {
      res = await g.fetch(API_URL, {
        method: 'POST',
        headers: {
          'authorization': 'Bearer ' + apiKey,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt() },
            { role: 'user', content: userText }
          ]
        }),
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timer);
      if (err && err.name === 'LLMFailure') throw err;
      const timedOut = controller.signal.aborted || (err && err.name === 'AbortError');
      return { retryable: true, reason: timedOut ? 'timeout after ' + timeoutMs + 'ms' : 'network error: ' + String((err && err.message) || err) };
    }

    // Timer stays armed through the body read: a stalled body must still abort.
    if (res.ok) {
      let data;
      try { data = await res.json(); }
      catch (e) { return { retryable: true, reason: controller.signal.aborted ? 'timeout reading response body' : 'unreadable response body' }; }
      finally { clearTimeout(timer); }
      const raw = data && data.choices && data.choices[0] && data.choices[0].message
        ? String(data.choices[0].message.content || '') : '';
      return { ok: true, raw: raw };
    }

    const status = res.status;
    let apiMsg;
    try { apiMsg = await readApiError(res); } finally { clearTimeout(timer); }
    const reason = 'HTTP ' + status + (apiMsg ? ': ' + apiMsg : '');
    if (status === 429 || status >= 500) return { retryable: true, reason: reason };
    return { fatal: true, kind: 'auth', reason: reason };
  }

  async function requestRaw(apiKey, model, userText) {
    if (!apiKey || typeof apiKey !== 'string') throw failure('auth', 'missing OpenAI API key');
    if (!model || typeof model !== 'string') throw failure('auth', 'missing model id');
    if (typeof g.fetch !== 'function') throw failure('auth', 'fetch is not available in this environment');

    const C = NS.CONST || {};
    const timeoutMs = C.LLM_TIMEOUT_MS || 60000;
    const retries = (typeof C.LLM_RETRIES === 'number') ? C.LLM_RETRIES : 2;

    const reasons = [];
    for (let i = 0; i <= retries; i++) {
      if (i > 0) await sleep(BACKOFF_MS[Math.min(i - 1, BACKOFF_MS.length - 1)]);
      const r = await attemptOnce(apiKey, model, userText, timeoutMs);
      if (r.ok) return r.raw;
      reasons.push('attempt ' + (i + 1) + ': ' + r.reason);
      if (r.fatal) throw failure(r.kind, scrub(apiKey, r.reason));
    }
    throw failure('exhausted', scrub(apiKey, 'OpenAI request failed after ' + (retries + 1) + ' attempts (' + reasons.join('; ') + ')'));
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
    const userText = JSON.stringify({ request: 'stance', you_are: opts.side });
    return requestRaw(opts.apiKey, opts.model, userText).then(function (raw) {
      return { raw: raw, parsed: lenientParse(raw) };
    });
  }

  function requestOrders(opts) {
    opts = opts || {};
    const userText = JSON.stringify(opts.payload);
    return requestRaw(opts.apiKey, opts.model, userText).then(function (raw) {
      return { raw: raw };
    });
  }

  NS.OpenAI = {
    requestStance: requestStance,
    requestOrders: requestOrders
  };

})(typeof window !== 'undefined' ? window : globalThis);
