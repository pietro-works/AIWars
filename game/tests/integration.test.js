/* AI WARS — integration test: full deterministic bot-vs-bot match driven the
   same way ui.js drives it (turnPayload -> Bots.orders -> sanitizeOrders ->
   halfTurn -> Replay.push), then replay export/import round-trip.
   Run: node game/tests/integration.test.js   (exit 0 = pass)                */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = p => path.join(__dirname, '..', 'js', p);
['engine.js', 'validate.js', 'bots.js', 'replay.js'].forEach(f =>
  vm.runInThisContext(fs.readFileSync(JS(f), 'utf8'), { filename: f }));
const NS = globalThis.AIWARS;

let failures = 0;
function ok(cond, name) {
  if (cond) { console.log('  ok  ' + name); }
  else { failures++; console.error('FAIL  ' + name); }
}

/* ---- drive a full match exactly like ui.js does ---- */
const stances = { A: NS.Bots.stance(11), B: NS.Bots.stance(22) };
let state = NS.Engine.createMatch({ stances });
const replay = NS.Replay.create({
  players: {
    A: { kind: 'bot', model: null, label: 'BOT A' },
    B: { kind: 'bot', model: null, label: 'BOT B' },
  },
});
replay.stanceDeclarations = JSON.parse(JSON.stringify(stances));

const flags = { combat: false, builtA: false, builtB: false };
let halves = 0;
const MAX_HALVES = NS.CONST.TURN_LIMIT * 2 + 4;

while (!state.result && halves < MAX_HALVES) {
  const side = state.half;
  const payload = NS.Engine.turnPayload(state, side);
  const seed = (side === 'A' ? 1000 : 2000) + state.turn;
  const raw = NS.Bots.orders(payload, seed);
  const sanitized = NS.Validate.sanitizeOrders(raw, state, side);
  const r = NS.Engine.halfTurn(state, side, sanitized);
  state = r.state;
  const log = r.log;
  NS.Replay.push(replay, log);

  ok(log.turn >= 1 && (log.activePlayer === 'A' || log.activePlayer === 'B'), 'log basics t' + log.turn + side) || 0;
  for (const k of ['parseStatus', 'ordersApplied', 'buildsStarted', 'buildsCompleted', 'combatEvents', 'deaths', 'coreDamage', 'resultingState'])
    if (!(k in log)) { failures++; console.error('FAIL  TurnLog missing field ' + k); }
  if (log.combatEvents.length) flags.combat = true;
  log.buildsCompleted.forEach(b => {
    const s = String(b.unitId || '').charAt(0);
    if (s === 'A') flags.builtA = true;
    if (s === 'B') flags.builtB = true;
  });
  halves++;
}

ok(!!state.result, 'match reached a result in ' + halves + ' half-turns (limit ' + MAX_HALVES + ')');
ok(['A', 'B', 'draw'].includes(state.result && state.result.winner), 'winner valid: ' + JSON.stringify(state.result));
ok(flags.combat, 'at least one combat event occurred');
ok(flags.builtA && flags.builtB, 'both sides completed at least one combat unit build');

/* determinism: rerun and compare results */
{
  let s2 = NS.Engine.createMatch({ stances: { A: NS.Bots.stance(11), B: NS.Bots.stance(22) } });
  let h = 0;
  while (!s2.result && h < MAX_HALVES) {
    const side = s2.half;
    const raw = NS.Bots.orders(NS.Engine.turnPayload(s2, side), (side === 'A' ? 1000 : 2000) + s2.turn);
    s2 = NS.Engine.halfTurn(s2, side, NS.Validate.sanitizeOrders(raw, s2, side)).state;
    h++;
  }
  ok(JSON.stringify(s2.result) === JSON.stringify(state.result), 'deterministic rerun -> identical result');
}

/* ---- replay round-trip ---- */
NS.Replay.finish(replay, state.result);
const json = NS.Replay.exportJSON(replay);
const back = NS.Replay.importJSON(json);
// compare against the ORIGINAL replay, not against a re-parse of the same
// string — the latter can only fail if importJSON throws, so it never catches
// a field that exportJSON silently drops.
ok(JSON.stringify(back) === JSON.stringify(replay), 'export -> import round-trips deep-equal');
ok(back.turns.length === replay.turns.length, 'turn count preserved: ' + back.turns.length);
ok(back.result && back.result.winner === state.result.winner, 'result preserved');

/* ---- fixture used by the replay viewer / renderer dev ----
   matchId/timestamp are freshly stamped per run, so an unconditional write
   dirties git on every test run; regenerate only on explicit request:
   node game/tests/integration.test.js --record                             */
if (process.argv.includes('--record')) {
  const fixDir = path.join(__dirname, '..', 'fixtures');
  fs.mkdirSync(fixDir, { recursive: true });
  fs.writeFileSync(path.join(fixDir, 'sample-match.json'), json);
  console.log('fixture written: fixtures/sample-match.json (' + (json.length / 1024).toFixed(0) + ' KB, ' + replay.turns.length + ' half-turns)');
}

if (failures) { console.error(failures + ' FAILURES'); process.exit(1); }
console.log('PASS: integration');
