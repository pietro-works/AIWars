/* AI WARS — AIWARS.UI
   Owns the screens (SETUP -> MATCH -> RESULT, plus REPLAY) and the match
   loop per CONTRACTS §10: payload -> source (llm/bot/human) -> sanitize ->
   Engine.halfTurn -> Replay.push -> Render.enqueue -> await Render idle.
   Node-safe to load (no top-level DOM access); browser-only at runtime. */
(function(g){
'use strict';
const NS = g.AIWARS = g.AIWARS || {};

const KEY_LS = 'aiwars_api_key';            /* anthropic (name kept for compat) */
const KEY_LS_OPENAI = 'aiwars_openai_key';
const OPENAI_MODELS = ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'];
/* SEND/INSULT copy lives in the tone pack (uiCopy.sendLines / insultLines)
   so the round-robin cursor guarantees no early repeats */

let d = null;                                  // document (set in boot)
let cfg = null;                                // { A:{kind,model,label}, B:{...} }
let match = null;                              // { state, replay, stances }
let gen = 0;                                   // loop generation; bump to cancel
let humanCtx = null;                           // active human half-turn context
let fp = { vehicle:'spread', triangle:'spread' };   // human fire-policy toggles
let keys = { anthropic:'', openai:'' };        // in-memory only unless remembered
let sessionNonce = '';                         // fresh per startMatch; scopes webtab threads
let botRRIndex = 0;                            // bot-vs-bot doctrine round-robin cursor (persisted)
let timerIv = null;

/* ===== tiny helpers ===== */
function $(id){ return d.getElementById(id); }
function C(path, vars){
  try{ return NS.Content.get(path, vars); }catch(e){ return ''; }
}
function sfx(ev){ try{ if (NS.Audio && NS.Audio.play) NS.Audio.play(ev); }catch(e){} }
function amb(on){ try{ if (NS.Audio && NS.Audio.ambient) NS.Audio.ambient(on); }catch(e){} }
function mus(on){ try{ if (NS.Audio && NS.Audio.music) NS.Audio.music(on); }catch(e){} }
function humanSide(){ return cfg ? (cfg.A.kind==='human' ? 'A' : cfg.B.kind==='human' ? 'B' : null) : null; }
function labelOf(side){ return (cfg && cfg[side] && cfg[side].label) || ('SIDE '+side); }
function sideColor(side){ return side==='A' ? 'cyan' : 'magenta'; }
function otherSide(s){ return s==='A' ? 'B' : 'A'; }
function idle(){ return new Promise(res=>NS.Render.onIdle(res)); }
function wait(ms){ return new Promise(res=>setTimeout(res, ms)); }
function noopOrders(status){
  return { orders:[], builds:[], fire_policy:{}, note:null, parseStatus: status||'malformed' };
}

/* ===== chat terminal typewriter ===== */
const chatQ = [];
let chatBusy = false, chatIv = null, chatTo = null;
function chat(text, color){
  chatQ.push({ text:String(text||''), color: color||'lime' });
  if (!chatBusy) chatStep();
}
/* full stop: a match/replay reset must not leave an interval typing into a
   detached line or an old queue delaying the new match's first lines */
function chatReset(){
  chatQ.length = 0;
  if (chatIv){ clearInterval(chatIv); chatIv = null; }
  if (chatTo){ clearTimeout(chatTo); chatTo = null; }
  chatBusy = false;
}
function chatStep(){
  const item = chatQ.shift();
  if (!item){ chatBusy = false; return; }
  chatBusy = true;
  const box = $('chattext');
  const line = d.createElement('div');
  line.className = 'cline ' + item.color;
  box.appendChild(line);
  while (box.children.length > 60) box.removeChild(box.firstChild);
  sfx('chat');   /* per-line tick (never per letter); audio.js cooldown throttles bursts */
  /* catch-up valve: when a busy half-turn queues a backlog, stop typing
     letter-by-letter and land lines whole so the feed never lags the board */
  if (chatQ.length > 4){
    line.textContent = '> ' + item.text;
    box.scrollTop = box.scrollHeight;
    chatTo = setTimeout(chatStep, 30);
    return;
  }
  let i = 0;
  chatIv = setInterval(()=>{
    i += 2;
    line.textContent = '> ' + item.text.slice(0, i);
    box.scrollTop = box.scrollHeight;
    if (i >= item.text.length){ clearInterval(chatIv); chatIv = null; chatTo = setTimeout(chatStep, 90); }
  }, 16);
}

/* ===== HUD ===== */
function hudNames(){
  $('nameA').textContent = 'CORE A: ' + labelOf('A').toUpperCase();
  $('nameB').textContent = 'CORE B: ' + labelOf('B').toUpperCase();
}
function forceStr(state, side){
  const n = { worker:0, vehicle:0, triangle:0 };
  state.units.forEach(u=>{ if (u.side===side) n[u.type]++; });
  return n.worker+'W '+n.vehicle+'V '+n.triangle+'T';
}
function hudState(state){
  const max = NS.CONST.CORE.hp;
  ['A','B'].forEach(s=>{
    const hp = Math.max(0, state.cores[s].hp);
    $('hpfill'+s).style.width = (hp/max*100)+'%';
    $('hpnum'+s).textContent = hp+'/'+max;
  });
  $('aforce').textContent = forceStr(state,'A');
  $('bforce').textContent = forceStr(state,'B');
  $('turncounter').textContent = 'TURN '+Math.min(state.turn, NS.CONST.TURN_LIMIT)+' / '+NS.CONST.TURN_LIMIT;
  intelEcon(state);
}
let stickyNote = '';   /* survives timer ticks — for must-read instructions */
function sysnote(t){ $('sysnote').textContent = ' ' + (stickyNote ? stickyNote + ' | ' + t : t); }
function parsestat(t){ $('parsestat').textContent = t; }
/* countdown surfaces in the SYS FEED line — the layout has no dedicated
   timer element, and a 4-minute webtab wait with zero feedback reads as a hang */
function timerRun(secs, label){
  timerStop();
  let left = secs;
  const who = label || 'AWAITING ORDERS';
  const tick = ()=>{
    const s = Math.max(0, left);
    sysnote(who + ' — ' + Math.floor(s/60) + ':' + String(s%60).padStart(2,'0'));
    left--;
  };
  tick();
  timerIv = setInterval(tick, 1000);
}
function timerStop(){
  if (timerIv){ clearInterval(timerIv); timerIv = null; }
}

/* ===== turn-log narration (all copy through Content) ===== */
function narrate(log, side){
  (log.buildsStarted||[]).forEach(b=>chat(C('eventLines.buildStarted', b), sideColor(side)));
  (log.buildsCompleted||[]).forEach(b=>chat(C('eventLines.buildCompleted', { worker:b.worker, produces:b.produces, unit:b.unitId }), sideColor(side)));
  (log.coreSpawns||[]).forEach(s=>chat(C('eventLines.coreSpawn', { side:s.side, unit:s.unitId }), sideColor(s.side)));
  const coreDmg = { A:0, B:0 };
  (log.coreDamage||[]).forEach(cd=>{ if (cd && (cd.core==='A'||cd.core==='B')) coreDmg[cd.core] += cd.dmg||0; });
  ['A','B'].forEach(s=>{ if (coreDmg[s] > 0) chat(C('eventLines.coreHit', { side:s, dmg:coreDmg[s] }), 'amber'); });
  (log.deaths||[]).forEach(id=>chat(C('eventLines.unitDied', { unit:id }), 'amber'));
  if (log.note) chat(labelOf(side)+': '+log.note, sideColor(side));
  if (log.parseStatus && log.parseStatus !== 'ok')
    chat(C('eventLines.parseFailed', { label: labelOf(side) }), 'magenta');
}

/* ===== order sources ===== */
function botSanitized(state, side){
  const payload = NS.Engine.turnPayload(state, side);
  const seed = (side==='A' ? 1000 : 2000) + state.turn;
  const raw = NS.Bots.orders(payload, seed);
  return NS.Validate.sanitizeOrders(raw, state, side);
}
/* per-provider order request; all share the LLMFailure contract */
function providerOrders(kind, side, payload){
  const model = cfg[side].model;
  if (kind === 'ollama') return NS.Ollama.requestOrders({ model, payload });
  if (kind === 'openai') return NS.OpenAI.requestOrders({ apiKey: keys.openai, model, payload });
  if (kind === 'webtab') return NS.WebTab.requestOrders({ bot: model, side, sessionKey: side+':'+model+':'+sessionNonce, payload });
  return NS.LLM.requestOrders({ apiKey: keys.anthropic, model, payload });
}
function providerTimeoutMs(kind){
  if (kind === 'ollama') return 120000;
  if (kind === 'webtab') return NS.WebTab.OVERALL_TIMEOUT_MS;   // true outer bound (incl. tab boot)
  return NS.CONST.LLM_TIMEOUT_MS;
}
function providerName(kind){
  return kind==='ollama' ? 'OLLAMA' : kind==='webtab' ? 'WEB TAB' : 'API';
}
const authFails = { A:0, B:0 };   // consecutive auth-class failures per side
async function remoteSanitized(state, side){
  // circuit breaker: 2 consecutive auth failures (logged out / extension gone /
  // bad key) means every further attempt is guaranteed setup work that fails —
  // stop calling out, noop the rest of the match for this side
  if (cfg[side].disabled) return noopOrders('malformed');
  const payload = NS.Engine.turnPayload(state, side);
  const kind = cfg[side].kind;
  chat(C('eventLines.thinking', { label: labelOf(side) }), sideColor(side));
  timerRun(Math.round(providerTimeoutMs(kind)/1000), labelOf(side).toUpperCase()+' COMPUTING');
  const myGen = gen;   /* a rematch/replay load bumps gen while we await; a stale
                          settle must not touch the NEW session (timer, chat,
                          authFails, cfg.disabled) — caller discards the value */
  try{
    const r = await providerOrders(kind, side, payload);
    if (gen !== myGen) return noopOrders('timeout');
    timerStop();
    authFails[side] = 0;
    return NS.Validate.sanitizeOrders(r.raw, state, side);
  }catch(err){
    if (gen !== myGen) return noopOrders('timeout');
    timerStop();
    const k = (err && err.kind) || 'exhausted';
    if (k === 'auth' && ++authFails[side] >= 2){
      cfg[side].disabled = true;
      stickyNote = providerName(kind)+' SIDE '+side+' DISABLED — FIX LOGIN/KEY AND REMATCH';
      sysnote(side+' NO-OP');
      chat(labelOf(side)+' went dark. Provider unreachable — side plays no-ops from here.', 'magenta');
    } else {
      sysnote(k==='auth' ? providerName(kind)+' CONFIG ERROR — '+side+' NO-OP' : side+' '+providerName(kind)+' TIMEOUT — NO-OP');
    }
    return noopOrders(k==='auth' ? 'malformed' : 'timeout');
  }
}

/* ===== human half-turn (deploy menu + board clicks + END TURN) ===== */
let hintedOrders = false;   /* one-shot session flag: teach the outline colors once */
function humanTurn(state, side){
  return new Promise(resolve=>{
    humanCtx = { state, side, moves:new Map(), builds:new Map(), sel:null, card:null, resolve };
    $('endturnbtn').classList.remove('off');
    $('deploybtn').classList.add('off');
    sysnote(labelOf(side).toUpperCase()+' — MOVE / BUILD, THEN END TURN');
    if (!hintedOrders){
      hintedOrders = true;
      chat('GREEN = AWAITING ORDERS / BLUE = LOCKED / ALL BLUE -> END TURN', 'lime');
    }
    refreshOrderInfo();
  });
}
/* drop a pending human half-turn without resolving it (its loop generation
   is already stale); resets the deploy/endturn UI so a new match or replay
   doesn't inherit live board clicks */
function cancelHuman(){
  if (!humanCtx) return;
  humanCtx = null;
  $('endturnbtn').classList.add('off');
  $('deploybtn').classList.add('off');
  d.querySelectorAll('.card.sel').forEach(el=>el.classList.remove('sel'));
  NS.Render.clearHighlight();
  refreshOrderInfo();   /* clears order outlines + END TURN ready pulse */
}
function humanDone(){
  if (!humanCtx) return;
  const hc = humanCtx;
  humanCtx = null;
  $('endturnbtn').classList.add('off');
  $('deploybtn').classList.add('off');
  d.querySelectorAll('.card.sel').forEach(el=>el.classList.remove('sel'));
  NS.Render.clearHighlight();
  refreshOrderInfo();   /* outlines off before the half-turn animation plays */
  sfx('endTurn');
  const raw = {
    orders: Array.from(hc.moves, kv=>({ unit: kv[0], target: kv[1] })),
    builds: Array.from(hc.builds, kv=>({ worker: kv[0], produces: kv[1] })),
    fire_policy: { vehicle:{ mode: fp.vehicle }, triangle:{ mode: fp.triangle } },
    note: null,
  };
  hc.resolve(NS.Validate.sanitizeOrders(raw, hc.state, hc.side));
}
/* single choke point for planning-phase UI: rebuilds the order-state outline
   map, the ORDERS x/y row, the selected-unit readout, and END TURN readiness.
   Called at every humanCtx mutation; with humanCtx null it clears everything
   (so replay/bot halves can never show stale outlines). */
function refreshOrderInfo(){
  const hc = humanCtx;
  const btn = $('endturnbtn'), row = $('intelorders');
  if (!hc){
    NS.Render.setOrderStates(null);
    if (btn) btn.classList.remove('ready');
    if (row){ row.textContent = '--'; row.classList.remove('done'); }
    intelSel(null);
    return;
  }
  const map = new Map();
  let total = 0, done = 0;
  hc.state.units.forEach(u=>{
    if (u.side !== hc.side) return;
    if (u.building){ map.set(u.id, { st:'building' }); return; }   /* inert: engine ignores its moves */
    total++;
    if (hc.moves.has(u.id)){ done++; map.set(u.id, { st:'ordered', target: hc.moves.get(u.id) }); }
    else if (hc.builds.has(u.id)){ done++; map.set(u.id, { st:'ordered' }); }
    else map.set(u.id, { st:'unordered' });
  });
  NS.Render.setOrderStates(map);
  const ready = total > 0 && done >= total;
  if (btn) btn.classList.toggle('ready', ready);
  if (row){
    row.textContent = done + '/' + total;
    row.classList.toggle('done', ready);
  }
  intelSel(hc.sel);
}
/* selected-unit readout (bottom intel slot, WarCraft context-pane idiom) */
function intelSel(u){
  const el = $('intelsel');
  if (!el) return;
  if (!u){
    el.textContent = humanCtx ? 'CLICK A GREEN UNIT' : '--';
    el.classList.add('dim');
    return;
  }
  const hc = humanCtx;
  el.classList.remove('dim');
  el.textContent = '';
  const stance = (hc.state.stances && hc.state.stances[hc.side] && hc.state.stances[hc.side][u.type]) || 'default';
  const st = NS.Engine.statFor(hc.state, u);
  const l1 = d.createElement('div');
  l1.className = 'sl1 ' + sideColor(hc.side);
  l1.textContent = u.id.toUpperCase() + ' - ' + u.type.toUpperCase() + ' - ' + stance.toUpperCase();
  const l2 = d.createElement('div');
  l2.className = 'sl2';
  l2.textContent = 'HP ' + u.hp + '/' + st.hp + '  ATK ' + st.atk + '  MOV ' + st.move + '  RNG ' + st.range;
  el.appendChild(l1); el.appendChild(l2);
}
/* economy rows (mint countdown + build queue) — driven by hudState so they
   stay live in bot-vs-bot and replay/spectate modes too */
function intelEcon(state){
  const mint = $('intelmint');
  if (mint){
    const every = (NS.CONST && NS.CONST.CORE_WORKER_EVERY) || 4;
    const rem = state.turn % every === 0 ? 0 : every - (state.turn % every);
    mint.textContent = rem === 0 ? 'NOW' : rem + 'T';
    mint.classList.toggle('hot', rem <= 1);
  }
  const q = $('intelqueue');
  if (q){
    const own = humanSide();
    const rows = state.units.filter(u=>u.building && (!own || u.side === own));
    rows.sort((a,b)=>a.building.completesTurn - b.building.completesTurn);
    q.textContent = '';
    if (!rows.length){
      const el = d.createElement('div');
      el.className = 'qrow dim';
      el.textContent = own ? 'NO BUILDS - SELECT A WORKER' : 'NO ACTIVE BUILDS';
      q.appendChild(el);
    } else rows.slice(0,3).forEach(u=>{
      const left = u.building.completesTurn - state.turn;
      const el = d.createElement('div'); el.className = 'qrow';
      const id = d.createElement('span');
      id.className = u.side === 'A' ? 'cyan' : 'magenta';
      id.textContent = u.id.toUpperCase();
      const rest = d.createElement('span');
      rest.className = 'amber';
      rest.textContent = ' -> ' + String(u.building.produces).slice(0,3).toUpperCase() + ' ' + (left <= 0 ? 'NOW' : left + 'T');
      el.appendChild(id); el.appendChild(rest);
      q.appendChild(el);
    });
  }
}
function unitAt(state, side, tile){
  return state.units.find(u=>u.side===side && u.pos[0]===tile[0] && u.pos[1]===tile[1]) || null;
}
function selectUnit(u){
  const hc = humanCtx;
  hc.sel = u;
  hc.card = null;
  d.querySelectorAll('.card.sel').forEach(el=>el.classList.remove('sel'));
  $('deploybtn').classList.add('off');
  const st = NS.Engine.statFor(hc.state, u);
  const tiles = [];
  for (let dx=-st.move; dx<=st.move; dx++)
    for (let dy=-st.move; dy<=st.move; dy++){
      const x = u.pos[0]+dx, y = u.pos[1]+dy;
      if (x>=0 && x<NS.CONST.GRID.W && y>=0 && y<NS.CONST.GRID.H) tiles.push([x,y]);
    }
  NS.Render.setHighlight(tiles, hc.side.toLowerCase());
  NS.Render.setSelection(u.pos);
  sysnote(u.id.toUpperCase()+' SELECTED — CLICK DESTINATION' + (u.type==='worker' && !u.building ? ' OR PICK A BUILD CARD' : ''));
  refreshOrderInfo();   /* feeds the selected-unit readout */
  sfx('select');
}
function boardClick(ev){
  if (!humanCtx) return;
  const hc = humanCtx;
  const tile = NS.Render.tileAt(ev.clientX, ev.clientY);
  if (!tile) return;
  const own = unitAt(hc.state, hc.side, tile);
  if (own && (!hc.sel || own.id !== hc.sel.id)){ selectUnit(own); return; }
  if (hc.sel){
    if (hc.sel.building){ sysnote(hc.sel.id.toUpperCase()+' IS MID-BUILD — CANNOT MOVE'); sfx('invalid'); return; }
    hc.moves.set(hc.sel.id, tile);
    hc.builds.delete(hc.sel.id);
    chat(hc.sel.id+' -> ['+tile[0]+','+tile[1]+']', sideColor(hc.side));
    hc.sel = null; hc.card = null;
    d.querySelectorAll('.card.sel').forEach(e=>e.classList.remove('sel'));  /* clear stale DEPLOY highlight */
    $('deploybtn').classList.add('off');
    NS.Render.clearHighlight();
    refreshOrderInfo();
    sfx('orderSet');   /* commit confirm; bare 'move' stays with render's motion steps */
  }
}
function cardClick(el){
  if (humanCtx && el.classList.contains('disabled') && el.dataset.produce === 'worker'){
    sysnote('WORKERS ARE MINTED BY YOUR CORE — ONE EVERY 4 TURNS');
    sfx('invalid');
    return;
  }
  if (!humanCtx || el.classList.contains('disabled')) return;
  const hc = humanCtx;
  if (!hc.sel || hc.sel.type!=='worker' || hc.sel.building){ sysnote('SELECT AN IDLE WORKER FIRST'); sfx('invalid'); return; }
  d.querySelectorAll('.card.sel').forEach(e=>e.classList.remove('sel'));
  el.classList.add('sel');
  hc.card = el.dataset.produce;
  $('deploybtn').classList.remove('off');
  sfx('uiTick');
}
/* card hover tutor (human half only): stats + build time at the moment of
   relevance, through the existing sysnote channel */
function cardHover(el){
  if (!humanCtx) return;
  const type = el.dataset.produce;
  if (!type || type === 'worker') return;
  try{
    const hc = humanCtx;
    const stance = (hc.state.stances && hc.state.stances[hc.side] && hc.state.stances[hc.side][type]) || 'default';
    const st = NS.CONST.UNITS[type][stance];
    const bt = (NS.CONST.BUILD_TURNS && NS.CONST.BUILD_TURNS[type]) || '?';
    sysnote(type.toUpperCase()+' — HP'+st.hp+' ATK'+st.atk+' MOV'+st.move+' RNG'+st.range+' — '+bt+' TURNS');
  }catch(e){}
}
function deployClick(){
  if (!humanCtx || !humanCtx.card || !humanCtx.sel) return;
  const hc = humanCtx;
  hc.builds.set(hc.sel.id, hc.card);
  hc.moves.delete(hc.sel.id);
  chat(hc.sel.id+' BUILDS '+hc.card.toUpperCase(), sideColor(hc.side));
  hc.sel = null; hc.card = null;
  d.querySelectorAll('.card.sel').forEach(e=>e.classList.remove('sel'));
  $('deploybtn').classList.add('off');
  NS.Render.clearHighlight();
  refreshOrderInfo();
  sfx('deployQueued');   /* queue chirp; 'buildStart' fires when the engine starts it */
}

/* ===== match loop ===== */
async function runMatch(myGen){
  try {
  const rep = match.replay;
  chat(C('eventLines.matchStart', { labelA: labelOf('A'), labelB: labelOf('B') }), 'lime');
  hudState(match.state);
  let lastTurn = 0;
  while (!match.state.result && gen === myGen){
    const state = match.state, side = state.half;
    if (state.turn !== lastTurn){
      lastTurn = state.turn;
      chat(C('eventLines.turnStart', { turn: state.turn, label: labelOf(side) }), 'lime');
      sfx('turnStart');
    }
    hudState(state);
    const kind = cfg[side].kind;
    let sanitized;
    if (kind === 'human') sanitized = await humanTurn(state, side);
    else if (kind === 'bot'){ sysnote(labelOf(side)+' COMPUTING...'); await wait(250); sanitized = botSanitized(state, side); }
    else sanitized = await remoteSanitized(state, side);
    if (gen !== myGen) return;
    const r = NS.Engine.halfTurn(state, side, sanitized);
    match.state = r.state;
    NS.Replay.push(rep, r.log);
    NS.Render.enqueue(r.log);
    parsestat(side+': '+String(r.log.parseStatus||'ok').toUpperCase());
    narrate(r.log, side);
    await idle();
    if (gen !== myGen) return;
    hudState(match.state);
  }
  if (gen !== myGen || !match.state.result) return;
  NS.Replay.finish(rep, match.state.result);
  showResult(match.state.result, match.state);
  } catch (err){
    /* an uncaught throw in the loop must not strand the music/ambient scheduler
       (only showResult stops them on the happy path). Generation-aware so a
       stale run's failure never silences a match that already took over. */
    if (gen !== myGen) return;
    console.error('AI WARS: match loop aborted —', err);
    timerStop(); amb(false); mus(false);
    parsestat('ERROR');
    sysnote('MATCH ERROR — ' + String((err && err.message) || err).slice(0, 80));
  }
}

/* ===== stance resolution + match start ===== */
const KIND_PREFIXES = [['llm:','llm'], ['ollama:','ollama'], ['openai:','openai'], ['webtab:','webtab']];
function readSetupSide(side){
  const kindVal = $('kind'+side).value;
  let kind = kindVal, model = null;
  for (const [pre, k] of KIND_PREFIXES){
    if (kindVal.indexOf(pre)===0){ kind = k; model = kindVal.slice(pre.length); break; }
  }
  return {
    kind, model,
    label: ($('label'+side).value || '').trim() || (side==='A' ? 'HOT CYAN' : 'NEON MAGENTA'),
  };
}
async function resolveStance(side){
  const k = cfg[side];
  if (k.kind === 'human'){
    return NS.Validate.sanitizeStance({
      worker:   $('stance'+side+'worker').value,
      vehicle:  $('stance'+side+'vehicle').value,
      triangle: $('stance'+side+'triangle').value,
    });
  }
  if (k.kind === 'bot'){
    /* bot vs bot: HARD RULE — round-robin doctrines (Latin square, consecutive
       indices per side) so every stance sprite gets showcased across matches.
       Bot vs anything else: fresh random doctrine each match (seeded from the
       match nonce, so the replay's stanceDeclarations still tell the truth). */
    if (cfg.A.kind === 'bot' && cfg.B.kind === 'bot'){
      return NS.Bots.stanceRoundRobin(botRRIndex + (side === 'A' ? 0 : 1));
    }
    const seed = (parseInt(sessionNonce, 36) % 2147483647) + (side === 'A' ? 0 : 7919);
    return NS.Bots.stance(seed);
  }
  let r;
  if (k.kind === 'ollama')      r = await NS.Ollama.requestStance({ model: k.model, side });
  else if (k.kind === 'openai') r = await NS.OpenAI.requestStance({ apiKey: keys.openai, model: k.model, side });
  else if (k.kind === 'webtab') r = await NS.WebTab.requestStance({ bot: k.model, side, sessionKey: side+':'+k.model+':'+sessionNonce });
  else                          r = await NS.LLM.requestStance({ apiKey: keys.anthropic, model: k.model, side });
  return NS.Validate.sanitizeStance(r.parsed != null ? r.parsed : r.raw);
}
let starting = false;   // re-entrancy guard: webtab/ollama preflights are slow
async function startMatch(){
  if (starting) return false;
  starting = true;
  try { return await startMatchInner(); } finally { starting = false; }
}
async function startMatchInner(){
  const myGen = gen;   // a replay load mid-preflight bumps gen; bail after each await
  const err = $('setuperr');
  err.textContent = '';
  cfg = { A: readSetupSide('A'), B: readSetupSide('B') };
  authFails.A = 0; authFails.B = 0;   // fresh circuit breaker per match
  stickyNote = '';
  const has = k => cfg.A.kind===k || cfg.B.kind===k;
  const needsOllama = has('ollama');
  keys.anthropic = ($('apikey').value || '').trim();
  keys.openai = ($('apikeyOpenai').value || '').trim();
  if (has('llm') && !keys.anthropic){ err.textContent = 'AN ANTHROPIC API KEY IS REQUIRED FOR CLAUDE API SIDES'; return; }
  if (has('openai') && !keys.openai){ err.textContent = 'AN OPENAI API KEY IS REQUIRED FOR OPENAI SIDES'; return; }
  if (has('llm') || has('openai')){
    try{
      if ($('remember').checked){
        if (keys.anthropic) localStorage.setItem(KEY_LS, keys.anthropic);
        if (keys.openai) localStorage.setItem(KEY_LS_OPENAI, keys.openai);
      } else {
        localStorage.removeItem(KEY_LS);
        localStorage.removeItem(KEY_LS_OPENAI);
      }
    }catch(e){}
  }
  if (has('webtab')){
    if (location.protocol === 'file:'){
      err.textContent = 'WEB TABS NEED THE GAME SERVED OVER http://localhost — RUN `python3 -m http.server` IN THE PROJECT FOLDER';
      return;
    }
    $('startbtn').textContent = 'LOOKING FOR BRIDGE...';
    const up = await NS.WebTab.ping();
    if (gen !== myGen) return false;
    if (!up){
      $('startbtn').textContent = 'START MATCH';
      err.textContent = 'AI WARS BRIDGE EXTENSION NOT DETECTED — INSTALL IT (extension/ FOLDER) TO USE WEB TABS';
      return;
    }
  }
  sessionNonce = Date.now().toString(36);
  if (cfg.A.kind === 'bot' && cfg.B.kind === 'bot'){
    /* advance the doctrine round-robin exactly once per bot-vs-bot match */
    try{
      botRRIndex = (parseInt(localStorage.getItem('aiwars_bot_rr'), 10) || 0);
      localStorage.setItem('aiwars_bot_rr', String((botRRIndex + 1) % 3));
    }catch(e){ botRRIndex = (botRRIndex + 1) % 3; }
  }
  if (needsOllama){
    $('startbtn').textContent = 'WAKING OLLAMA...';
    let ollamaUp = true;
    try{ await NS.Ollama.listModels(); }
    catch(e){ ollamaUp = false; }
    if (gen !== myGen) return false;
    if (!ollamaUp){
      $('startbtn').textContent = 'START MATCH';
      err.textContent = 'OLLAMA NOT REACHABLE AT '+NS.Ollama.BASE_URL+' — IS `ollama serve` RUNNING?';
      return;
    }
    // preload each ollama model so the first real turn is not a cold 20s+ wait
    const warmed = {};
    ['A','B'].forEach(s=>{ if (cfg[s].kind==='ollama' && !warmed[cfg[s].model]){ warmed[cfg[s].model]=1; NS.Ollama.warm(cfg[s].model); } });
  }
  $('startbtn').textContent = 'DECLARING DOCTRINES...';
  let stances;
  try{
    stances = { A: await resolveStance('A'), B: await resolveStance('B') };
  }catch(e){
    $('startbtn').textContent = 'START MATCH';
    err.textContent = (e && e.kind==='auth')
      ? 'PROVIDER REJECTED THE REQUEST — CHECK KEYS / LOGIN AND RETRY ('+String(e.message||'').slice(0,80)+')'
      : 'DOCTRINE REQUEST FAILED — RETRY';
    return;
  }
  if (gen !== myGen) return false;
  $('startbtn').textContent = 'START MATCH';
  const state = NS.Engine.createMatch({ stances });
  const replay = NS.Replay.create({
    players: {
      A: { kind: cfg.A.kind, model: cfg.A.model, label: cfg.A.label },
      B: { kind: cfg.B.kind, model: cfg.B.model, label: cfg.B.label },
    },
  });
  replay.stanceDeclarations = JSON.parse(JSON.stringify(stances));
  match = { state, replay, stances };
  gen++;
  cancelHuman();
  timerStop();
  $('setup').classList.add('hidden');
  $('result').classList.add('hidden');
  chatReset();
  $('chattext').textContent = '';
  hudNames();
  parsestat('--');
  NS.Render.renderState(state);
  sfx('matchStart');   /* "systems online" power-up sweep */
  amb(true);           /* ambient bed runs for the whole match, off at result */
  mus(true);           /* in-game track rides the same lifecycle as the bed */
  runMatch(gen);
  return true;
}

/* ===== result / export / rematch ===== */
function showResult(result, state){
  timerStop();
  const winner = result.winner;
  let title, banner;
  if (winner === 'draw'){ title = 'DRAW'; banner = C('victoryBanners.draw'); }
  else {
    title = labelOf(winner).toUpperCase() + ' WINS';
    banner = C('victoryBanners.win', { label: labelOf(winner), reason: result.reason });
  }
  chat(banner, 'lime');
  ['A','B'].forEach(s=>{ if (state.cores[s].hp <= 0) chat(C('eventLines.coreDestroyed', { side:s }), 'magenta'); });
  $('restitle').textContent = title;
  $('resreason').textContent = 'REASON: '+String(result.reason).replace(/_/g,' ').toUpperCase()+' — TURN '+result.finalTurn;
  $('reshpA').textContent = labelOf('A')+' '+Math.max(0,state.cores.A.hp);
  $('reshpB').textContent = labelOf('B')+' '+Math.max(0,state.cores.B.hp);
  $('result').classList.remove('hidden');
  amb(false);
  mus(false);
  /* exactly one result sting: defeat only for a human loss, matchEnd for draws,
     victory otherwise (human win or spectated win) */
  const hs = humanSide();
  if (winner === 'draw') sfx('matchEnd');
  else if (hs && winner !== hs) sfx('defeat');
  else sfx('victory');
}
function exportReplay(){
  if (!match || !match.replay) return;
  const blob = new Blob([NS.Replay.exportJSON(match.replay)], { type:'application/json' });
  const a = d.createElement('a');
  a.href = URL.createObjectURL(blob);
  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || 'side';
  a.download = 'aiwars-'+slug(labelOf('A'))+'-vs-'+slug(labelOf('B'))+'-'
             + String(match.replay.meta.timestamp||'').slice(0,10)+'-'
             + match.replay.meta.matchId.slice(0,8)+'.json';
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href), 5000);
}

