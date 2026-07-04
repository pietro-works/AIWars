/*
 * AI WARS — ollama-client.js
 * Local Ollama client (browser-only at runtime; loads harmlessly in Node).
 * Mirrors AIWARS.LLM's public shape and failure contract so ui.js routes to
 * either interchangeably:
 *
 *   AIWARS.Ollama.requestStance({model, side})    -> Promise<{raw, parsed}>
 *   AIWARS.Ollama.requestOrders({model, payload})  -> Promise<{raw}>
 *   AIWARS.Ollama.listModels()                     -> Promise<[name,...]>  (chat models only)
 *   AIWARS.Ollama.warm(model)                      -> Promise<void>        (best-effort preload)
 *
 * Talks to Ollama's native /api/chat with format:'json', which forces the
 * model to emit a single valid JSON object — the salvage-friendly shape the
 * engine expects even from a small local model. Reuses the exact ruleset
 * system prompt from AIWARS.LLM so both clients play by identical rules.
 *
 * Failure surface matches LLM: throws Error .name='LLMFailure' with
 *   .kind='auth'      — model missing / bad request / config; never retried
 *   .kind='exhausted' — timeout / connection refused / 5xx after retries
 */
(function (g) {
  'use strict';

  const NS = g.AIWARS = g.AIWARS || {};

  const BASE_URL = 'http://localhost:11434';
  const BACKOFF_MS = [1000, 3000];
  const KEEP_ALIVE = '30m';       // pin the model in VRAM across a whole match
  // First call cold-loads weights (measured ~26s for a 3B). Give the local
  // path more headroom than the network one so a cold start is not a no-op.
  const COLD_TIMEOUT_MS = 120000;

  function failure(kind, message) {
    const err = new Error(message);
    err.name = 'LLMFailure';
    err.kind = kind;
    return err;
  }

  function systemPrompt() {
    if (NS.LLM && typeof NS.LLM._buildSystemPrompt === 'function') return NS.LLM._buildSystemPrompt();
    throw failure('auth', 'llm-client.js must load before ollama-client.js (shared system prompt)');
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function readErr(res) {
    try {
      const body = await res.text();
      try { const j = JSON.parse(body); if (j && j.error) return String(j.error).slice(0, 300); } catch (e) {}
      return body ? String(body).slice(0, 300) : '';
    } catch (e) { return ''; }
  }

  /*
   * One attempt. Returns { ok, raw } | { retryable, reason } | { fatal, kind, reason }.
   */
  async function attemptOnce(model, userText, timeoutMs) {
    const controller = new g.AbortController();
    const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    let res;
    try {
      res = await g.fetch(BASE_URL + '/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: model,
          stream: false,
          format: 'json',
          keep_alive: KEEP_ALIVE,
          options: { temperature: 0.5, num_predict: 1024 },
          messages: [
            { role: 'system', content: systemPrompt() },
            { role: 'user', content: userText }
          ]
        }),
        signal: controller.signal
      });
    } catch (err) {
      if (err && err.name === 'LLMFailure') throw err;
      const timedOut = controller.signal.aborted || (err && err.name === 'AbortError');
      // A refused connection lands here too (server not running) — retryable,
      // then surfaced as 'exhausted' so the turn is a clean no-op.
      return { retryable: true, reason: timedOut ? 'timeout after ' + timeoutMs + 'ms' : 'connection error: ' + String((err && err.message) || err) };
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      let data;
      try { data = await res.json(); } catch (e) { return { retryable: true, reason: 'unreadable response body' }; }
      const raw = data && data.message && typeof data.message.content === 'string' ? data.message.content : '';
      return { ok: true, raw: raw };
    }

    const status = res.status;
    const reason = 'HTTP ' + status + ((await readErr(res)) ? ': ' + (await readErr(res)) : '');
    if (status >= 500) return { retryable: true, reason: reason };
    // 404 (model not pulled) / 400 (bad request) — config problems, no retry.
    return { fatal: true, kind: 'auth', reason: reason };
  }

  async function requestRaw(model, userText) {
    if (!model || typeof model !== 'string') throw failure('auth', 'missing ollama model id');
    if (typeof g.fetch !== 'function') throw failure('auth', 'fetch is not available in this environment');
    const C = NS.CONST || {};
    const retries = (typeof C.LLM_RETRIES === 'number') ? C.LLM_RETRIES : 2;

    const reasons = [];
    for (let i = 0; i <= retries; i++) {
      if (i > 0) await sleep(BACKOFF_MS[Math.min(i - 1, BACKOFF_MS.length - 1)]);
      const r = await attemptOnce(model, userText, COLD_TIMEOUT_MS);
      if (r.ok) return r.raw;
      reasons.push('attempt ' + (i + 1) + ': ' + r.reason);
      if (r.fatal) throw failure(r.kind, r.reason);
    }
    throw failure('exhausted', 'ollama request failed after ' + (retries + 1) + ' attempts (' + reasons.join('; ') + ')');
  }

  function lenientParse(text) {
    if (typeof text !== 'string') return null;
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try { return JSON.parse(text.slice(start, end + 1)); } catch (e) { return null; }
  }

  /* ---- public API ---- */

  function requestStance(opts) {
    opts = opts || {};
    const userText = JSON.stringify({ request: 'stance', you_are: opts.side });
    return requestRaw(opts.model, userText).then(function (raw) {
      return { raw: raw, parsed: lenientParse(raw) };
    });
  }

  function requestOrders(opts) {
    opts = opts || {};
    const userText = JSON.stringify(opts.payload);
    return requestRaw(opts.model, userText).then(function (raw) { return { raw: raw }; });
  }

  // GET /api/tags, drop embedding-only models (they cannot chat). Returns
  // an array of model names, or throws LLMFailure('exhausted') if unreachable.
  async function listModels() {
    if (typeof g.fetch !== 'function') throw failure('auth', 'fetch unavailable');
    let res;
    try {
      const c = new g.AbortController();
      const t = setTimeout(function () { c.abort(); }, 4000);
      res = await g.fetch(BASE_URL + '/api/tags', { signal: c.signal });
      clearTimeout(t);
    } catch (e) {
      throw failure('exhausted', 'ollama not reachable at ' + BASE_URL);
    }
    if (!res.ok) throw failure('exhausted', 'ollama /api/tags returned HTTP ' + res.status);
    const j = await res.json();
    const models = (j && Array.isArray(j.models)) ? j.models : [];
    return models
      .filter(function (m) {
        const fam = (m.details && m.details.family) || '';
        const name = m.name || '';
        return !/embed/i.test(name) && !/bert/i.test(fam);
      })
      .map(function (m) { return m.name; });
  }

  // Best-effort: load + pin the model so the first real turn is not a cold
  // 20s+ wait. Never throws — a failed warm just means the first turn pays it.
  function warm(model) {
    if (!model || typeof g.fetch !== 'function') return Promise.resolve();
    return g.fetch(BASE_URL + '/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: model, prompt: '', stream: false, keep_alive: KEEP_ALIVE })
    }).then(function () {}).catch(function () {});
  }

  NS.Ollama = {
    requestStance: requestStance,
    requestOrders: requestOrders,
    listModels: listModels,
    warm: warm,
    BASE_URL: BASE_URL
  };

})(typeof window !== 'undefined' ? window : globalThis);
