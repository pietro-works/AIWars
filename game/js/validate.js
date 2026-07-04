/*
 * AI WARS — validate.js
 * AIWARS.Validate: order/stance sanitization per CONTRACTS §4 and masterplan §11.
 * Governing rule: read whatever valid data exists, apply up to legal limits,
 * drop only what's broken. Wholly unparseable input -> 'malformed' no-op turn.
 * Pure, deterministic, no DOM/net. Reads AIWARS.CONST (engine.js loads first).
 */
(function(g){
  const NS = g.AIWARS = g.AIWARS || {};

  const STANCES = ['default', 'attack', 'defense'];
  const CLASSES = ['worker', 'vehicle', 'triangle'];
  const BUILDABLE = ['vehicle', 'triangle'];   // workers not buildable (§7)
  const NOTE_MAX = 500;                        // sanity cap, notes are inert flavor

  function grid(){
    // CONST lives in engine.js; fall back to contract numbers if loaded standalone.
    return (NS.CONST && NS.CONST.GRID) || { W: 24, H: 14 };
  }

  // Extract the first balanced {...} JSON object from LLM text. Strips markdown
  // fences, then scans from the first '{' with a string-aware depth counter so
  // braces inside quoted values don't break the match.
  function extractJson(text){
    if (typeof text !== 'string') return null;
    const cleaned = text.replace(/```[a-zA-Z]*/g, '');
    const start = cleaned.indexOf('{');
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < cleaned.length; i++){
      const c = cleaned[i];
      if (esc){ esc = false; continue; }
      if (inStr){
        if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}'){
        depth--;
        if (depth === 0){
          try {
            const o = JSON.parse(cleaned.slice(start, i + 1));
            return (o && typeof o === 'object' && !Array.isArray(o)) ? o : null;
          } catch (e){ return null; }
        }
      }
    }
    return null;
  }

  function asObject(raw){
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    return extractJson(raw);
  }

  // Coerce to a clamped integer grid coordinate, or null when not numeric.
  function clampCoord(v, max){
    const n = Number(v);
    if (!isFinite(n)) return null;
    return Math.min(max, Math.max(0, Math.round(n)));
  }

  function findUnit(state, id){
    if (typeof id !== 'string') return null;
    for (let i = 0; i < state.units.length; i++) if (state.units[i].id === id) return state.units[i];
    return null; // units in state.units are alive by construction
  }

  // sanitizeOrders(raw, state, side) — per-field salvage. raw is a string (LLM
  // text) or an object (bot/human). Returns a contract-shaped object always.
  function sanitizeOrders(raw, state, side){
    const obj = asObject(raw);
    if (!obj){
      return { orders: [], builds: [], fire_policy: {}, note: null, parseStatus: 'malformed' };
    }
    const G = grid();

    // orders: unit must exist, belong to side, be alive; target clamped to grid
    // ints; duplicate orders for the same unit -> first wins.
    const orders = [];
    const ordered = {};
    const rawOrders = Array.isArray(obj.orders) ? obj.orders : [];
    for (const o of rawOrders){
      if (!o || typeof o !== 'object') continue;
      const u = findUnit(state, o.unit);
      if (!u || u.side !== side) continue;
      if (ordered[u.id]) continue;
      const t = o.target;
      if (!Array.isArray(t) || t.length < 2) continue;
      const x = clampCoord(t[0], G.W - 1);
      const y = clampCoord(t[1], G.H - 1);
      if (x === null || y === null) continue;
      ordered[u.id] = true;
      orders.push({ unit: u.id, target: [x, y] });
    }

    // builds: own idle non-building workers only; duplicate -> first wins.
    const builds = [];
    const building = {};
    const rawBuilds = Array.isArray(obj.builds) ? obj.builds : [];
    for (const b of rawBuilds){
      if (!b || typeof b !== 'object') continue;
      const u = findUnit(state, b.worker);
      if (!u || u.side !== side || u.type !== 'worker' || u.building) continue;
      if (building[u.id]) continue;
      if (BUILDABLE.indexOf(b.produces) < 0) continue; // drops 'worker' and garbage
      building[u.id] = true;
      builds.push({ worker: u.id, produces: b.produces });
    }

    // fire_policy: keep only known classes with a valid mode; focus may carry an
    // optional string target (range/existence is the engine's concern, §3).
    const fire_policy = {};
    const rawFp = obj.fire_policy;
    if (rawFp && typeof rawFp === 'object' && !Array.isArray(rawFp)){
      for (const cls of CLASSES){
        const p = rawFp[cls];
        if (!p || typeof p !== 'object') continue;
        if (p.mode === 'spread'){
          fire_policy[cls] = { mode: 'spread' };
        } else if (p.mode === 'focus'){
          fire_policy[cls] = (typeof p.target === 'string' && p.target.length)
            ? { mode: 'focus', target: p.target }
            : { mode: 'focus' };
        }
      }
    }

    const note = (typeof obj.note === 'string' && obj.note.length)
      ? obj.note.slice(0, NOTE_MAX)
      : null;

    return { orders, builds, fire_policy, note, parseStatus: 'ok' };
  }

  // sanitizeStance(raw) -> {worker,vehicle,triangle}; invalid fields -> 'default'.
  function sanitizeStance(raw){
    const obj = asObject(raw) || {};
    const out = {};
    for (const t of CLASSES) out[t] = STANCES.indexOf(obj[t]) >= 0 ? obj[t] : 'default';
    return out;
  }

  NS.Validate = { sanitizeOrders, sanitizeStance };

})(typeof window !== 'undefined' ? window : globalThis);