/* ===== replay viewer ===== */
async function playReplay(rep, myGen){
  try {
  cfg = {
    A: { kind: rep.meta.players.A.kind, model: rep.meta.players.A.model, label: rep.meta.players.A.label || 'SIDE A' },
    B: { kind: rep.meta.players.B.kind, model: rep.meta.players.B.model, label: rep.meta.players.B.label || 'SIDE B' },
  };
  const stances = (rep.stanceDeclarations && rep.stanceDeclarations.A) ? rep.stanceDeclarations : undefined;
  const initial = NS.Engine.createMatch({ stances });
  match = { state: initial, replay: rep, stances };
  $('setup').classList.add('hidden');
  $('result').classList.add('hidden');
  stickyNote = '';
  chatReset();
  $('chattext').textContent = '';
  hudNames();
  parsestat('REPLAY');
  NS.Render.renderState(initial);
  hudState(initial);
  chat('REPLAY // '+labelOf('A')+' VS '+labelOf('B'), 'lime');
  amb(true);   /* replays get the same bed; showResult / the no-result branch stop it */
  mus(true);   /* and the same track */
  let lastTurn = 0;
  for (const log of rep.turns){
    if (gen !== myGen) return;
    if (log.turn !== lastTurn){
      lastTurn = log.turn;
      chat(C('eventLines.turnStart', { turn: log.turn, label: labelOf(log.activePlayer||'A') }), 'lime');
      sfx('turnStart');
    }
    NS.Render.enqueue(log);
    narrate(log, log.activePlayer || 'A');
    await idle();
    if (gen !== myGen) return;
    if (log.resultingState) hudState(log.resultingState);
  }
  if (gen !== myGen) return;
  const last = rep.turns.length ? rep.turns[rep.turns.length-1].resultingState : initial;
  if (rep.result){
    showResult(rep.result, last || initial);
  } else {
    /* file with no recorded result: don't strand the user on a dead board */
    timerStop();
    amb(false);
    mus(false);
    $('restitle').textContent = 'REPLAY ENDED';
    $('resreason').textContent = 'NO RESULT RECORDED IN THIS FILE';
    /* clear the two spans, never the parent — showResult needs them later */
    $('reshpA').textContent = ''; $('reshpB').textContent = '';
    $('result').classList.remove('hidden');
  }
  } catch (err){
    /* same strand guard as runMatch: a throw over a bad replay must stop the
       music/ambient scheduler, not leave it running over a dead screen. */
    if (gen !== myGen) return;
    console.error('AI WARS: replay aborted —', err);
    timerStop(); amb(false); mus(false);
    $('restitle').textContent = 'REPLAY ERROR';
    $('resreason').textContent = String((err && err.message) || err).slice(0, 80);
    $('reshpA').textContent = ''; $('reshpB').textContent = '';
    $('result').classList.remove('hidden');
  }
}
function loadReplayFile(file){
  const rd = new FileReader();
  rd.onload = ()=>{
    try{
      const rep = NS.Replay.importJSON(String(rd.result));
      gen++;
      cancelHuman();
      timerStop();
      playReplay(rep, gen);
    }catch(e){
      $('setuperr').textContent = 'BAD REPLAY FILE: '+(e && e.message || 'unreadable');
    }
  };
  rd.onerror = ()=>{ $('setuperr').textContent = 'COULD NOT READ THAT FILE'; };
  rd.readAsText(file);
}

