/*
 * AI WARS — llm-client.js
 * Anthropic BYOK client (browser-only at runtime; loads harmlessly in Node).
 * Contract: game/CONTRACTS.md §7  |  Spec: AI_WARS_MASTERPLAN.md §12.
 *
 *   AIWARS.LLM.requestStance({apiKey, model, side})   -> Promise<{raw, parsed}>
 *   AIWARS.LLM.requestOrders({apiKey, model, payload}) -> Promise<{raw}>
 *
 * Failure surface: throws Error with .name='LLMFailure' and
 *   .kind='auth'      — 400/401 (and other non-retryable 4xx) / missing config; never retried
 *   .kind='exhausted' — timeout / network / 429 / 5xx after all retry attempts
 * The API key is never logged and is scrubbed from every error message.
 */
(function (g) {
  'use strict';

  const NS = g.AIWARS = g.AIWARS || {};

  const API_URL = 'https://api.anthropic.com/v1/messages';
  const ANTHROPIC_VERSION = '2023-06-01';
  // Thinking-enabled models (fable-5 always, sonnet-5 adaptive) spend
  // reasoning tokens from this same budget BEFORE the text block; 1024 could
  // exhaust mid-thought and return an empty/truncated turn with no error.
  const MAX_TOKENS = 8192;
  // Waits BEFORE retry attempt 2 and attempt 3 (contract: backoff 1s / 3s).
  const BACKOFF_MS = [1000, 3000];
  // Cap on server-supplied retry-after so a hostile/buggy header can't stall a match.
  const RETRY_AFTER_CAP_MS = 30000;

  /* ------------------------------------------------------------------ *
   * Structured errors                                                   *
   * ------------------------------------------------------------------ */

  function failure(kind, message) {
    const err = new Error(message);
    err.name = 'LLMFailure';
    err.kind = kind; // 'auth' | 'exhausted'
    return err;
  }

  // Belt-and-braces: strip the key from any message that might echo it back.
  function scrub(apiKey, msg) {
    let out = String(msg == null ? '' : msg);
    if (typeof apiKey === 'string' && apiKey.length > 3) {
      out = out.split(apiKey).join('[redacted-key]');
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * System prompt — built ONCE (lazily, at first call) from AIWARS.CONST
   * so it reflects the live 24x14 numbers, then cached for the session. *
   * The exact same bytes go out on every call → prompt-cache friendly.  *
   * ------------------------------------------------------------------ */

  let cachedPrompt = null;

  function buildSystemPrompt() {
    if (cachedPrompt) return cachedPrompt;
    const C = NS.CONST;
    if (!C) {
      throw failure('auth', 'AIWARS.CONST is not loaded — engine.js must be loaded before any LLM call');
    }

    const stanceNames = ['default', 'attack', 'defense'];
    const unitTypes = Object.keys(C.UNITS);

    // Unit stat table, all stances, straight from CONST.
    const statLines = unitTypes.map(function (type) {
      const cells = stanceNames.map(function (s) {
        const st = C.UNITS[type][s];
        return s + ': hp ' + st.hp + ', atk ' + st.atk + ', move ' + st.move + ', range ' + st.range;
      });
      return '- ' + type + ' — ' + cells.join(' | ');
    }).join('\n');

    // Core passive worker spawn turns (turns divisible by CORE_WORKER_EVERY).
    const spawnTurns = [];
    for (let t = C.CORE_WORKER_EVERY; t <= C.TURN_LIMIT; t += C.CORE_WORKER_EVERY) spawnTurns.push(t);

    const buildLines = Object.keys(C.BUILD_TURNS).map(function (u) {
      return u + ' takes ' + C.BUILD_TURNS[u] + ' turns';
    }).join(', ');

    const W = C.GRID.W, H = C.GRID.H;

    cachedPrompt = [
      'You are an AI commander in AI WARS, a deterministic turn-based strategy game between side A and side B. You command one side. Play to win.',
      '',
      'GRID & DISTANCE',
      '- Grid is ' + W + 'x' + H + ' tiles; x in 0..' + (W - 1) + ', y in 0..' + (H - 1) + '.',
      '- Core A at [' + C.CORE_POS.A.join(',') + '], Core B at [' + C.CORE_POS.B.join(',') + '].',
      '- ALL distances and ranges are Chebyshev: dist = max(|dx|,|dy|). Diagonals count as 1.',
      '- Tiles are EXCLUSIVE: one unit or Core per tile, never more. Occupied tiles block movement and spawns.',
      '',
      'MATCH FLOW',
      '- Match lasts at most ' + C.TURN_LIMIT + ' turns. A acts first on odd turns, B on even turns; the second mover sees the first mover\'s resolved result.',
      '- Each side starts with 1 Core and ' + C.START_WORKERS + ' workers. No starting combat units.',
      '- Win instantly by destroying the enemy Core. At turn ' + C.TURN_LIMIT + ': higher Core HP% wins; tie broken by total remaining unit HP; otherwise draw.',
      '- STAGNATION: after turn ' + C.STAGNATION.afterTurn + ', any full turn with ZERO combat costs BOTH Cores ' + C.STAGNATION.dmg + ' HP. Sitting back late-game is suicide; force engagements.',
      '',
      'UNITS (stats by stance: hp / atk / move / range)',
      statLines,
      '- At tick 0 each side blindly declares one stance per unit TYPE (default/attack/defense). Stances are locked for the whole match; units built later inherit the declared stance for their type.',
      '',
      'CORE',
      '- HP ' + C.CORE.hp + ', immobile, no stance. Automatically deals ' + C.CORE.attack + ' damage to EVERY enemy unit within range ' + C.CORE.range + ' each combat phase (not split). Cores never damage the enemy Core.',
      '- The Core spawns 1 free worker adjacent to itself every ' + C.CORE_WORKER_EVERY + ' turns (turns ' + spawnTurns.join(', ') + '). This is the ONLY source of new workers.',
      '',
      'BUILDING',
      '- Only workers build. ' + buildLines + '. Workers cannot build workers.',
      '- A building worker is locked in place and fully vulnerable until done; it ignores movement orders; one build at a time; if it dies mid-build the build is lost.',
      '- Finished units spawn on the nearest free tile around the builder (rings up to radius 3). If every tile is packed the build is held a turn; a buried Core skips its free worker that cycle.',
      '',
      'MOVEMENT',
      '- An order is a destination tile, never a target unit. If the tile is within the unit\'s move range it moves exactly there; if farther, it moves as far as it can along that line and stops (clamped, not failed).',
      '- Occupied tiles refuse entry: a blocked diagonal step sidesteps along one axis (x first, then y) when it can; a fully blocked unit stops where it is. Blocked and out-of-range both count as clamped, never failed.',
      '- Units without a (valid) order hold position. Mid-build workers never move.',
      '',
      'COMBAT (automatic, once per half-turn, after the active side\'s movement/builds)',
      '- ALL units of BOTH sides plus BOTH Cores fire simultaneously from current post-movement positions. All damage is computed from pre-phase HP, then deaths are applied — mutual kills are possible.',
      '- Default = spread fire: each unit deals its FULL atk to EVERY enemy unit in range (not divided).',
      '- fire_policy (optional, per unit class, declared each turn; your last declaration persists while the opponent acts):',
      '  * {"mode":"focus","target":"<enemy id>"}: each unit of that class deals full atk to that unit ONLY if it is in that unit\'s range; otherwise that unit attacks NOTHING this phase (no fallback). Confirm range before focusing.',
      '  * {"mode":"focus"} with no target: the engine auto-picks the lowest-HP enemy in each unit\'s range (ties by unit id ascending).',
      '  * Triangles multi-lock under focus: up to ' + C.TRIANGLE_FOCUS_TARGETS + ' targets at once — your named target first, remaining slots auto-fill lowest-HP-first. Every other class focuses exactly 1.',
      '  * {"mode":"spread"} or an unmentioned class: default spread fire.',
      '- Workers have atk 0 and never attack. The Core always hits everything in its range and has no fire policy.',
      '',
      'FAULT TOLERANCE',
      '- The engine salvages every valid piece of your JSON and drops the rest: an invalid/missing order means that unit simply holds; an invalid build simply does not start; an unreachable focus target means that unit attacks nothing.',
      '- If your entire response cannot be parsed as JSON, your whole turn is a no-op. There is no other penalty. Precision is rewarded.',
      '',
      'OUTPUT PROTOCOL — every user message is exactly one of these two requests:',
      '1) STANCE REQUEST — the user message contains "request":"stance". Respond with exactly this shape:',
      '{"worker":"default","vehicle":"attack","triangle":"defense"}',
      'where each value is one of "default", "attack", "defense" (example values shown).',
      '2) TURN ORDERS — the user message is the current turn state JSON (fields: turn, you_are, your_core_hp, enemy_core_hp, your_units, visible_enemy_units, grid, your_stance_doctrine). visible_enemy_units is all enemy units (full visibility). Respond with exactly this shape:',
      '{"orders":[{"unit":"A_v1","target":[12,7]}],"builds":[{"worker":"A_w1","produces":"vehicle"}],"fire_policy":{"vehicle":{"mode":"focus","target":"B_t2"},"triangle":{"mode":"spread"}},"note":"optional short comment"}',
      '- orders: destination tiles for your own units; omit a unit to hold. target is [x,y] integers on the grid.',
      '- builds: only your own idle, non-building workers; produces is "vehicle" or "triangle".',
      '- fire_policy: optional, keys are unit classes ("vehicle","triangle").',
      '- note: optional free text, mechanically inert (shown to spectators).',
      '- All top-level fields are optional; include only what you need.',
      'Respond with a single JSON object only. No prose. No markdown fences.'
    ].join('\n');

    return cachedPrompt;
  }

  /* ------------------------------------------------------------------ *
   * HTTP plumbing                                                       *
   * ------------------------------------------------------------------ */

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // retry-after may be seconds or an HTTP date; returns ms or null.
  function parseRetryAfter(value) {
    if (!value) return null;
    const v = String(value).trim();
    if (/^\d+$/.test(v)) return Math.min(parseInt(v, 10) * 1000, RETRY_AFTER_CAP_MS);
    const when = Date.parse(v);
    if (!isNaN(when)) return Math.min(Math.max(when - Date.now(), 0), RETRY_AFTER_CAP_MS);
    return null;
  }

  // Bounded read of an error body; prefers the API's error.message field.
  async function readApiError(res) {
    try {
      const body = await res.text();
      try {
        const j = JSON.parse(body);
        if (j && j.error && j.error.message) return String(j.error.message).slice(0, 300);
      } catch (e) { /* body not JSON — fall through */ }
      return body ? String(body).slice(0, 300) : '';
    } catch (e) {
      return '';
    }
  }

  // raw = text of the first text content block (thinking-capable models may
  // emit a leading non-text block; skip those, fall back to first block).
  function extractText(data) {
    const blocks = data && Array.isArray(data.content) ? data.content : [];
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i] && blocks[i].type === 'text' && typeof blocks[i].text === 'string') {
        return blocks[i].text;
      }
    }
    return (blocks[0] && typeof blocks[0].text === 'string') ? blocks[0].text : '';
  }

  /*
   * One attempt. Returns one of:
   *   { ok:true, raw }
   *   { retryable:true, reason, retryAfterMs? }   — timeout / network / 429 / 5xx
   *   { fatal:true, kind:'auth', reason }          — 400/401 and other 4xx config errors
   */
  async function attemptOnce(apiKey, model, userText, timeoutMs) {
    const controller = new g.AbortController();
    const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    let res;
    try {
      res = await g.fetch(API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: model,
          max_tokens: MAX_TOKENS,
          system: [{ type: 'text', text: buildSystemPrompt(), cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: userText }]
        }),
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timer);
      if (err && err.name === 'LLMFailure') throw err; // missing CONST from buildSystemPrompt
      const timedOut = controller.signal.aborted || (err && err.name === 'AbortError');
      return {
        retryable: true,
        reason: timedOut
          ? 'timeout after ' + timeoutMs + 'ms'
          : 'network error: ' + String((err && err.message) || err)
      };
    }

    // Timer stays armed through the body read: a server that returns headers
    // then stalls the body would otherwise hang the attempt forever.
    if (res.ok) {
      let data;
      try {
        data = await res.json();
      } catch (e) {
        return { retryable: true, reason: controller.signal.aborted
          ? 'timeout reading response body' : 'unreadable response body' };
      } finally {
        clearTimeout(timer);
      }
      return { ok: true, raw: extractText(data) };
    }

    const status = res.status;
    let apiMsg;
    try { apiMsg = await readApiError(res); } finally { clearTimeout(timer); }
    const reason = 'HTTP ' + status + (apiMsg ? ': ' + apiMsg : '');

    if (status === 429 || status >= 500) {
      const ra = (res.headers && typeof res.headers.get === 'function')
        ? parseRetryAfter(res.headers.get('retry-after'))
        : null;
      return { retryable: true, reason: reason, retryAfterMs: ra };
    }

    // 401 = bad key, 400 = bad request/config; other 4xx (403/404/413) are
    // equally non-retryable configuration problems. Surface all as kind 'auth'.
    return { fatal: true, kind: 'auth', reason: reason };
  }

  // Full request with retry policy: up to CONST.LLM_RETRIES (default 2) extra
  // attempts, backoff 1s then 3s, retry-after honored when the server sends it.
  async function requestRaw(apiKey, model, userText) {
    if (!apiKey || typeof apiKey !== 'string') throw failure('auth', 'missing API key');
    if (!model || typeof model !== 'string') throw failure('auth', 'missing model id');
    if (typeof g.fetch !== 'function') throw failure('auth', 'fetch is not available in this environment');

    const C = NS.CONST || {};
    const timeoutMs = C.LLM_TIMEOUT_MS || 60000;
    const retries = (typeof C.LLM_RETRIES === 'number') ? C.LLM_RETRIES : 2;

    const reasons = [];
    let nextWaitMs = null;

    for (let i = 0; i <= retries; i++) {
      if (i > 0) {
        const wait = (nextWaitMs != null) ? nextWaitMs : BACKOFF_MS[Math.min(i - 1, BACKOFF_MS.length - 1)];
        await sleep(wait);
      }
      const r = await attemptOnce(apiKey, model, userText, timeoutMs);
      if (r.ok) return r.raw;
      reasons.push('attempt ' + (i + 1) + ': ' + r.reason);
      if (r.fatal) throw failure(r.kind, scrub(apiKey, r.reason));
      nextWaitMs = (r.retryAfterMs != null) ? r.retryAfterMs : null;
    }

    throw failure('exhausted', scrub(apiKey,
      'LLM request failed after ' + (retries + 1) + ' attempts (' + reasons.join('; ') + ')'));
  }

  /* ------------------------------------------------------------------ *
   * Lenient JSON extraction (best-effort only — Validate owns real       *
   * salvage; this just powers requestStance's `parsed` convenience).     *
   * ------------------------------------------------------------------ */

  function lenientParse(text) {
    if (typeof text !== 'string') return null;
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (e) {
      return null;
    }
  }

  /* ------------------------------------------------------------------ *
   * Public API — CONTRACTS.md §7                                        *
   * ------------------------------------------------------------------ */

  // Tick-0 blind stance declaration (masterplan §12.6). Caller still runs
  // Validate.sanitizeStance on `parsed`/`raw`; parsed is null if unparseable.
  function requestStance(opts) {
    opts = opts || {};
    const userText = JSON.stringify({ request: 'stance', you_are: opts.side });
    return requestRaw(opts.apiKey, opts.model, userText).then(function (raw) {
      return { raw: raw, parsed: lenientParse(raw) };
    });
  }

  // Per-turn orders (masterplan §12.5). payload is Engine.turnPayload output
  // (§12.4). Returns raw text only — caller runs Validate.sanitizeOrders.
  function requestOrders(opts) {
    opts = opts || {};
    const userText = JSON.stringify(opts.payload);
    return requestRaw(opts.apiKey, opts.model, userText).then(function (raw) {
      return { raw: raw };
    });
  }

  NS.LLM = {
    requestStance: requestStance,
    requestOrders: requestOrders,
    // exposed for headless tests only; not part of the gameplay contract
    _buildSystemPrompt: buildSystemPrompt
  };

})(typeof window !== 'undefined' ? window : globalThis);
