// AI WARS — bots.js — AIWARS.Bots (CONTRACTS §6)
// Deterministic scripted opponent. Consumes ONLY the §12.4 turn payload
// (never engine state). Same (payload, seed) in => same orders out.
(function(g){
  const NS = g.AIWARS = g.AIWARS || {};

  // ---------------------------------------------------------------- rng ----
  // PACS0005 — sim determinism: bots use this seeded PRNG only, never Math.random — AGENTS.md
  // mulberry32 — tiny deterministic PRNG, embedded so bots.js has zero deps.
  function mulberry32(a){
    a = a >>> 0;
    return function(){
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ------------------------------------------------------------- helpers ---
  function cheb(a, b){ return Math.max(Math.abs(a[0]-b[0]), Math.abs(a[1]-b[1])); }
  function sign(n){ return n > 0 ? 1 : (n < 0 ? -1 : 0); }
  function clampInt(v, lo, hi){ return Math.max(lo, Math.min(hi, Math.round(v))); }
  function clampToGrid(t, grid){
    return [ clampInt(t[0], 0, grid.width - 1), clampInt(t[1], 0, grid.height - 1) ];
  }

  // Core positions are fixed game constants (CONTRACTS §1). Prefer the
  // engine-declared single source when loaded; fall back to the same values
  // so bots.js also works standalone (payload carries no core positions).
  function corePos(side){
    const C = NS.CONST && NS.CONST.CORE_POS;
    const FALLBACK = { A: [1, 1], B: [22, 12] };
    return (C && C[side]) ? C[side] : FALLBACK[side];
  }

  // Short deterministic taunts for the mechanically-inert "note" field.
  const TAUNTS = [
    'Executing optimal aggression subroutine.',
    'Your core is a rounding error.',
    'I have already simulated your defeat.',
    'Resistance is inefficient.',
    'Deploying. Do keep up.',
    'This is not even my final doctrine.',
    'Recalibrating... you are still losing.',
    'My workers unionized against you.'
  ];

  // PACS0004 — stance vocabulary; must match engine.js STANCES — AGENTS.md
  const STANCES = ['default', 'attack', 'defense'];

  // --------------------------------------------------------------- stance --
  // stance(rngSeed) -> {worker, vehicle, triangle}. Each type rolls its stance
  // independently so doctrines VARY match to match (callers supply a fresh
  // seed per match). Still a pure function of the seed — replays and tests
  // stay deterministic.
  function stance(rngSeed){
    const rng = mulberry32(((rngSeed >>> 0) || 1));
    return {
      worker:   STANCES[Math.floor(rng() * 3)],
      vehicle:  STANCES[Math.floor(rng() * 3)],
      triangle: STANCES[Math.floor(rng() * 3)],
    };
  }

  // stanceRoundRobin(i) -> Latin-square doctrine for bot-vs-bot showcases:
  // each type takes a DIFFERENT stance, and cycling i (0,1,2,...) walks every
  // type through every stance — all 9 sprite variants appear within 3 matches.
  // Sides should use consecutive indices (A: i, B: i+1) so they never mirror.
  function stanceRoundRobin(i){
    const k = ((i % 3) + 3) % 3;
    return {
      worker:   STANCES[k],
      vehicle:  STANCES[(k + 1) % 3],
      triangle: STANCES[(k + 2) % 3],
    };
  }

  // Pick the ring tile at EXACTLY Chebyshev 2 from `anchor` that is cheapest
  // to reach for `from`, tie-broken toward `goal`, then by x, then y.
  // Deterministic: fixed iteration order over the ring.
  function kiteTile(from, anchor, goal, grid){
    let best = null, bestKey = null;
    for (let dx = -2; dx <= 2; dx++){
      for (let dy = -2; dy <= 2; dy++){
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== 2) continue; // ring only
        const x = anchor[0] + dx, y = anchor[1] + dy;
        if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
        const t = [x, y];
        const key = [cheb(from, t), cheb(t, goal), x, y];
        if (!best || key[0] < bestKey[0] ||
            (key[0] === bestKey[0] && (key[1] < bestKey[1] ||
            (key[1] === bestKey[1] && (key[2] < bestKey[2] ||
            (key[2] === bestKey[2] && key[3] < bestKey[3])))))){
          best = t; bestKey = key;
        }
      }
    }
    return best; // null only if the whole ring is off-grid (cannot happen at 24x14)
  }

  // --------------------------------------------------------------- orders --
  // orders(payload, rngSeed) -> {orders, builds, fire_policy, note}
  function orders(payload, rngSeed){
    payload = payload || {};
    const turn  = (typeof payload.turn === 'number') ? (payload.turn | 0) : 0;
    // Fold the turn into the seed so behavior varies across turns but stays
    // a pure function of (payload, seed).
    const rng = mulberry32(((((rngSeed >>> 0) ^ Math.imul(turn + 1, 0x9E3779B9)) >>> 0) || 1));

    const me        = payload.you_are === 'B' ? 'B' : 'A';
    const foeSide   = me === 'A' ? 'B' : 'A';
    const myCore    = corePos(me);
    const enemyCore = corePos(foeSide);
    const grid      = (payload.grid && payload.grid.width) ? payload.grid : { width: 24, height: 14 };
    const mine      = Array.isArray(payload.your_units) ? payload.your_units : [];
    const foes      = Array.isArray(payload.visible_enemy_units) ? payload.visible_enemy_units : [];

    const ordersArr = [];
    const builds = [];

    // ---- census (count in-progress builds so the mix does not overshoot)
    let vehCount = 0, triCount = 0;
    for (const u of mine){
      if (u.type === 'vehicle') vehCount++;
      else if (u.type === 'triangle') triCount++;
      if (u.building && u.building.produces === 'vehicle') vehCount++;
      else if (u.building && u.building.produces === 'triangle') triCount++;
    }

    // ---- workers: stay adjacent-ish to own core, build only up to the army
    // cap (live + in-progress combat units). Rebuild-to-strength, not hoard:
    // losses drop the census below the cap and production resumes.
    const MAX_COMBAT = 6;   // 2 vehicles + 4 triangles at the 2:1 mix
    for (const w of mine){
      if (w.type !== 'worker') continue;
      if (w.building) continue;                 // mid-build: immobile, busy
      if (cheb(w.pos, myCore) > 2){
        // Drift home first: target the core-adjacent tile facing the worker.
        const home = clampToGrid([
          myCore[0] + (sign(w.pos[0] - myCore[0]) || 1),
          myCore[1] + (sign(w.pos[1] - myCore[1]) || 1)
        ], grid);
        ordersArr.push({ unit: w.id, target: home });
      } else if (vehCount + triCount < MAX_COMBAT){
        // Build mix: first vehicle ASAP, then keep ~2:1 triangles:vehicles.
        let produces;
        if (vehCount === 0) produces = 'vehicle';
        else if (triCount < 2 * vehCount) produces = 'triangle';
        else produces = 'vehicle';
        builds.push({ worker: w.id, produces: produces });
        if (produces === 'vehicle') vehCount++; else triCount++;
      }
      // at cap: worker idles by the core until losses reopen a build slot
    }

    // ---- combat units: rally near own core until group >= 3, then push
    const combat = mine.filter(function(u){ return u.type === 'vehicle' || u.type === 'triangle'; });
    const groupReady = combat.length >= 3;
    const dirX = sign(enemyCore[0] - myCore[0]) || 1;
    const dirY = sign(enemyCore[1] - myCore[1]) || 1;
    const rally = clampToGrid([myCore[0] + 3 * dirX, myCore[1] + 3 * dirY], grid);
    // Advance destination: tile adjacent to the enemy core on our side
    // (units never need to stand ON the core tile; engine clamps the path).
    const assault = clampToGrid([enemyCore[0] - dirX, enemyCore[1] - dirY], grid);

    const enemyVehicles = foes.filter(function(f){ return f.type === 'vehicle'; });

    for (const u of combat){
      let target = null;

      // Triangles kite: hold EXACTLY range 2 from the nearest enemy vehicle
      // whenever one is close enough to matter this turn.
      if (u.type === 'triangle' && enemyVehicles.length){
        let nearest = null, nd = Infinity;
        for (const f of enemyVehicles){
          const d = cheb(u.pos, f.pos);
          if (d < nd || (d === nd && f.id < nearest.id)){ nearest = f; nd = d; }
        }
        const reach = (typeof u.move_range === 'number' ? u.move_range : 9) + 3;
        if (nd <= reach){
          target = kiteTile(u.pos, nearest.pos, enemyCore, grid);
        }
      }

      if (!target) target = groupReady ? assault : rally;
      if (target[0] === u.pos[0] && target[1] === u.pos[1]) continue; // hold
      ordersArr.push({ unit: u.id, target: [target[0], target[1]] });
    }

    // ---- fire policy: with >= 2 combat units engaged, focus w/o target so
    // the engine auto-picks the lowest-HP enemy in range (finish the kill).
    let engaged = 0;
    for (const u of combat){
      const range = (typeof u.attack_range === 'number') ? u.attack_range
                  : (u.type === 'triangle' ? 2 : 1);
      for (const f of foes){
        if (cheb(u.pos, f.pos) <= range){ engaged++; break; }
      }
    }
    const fire_policy = (engaged >= 2)
      ? { vehicle: { mode: 'focus' }, triangle: { mode: 'focus' } }
      : {};

    const note = TAUNTS[Math.floor(rng() * TAUNTS.length)];

    return { orders: ordersArr, builds: builds, fire_policy: fire_policy, note: note };
  }

  NS.Bots = { stance: stance, stanceRoundRobin: stanceRoundRobin, orders: orders };
})(typeof window !== 'undefined' ? window : globalThis);