/* ===== setup screen wiring ===== */
async function fillSetup(){
  /* discover locally-installed Ollama models (best-effort; empty if server down) */
  let ollamaModels = [];
  try{ ollamaModels = await NS.Ollama.listModels(); }catch(e){}
  const preferOllama = ollamaModels.find(m=>/qwen/i.test(m)) || ollamaModels[0] || null;

  const kinds = [['human','HUMAN'], ['bot','SCRIPTED BOT']]
    .concat(ollamaModels.map(m=>['ollama:'+m, 'OLLAMA — '+m.toUpperCase()]))
    .concat(NS.CONST.MODELS.map(m=>['llm:'+m, 'CLAUDE API — '+m.toUpperCase()]))
    .concat(OPENAI_MODELS.map(m=>['openai:'+m, 'OPENAI API — '+m.toUpperCase()]))
    .concat(NS.WebTab.BOTS.map(b=>['webtab:'+b.id, b.label]));

  ['A','B'].forEach(side=>{
    const sel = $('kind'+side);
    sel.innerHTML = '';
    kinds.forEach(k=>{
      const o = d.createElement('option');
      o.value = k[0]; o.textContent = k[1];
      sel.appendChild(o);
    });
    /* "just hit play": if Ollama is up, default BOTH sides to it so START MATCH
       runs model-vs-model with no further setup; otherwise human vs bot. */
    sel.value = preferOllama ? ('ollama:'+preferOllama) : (side==='A' ? 'human' : 'bot');
    ['worker','vehicle','triangle'].forEach(t=>{
      const st = $('stance'+side+t);
      st.innerHTML = '';
      ['default','attack','defense'].forEach(v=>{
        const o = d.createElement('option');
        o.value = v; o.textContent = v.toUpperCase();
        st.appendChild(o);
      });
    });
    sel.addEventListener('change', setupVisibility);
  });

  /* warm the default model in the background so first turn is not a cold wait */
  if (preferOllama) NS.Ollama.warm(preferOllama);
  setupVisibility();
}
function setupVisibility(){
  let anyAnthropic = false, anyOpenai = false;
  ['A','B'].forEach(side=>{
    const v = $('kind'+side).value;
    $('stanceRow'+side).classList.toggle('hidden', v !== 'human');
    if (v.indexOf('llm:')===0) anyAnthropic = true;
    if (v.indexOf('openai:')===0) anyOpenai = true;
  });
  $('keyrow').classList.toggle('hidden', !anyAnthropic);
  $('keyrowOpenai').classList.toggle('hidden', !anyOpenai);
  $('rememberrow').classList.toggle('hidden', !anyAnthropic && !anyOpenai);
}

