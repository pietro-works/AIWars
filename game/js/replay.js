// AI WARS — replay.js — AIWARS.Replay (CONTRACTS §5, masterplan §14)
// The replay JSON is the full contract between sim and renderer.
(function(g){
  const NS = g.AIWARS = g.AIWARS || {};

  // PACS0020 — bump on any resultingState leaf-schema change; importJSON checks only this string + container existence — AGENTS.md
  const SPEC_VERSION = '1.0';
  // PACS0019 — every provider kind ui.js produces must be here or normPlayer silently coerces it to "bot" — AGENTS.md
  const KINDS = ['llm', 'bot', 'human', 'ollama', 'openai', 'webtab'];

  function uuid4(){
    // crypto when present, Math.random fallback (ids need uniqueness, not security)
    if (g.crypto && typeof g.crypto.randomUUID === 'function') return g.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c){
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function normPlayer(p){
    p = p || {};
    return {
      kind:  KINDS.indexOf(p.kind) >= 0 ? p.kind : 'bot',
      model: (typeof p.model === 'string') ? p.model : null,
      label: (typeof p.label === 'string') ? p.label : ''
    };
  }

  // create(meta) -> fresh replay object. Everything in meta is optional;
  // sane 24x14 defaults fill the gaps.
  function create(meta){
    meta = meta || {};
    const players = meta.players || {};
    return {
      meta: {
        specVersion: SPEC_VERSION,
        matchId:   (typeof meta.matchId === 'string' && meta.matchId) ? meta.matchId : uuid4(),
        timestamp: (typeof meta.timestamp === 'string' && meta.timestamp) ? meta.timestamp : new Date().toISOString(),
        gridSize:  meta.gridSize || { w: 24, h: 14 },
        cores:     meta.cores || { A: [1, 1], B: [22, 12] },
        players:   { A: normPlayer(players.A), B: normPlayer(players.B) },
        turnLimit: (typeof meta.turnLimit === 'number') ? meta.turnLimit : 40
      },
      stanceDeclarations: (meta.stanceDeclarations && typeof meta.stanceDeclarations === 'object')
        ? meta.stanceDeclarations : {},
      turns: [],
      result: null
    };
  }

  function push(replay, turnLog){
    if (!replay || !Array.isArray(replay.turns)) throw new Error('Replay.push: not a replay object (missing turns array)');
    if (!turnLog || typeof turnLog !== 'object') throw new Error('Replay.push: turnLog must be an object');
    replay.turns.push(turnLog);
    return replay;
  }

  function finish(replay, result){
    if (!replay || !Array.isArray(replay.turns)) throw new Error('Replay.finish: not a replay object (missing turns array)');
    replay.result = result || null;
    return replay;
  }

  function exportJSON(replay){
    if (!replay || typeof replay !== 'object') throw new Error('Replay.exportJSON: not a replay object');
    return JSON.stringify(replay, null, 2);
  }

  // ---- import validation -------------------------------------------------
  function fail(msg){ throw new Error('Replay import failed: ' + msg); }

  function checkPos(p, what){
    if (!Array.isArray(p) || p.length !== 2 ||
        typeof p[0] !== 'number' || typeof p[1] !== 'number') fail(what + ' must be a [x,y] number pair');
  }

  function importJSON(str){
    if (typeof str !== 'string') fail('expected a JSON string, got ' + typeof str);
    let obj;
    try { obj = JSON.parse(str); }
    catch (e){ fail('not valid JSON (' + e.message + ')'); }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail('top level must be an object');

    const meta = obj.meta;
    if (!meta || typeof meta !== 'object') fail('missing "meta" object');
    if (meta.specVersion !== SPEC_VERSION){
      fail('unsupported specVersion "' + meta.specVersion + '" (expected "' + SPEC_VERSION + '")');
    }
    if (typeof meta.matchId !== 'string' || !meta.matchId) fail('meta.matchId must be a non-empty string');
    if (typeof meta.timestamp !== 'string') fail('meta.timestamp must be a string');
    if (!meta.gridSize || typeof meta.gridSize.w !== 'number' || typeof meta.gridSize.h !== 'number'){
      fail('meta.gridSize must be {w:number, h:number}');
    }
    if (!meta.cores || typeof meta.cores !== 'object') fail('missing meta.cores');
    checkPos(meta.cores.A, 'meta.cores.A');
    checkPos(meta.cores.B, 'meta.cores.B');
    if (!meta.players || typeof meta.players !== 'object') fail('missing meta.players');
    for (const side of ['A', 'B']){
      const p = meta.players[side];
      if (!p || typeof p !== 'object') fail('missing meta.players.' + side);
      if (KINDS.indexOf(p.kind) < 0){
        fail('meta.players.' + side + '.kind must be one of ' + KINDS.join('|') + ', got "' + p.kind + '"');
      }
    }
    if (typeof meta.turnLimit !== 'number' || meta.turnLimit <= 0) fail('meta.turnLimit must be a positive number');

    if (obj.stanceDeclarations == null) obj.stanceDeclarations = {};
    if (typeof obj.stanceDeclarations !== 'object' || Array.isArray(obj.stanceDeclarations)){
      fail('stanceDeclarations must be an object');
    }

    if (!Array.isArray(obj.turns)) fail('"turns" must be an array');
    for (let i = 0; i < obj.turns.length; i++){
      const t = obj.turns[i];
      const at = 'turns[' + i + ']';
      if (!t || typeof t !== 'object') fail(at + ' must be an object');
      if (typeof t.turn !== 'number') fail(at + '.turn must be a number');
      if (t.activePlayer !== 'A' && t.activePlayer !== 'B') fail(at + '.activePlayer must be "A" or "B"');
      if (typeof t.parseStatus !== 'string') fail(at + '.parseStatus must be a string');
      if (!t.resultingState || typeof t.resultingState !== 'object'){
        fail(at + '.resultingState snapshot is missing (renderer cannot scrub without it)');
      }
      // The renderer + hudState deref cores.A/B and units[] every half-turn with
      // no guards; a structurally-empty snapshot must be rejected here, not crash
      // playReplay mid-run as an unhandled async throw.
      const rs = t.resultingState;
      if (!rs.cores || typeof rs.cores !== 'object' || !rs.cores.A || !rs.cores.B){
        fail(at + '.resultingState.cores must have A and B');
      }
      if (!Array.isArray(rs.units)) fail(at + '.resultingState.units must be an array');
    }

    if (obj.result != null){
      const r = obj.result;
      if (typeof r !== 'object') fail('"result" must be an object or null');
      if (r.winner !== 'A' && r.winner !== 'B' && r.winner !== 'draw'){
        fail('result.winner must be "A", "B" or "draw", got "' + r.winner + '"');
      }
      if (typeof r.reason !== 'string') fail('result.reason must be a string');
      if (typeof r.finalTurn !== 'number') fail('result.finalTurn must be a number');
    }

    return obj;
  }

  NS.Replay = {
    create: create,
    push: push,
    finish: finish,
    exportJSON: exportJSON,
    importJSON: importJSON
  };
})(typeof window !== 'undefined' ? window : globalThis);
