/*
 * AI WARS — engine.test.js
 * Bare-Node, zero-dep unit tests for engine.js + validate.js (CONTRACTS §11,
 * minus the bot-vs-bot integration test which lands with bots.js).
 * Run: node game/tests/engine.test.js  -> exit 0 on pass, 1 on any failure.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Load modules the same way the browser does (no require/exports in them).
for (const f of ['engine.js', 'validate.js']){
  const p = path.join(__dirname, '..', 'js', f);
  vm.runInThisContext(fs.readFileSync(p, 'utf8'), { filename: p });
}
const { CONST, Engine, Validate } = globalThis.AIWARS;

// ── tiny harness ────────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
let current = '';
function test(name, fn){
  current = name;
  try { fn(); passed++; }
  catch (e){ failures.push({ name, msg: e.message, stack: e.stack }); }
}
function assert(cond, msg){
  if (!cond) throw new Error((msg || 'assertion failed'));
}
function assertEq(actual, expected, msg){
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error((msg || 'not equal') + '\n  actual:   ' + a + '\n  expected: ' + e);
}

// ── helpers ─────────────────────────────────────────────────────────────────
const EMPTY = { orders: [], builds: [], fire_policy: {}, note: null, parseStatus: 'ok' };
function mk(over){ // fresh default match, optionally overridden field-by-field
  const s = Engine.createMatch({ stances: { A: {}, B: {} } });
  return Object.assign(s, over || {});
}
function unit(id, side, type, pos, hp, building){
  return { id, side, type, pos, hp, building: building || null };
}
function byId(state, id){ return state.units.find(u => u.id === id) || null; }
// run one half-turn with no orders for whoever is up next
function idle(s){ return Engine.halfTurn(s, s.half, EMPTY).state; }

// ═══ constants sanity ═══════════════════════════════════════════════════════
test('CONST matches the retune + 2026-07-21 balance pass', () => {
  assertEq(CONST.GRID, { W: 24, H: 14 });
  assertEq(CONST.CORE_POS, { A: [1,1], B: [22,12] });
  assertEq(CONST.TURN_LIMIT, 40);
  assertEq(CONST.CORE, { hp: 200, attack: 5, range: 2 });
  assertEq(CONST.BUILD_TURNS, { vehicle: 3, triangle: 2 });
  // 2026-07-21: flat +3 move on every unit/stance; hp/atk/ranges unchanged
  assertEq(CONST.UNITS, {
    worker:   { default:{hp:20,atk:0,move:5,range:0}, attack:{hp:10,atk:0,move:5,range:0}, defense:{hp:30,atk:0,move:5,range:0} },
    vehicle:  { default:{hp:60,atk:10,move:6,range:1}, attack:{hp:30,atk:15,move:6,range:1}, defense:{hp:90,atk:5,move:6,range:1} },
    triangle: { default:{hp:16,atk:4,move:9,range:2}, attack:{hp:8,atk:5,move:9,range:2}, defense:{hp:24,atk:3,move:9,range:2} },
  });
  assertEq(CONST.TRIANGLE_FOCUS_TARGETS, 3);
  assertEq(CONST.STAGNATION, { afterTurn: 20, dmg: 20 });
  assertEq(CONST.MELTDOWN, { fromTurn: 30, dmg: 20 });
});

// ═══ createMatch / statFor / turnPayload ════════════════════════════════════
test('createMatch: initial state shape, 2 workers per side adjacent to core', () => {
  const s = Engine.createMatch({ stances: { A: { vehicle: 'attack' }, B: { worker: 'garbage' } } });
  assertEq(s.turn, 1); assertEq(s.half, 'A'); assertEq(s.result, null);
  assertEq(s.cores.A, { pos: [1,1], hp: 200 });
  assertEq(s.cores.B, { pos: [22,12], hp: 200 });
  assertEq(s.stances.A, { worker: 'default', vehicle: 'attack', triangle: 'default' });
  assertEq(s.stances.B, { worker: 'default', vehicle: 'default', triangle: 'default' }); // invalid -> default
  assertEq(s.units.length, 4);
  assertEq(s.counters, { A: { worker: 2, vehicle: 0, triangle: 0 }, B: { worker: 2, vehicle: 0, triangle: 0 } });
  assertEq(s.coreSpawnedTurn, { A: 0, B: 0 });
  assertEq(s.lastAggroTurn, 0);
  assertEq(s.firePolicies, { A: {}, B: {} });
  for (const u of s.units){
    assert(u.hp > 0, 'worker hp set');
    const d = Math.max(Math.abs(u.pos[0]-s.cores[u.side].pos[0]), Math.abs(u.pos[1]-s.cores[u.side].pos[1]));
    assertEq(d, 1, u.id + ' adjacent to own core');
  }
  // deterministic spawn around the 2x2 core block. A's north tile [1,0] is a
  // core tile, so ring-1 clockwise-from-north lands w1 on [2,0], then w2 on
  // [2,1]. B's block extends down-right, leaving its north tiles free.
  assertEq(byId(s, 'A_w1').pos, [2, 0]);
  assertEq(byId(s, 'A_w2').pos, [2, 1]);
  assertEq(byId(s, 'B_w1').pos, [22, 11]);
  assertEq(byId(s, 'B_w2').pos, [23, 11]);
});

test('statFor derives stance stats, never per-unit storage', () => {
  const s = mk({ stances: { A: { worker:'defense', vehicle:'attack', triangle:'default' }, B: { worker:'default', vehicle:'default', triangle:'defense' } } });
  assertEq(Engine.statFor(s, unit('A_v9','A','vehicle',[0,0],1)), { hp: 30, atk: 15, move: 6, range: 1 });
  assertEq(Engine.statFor(s, unit('A_w9','A','worker',[0,0],1)), { hp: 30, atk: 0, move: 5, range: 0 });
  assertEq(Engine.statFor(s, unit('B_t9','B','triangle',[0,0],1)), { hp: 24, atk: 3, move: 9, range: 2 });
});

test('turnPayload: §12.4 shape, full visibility, building exposed snake_case', () => {
  const s = mk();
  s.units = [
    unit('A_w1','A','worker',[3,2],20,{ produces:'vehicle', completesTurn: 9 }),
    unit('A_v1','A','vehicle',[9,8],60),
    unit('B_t1','B','triangle',[11,9],16),
  ];
  s.cores.A.hp = 178;
  const p = Engine.turnPayload(s, 'A');
  assertEq(p.turn, 1); assertEq(p.you_are, 'A');
  assertEq(p.your_core_hp, 178); assertEq(p.enemy_core_hp, 200);
  assertEq(p.grid, { width: 24, height: 14 });
  assertEq(p.your_units.length, 2);
  assertEq(p.your_units[0], { id:'A_w1', type:'worker', pos:[3,2], hp:20, move_range:5, attack_range:0, building:{ produces:'vehicle', completes_turn:9 } });
  assertEq(p.your_units[1], { id:'A_v1', type:'vehicle', pos:[9,8], hp:60, move_range:6, attack_range:1 });
  assertEq(p.visible_enemy_units, [{ id:'B_t1', type:'triangle', pos:[11,9], hp:16 }]);
  assertEq(p.your_stance_doctrine, { worker:'default', vehicle:'default', triangle:'default' });
  // payload is detached from state
  p.your_units[0].pos[0] = 99;
  assertEq(s.units[0].pos[0], 3);
});

// ═══ halfTurn mechanics ══════════════════════════════════════════════════════
test('halfTurn never mutates input state and rejects wrong side / ended match', () => {
  const s = mk();
  const snapshot = JSON.stringify(s);
  const r = Engine.halfTurn(s, 'A', EMPTY);
  assertEq(JSON.stringify(s), snapshot, 'input state mutated');
  assert(r.state !== s, 'returned state is a new object');
  let threw = false;
  try { Engine.halfTurn(s, 'B', EMPTY); } catch (e){ threw = true; }
  assert(threw, 'acting out of turn must throw');
  const ended = mk({ result: { winner:'A', reason:'core_destroyed', finalTurn: 5 } });
  threw = false;
  try { Engine.halfTurn(ended, 'A', EMPTY); } catch (e){ threw = true; }
  assert(threw, 'ended match must throw');
});

test('movement: within range lands exactly on target, clamped=false', () => {
  const s = mk();
  s.units = [unit('A_t1','A','triangle',[5,5],16)]; // move 6
  const { state, log } = Engine.halfTurn(s, 'A', { ...EMPTY, orders: [{ unit:'A_t1', target:[9,7] }] }); // cheb 4
  assertEq(byId(state,'A_t1').pos, [9,7]);
  assertEq(log.ordersApplied, [{ unit:'A_t1', from:[5,5], to:[9,7], clamped:false }]);
});

test('movement: clamp along line via greedy sign-steps', () => {
  const s = mk();
  s.units = [unit('A_v1','A','vehicle',[5,5],60)]; // move 6
  const { state, log } = Engine.halfTurn(s, 'A', { ...EMPTY, orders: [{ unit:'A_v1', target:[12,12] }] }); // cheb 7 > move 6
  // steps: [6,6]..[11,11]; stops at exactly move-range Chebyshev steps
  assertEq(byId(state,'A_v1').pos, [11,11]);
  assertEq(log.ordersApplied[0].clamped, true);
});

test('movement: straight-ish diagonal exhausts dy first then runs straight', () => {
  const s = mk();
  s.units = [unit('A_t1','A','triangle',[5,5],16)]; // move 9
  const { state } = Engine.halfTurn(s, 'A', { ...EMPTY, orders: [{ unit:'A_t1', target:[20,8] }] }); // cheb 15 > move 9
  // [6,6][7,7][8,8] then straight [9,8]..[14,8] = 9 steps
  assertEq(byId(state,'A_t1').pos, [14,8]);
});

test('movement: mid-build worker ignores move orders', () => {
  const s = mk();
  s.units = [unit('A_w1','A','worker',[5,5],20,{ produces:'triangle', completesTurn: 4 })];
  const { state, log } = Engine.halfTurn(s, 'A', { ...EMPTY, orders: [{ unit:'A_w1', target:[6,5] }] });
  assertEq(byId(state,'A_w1').pos, [5,5]);
  assertEq(log.ordersApplied, []);
});

// ═══ movement: landing exclusivity (transit passes through) ═════════════════
test('movement: transit passes through an occupied tile, lands on free target', () => {
  const s = mk();
  s.units = [
    unit('A_v1','A','vehicle',[5,5],60),   // move 3
    unit('A_w9','A','worker',[7,5],20),    // sits on the line — no longer a wall
  ];
  const { state, log } = Engine.halfTurn(s, 'A', { ...EMPTY, orders: [{ unit:'A_v1', target:[8,5] }] });
  assertEq(byId(state,'A_v1').pos, [8,5], 'passes through the worker');
  assertEq(log.ordersApplied, [{ unit:'A_v1', from:[5,5], to:[8,5], clamped:false }]);
  assertEq(byId(state,'A_w9').pos, [7,5], 'blocker untouched');
});

test('movement: occupied destination redirects to nearest free tile from mover POV', () => {
  const s = mk();
  s.units = [
    unit('A_v1','A','vehicle',[5,5],60),   // move 3
    unit('A_w9','A','worker',[7,5],20),    // squatting on the ordered tile
  ];
  const { state, log } = Engine.halfTurn(s, 'A', { ...EMPTY, orders: [{ unit:'A_v1', target:[7,5] }] });
  // ring r=1 around [7,5], closest to [5,5] (d=1), first in clockwise walk: [6,6]
  assertEq(byId(state,'A_v1').pos, [6,6]);
  assertEq(log.ordersApplied, [{ unit:'A_v1', from:[5,5], to:[6,6], clamped:true }]);
});

test('movement: corner-boxed unit escapes through its neighbors', () => {
  const s = mk();
  s.units = [
    unit('A_t1','A','triangle',[5,5],16),  // move 6
    unit('A_w7','A','worker',[6,6],20),    // the old wall
    unit('A_w8','A','worker',[6,5],20),
    unit('A_w9','A','worker',[5,6],20),
  ];
  const { state, log } = Engine.halfTurn(s, 'A', { ...EMPTY, orders: [{ unit:'A_t1', target:[7,7] }] });
  assertEq(byId(state,'A_t1').pos, [7,7], 'walks straight through the box');
  assertEq(log.ordersApplied, [{ unit:'A_t1', from:[5,5], to:[7,7], clamped:false }]);
});

test('movement: clamped short onto an occupied tile re-resolves the landing', () => {
  const s = mk();
  s.units = [
    unit('A_v1','A','vehicle',[5,5],60),   // move 6: clamp point is [11,5]
    unit('A_w9','A','worker',[11,5],20),   // squatting exactly there
  ];
  const { state, log } = Engine.halfTurn(s, 'A', { ...EMPTY, orders: [{ unit:'A_v1', target:[20,5] }] }); // cheb 15 > move 6
  // clamps 6 east to [11,5] (occupied) -> re-resolve: ring r=1 around [11,5],
  // closest to [5,5] (d=5), first in clockwise-from-north walk: [10,6]
  assertEq(byId(state,'A_v1').pos, [10,6]);
  assertEq(log.ordersApplied[0].clamped, true);
});

test('movement: two movers to the same tile — first in array order wins', () => {
  const s = mk();
  s.units = [
    unit('A_v1','A','vehicle',[5,5],60),
    unit('A_v2','A','vehicle',[7,5],60),
  ];
  const { state, log } = Engine.halfTurn(s, 'A', { ...EMPTY,
    orders: [{ unit:'A_v1', target:[6,5] }, { unit:'A_v2', target:[6,5] }] });
  assertEq(byId(state,'A_v1').pos, [6,5], 'first order claims the tile');
  assertEq(byId(state,'A_v2').pos, [7,5], 'second mover stops adjacent');
  assertEq(log.ordersApplied, [
    { unit:'A_v1', from:[5,5], to:[6,5], clamped:false },
    { unit:'A_v2', from:[7,5], to:[7,5], clamped:true },
  ]);
});

// ═══ builds ═════════════════════════════════════════════════════════════════
test('build timing: triangle completes on turn+2, spawn adjacent [0,-1] first', () => {
  let s = mk();
  s.units = [unit('A_w1','A','worker',[5,5],20)];
  const r1 = Engine.halfTurn(s, 'A', { ...EMPTY, builds: [{ worker:'A_w1', produces:'triangle' }] });
  assertEq(r1.log.buildsStarted, [{ worker:'A_w1', produces:'triangle', completesTurn: 3 }]);
  assertEq(byId(r1.state,'A_w1').building, { produces:'triangle', completesTurn: 3 });
  s = r1.state;
  // idle to turn 3's A half (odd turn -> A first), where the completion fires
  while (!(s.turn === 3 && s.half === 'A')) s = idle(s);
  assert(byId(s,'A_t1') === null, 'triangle must not exist before A half of t3');
  const r2 = Engine.halfTurn(s, 'A', EMPTY); // t3 A half: completion fires
  const t = byId(r2.state, 'A_t1');
  assert(t, 'A_t1 spawned');
  assertEq(t.pos, [5,4], 'first offset [0,-1] from builder');
  assertEq(t.hp, 16, 'inherits default stance max hp');
  assertEq(byId(r2.state,'A_w1').building, null, 'worker freed');
  assertEq(r2.log.buildsCompleted, [{ worker:'A_w1', produces:'triangle', unitId:'A_t1', pos:[5,4] }]);
});

test('build timing: vehicle completes on turn+3', () => {
  let s = mk();
  s.units = [unit('A_w1','A','worker',[10,10],20)];
  s = Engine.halfTurn(s, 'A', { ...EMPTY, builds: [{ worker:'A_w1', produces:'vehicle' }] }).state;
  // idle everything until A's half of turn 4 (completesTurn = 1 + 3 = 4)
  while (!(s.turn === 4 && s.half === 'A')) s = idle(s);
  assert(byId(s,'A_v1') === null, 'no vehicle before completion half');
  s = idle(s);
  const v = byId(s,'A_v1');
  assert(v, 'A_v1 spawned on turn 4'); assertEq(v.hp, 60);
});

test('spawn adjacency: skips off-grid and core tiles in fixed offset order', () => {
  // builder on top edge: [0,-1] and [1,-1] off-grid -> [1,0] offset wins
  let s = mk();
  s.units = [unit('A_w1','A','worker',[5,0],20,{ produces:'triangle', completesTurn: 1 })];
  let r = Engine.halfTurn(s, 'A', EMPTY);
  assertEq(byId(r.state,'A_t1').pos, [6,0]);
  // builder at [1,2]: offset [0,-1] hits core A at [1,1] -> skipped -> [2,1]
  s = mk();
  s.units = [unit('A_w1','A','worker',[1,2],20,{ produces:'triangle', completesTurn: 1 })];
  r = Engine.halfTurn(s, 'A', EMPTY);
  assertEq(byId(r.state,'A_t1').pos, [2,1]);
});

test('no stacking: spawn skips unit-occupied tiles like core tiles', () => {
  const s = mk();
  s.units = [
    unit('A_w1','A','worker',[5,5],20,{ produces:'triangle', completesTurn: 1 }),
    unit('A_w2','A','worker',[5,4],20), // sits on the first-choice spawn tile
  ];
  const r = Engine.halfTurn(s, 'A', EMPTY);
  assertEq(byId(r.state,'A_t1').pos, [6,4], 'skips to the next clockwise ring-1 tile');
});

test('spawn overflows to ring r=2 when the whole r=1 ring is taken', () => {
  const s = mk();
  const ring1 = [[5,4],[6,4],[6,5],[6,6],[5,6],[4,6],[4,5],[4,4]];
  s.units = [unit('A_w1','A','worker',[5,5],20,{ produces:'triangle', completesTurn: 1 })]
    .concat(ring1.map((p,i) => unit('A_blk'+i,'A','worker',p,20)));
  const r = Engine.halfTurn(s, 'A', EMPTY);
  assertEq(byId(r.state,'A_t1').pos, [5,3], 'first r=2 offset [0,-2], clockwise from north');
});

test('build completion held (+1 turn) while the whole r<=3 neighborhood is packed', () => {
  let s = mk();
  const blockers = [];
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++){
    if (!dx && !dy) continue;
    blockers.push(unit('A_blk_' + dx + '_' + dy, 'A', 'worker', [5 + dx, 5 + dy], 20));
  }
  s.units = [unit('A_w1','A','worker',[5,5],20,{ produces:'triangle', completesTurn: 1 })].concat(blockers);
  let r = Engine.halfTurn(s, 'A', EMPTY);
  assertEq(r.log.buildsCompleted, [], 'held builds are not logged');
  assert(byId(r.state,'A_t1') === null, 'no unit spawned');
  assertEq(byId(r.state,'A_w1').building, { produces:'triangle', completesTurn: 2 }, 'completion pushed one turn');
  // free one ring-1 tile; the held build lands there on A's next half
  s = r.state;
  s = idle(s);   // t1 B half
  s = idle(s);   // t2 B half (B first on even turns)
  s.units = s.units.filter(u => u.id !== 'A_blk_0_-1');   // vacate [5,4]
  r = Engine.halfTurn(s, 'A', EMPTY);
  assertEq(r.log.buildsCompleted, [{ worker:'A_w1', produces:'triangle', unitId:'A_t1', pos:[5,4] }]);
  assertEq(byId(r.state,'A_w1').building, null);
});

// ═══ core passive worker ════════════════════════════════════════════════════
test('core passive worker: each side spawns exactly once on turn 4, again on 8', () => {
  let s = mk();
  const logs = [];
  while (!s.result && s.turn <= 9){
    const r = Engine.halfTurn(s, s.half, EMPTY);
    logs.push(r.log);
    s = r.state;
    if (s.turn > 9) break;
  }
  const spawns = logs.flatMap(l => l.coreSpawns.map(cs => ({ turn: l.turn, side: cs.side, pos: cs.pos })));
  // starters + the 4 core tiles are blocked, so spawns walk the ring clockwise
  // to the first free tile around each 2x2 block.
  assertEq(spawns, [
    { turn: 4, side: 'B', pos: [21,13] },  // t4 even: B acts first
    { turn: 4, side: 'A', pos: [2,2] },
    { turn: 8, side: 'B', pos: [21,12] },
    { turn: 8, side: 'A', pos: [1,2] },
  ]);
  assertEq(s.coreSpawnedTurn, { A: 8, B: 8 });
  // 2 starters + t4 + t8 per side
  assertEq(s.units.filter(u => u.side === 'A').length, 4);
  assertEq(s.units.filter(u => u.side === 'B').length, 4);
  assertEq(byId(s, 'A_w4').id, 'A_w4');
});

test('core passive worker skipped when the core is buried (no same-turn retry)', () => {
  const s = mk({ turn: 4, half: 'B' });   // B first on even turns
  const blockers = [];
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++){
    if (!dx && !dy) continue;
    const x = 1 + dx, y = 1 + dy;
    if (x < 0 || y < 0) continue;         // off-grid tiles need no blocker
    blockers.push(unit('A_blk_' + dx + '_' + dy, 'A', 'worker', [x, y], 20));
  }
  s.units = blockers;                      // core A fully buried, core B free
  const rB = Engine.halfTurn(s, 'B', EMPTY);
  assertEq(rB.log.coreSpawns, [{ side:'B', unitId:'B_w3', pos:[22,11] }], 'free core spawns fine');
  const rA = Engine.halfTurn(rB.state, 'A', EMPTY);
  assertEq(rA.log.coreSpawns, [], 'buried core: worker skipped this cycle');
  assertEq(rA.state.coreSpawnedTurn, { A: 0, B: 4 }, 'skip is not marked as spawned');
});

// ═══ combat ═════════════════════════════════════════════════════════════════
test('spread hits ALL enemies in range with full atk (and the enemy core)', () => {
  const s = mk();
  s.units = [
    unit('A_t1','A','triangle',[10,10],16),  // atk 4, range 2
    unit('B_w1','B','worker',[10,8],20),     // cheb 2 - hit
    unit('B_w2','B','worker',[12,12],20),    // cheb 2 - hit
    unit('B_w3','B','worker',[8,10],20),     // cheb 2 - hit
    unit('B_w4','B','worker',[13,10],20),    // cheb 3 - out of range
  ];
  const { state, log } = Engine.halfTurn(s, 'A', EMPTY); // default policy {} = spread
  assertEq(byId(state,'B_w1').hp, 16);
  assertEq(byId(state,'B_w2').hp, 16);
  assertEq(byId(state,'B_w3').hp, 16);
  assertEq(byId(state,'B_w4').hp, 20);
  assertEq(log.combatEvents.length, 3);
  assertEq(log.combatEvents[0].dmg, 4, 'full atk, not divided');
  // spread also reaches the enemy core
  const s2 = mk();
  s2.units = [unit('A_v1','A','vehicle',[21,12],60)]; // adjacent to core B [22,12]
  const r2 = Engine.halfTurn(s2, 'A', EMPTY);
  assertEq(r2.state.cores.B.hp, 190);
  assertEq(r2.log.coreDamage, [{ core:'B', dmg:10, from:'A_v1' }]);
  assertEq(byId(r2.state,'A_v1').hp, 55, 'core B fires back for 5');
});

test('workers (atk 0) never attack', () => {
  const s = mk();
  s.units = [unit('A_w1','A','worker',[10,10],20), unit('B_w1','B','worker',[10,11],20)];
  const { state, log } = Engine.halfTurn(s, 'A', EMPTY);
  assertEq(log.combatEvents, []);
  assertEq(byId(state,'B_w1').hp, 20);
});

test('focus with unreachable target: unit attacks nothing (no fallback)', () => {
  const s = mk();
  s.units = [
    unit('A_v1','A','vehicle',[10,10],60),   // range 1
    unit('B_w1','B','worker',[10,11],20),    // in range, but NOT the focus target
    unit('B_t1','B','triangle',[20,10],16),  // named target, far out of range
  ];
  const { state, log } = Engine.halfTurn(s, 'A', { ...EMPTY, fire_policy: { vehicle: { mode:'focus', target:'B_t1' } } });
  assertEq(log.combatEvents.filter(e => e.attacker === 'A_v1'), []);
  assertEq(byId(state,'B_w1').hp, 20);
  assertEq(byId(state,'B_t1').hp, 16);
});

test('focus with reachable target: full atk to that unit only (non-triangle)', () => {
  const s = mk();
  s.units = [
    unit('A_v1','A','vehicle',[10,10],60),
    unit('B_w1','B','worker',[10,11],20),
    unit('B_w2','B','worker',[11,10],20),
  ];
  const { state, log } = Engine.halfTurn(s, 'A', { ...EMPTY, fire_policy: { vehicle: { mode:'focus', target:'B_w2' } } });
  assertEq(byId(state,'B_w2').hp, 10);
  assertEq(byId(state,'B_w1').hp, 20, 'non-target untouched');
  assertEq(log.combatEvents, [{ attacker:'A_v1', target:'B_w2', dmg:10 }]);
});

test('focus without target: lowest pre-phase HP, ties by id; non-triangles hit exactly 1', () => {
  const s = mk();
  s.units = [
    unit('A_v1','A','vehicle',[10,10],60),   // range 1, single focus slot
    unit('B_w3','B','worker',[10,9],7),      // lowest hp tie...
    unit('B_w2','B','worker',[11,10],7),     // ...tie -> B_w2 < B_w3 wins
    unit('B_w1','B','worker',[9,10],15),
  ];
  const { log } = Engine.halfTurn(s, 'A', { ...EMPTY, fire_policy: { vehicle: { mode:'focus' } } });
  assertEq(log.combatEvents, [{ attacker:'A_v1', target:'B_w2', dmg:10 }]);
  // no enemy unit in range -> attacks nothing
  const s2 = mk();
  s2.units = [unit('A_v1','A','vehicle',[10,10],60), unit('B_w1','B','worker',[20,10],20)];
  const r2 = Engine.halfTurn(s2, 'A', { ...EMPTY, fire_policy: { vehicle: { mode:'focus' } } });
  assertEq(r2.log.combatEvents, []);
});

test('triangle focus engages up to 3 targets, lowest HP first, ties by id', () => {
  const s = mk();
  s.units = [
    unit('A_t1','A','triangle',[10,10],16),  // atk 4, range 2, 3 focus slots
    unit('B_w1','B','worker',[9,10],15),
    unit('B_w2','B','worker',[11,10],7),
    unit('B_w3','B','worker',[10,8],7),
    unit('B_w4','B','worker',[12,12],20),    // in range (cheb 2) but 4th priority
    unit('B_w5','B','worker',[15,10],20),    // out of range
  ];
  const { state, log } = Engine.halfTurn(s, 'A', { ...EMPTY, fire_policy: { triangle: { mode:'focus' } } });
  assertEq(log.combatEvents, [
    { attacker:'A_t1', target:'B_w2', dmg:4 },
    { attacker:'A_t1', target:'B_w3', dmg:4 },
    { attacker:'A_t1', target:'B_w1', dmg:4 },
  ]);
  assertEq(byId(state,'B_w4').hp, 20, '4th-priority enemy untouched');
  assertEq(byId(state,'B_w5').hp, 20);
});

test('triangle focus with explicit in-range target: target + 2 lowest-HP auto-fills', () => {
  const s = mk();
  s.units = [
    unit('A_t1','A','triangle',[10,10],16),
    unit('B_w1','B','worker',[9,10],15),
    unit('B_w2','B','worker',[11,10],7),
    unit('B_w3','B','worker',[10,8],7),
    unit('B_w4','B','worker',[12,12],20),    // explicit target, worst priority
  ];
  const { state, log } = Engine.halfTurn(s, 'A', { ...EMPTY, fire_policy: { triangle: { mode:'focus', target:'B_w4' } } });
  assertEq(log.combatEvents, [
    { attacker:'A_t1', target:'B_w4', dmg:4 },  // explicit target leads
    { attacker:'A_t1', target:'B_w2', dmg:4 },  // then lowest HP, id-tiebroken
    { attacker:'A_t1', target:'B_w3', dmg:4 },
  ]);
  assertEq(byId(state,'B_w1').hp, 15, 'slot 4 never fires');
});

test('triangle focus with explicit OUT-of-range target: zero attacks (strict)', () => {
  const s = mk();
  s.units = [
    unit('A_t1','A','triangle',[10,10],16),
    unit('B_w2','B','worker',[11,10],7),     // in range, would be free kills
    unit('B_w3','B','worker',[10,8],7),
    unit('B_w5','B','worker',[15,10],20),    // named target, cheb 5
  ];
  const { state, log } = Engine.halfTurn(s, 'A', { ...EMPTY, fire_policy: { triangle: { mode:'focus', target:'B_w5' } } });
  assertEq(log.combatEvents, []);
  assertEq(byId(state,'B_w2').hp, 7);
  assertEq(byId(state,'B_w3').hp, 7);
});

test('fire policy persists: passive side keeps its last declaration', () => {
  // A declares focus on an id that will never be in range; on B's half A is
  // passive and must still hold fire (persisted policy), not fall back to spread.
  const s = mk();
  s.units = [
    unit('A_v1','A','vehicle',[10,10],60),
    unit('B_w1','B','worker',[10,11],20),
    unit('B_t9','B','triangle',[0,13],16),
  ];
  const r1 = Engine.halfTurn(s, 'A', { ...EMPTY, fire_policy: { vehicle: { mode:'focus', target:'B_t9' } } });
  assertEq(r1.state.firePolicies.A, { vehicle: { mode:'focus', target:'B_t9' } });
  const r2 = Engine.halfTurn(r1.state, 'B', EMPTY);
  assertEq(r2.log.combatEvents.filter(e => e.attacker === 'A_v1'), [], 'passive A vehicle held focus');
  assertEq(byId(r2.state,'B_w1').hp, 20);
});

test('both sides + both cores fire simultaneously on every half-turn', () => {
  // B's unit attacks during A's half-turn even though B is passive.
  const s = mk();
  s.units = [unit('A_v1','A','vehicle',[10,10],60), unit('B_v1','B','vehicle',[10,11],60)];
  const { state, log } = Engine.halfTurn(s, 'A', EMPTY);
  assertEq(byId(state,'A_v1').hp, 50, 'passive B vehicle hit A');
  assertEq(byId(state,'B_v1').hp, 50);
  assertEq(log.combatEvents.length, 2);
});

test('simultaneous damage from pre-phase HP: mutual kill possible', () => {
  const s = mk();
  s.units = [unit('A_v1','A','vehicle',[10,10],5), unit('B_v1','B','vehicle',[10,11],5)];
  const { state, log } = Engine.halfTurn(s, 'A', EMPTY);
  assertEq(state.units, [], 'both died');
  assertEq(log.deaths.sort(), ['A_v1','B_v1']);
  assertEq(log.combatEvents.length, 2, 'both attacks landed despite both dying');
});

test('focus target dying to someone else same phase still absorbs every attack', () => {
  const s = mk();
  s.units = [
    unit('A_v1','A','vehicle',[10,9],60),
    unit('A_v2','A','vehicle',[10,11],60),
    unit('B_t1','B','triangle',[10,10],2), // dies to either hit
  ];
  const { log } = Engine.halfTurn(s, 'A', { ...EMPTY, fire_policy: { vehicle: { mode:'focus', target:'B_t1' } } });
  const hits = log.combatEvents.filter(e => e.target === 'B_t1');
  assertEq(hits.length, 2, 'overkill attack still logged (simultaneity)');
  assertEq(log.deaths, ['B_t1'], 'dies exactly once');
});

test('core hits every enemy unit in range for 5; own units untouched', () => {
  const s = mk();
  s.units = [
    unit('A_w1','A','worker',[20,12],20),  // cheb 2 from core B - hit
    unit('A_w2','A','worker',[22,10],20),  // cheb 2 - hit
    unit('A_w3','A','worker',[19,12],20),  // cheb 3 - safe
    unit('B_w1','B','worker',[21,12],20),  // B's own, adjacent - safe from own core
  ];
  const { state, log } = Engine.halfTurn(s, 'A', EMPTY);
  assertEq(byId(state,'A_w1').hp, 15);
  assertEq(byId(state,'A_w2').hp, 15);
  assertEq(byId(state,'A_w3').hp, 20);
  assertEq(byId(state,'B_w1').hp, 20);
  assertEq(log.combatEvents.filter(e => e.attacker === 'B_core').length, 2);
});

test('mid-build worker dying loses the build', () => {
  let s = mk();
  s.units = [unit('A_w1','A','worker',[21,12],5,{ produces:'vehicle', completesTurn: 3 })]; // adjacent to core B, dies to 5 dmg
  s = Engine.halfTurn(s, 'A', EMPTY).state;
  assertEq(s.units.filter(u => u.id === 'A_w1'), [], 'worker dead');
  while (!s.result && s.turn < 7) s = idle(s);
  assert(byId(s, 'A_v1') === null, 'no vehicle ever completes');
});

// ═══ stagnation ═════════════════════════════════════════════════════════════
test('stagnation: full no-combat turn past 20 bleeds BOTH cores 20', () => {
  const s = mk({ turn: 21, half: 'A' });
  const rA = Engine.halfTurn(s, 'A', EMPTY);          // first mover: turn not complete
  assertEq(rA.state.cores.A.hp, 200);
  assertEq(rA.log.coreDamage, []);
  const rB = Engine.halfTurn(rA.state, 'B', EMPTY);   // turn 21 completes: bleed
  assertEq(rB.state.cores.A.hp, 180);
  assertEq(rB.state.cores.B.hp, 180);
  assertEq(rB.log.coreDamage, [
    { core:'A', dmg:20, from:'stagnation' },
    { core:'B', dmg:20, from:'stagnation' },
  ]);
  assertEq(rB.state.result, null);
  assertEq(rB.state.turn, 22);
});

test('stagnation: any combat during the turn prevents the bleed', () => {
  const s = mk({ turn: 21, half: 'A' });
  s.units = [unit('A_v1','A','vehicle',[10,10],60), unit('B_w1','B','worker',[10,11],20)];
  const rA = Engine.halfTurn(s, 'A', EMPTY);
  assert(rA.log.combatEvents.length > 0, 'combat happened this turn');
  assertEq(rA.state.lastAggroTurn, 21);
  const rB = Engine.halfTurn(rA.state, 'B', EMPTY);
  assertEq(rB.state.cores.A.hp, 200);
  assertEq(rB.state.cores.B.hp, 200);
  assertEq(rB.log.coreDamage, []);
});

test('stagnation never fires on or before turn 20', () => {
  const s = mk({ turn: 20, half: 'B' });   // B first on even turns
  const r1 = Engine.halfTurn(s, 'B', EMPTY);
  const r2 = Engine.halfTurn(r1.state, 'A', EMPTY);   // turn 20 completes: no bleed
  assertEq(r2.state.cores.A.hp, 200);
  assertEq(r2.state.cores.B.hp, 200);
  assertEq(r2.log.coreDamage, []);
  assertEq(r2.state.turn, 21);
});

test('stagnation double-kill resolves via the mutual-kill tiebreak chain', () => {
  // raw core HP splits it: A raw -5 > B raw -10
  let s = mk({ turn: 25, half: 'A' });
  s.cores.A.hp = 15; s.cores.B.hp = 10;
  s = Engine.halfTurn(s, 'A', EMPTY).state;
  const r1 = Engine.halfTurn(s, 'B', EMPTY);
  assertEq(r1.state.result, { winner:'A', reason:'core_hp', finalTurn: 25 });
  assertEq(r1.state.cores.A.hp, 0); assertEq(r1.state.cores.B.hp, 0);
  // equal raw -> total remaining unit HP breaks the tie
  let s2 = mk({ turn: 25, half: 'A' });
  s2.cores.A.hp = 10; s2.cores.B.hp = 10;
  s2.units = s2.units.filter(u => u.id !== 'B_w2');   // A keeps more unit HP
  s2 = Engine.halfTurn(s2, 'A', EMPTY).state;
  const r2 = Engine.halfTurn(s2, 'B', EMPTY);
  assertEq(r2.state.result, { winner:'A', reason:'unit_hp', finalTurn: 25 });
  // everything tied -> draw
  let s3 = mk({ turn: 25, half: 'A' });
  s3.cores.A.hp = 10; s3.cores.B.hp = 10;
  s3 = Engine.halfTurn(s3, 'A', EMPTY).state;
  const r3 = Engine.halfTurn(s3, 'B', EMPTY);
  assertEq(r3.state.result, { winner:'draw', reason:'draw', finalTurn: 25 });
});

// ═══ datacenter meltdown (turns 30-40, unconditional) ═══════════════════════
test('meltdown: bleeds BOTH cores 20 every turn from turn 30, even WITH combat', () => {
  // lastAggroTurn=30 marks combat this turn; unlike the coward tax, meltdown fires anyway.
  const s = mk({ turn: 30, half: 'A', lastAggroTurn: 30 });   // even turn -> A completes
  s.cores.A.hp = 150; s.cores.B.hp = 150;
  const { state, log } = Engine.halfTurn(s, 'A', EMPTY);
  assertEq(state.cores.A.hp, 130); assertEq(state.cores.B.hp, 130);
  assertEq(log.coreDamage, [{ core:'A', dmg:20, from:'meltdown' }, { core:'B', dmg:20, from:'meltdown' }]);
  assertEq(state.result, null);   // both survive this tick
});

test('meltdown: single-core burnout ends immediately as core_destroyed', () => {
  const s = mk({ turn: 34, half: 'A' });   // even turn -> B first, A completes
  s.cores.A.hp = 100; s.cores.B.hp = 15;
  const { state } = Engine.halfTurn(s, 'A', EMPTY);
  assertEq(state.result, { winner:'A', reason:'core_destroyed', finalTurn: 34 });
  assertEq(state.cores.A.hp, 80); assertEq(state.cores.B.hp, 0);
});

test('meltdown: equal-HP burnout with equal units resolves as a DRAW (the tie path)', () => {
  const s = mk({ turn: 38, half: 'A' });   // even turn -> A completes; 38 not %4, no core spawn
  s.cores.A.hp = 20; s.cores.B.hp = 20;    // both cross zero on the same meltdown tick
  const { state } = Engine.halfTurn(s, 'A', EMPTY);
  assertEq(state.cores.A.hp, 0); assertEq(state.cores.B.hp, 0);
  assertEq(state.result, { winner:'draw', reason:'draw', finalTurn: 38 });
});

test('meltdown: equal-HP burnout, unequal units -> unit-HP tiebreak (not arbitrary)', () => {
  const s = mk({ turn: 34, half: 'A' });   // 34 not %4, no core spawn to skew unit HP
  s.cores.A.hp = 20; s.cores.B.hp = 20;
  s.units = s.units.filter(u => u.id !== 'B_w2');   // A keeps more unit HP
  const { state } = Engine.halfTurn(s, 'A', EMPTY);
  assertEq(state.result, { winner:'A', reason:'unit_hp', finalTurn: 34 });
});

test('meltdown does not fire before turn 30 (coward tax owns 21-29)', () => {
  const s = mk({ turn: 29, half: 'B', lastAggroTurn: 29 });   // odd turn -> B completes; combat -> no coward tax
  s.cores.A.hp = 150; s.cores.B.hp = 150;
  const { state, log } = Engine.halfTurn(s, 'B', EMPTY);
  assertEq(state.cores.A.hp, 150); assertEq(state.cores.B.hp, 150);   // no bleed at all
  assertEq(log.coreDamage, []);
});

// ═══ win conditions ═════════════════════════════════════════════════════════
test('win by core kill ends the match immediately', () => {
  const s = mk();
  s.cores.B.hp = 8;
  s.units = [unit('A_v1','A','vehicle',[21,12],60)]; // atk 10 adjacent to core B
  const { state } = Engine.halfTurn(s, 'A', EMPTY);
  assertEq(state.cores.B.hp, 0);
  assertEq(state.result, { winner:'A', reason:'core_destroyed', finalTurn: 1 });
});

test('simultaneous mutual core kill: higher core HP% at that instant wins', () => {
  const s = mk();
  s.cores.A.hp = 5; s.cores.B.hp = 1;
  s.units = [
    unit('A_v1','A','vehicle',[21,12],60), // kills core B: 1-10 = -9
    unit('B_v1','B','vehicle',[2,1],60),   // kills core A: 5-10 = -5
  ];
  const { state } = Engine.halfTurn(s, 'A', EMPTY);
  assertEq(state.cores.A.hp, 0); assertEq(state.cores.B.hp, 0);
  assertEq(state.result, { winner:'A', reason:'core_hp', finalTurn: 1 }); // -5 > -9
});

test('mutual core kill, equal HP%: total remaining unit HP breaks the tie', () => {
  const s = mk();
  s.cores.A.hp = 8; s.cores.B.hp = 8;
  s.units = [
    unit('A_v1','A','vehicle',[21,12],60),
    unit('B_v1','B','vehicle',[2,1],60),
    unit('A_w9','A','worker',[10,5],20), // extra A hp, out of all danger
  ];
  const { state } = Engine.halfTurn(s, 'A', EMPTY);
  assertEq(state.result, { winner:'A', reason:'unit_hp', finalTurn: 1 });
});

test('mutual core kill, everything tied: draw', () => {
  const s = mk();
  s.cores.A.hp = 8; s.cores.B.hp = 8;
  s.units = [
    unit('A_v1','A','vehicle',[21,12],60),
    unit('B_v1','B','vehicle',[2,1],60),
  ];
  const { state } = Engine.halfTurn(s, 'A', EMPTY);
  assertEq(state.result, { winner:'draw', reason:'draw', finalTurn: 1 });
});

test('turn limit: core HP% tiebreak after both halves of turn 40', () => {
  // turn 40 is even -> B first, A second; state below is mid-turn-40, A's half left.
  // cores set high enough to survive the turn-40 meltdown tick (-20 each), so the
  // pure time-limit HP% path resolves it.
  const s = mk({ turn: 40, half: 'A', lastAggroTurn: 40 });
  s.cores.A.hp = 150; s.cores.B.hp = 100;
  const { state } = Engine.halfTurn(s, 'A', EMPTY);
  assertEq(state.result, { winner:'A', reason:'core_hp', finalTurn: 40 });  // 130 vs 80 after meltdown
});

test('turn limit: equal core HP -> unit HP tiebreak', () => {
  // run BOTH halves of turn 40 so the turn-40 core spawn (40 %4==0) is symmetric;
  // A starts down one worker and stays down after both sides mint.
  const s = mk({ turn: 40, half: 'B', lastAggroTurn: 40 });
  s.units = s.units.filter(u => u.id !== 'A_w2'); // A loses 20 unit hp
  const mid = Engine.halfTurn(s, 'B', EMPTY).state;
  const { state } = Engine.halfTurn(mid, 'A', EMPTY);   // both cores 200->180, equal
  assertEq(state.result, { winner:'B', reason:'unit_hp', finalTurn: 40 });
});

test('turn limit: everything tied -> draw', () => {
  const s = mk({ turn: 40, half: 'B', lastAggroTurn: 40 });
  const mid = Engine.halfTurn(s, 'B', EMPTY).state;
  const { state } = Engine.halfTurn(mid, 'A', EMPTY);   // both cores 200->180, symmetric spawns
  assertEq(state.result, { winner:'draw', reason:'draw', finalTurn: 40 });
});

test('no premature end: first half of the final turn never times out', () => {
  const s = mk({ turn: 40, half: 'B' }); // B is FIRST mover on even turns
  const { state } = Engine.halfTurn(s, 'B', EMPTY);
  assertEq(state.result, null, 'first half of turn 40 must not end the match');
  assertEq(state.turn, 40); assertEq(state.half, 'A');
});

// ═══ turn/half advancement ══════════════════════════════════════════════════
test('alternating first mover: A on odd turns, B on even turns', () => {
  let s = mk();
  const seq = [];
  for (let i = 0; i < 8; i++){ seq.push(s.turn + s.half); s = idle(s); }
  assertEq(seq, ['1A','1B','2B','2A','3A','3B','4B','4A']);
  assertEq(s.turn, 5); assertEq(s.half, 'A');
});

test('smoke: full idle match ends in a symmetric draw as the datacenter melts', () => {
  let s = mk();
  let halves = 0;
  while (!s.result){
    s = idle(s);
    halves++;
    assert(halves <= 60, 'match must end within 60 half-turns');
  }
  assertEq(halves, 60);
  // coward tax bleeds both cores 20 on turns 21..29 (180), then the turn-30
  // meltdown tick takes the last 20 -> both hit 0 on turn 30, symmetric draw
  assertEq(s.result, { winner:'draw', reason:'draw', finalTurn: 30 });
  assertEq(s.cores.A.hp, 0); assertEq(s.cores.B.hp, 0);
  // 2 starters + core spawns on turns 4,8,...,28 (7 each side)
  assertEq(s.units.filter(u => u.side === 'A').length, 9);
  assertEq(s.units.filter(u => u.side === 'B').length, 9);
});

// ═══ Validate.sanitizeOrders ════════════════════════════════════════════════
test('sanitize: wholly unparseable -> malformed no-op', () => {
  const s = mk();
  for (const raw of ['total garbage', '', null, undefined, 42, [], '}{', '"just a string"']){
    const r = Validate.sanitizeOrders(raw, s, 'A');
    assertEq(r, { orders: [], builds: [], fire_policy: {}, note: null, parseStatus: 'malformed' }, 'raw=' + JSON.stringify(raw));
  }
  // and the engine treats it as a no-op half-turn
  const r = Engine.halfTurn(s, 'A', Validate.sanitizeOrders('garbage', s, 'A'));
  assertEq(r.log.parseStatus, 'malformed');
  assertEq(r.log.ordersApplied, []); assertEq(r.log.buildsStarted, []);
});

test('sanitize: markdown fences + prose stripped, first {...} extracted', () => {
  const s = mk();
  const raw = 'Sure! Here are my orders:\n```json\n{"orders":[{"unit":"A_w1","target":[3,3]}],"note":"hi {brace} inside"}\n```\nGood luck!';
  const r = Validate.sanitizeOrders(raw, s, 'A');
  assertEq(r.parseStatus, 'ok');
  assertEq(r.orders, [{ unit:'A_w1', target:[3,3] }]);
  assertEq(r.note, 'hi {brace} inside');
});

test('sanitize: per-field salvage keeps valid orders, drops broken ones', () => {
  const s = mk();
  s.units = [
    unit('A_w1','A','worker',[3,2],20),
    unit('A_v1','A','vehicle',[5,5],60),
    unit('B_w1','B','worker',[20,11],20),
  ];
  const raw = {
    orders: [
      { unit: 'A_v1', target: [6,6] },        // valid
      { unit: 'B_w1', target: [4,4] },        // enemy unit -> dropped
      { unit: 'A_x9', target: [4,4] },        // nonexistent/dead -> dropped
      { unit: 'A_v1', target: [1,1] },        // duplicate -> first wins
      { unit: 'A_w1', target: 'north' },      // broken target -> dropped
      { unit: 'A_w1', target: [99, -7.4] },   // clamped to grid ints
      'nonsense',
      { target: [1,1] },
    ],
    builds: [
      { worker: 'A_w1', produces: 'worker' },   // workers not buildable -> dropped
      { worker: 'A_v1', produces: 'triangle' }, // not a worker -> dropped
      { worker: 'A_w1', produces: 'triangle' }, // valid
      { worker: 'A_w1', produces: 'vehicle' },  // duplicate worker -> first wins
    ],
    fire_policy: {
      vehicle: { mode: 'focus', target: 'B_w1' },
      triangle: { mode: 'lazer' },              // invalid mode -> dropped
      worker: { mode: 'spread' },
      dragon: { mode: 'focus' },                // unknown class -> dropped
    },
    note: 12345,                                // non-string -> null
  };
  const r = Validate.sanitizeOrders(raw, s, 'A');
  assertEq(r.parseStatus, 'ok');
  assertEq(r.orders, [{ unit:'A_v1', target:[6,6] }, { unit:'A_w1', target:[23,0] }]);
  assertEq(r.builds, [{ worker:'A_w1', produces:'triangle' }]);
  assertEq(r.fire_policy, { worker:{ mode:'spread' }, vehicle:{ mode:'focus', target:'B_w1' } });
  assertEq(r.note, null);
});

test('sanitize: busy (mid-build) worker build rejected', () => {
  const s = mk();
  s.units = [unit('A_w1','A','worker',[3,2],20,{ produces:'vehicle', completesTurn: 8 })];
  const r = Validate.sanitizeOrders({ builds: [{ worker:'A_w1', produces:'triangle' }] }, s, 'A');
  assertEq(r.builds, []);
  assertEq(r.parseStatus, 'ok', 'still a valid (empty) turn, not malformed');
});

test('sanitize: focus without target survives; focus target kept as opaque string', () => {
  const s = mk();
  const r = Validate.sanitizeOrders({ fire_policy: { triangle: { mode:'focus' }, vehicle: { mode:'focus', target:'B_t99' } } }, s, 'A');
  assertEq(r.fire_policy, { vehicle:{ mode:'focus', target:'B_t99' }, triangle:{ mode:'focus' } });
});

// ═══ Validate.sanitizeStance ════════════════════════════════════════════════
test('sanitizeStance: object, string, and garbage inputs', () => {
  assertEq(Validate.sanitizeStance({ worker:'defense', vehicle:'attack', triangle:'default' }),
           { worker:'defense', vehicle:'attack', triangle:'default' });
  assertEq(Validate.sanitizeStance({ worker:'DEFENSE', vehicle:7, extra:'x' }),
           { worker:'default', vehicle:'default', triangle:'default' });
  assertEq(Validate.sanitizeStance('```json\n{"worker":"attack"}\n```'),
           { worker:'attack', vehicle:'default', triangle:'default' });
  assertEq(Validate.sanitizeStance('nope'),
           { worker:'default', vehicle:'default', triangle:'default' });
  assertEq(Validate.sanitizeStance(null),
           { worker:'default', vehicle:'default', triangle:'default' });
});

// ═══ log shape ══════════════════════════════════════════════════════════════
test('TurnLog carries all contract fields + detached resultingState snapshot', () => {
  const s = mk();
  const { state, log } = Engine.halfTurn(s, 'A', { ...EMPTY, note: 'opening' });
  for (const k of ['turn','activePlayer','parseStatus','note','ordersApplied','buildsStarted','buildsCompleted','coreSpawns','combatEvents','deaths','coreDamage','resultingState']){
    assert(k in log, 'missing log field ' + k);
  }
  assertEq(log.turn, 1); assertEq(log.activePlayer, 'A');
  assertEq(log.parseStatus, 'ok'); assertEq(log.note, 'opening');
  assertEq(JSON.stringify(log.resultingState), JSON.stringify(state));
  assert(log.resultingState !== state, 'snapshot must be detached from live state');
});

// ── report ──────────────────────────────────────────────────────────────────
if (failures.length){
  console.error('FAIL: ' + failures.length + ' of ' + (passed + failures.length) + ' tests');
  for (const f of failures){
    console.error('\n✗ ' + f.name + '\n  ' + f.msg.replace(/\n/g, '\n  '));
  }
  process.exit(1);
} else {
  console.log('PASS: ' + passed + ' tests');
  process.exit(0);
}
