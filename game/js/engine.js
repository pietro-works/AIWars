/*
 * AI WARS — engine.js
 * AIWARS.CONST (single source of constants) + AIWARS.Engine (pure simulation core).
 * Per game/CONTRACTS.md §1-§3. Pure: no DOM, no canvas, no network, no Math.random.
 * Every public function deep-clones input state; determinism is a hard requirement.
 */
(function(g){
  const NS = g.AIWARS = g.AIWARS || {};

  // ── §1 Constants — single source of truth ────────────────────────────────
  const CONST = NS.CONST = {
    GRID: { W: 24, H: 14 },
    CORE_POS: { A: [1, 1], B: [22, 12] },
    TURN_LIMIT: 30,
    CORE: { hp: 200, attack: 5, range: 2 },
    CORE_WORKER_EVERY: 4,               // spawn turns 4,8,12,16,20,24,28
    // 2026-07-04 balance pass: movement +50%, unit attacks +25% (round half up:
    // 1.5->2, 3.75->4, 2.5->3). Core attack intentionally untouched.
    UNITS: {
      worker:   { default:{hp:20,atk:0,move:2,range:0}, attack:{hp:10,atk:0,move:2,range:0}, defense:{hp:30,atk:0,move:2,range:0} },
      vehicle:  { default:{hp:60,atk:10,move:3,range:1}, attack:{hp:30,atk:15,move:3,range:1}, defense:{hp:90,atk:5,move:3,range:1} },
      triangle: { default:{hp:16,atk:4,move:6,range:2}, attack:{hp:8,atk:5,move:6,range:2}, defense:{hp:24,atk:3,move:6,range:2} },
    },
    TRIANGLE_FOCUS_TARGETS: 3,          // triangles focus-fire up to 3 enemies at once
    STAGNATION: { afterTurn: 20, dmg: 20 },  // full turn >20 with zero combat -> both cores bleed
    BUILD_TURNS: { vehicle: 5, triangle: 3 },  // workers not buildable
    START_WORKERS: 2,
    LLM_TIMEOUT_MS: 60000,
    LLM_RETRIES: 2,
    MODELS: ["claude-opus-4-8","claude-sonnet-5","claude-haiku-4-5-20251001","claude-fable-5"],
  };

  // Cores occupy a 2x2 block anchored at CORE_POS and extending toward the
  // nearest corner (A -> top-left, B -> bottom-right). These four tiles are
  // permanently blocked: nothing spawns on them and nothing can land on them.
  // CORE_POS stays the anchor tile (combat/FX still aim at it).
  function coreBlock(p){
    const dx = p[0] < CONST.GRID.W / 2 ? -1 : 1;
    const dy = p[1] < CONST.GRID.H / 2 ? -1 : 1;
    return [[p[0], p[1]], [p[0]+dx, p[1]], [p[0], p[1]+dy], [p[0]+dx, p[1]+dy]];
  }
  CONST.CORE_TILES = { A: coreBlock(CONST.CORE_POS.A), B: coreBlock(CONST.CORE_POS.B) };

  const STANCES = ['default', 'attack', 'defense'];
  const TYPES = ['worker', 'vehicle', 'triangle'];
  const TYPE_LETTER = { worker: 'w', vehicle: 'v', triangle: 't' };

  // Fixed neighbor iteration order for ALL spawn-adjacency decisions (deterministic).
  // Clockwise from north: N, NE, E, SE, S, SW, W, NW.
  const NEIGHBOR_OFFSETS = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];

  // Ring of Chebyshev radius r, walked clockwise starting at due north (0,-r).
  // 8r tiles; used for deterministic spawn placement (r=1) and overflow (r=2,3).
  function ringOffsets(r){
    const out = [];
    let x = 0, y = -r;
    out.push([x, y]);
    while (x <  r){ x++; out.push([x, y]); }   // north edge -> NE corner
    while (y <  r){ y++; out.push([x, y]); }   // east edge  -> SE corner
    while (x > -r){ x--; out.push([x, y]); }   // south edge -> SW corner
    while (y > -r){ y--; out.push([x, y]); }   // west edge  -> NW corner
    while (x < -1){ x++; out.push([x, y]); }   // back along the north edge to (-1,-r)
    return out;
  }

  // ── helpers ──────────────────────────────────────────────────────────────
  function clone(o){ return JSON.parse(JSON.stringify(o)); }
  function cheb(a, b){ return Math.max(Math.abs(a[0]-b[0]), Math.abs(a[1]-b[1])); }
  function other(side){ return side === 'A' ? 'B' : 'A'; }
  function inGrid(x, y){ return x >= 0 && y >= 0 && x < CONST.GRID.W && y < CONST.GRID.H; }
  function firstMoverOf(turn){ return turn % 2 === 1 ? 'A' : 'B'; } // A odd, B even
  function findUnit(state, id){
    for (let i = 0; i < state.units.length; i++) if (state.units[i].id === id) return state.units[i];
    return null;
  }

  // Local stance validation (engine must not depend on validate.js load order).
  function cleanStance(raw){
    const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    const out = {};
    for (const t of TYPES) out[t] = STANCES.indexOf(src[t]) >= 0 ? src[t] : 'default';
    return out;
  }

  function mintId(state, side, type){
    state.counters[side][type] += 1;
    return side + '_' + TYPE_LETTER[type] + state.counters[side][type];
  }

  // A core tile is any of the 4 tiles the side's 2x2 core covers.
  function coreOccupies(side, x, y){
    const tiles = CONST.CORE_TILES[side];
    for (let i = 0; i < tiles.length; i++) if (tiles[i][0] === x && tiles[i][1] === y) return true;
    return false;
  }
  // Chebyshev distance from a position to the NEAREST tile of a side's core block.
  function minChebToCore(pos, side){
    const tiles = CONST.CORE_TILES[side];
    let m = Infinity;
    for (let i = 0; i < tiles.length; i++){ const d = cheb(pos, tiles[i]); if (d < m) m = d; }
    return m;
  }

  // Tile exclusivity: cores (all 4 tiles of each 2x2 block) and living units
  // block a tile. ignoreId exempts the moving/building unit itself.
  function occupiedAt(state, x, y, ignoreId){
    if (coreOccupies('A', x, y) || coreOccupies('B', x, y)) return true;
    for (const u of state.units){
      if (ignoreId && u.id === ignoreId) continue;
      if (u.pos[0] === x && u.pos[1] === y) return true;
    }
    return false;
  }

  // Spawn placement (deterministic): scan rings r=1..3 clockwise-from-north from
  // `base`, pick the first in-grid FREE tile (no core, no unit — tiles are
  // exclusive now). Returns null when the whole r<=3 neighborhood is packed;
  // callers decide (delay the build / skip the passive worker).
  function spawnPos(state, base){
    for (let r = 1; r <= 3; r++){
      for (const off of ringOffsets(r)){
        const x = base[0] + off[0], y = base[1] + off[1];
        if (!inGrid(x, y)) continue;
        if (occupiedAt(state, x, y)) continue;
        return [x, y];
      }
    }
    return null;
  }

  function totalUnitHp(state, side){
    let sum = 0;
    for (const u of state.units) if (u.side === side) sum += u.hp;
    return sum;
  }

  // ── §3 Engine API ────────────────────────────────────────────────────────

  // createMatch({stances:{A,B}}) -> state. Invalid/missing stance fields default to 'default'.
  function createMatch(opts){
    const stancesIn = (opts && opts.stances) || {};
    const state = {
      turn: 1,
      half: 'A',
      cores: {
        A: { pos: clone(CONST.CORE_POS.A), hp: CONST.CORE.hp },
        B: { pos: clone(CONST.CORE_POS.B), hp: CONST.CORE.hp },
      },
      stances: { A: cleanStance(stancesIn.A), B: cleanStance(stancesIn.B) },
      firePolicies: { A: {}, B: {} },     // {} = all spread
      units: [],
      counters: { A: {worker:0,vehicle:0,triangle:0}, B: {worker:0,vehicle:0,triangle:0} },
      coreSpawnedTurn: { A: 0, B: 0 },    // last turn each side received its core passive worker
      lastAggroTurn: 0,                   // last turn with any combat/core damage (stagnation rule)
      result: null,
    };
    for (const side of ['A','B']){
      for (let i = 0; i < CONST.START_WORKERS; i++){
        const id = mintId(state, side, 'worker');
        const pos = spawnPos(state, state.cores[side].pos);   // always free at match start
        const unit = { id, side, type: 'worker', pos: pos || clone(state.cores[side].pos), hp: 0, building: null };
        unit.hp = statFor(state, unit).hp;
        state.units.push(unit);
      }
    }
    return state;
  }

  // statFor(state, unit) -> {hp,atk,move,range} derived from the side's locked stance.
  // Never stored per-unit; `hp` here is the stance MAX hp, current hp lives on the unit.
  function statFor(state, unit){
    const sideStances = state.stances[unit.side] || {};
    const stance = STANCES.indexOf(sideStances[unit.type]) >= 0 ? sideStances[unit.type] : 'default';
    const b = CONST.UNITS[unit.type][stance];
    return { hp: b.hp, atk: b.atk, move: b.move, range: b.range };
  }

  // turnPayload(state, side) -> per-turn LLM/bot input JSON (masterplan §12.4, full visibility).
  function turnPayload(state, side){
    const enemy = other(side);
    const yourUnits = [];
    const enemyUnits = [];
    for (const u of state.units){
      if (u.side === side){
        const st = statFor(state, u);
        const row = { id: u.id, type: u.type, pos: [u.pos[0], u.pos[1]], hp: u.hp, move_range: st.move, attack_range: st.range };
        if (u.building) row.building = { produces: u.building.produces, completes_turn: u.building.completesTurn };
        yourUnits.push(row);
      } else {
        enemyUnits.push({ id: u.id, type: u.type, pos: [u.pos[0], u.pos[1]], hp: u.hp });
      }
    }
    return {
      turn: state.turn,
      you_are: side,
      your_core_hp: state.cores[side].hp,
      enemy_core_hp: state.cores[enemy].hp,
      your_units: yourUnits,
      visible_enemy_units: enemyUnits,
      grid: { width: CONST.GRID.W, height: CONST.GRID.H },
      your_stance_doctrine: clone(state.stances[side]),
    };
  }

  // ── halfTurn internals ───────────────────────────────────────────────────

  // Landing resolution: tiles are exclusive at REST only, never in transit.
  // If `target` is free (or is the mover's own tile) take it; otherwise scan
  // rings r=1.. outward around the target and pick the free in-grid tile
  // closest (Chebyshev) to `from` — "nearest free tile next to the target from
  // the mover's point of view". Ties break by ring walk order (clockwise from
  // north), so the result is fully deterministic.
  function freeLanding(s, from, target, ignoreId){
    if (!occupiedAt(s, target[0], target[1], ignoreId)) return [target[0], target[1]];
    const maxR = Math.max(CONST.GRID.W, CONST.GRID.H);
    for (let r = 1; r <= maxR; r++){
      let best = null, bestD = Infinity;
      for (const off of ringOffsets(r)){
        const x = target[0] + off[0], y = target[1] + off[1];
        if (!inGrid(x, y) || occupiedAt(s, x, y, ignoreId)) continue;
        const d = cheb(from, [x, y]);
        if (d < bestD){ best = [x, y]; bestD = d; }
      }
      if (best) return best;
    }
    return [from[0], from[1]];             // 336-tile board fully packed: stay put
  }

  // 1. Movement. Chebyshev clamp along the ordered line, implemented as greedy
  // stepping: each step moves dx=sign(tx-x), dy=sign(ty-y), for
  // min(move_range, chebyshev(from, dest)) steps. Units pass THROUGH occupied
  // tiles freely; only the landing tile is exclusive. An occupied destination
  // redirects via freeLanding BEFORE stepping (so travel aims at the real
  // landing spot); a move clamped short onto an occupied tile re-resolves the
  // landing the same way. Orders are processed in array order against LIVE
  // positions, so earlier movers claim landing tiles first.
  // Mid-build workers ignore movement orders entirely.
  function applyMovement(s, side, orders, log){
    for (const o of orders){
      const u = findUnit(s, o.unit);
      if (!u || u.side !== side) continue;   // defensive; sanitizeOrders already filters
      if (u.building) continue;              // locked in place while building
      // defensive re-clamp to grid (sanitizeOrders already guarantees this)
      const target = [
        Math.min(CONST.GRID.W - 1, Math.max(0, o.target[0])),
        Math.min(CONST.GRID.H - 1, Math.max(0, o.target[1])),
      ];
      const from = [u.pos[0], u.pos[1]];
      const move = statFor(s, u).move;
      const dest = freeLanding(s, from, target, u.id);
      const steps = Math.min(move, cheb(from, dest));
      let x = from[0], y = from[1];
      for (let i = 0; i < steps; i++){
        const sx = Math.sign(dest[0] - x), sy = Math.sign(dest[1] - y);
        if (!sx && !sy) break;
        x += sx; y += sy;
      }
      // clamped short of dest: the interim tile may itself be occupied
      let land = [x, y];
      if (occupiedAt(s, x, y, u.id)) land = freeLanding(s, from, [x, y], u.id);
      u.pos = [land[0], land[1]];
      log.ordersApplied.push({ unit: u.id, from, to: [land[0], land[1]],
        clamped: land[0] !== target[0] || land[1] !== target[1] });
    }
  }

  // 2. Build starts. Only idle (non-building) own workers; fire-and-forget.
  function applyBuildStarts(s, side, builds, log){
    for (const b of builds){
      const u = findUnit(s, b.worker);
      if (!u || u.side !== side || u.type !== 'worker' || u.building) continue; // defensive
      if (!CONST.BUILD_TURNS[b.produces]) continue;
      u.building = { produces: b.produces, completesTurn: s.turn + CONST.BUILD_TURNS[b.produces] };
      log.buildsStarted.push({ worker: u.id, produces: b.produces, completesTurn: u.building.completesTurn });
    }
  }

  // 3. Build completions for THIS side with completesTurn <= turn.
  // (A build started this half-turn completes at turn+N, so never same-turn.)
  function applyBuildCompletions(s, side, log){
    const existing = s.units.slice(); // iterate snapshot; we push new units while looping
    for (const u of existing){
      if (u.side !== side || !u.building || u.building.completesTurn > s.turn) continue;
      const type = u.building.produces;
      const pos = spawnPos(s, u.pos);
      if (!pos){
        // whole r<=3 neighborhood packed: hold the finished build one more turn
        u.building.completesTurn = s.turn + 1;
        continue;
      }
      const id = mintId(s, side, type);
      const unit = { id, side, type, pos, hp: 0, building: null };
      unit.hp = statFor(s, unit).hp; // new units inherit the tick-0 stance for their type
      s.units.push(unit);
      u.building = null;
      log.buildsCompleted.push({ worker: u.id, produces: type, unitId: id, pos: [unit.pos[0], unit.pos[1]] });
    }
  }

  // 4. Core passive worker: on turns divisible by CORE_WORKER_EVERY, when this
  // side's half runs, spawn exactly 1 worker adjacent to own core — once per
  // side per such turn, tracked in state.coreSpawnedTurn[side].
  function applyCoreSpawn(s, side, log){
    if (s.turn % CONST.CORE_WORKER_EVERY !== 0) return;
    if (s.coreSpawnedTurn[side] === s.turn) return;
    const pos = spawnPos(s, s.cores[side].pos);
    if (!pos) return;                     // core buried in units: this cycle's worker is skipped
    s.coreSpawnedTurn[side] = s.turn;
    const id = mintId(s, side, 'worker');
    const unit = { id, side, type: 'worker', pos, hp: 0, building: null };
    unit.hp = statFor(s, unit).hp;
    s.units.push(unit);
    log.coreSpawns.push({ side, unitId: id, pos: [unit.pos[0], unit.pos[1]] });
  }

  // 5. Combat — CONTRACTS §3, encoded literally. Once per half-turn, after the
  // active side's movement/builds: ALL units of BOTH sides plus BOTH cores fire
  // simultaneously from current (post-movement) positions.
  //   - Active side's fire_policy comes from this half-turn's orders (already
  //     persisted to state.firePolicies[side] by halfTurn); passive side uses
  //     its last-persisted policy. {} = all spread.
  //   - Spread: full atk to EVERY enemy in range — enemy units AND the enemy core.
  //   - Focus with target: full atk to that enemy UNIT if in range, else nothing
  //     (no fallback; cores are not focusable — targets are unit ids).
  //   - Focus without target: engine picks the lowest-HP enemy UNIT in range,
  //     ties broken by unit id ascending; no unit in range -> attacks nothing.
  //   - Workers (atk 0) never attack. Cores hit every enemy unit in range for
  //     CORE.attack; cores never damage the enemy core.
  //   - All damage is computed from pre-phase HP and applied simultaneously;
  //     deaths (hp<=0) are removed only after everything is applied, so a focus
  //     target that "dies" to someone else this phase still absorbs every attack.
  // Returns raw (unclamped) post-phase core HP for the mutual-kill tiebreak.
  function resolveCombat(s, log){
    const unitDmg = {};                       // id -> accumulated damage
    const coreDmg = { A: 0, B: 0 };

    for (const u of s.units){
      const st = statFor(s, u);
      if (st.atk <= 0) continue;              // workers never attack
      const enemySide = other(u.side);
      const inRangeUnits = s.units.filter(e => e.side === enemySide && cheb(u.pos, e.pos) <= st.range);
      const coreInRange = minChebToCore(u.pos, enemySide) <= st.range;
      const pol = (s.firePolicies[u.side] || {})[u.type];
      const mode = (pol && pol.mode === 'focus') ? 'focus' : 'spread';

      if (mode === 'spread'){
        for (const e of inRangeUnits){
          unitDmg[e.id] = (unitDmg[e.id] || 0) + st.atk;
          log.combatEvents.push({ attacker: u.id, target: e.id, dmg: st.atk });
        }
        if (coreInRange){
          coreDmg[enemySide] += st.atk;
          log.coreDamage.push({ core: enemySide, dmg: st.atk, from: u.id });
        }
      } else {
        // Focus fire. Triangles are multi-lock platforms: focus engages up to
        // TRIANGLE_FOCUS_TARGETS enemies at once (named target first if given,
        // remaining slots auto-filled lowest-HP-first, ties by id ascending).
        // Other classes focus exactly one target.
        const slots = u.type === 'triangle' ? CONST.TRIANGLE_FOCUS_TARGETS : 1;
        const byPriority = inRangeUnits.slice().sort((a, b) =>
          a.hp !== b.hp ? a.hp - b.hp : (a.id < b.id ? -1 : 1));
        let targets = [];
        if (typeof pol.target === 'string' && pol.target.length){
          // explicit target: in range -> engage (plus auto-fill for triangles);
          // out of range -> this unit attacks NOTHING (strict, no fallback)
          const t = inRangeUnits.find(e => e.id === pol.target);
          if (t) targets = [t].concat(byPriority.filter(e => e.id !== t.id)).slice(0, slots);
        } else {
          targets = byPriority.slice(0, slots);
        }
        for (const t of targets){
          unitDmg[t.id] = (unitDmg[t.id] || 0) + st.atk;
          log.combatEvents.push({ attacker: u.id, target: t.id, dmg: st.atk });
        }
      }
    }

    // Both cores fire: every enemy unit in range takes CORE.attack. Attacker id
    // in the log is 'A_core' / 'B_core' (cores are not units, need a stable tag).
    for (const cs of ['A','B']){
      const enemySide = other(cs);
      for (const e of s.units){
        if (e.side !== enemySide || minChebToCore(e.pos, cs) > CONST.CORE.range) continue;
        unitDmg[e.id] = (unitDmg[e.id] || 0) + CONST.CORE.attack;
        log.combatEvents.push({ attacker: cs + '_core', target: e.id, dmg: CONST.CORE.attack });
      }
    }

    // Simultaneous application, then deaths.
    for (const u of s.units) if (unitDmg[u.id]) u.hp -= unitDmg[u.id];
    s.units = s.units.filter(u => {
      if (u.hp <= 0){ log.deaths.push(u.id); return false; }
      return true;
    });
    const rawCoreHp = { A: s.cores.A.hp - coreDmg.A, B: s.cores.B.hp - coreDmg.B };
    s.cores.A.hp = Math.max(0, rawCoreHp.A);
    s.cores.B.hp = Math.max(0, rawCoreHp.B);
    if (log.combatEvents.length || log.coreDamage.length) s.lastAggroTurn = s.turn;
    return rawCoreHp;
  }

  // Stagnation rule: once past STAGNATION.afterTurn, a FULL turn (both halves)
  // with zero combat events and zero core damage bleeds BOTH cores. Runs on the
  // second mover's half, after combat, before the turn advances — so a
  // stagnation kill on turn 30 beats the time-limit tiebreak.
  function applyStagnation(s, side, log){
    if (s.result) return;
    if (s.turn <= CONST.STAGNATION.afterTurn) return;
    if (side === firstMoverOf(s.turn)) return;      // only when the turn is completing
    if (s.lastAggroTurn === s.turn) return;         // someone fought this turn
    const dmg = CONST.STAGNATION.dmg;
    const raw = { A: s.cores.A.hp - dmg, B: s.cores.B.hp - dmg };
    s.cores.A.hp = Math.max(0, raw.A);
    s.cores.B.hp = Math.max(0, raw.B);
    log.coreDamage.push({ core: 'A', dmg, from: 'stagnation' });
    log.coreDamage.push({ core: 'B', dmg, from: 'stagnation' });
    checkCoreDeath(s, raw);
  }

  // 6. Win check after combat. rawCoreHp keeps sub-zero values so a simultaneous
  // mutual core kill can be split by "higher core HP% at that instant".
  function checkCoreDeath(s, rawCoreHp){
    const aDead = rawCoreHp.A <= 0, bDead = rawCoreHp.B <= 0;
    if (!aDead && !bDead) return;
    if (aDead && bDead){
      // mutual kill: higher core HP% -> total remaining unit HP -> draw
      if (rawCoreHp.A !== rawCoreHp.B){ // same max HP, so raw compare == % compare
        s.result = { winner: rawCoreHp.A > rawCoreHp.B ? 'A' : 'B', reason: 'core_hp', finalTurn: s.turn };
      } else {
        const ha = totalUnitHp(s, 'A'), hb = totalUnitHp(s, 'B');
        if (ha !== hb) s.result = { winner: ha > hb ? 'A' : 'B', reason: 'unit_hp', finalTurn: s.turn };
        else s.result = { winner: 'draw', reason: 'draw', finalTurn: s.turn };
      }
    } else {
      s.result = { winner: aDead ? 'B' : 'A', reason: 'core_destroyed', finalTurn: s.turn };
    }
  }

  // Turn-limit end: higher core HP% -> total remaining unit HP -> draw.
  function timeLimitResult(s){
    const pa = s.cores.A.hp / CONST.CORE.hp, pb = s.cores.B.hp / CONST.CORE.hp;
    if (pa !== pb){ s.result = { winner: pa > pb ? 'A' : 'B', reason: 'core_hp', finalTurn: s.turn }; return; }
    const ha = totalUnitHp(s, 'A'), hb = totalUnitHp(s, 'B');
    if (ha !== hb){ s.result = { winner: ha > hb ? 'A' : 'B', reason: 'unit_hp', finalTurn: s.turn }; return; }
    s.result = { winner: 'draw', reason: 'draw', finalTurn: s.turn };
  }

  // 7. Advance half/turn. First mover: A on odd turns, B on even turns. After
  // the second half of a turn, the turn increments; past TURN_LIMIT the match
  // ends on the tiebreak chain instead.
  function advance(s){
    if (s.result) return;
    const first = firstMoverOf(s.turn);
    if (s.half === first){
      s.half = other(first);
    } else {
      if (s.turn >= CONST.TURN_LIMIT){ timeLimitResult(s); return; }
      s.turn += 1;
      s.half = firstMoverOf(s.turn);
    }
  }

  // halfTurn(state, side, sanitizedOrders) -> { state, log }. Pure: input state
  // is never mutated. sanitizedOrders must come from Validate.sanitizeOrders
  // (engine still re-checks defensively). Deterministic.
  function halfTurn(state, side, sanitizedOrders){
    if (state.result) throw new Error('AIWARS.Engine.halfTurn: match already ended');
    if (side !== state.half) throw new Error('AIWARS.Engine.halfTurn: side ' + side + ' acted out of turn (half=' + state.half + ')');

    const s = clone(state);
    if (!s.coreSpawnedTurn) s.coreSpawnedTurn = { A: 0, B: 0 }; // tolerate older snapshots
    if (typeof s.lastAggroTurn !== 'number') s.lastAggroTurn = 0;
    const so = sanitizedOrders || {};
    const orders = Array.isArray(so.orders) ? so.orders : [];
    const builds = Array.isArray(so.builds) ? so.builds : [];

    const log = {
      turn: s.turn,
      activePlayer: side,
      parseStatus: so.parseStatus || 'ok',
      note: (typeof so.note === 'string') ? so.note : null,
      ordersApplied: [],
      buildsStarted: [],
      buildsCompleted: [],
      coreSpawns: [],
      combatEvents: [],
      deaths: [],
      coreDamage: [],
      resultingState: null,
    };

    // Active side's fire policy is this half-turn's declaration, persisted.
    // A turn with no declaration (incl. malformed no-op turns) persists {} = spread.
    s.firePolicies[side] = clone((so.fire_policy && typeof so.fire_policy === 'object') ? so.fire_policy : {});

    applyMovement(s, side, orders, log);        // 1
    applyBuildStarts(s, side, builds, log);     // 2
    applyBuildCompletions(s, side, log);        // 3
    applyCoreSpawn(s, side, log);               // 4
    const rawCoreHp = resolveCombat(s, log);    // 5
    checkCoreDeath(s, rawCoreHp);               // 6
    applyStagnation(s, side, log);              // 6b: passivity tax past turn 20
    advance(s);                                 // 7

    log.resultingState = clone(s);
    return { state: s, log };
  }

  NS.Engine = { createMatch, statFor, turnPayload, halfTurn };

})(typeof window !== 'undefined' ? window : globalThis);