/* ===== intro: splash -> fade to black -> slow bg reveal -> console lands ===== */
function runIntro(){
  const splash = $('splash'), frame = $('splashframe'), veil = $('splashveil');
  const blackout = $('introblack'), stage = $('stage');
  const skip = ()=>{
    if (splash) splash.remove();
    if (blackout) blackout.remove();
    stage.classList.remove('prelanding','landing');
  };
  if (!splash || !frame || !blackout){ skip(); return; }
  /* dev escape hatch */
  if (location.search.indexOf('nosplash') !== -1){ skip(); return; }

  stage.classList.add('prelanding');
  let begun = false;
  const begin = ()=>{
    if (begun) return; begun = true;
    veil.style.opacity = '1';                                /* 1. fade splash to black */
    setTimeout(()=>{
      splash.remove();                                       /* pure black now */
      setTimeout(()=>{
        blackout.style.opacity = '0';                        /* 2. bg fades in slowly (2.9s) */
        setTimeout(()=>{
          stage.classList.add('landing');                    /* 3. console hovers in, lands */
          let landed = false;
          const done = ()=>{
            if (landed) return; landed = true;
            stage.classList.remove('prelanding','landing');
            blackout.remove();
            try{ if (NS.Audio && NS.Audio.init){ NS.Audio.init(); sfx('coreHit'); } }catch(e){}
          };
          stage.addEventListener('animationend', done, { once:true });
          setTimeout(done, 3100);                            /* backstop: hidden tabs delay animationend */
        }, 1700);                                            /* held beat: bg gets read before the drop */
      }, 350);
    }, 750);
  };
  /* arming is timing-hostile: the iframe may load before or after boot, and a
     reload can surface a transitional blank doc. Poll instead of judging once.
     Two arm modes: same-origin (listen inside the iframe doc — lets the splash's
     own sound toggle keep working) and catcher (an overlay on the parent page,
     for file:// / any context where the iframe doc is walled off). */
  let armed = false, frameLoaded = false;
  const arm = (doc)=>{
    if (armed) return; armed = true;
    doc.addEventListener('click', e=>{
      if (!e.isTrusted) return;                                /* splash fires synthetic events */
      const t = e.target;
      if (t && t.closest && t.closest('#aw-sndbtn')) return;   /* sound toggle, not begin */
      begin();
    }, true);
    doc.addEventListener('keydown', e=>{ if (e.isTrusted) begin(); }, true);
  };
  const catcher = $('splashcatch');
  const sndspot = $('splashsnd');
  /* the splash posts {type:'aiwars:sndstate', muted} after every toggle; the
     parent only mirrors it on the hotspot tooltip. Purely optional — if the
     message never arrives nothing here depends on it. */
  window.addEventListener('message', e=>{
    const md = e && e.data;
    if (!md || md.type !== 'aiwars:sndstate') return;
    if (sndspot) sndspot.title = md.muted ? 'SOUND: OFF' : 'SOUND: ON';
  });
  const armCatcher = ()=>{
    if (armed) return; armed = true;
    if (!catcher){ begin(); return; }
    catcher.style.pointerEvents = 'auto';
    catcher.addEventListener('click', e=>{ if (e.isTrusted) begin(); });
    /* walled mode blindspot fix: the catcher paints above the WHOLE iframe, so
       the splash's own SND button (top-right, 34px @ 18px inset) can never be
       hit. This hotspot covers that corner and forwards the click in via
       postMessage instead of begin(); everywhere else still begins. Inert
       (pointer-events:none) in same-origin mode, where the real button works. */
    if (sndspot){
      sndspot.style.pointerEvents = 'auto';
      sndspot.addEventListener('click', e=>{
        if (!e.isTrusted) return;
        try{ frame.contentWindow.postMessage({ type:'aiwars:sndtoggle' }, '*'); }catch(err){}
      });
    }
  };
  const docState = ()=>{
    /* 'ready' = doc reachable with the splash booted; 'pending' = reachable but
       not (yet) the splash; 'walled' = cross-origin/opaque, cannot ever see in */
    let doc = null;
    try{ doc = frame.contentDocument; }catch(e){ return 'walled'; }
    if (!doc) return 'walled';
    if (doc.getElementById && doc.getElementById('aw-root')) return 'ready';
    return 'pending';
  };
  const tryArm = ()=>{
    if (armed) return true;
    const st = docState();
    if (st === 'ready'){ arm(frame.contentDocument); return true; }
    /* only trust 'walled' once the iframe actually loaded — before that it can
       be a transitional about:blank that will become reachable */
    if (st === 'walled' && frameLoaded){ armCatcher(); return true; }
    return false;
  };
  tryArm();
  frame.addEventListener('load', ()=>{ frameLoaded = true; tryArm(); });
  const armIv = setInterval(()=>{ if (tryArm() || begun) clearInterval(armIv); }, 400);
  /* focus may sit on the parent page — any key begins from here too */
  window.addEventListener('keydown', function onKey(e){
    if (!e.isTrusted) return;
    if (!begun && armed && d.body.contains(splash)) begin();
    if (begun) window.removeEventListener('keydown', onKey);
  });
  /* doc reachable but the splash never booted (broken asset) -> play without it.
     Walled contexts (file://) never hit this: the catcher arms as soon as the
     iframe load event fires. */
  setTimeout(()=>{
    clearInterval(armIv);
    if (!begun && !armed) skip();
  }, 9000);
}

/* ===== boot ===== */
async function boot(){
  d = g.document;
  if (!d) throw new Error('UI.boot requires a browser');
  runIntro();
  NS.Content.load('content/tone-pack.json');   /* seam: external pack overrides the embedded default */
  await fillSetup();
  try{
    const saved = localStorage.getItem(KEY_LS);
    if (saved){ $('apikey').value = saved; $('remember').checked = true; keys.anthropic = saved; }
    const savedOa = localStorage.getItem(KEY_LS_OPENAI);
    if (savedOa){ $('apikeyOpenai').value = savedOa; $('remember').checked = true; keys.openai = savedOa; }
  }catch(e){}

  $('startbtn').addEventListener('click', startMatch);
  const wireShow = (inputId, btnId)=>$(btnId).addEventListener('click', ()=>{
    const k = $(inputId);
    k.type = k.type==='password' ? 'text' : 'password';
    $(btnId).textContent = k.type==='password' ? 'SHOW' : 'HIDE';
  });
  wireShow('apikey','keyshow');
  wireShow('apikeyOpenai','keyshowOpenai');
  $('replaylink').addEventListener('click', ()=>$('replayfile').click());
  $('replayfile').addEventListener('change', ev=>{
    if (ev.target.files && ev.target.files[0]) loadReplayFile(ev.target.files[0]);
    ev.target.value = '';
  });

  $('board').addEventListener('click', boardClick);
  d.querySelectorAll('#deploy .card').forEach(el=>{
    el.addEventListener('click', ()=>cardClick(el));
    el.addEventListener('mouseenter', ()=>cardHover(el));
  });
  $('deploybtn').addEventListener('click', deployClick);
  $('endturnbtn').addEventListener('click', ()=>{ if (humanCtx) humanDone(); });
  d.querySelectorAll('.fpopt').forEach(el=>el.addEventListener('click', ()=>{
    fp[el.dataset.cls] = el.dataset.mode;
    d.querySelectorAll('.fpopt[data-cls="'+el.dataset.cls+'"]').forEach(e=>e.classList.toggle('on', e===el));
    sfx('uiTick');
  }));

  /* speed / pause / skip controls are optional — the layout may omit them */
  d.querySelectorAll('#speedctl [data-speed]').forEach(el=>el.addEventListener('click', ()=>{
    NS.Render.setSpeed(+el.dataset.speed);
    d.querySelectorAll('#speedctl [data-speed]').forEach(e=>e.classList.toggle('on', e===el));
    sfx('uiTick');
  }));
  const pauseBtn = $('pausebtn');
  if (pauseBtn){
    let paused = false;
    pauseBtn.addEventListener('click', ()=>{
      paused = !paused;
      NS.Render.setPaused(paused);
      pauseBtn.classList.toggle('on', paused);
    });
  }
  const skipBtn = $('skipbtn');
  if (skipBtn) skipBtn.addEventListener('click', ()=>NS.Render.skipAll());

  const mySide = ()=>cfg ? (cfg.A.kind==='human' ? 'A' : cfg.B.kind==='human' ? 'B' : 'A') : 'A';
  d.querySelectorAll('.emote').forEach(el=>el.addEventListener('click', ()=>{
    const s = mySide();
    NS.Render.emote(s.toLowerCase(), el.dataset.etext);
    chat('EMOTE: '+el.dataset.etext, sideColor(s));
    sfx('emote');
  }));
  $('btnsend').addEventListener('click', ()=>chat(C('uiCopy.sendLines') || 'gl hf, machine.', sideColor(mySide())));
  $('btnemote').addEventListener('click', ()=>{
    const els = d.querySelectorAll('.emote');
    if (els.length) els[Math.floor(Math.random()*els.length)].click();
  });
  $('btninsult').addEventListener('click', ()=>{
    const s = mySide();
    NS.Render.emote(otherSide(s).toLowerCase(), '!!');
    chat('INSULT: '+(C('uiCopy.insultLines') || 'You move like a 300ms ping.'), sideColor(s));
  });

  d.addEventListener('click', function initAudio(){
    try{ if (NS.Audio && NS.Audio.init) NS.Audio.init(); }catch(e){}
    d.removeEventListener('click', initAudio);
  });

  $('newmatchbtn').addEventListener('click', ()=>{
    gen++; cancelHuman(); timerStop();
    $('result').classList.add('hidden');
    $('setup').classList.remove('hidden');
  });
  $('rematchbtn').addEventListener('click', async ()=>{
    gen++; cancelHuman();
    $('result').classList.add('hidden');
    const ok = await startMatch();
    /* a failed restart (expired login, dead bridge...) reports on the setup
       overlay — bring it back so the error is actually visible */
    if (!ok) $('setup').classList.remove('hidden');
  });
  $('exportbtn').addEventListener('click', exportReplay);

  NS.Render.init().then(()=>{
    sysnote('AWAITING MATCH SETUP');
    chat(C('uiCopy.titleScreen') || 'AI WARS ONLINE.', 'lime');
  }).catch(e=>console.error('Render init failed:', e));
}

NS.UI = { boot };
})(typeof window !== 'undefined' ? window : globalThis);
