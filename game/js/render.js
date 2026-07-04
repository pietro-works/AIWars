/* AI WARS — AIWARS.Render
   Owns the board canvas rAF loop. Consumes TurnLogs sequentially (enqueue),
   choreographs moves, layers combat/beam/death/build FX, reconciles each
   half-turn against the log's resultingState snapshot. Between half-turns
   (LLM thinking, human deciding) the THEATRICS layer keeps the board alive:
   per-type idle animation, and engaged enemies looping attack volleys.
   Draw geometry (CK checker rect mapping of Board Canvas.png, unit/core
   scaling, bolt style) is a faithful port of mockup/board-demo.html.
   Node-safe to load (no top-level DOM access); browser-only at runtime. */
(function(g){
'use strict';
const NS = g.AIWARS = g.AIWARS || {};

/* ===== board geometry constants (must match mockup + CONTRACTS GRID) ===== */
const NX = 24, NY = 14;
const IMG_ASPECT = 2560/1440;
/* normalized rect of Board Canvas.png occupied by the 24x14 checker.
   Re-measured 2026-07-04 via least-squares edge fit (the old thresholded scan
   had swallowed ~15-20px of the frame's inner border on every side).
   2026-07-04 polish: +2 art px right and down (visual registration: unit feet
   vs cell centers read better; edge fit alone had it sub-pixel on the art). */
const CK = { x0:0.1986, y0:0.1692, x1:0.8068, y1:0.8143 };
const SIDE_RGB = { a:'0,241,240', b:'247,3,149' };
const LIME_RGB = '139,255,46';
const AMBER = '255,208,2';
/* order-state ledger (hud-polish-skill §5): blue = committed order, grey = inert.
   Never side colors for state. */
const BLUE_RGB = '61,155,255';
const GREY_RGB = '86,96,110';

/* ===== animation durations (ms at 1x speed) ===== */
const DUR_SPAWN = 250, DUR_COMBAT = 950, DUR_DEATH = 420, DUR_MIN = 160;
/* choreographed movement: departures stagger, duration scales with distance */
const MOVE_STAGGER = 130, MOVE_BASE = 320, MOVE_PER_TILE = 130, MOVE_MAX = 1350;
const BUBBLE_MS = 2200;
/* theatrical volley cycles per attacker type (anticipation->action->recovery) */
const VOLLEY = {
  worker:   { period: 2700, antic: 260, action: 240 },
  vehicle:  { period: 2500, antic: 200, action: 460 },
  triangle: { period: 3100, antic: 380, action: 320 },
  core:     { period: 3600, antic: 300, action: 420 },
};
const PART_CAP = 140;

/* ===== module state ===== */
let board=null, ctx=null, META=null, CORE=null;
const IMGS = {};
let readyP = null, rafOn = false;

/* scene = what is on screen right now (positions may be mid-tween floats) */
const scene = { units:new Map(), cores:{A:{hp:200},B:{hp:200}}, stances:null };

let queue = [], job = null, idleCbs = [];
let speed = 1, paused = false;
let clock = 0, lastTs = 0;

let highlight = null;   /* {tiles:[[x,y],...], color:'a'|'b'} */
let selection = null;   /* [x,y] */
let orderStates = null; /* Map unitId -> {st:'unordered'|'ordered'|'building', flipAt} — human half only */
let bubbles = [];       /* {side:'a'|'b', text, born} */
let parts = [];         /* particle pool: dust/casing/spark/exhaust/pop */
let engagements = [];   /* theatrical attack pairs, rebuilt on applyState */
let fxOps = [];         /* per-frame theatrical draw ops (filled by updateTheatrics) */

/* ===== helpers ===== */
function sfx(ev){ try{ if(NS.Audio && NS.Audio.play) NS.Audio.play(ev); }catch(e){} }
function corePos(side){
  const C = NS.CONST && NS.CONST.CORE_POS;
  return C && C[side] ? C[side] : (side==='A' ? [1,1] : [22,12]);
}
function coreRange(){ return (NS.CONST && NS.CONST.CORE && NS.CONST.CORE.range) || 2; }
function rng(n){ const s=Math.sin(n*12.9898)*43758.5453; return s-Math.floor(s); }
function hash(id){ let h=0; const s=String(id); for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))|0; return Math.abs(h); }
function easeInOutCubic(p){ return p<.5 ? 4*p*p*p : 1-Math.pow(-2*p+2,3)/2; }
function easeInOutSine(p){ return -(Math.cos(Math.PI*p)-1)/2; }
function easeOutBack(p){ const c=1.35; return 1+ (c+1)*Math.pow(p-1,3) + c*Math.pow(p-1,2); }
function cheb(a,b){ return Math.max(Math.abs(a[0]-b[0]), Math.abs(a[1]-b[1])); }

/* stance-derived attack range for theatrics; workers get a theatrical melee
   reach of 1 (engine atk is 0 — the feint is pure showmanship, no damage) */
function rangeOf(u){
  if (u.type === 'worker') return 1;
  try{
    const sideUp = u.side==='a' ? 'A' : 'B';
    const st = (scene.stances && scene.stances[sideUp] && scene.stances[sideUp][u.type]) || 'default';
    return NS.CONST.UNITS[u.type][st].range;
  }catch(e){ return u.type==='triangle' ? 2 : 1; }
}

/* core-id detection for TurnLog attacker/target fields ('A','core_B','B_core'...) */
function coreSideOf(id){
  if (typeof id !== 'string') return null;
  const m = /^(?:core[\s_-]?([ab])|([ab])[\s_-]?core|([ab]))$/i.exec(id.trim());
  const s = m && (m[1]||m[2]||m[3]);
  return s ? s.toUpperCase() : null;
}
function posOf(id){
  const u = scene.units.get(id);
  if (u) return [u.x, u.y];
  const s = coreSideOf(id);
  return s ? corePos(s) : null;
}
function rgbOf(id){
  const u = scene.units.get(id);
  if (u) return SIDE_RGB[u.side] || LIME_RGB;
  const s = coreSideOf(id);
  return s ? SIDE_RGB[s.toLowerCase()] : LIME_RGB;
}
function unitTypeOf(id){
  const u = scene.units.get(id);
  return u ? u.type : (coreSideOf(id) ? 'core' : null);
}

/* ===== particles (grid-space coords; converted at draw so resize is safe) ===== */
function spawnPart(p){
  if (parts.length >= PART_CAP) parts.shift();
  p.born = clock; parts.push(p);
}
function dust(x, y, seed){
  for (let i=0;i<3;i++){
    const a = rng(seed+i)*Math.PI*2, sp = 0.15+rng(seed+i+3)*0.25;
    spawnPart({ kind:'dust', x, y, vx:Math.cos(a)*sp, vy:-0.12-rng(seed+i+7)*0.2, grav:0.5,
      life:480+rng(seed+i+11)*260, size:0.06+rng(seed+i+13)*0.05, color:'170,150,130' });
  }
}
function casing(x, y, dir, seed){
  spawnPart({ kind:'casing', x, y: y-0.35, vx:-dir*(0.35+rng(seed)*0.3), vy:-0.75-rng(seed+1)*0.4,
    grav:2.6, life:620, size:0.05, color:AMBER });
}
function sparkBurst(x, y, rgb, n, seed){
  for (let i=0;i<n;i++){
    const a = rng(seed+i)*Math.PI*2, sp = 0.4+rng(seed+i+5)*0.7;
    spawnPart({ kind:'spark', x, y:y-0.35, vx:Math.cos(a)*sp, vy:Math.sin(a)*sp*0.7-0.2,
      grav:1.4, life:300+rng(seed+i+9)*180, size:0.035, color:rgb });
  }
}
function exhaust(x, y, dir, seed){
  spawnPart({ kind:'dust', x:x-dir*0.32, y:y-0.18, vx:-dir*0.12, vy:-0.18-rng(seed)*0.1, grav:-0.08,
    life:700, size:0.05+rng(seed+2)*0.04, color:'120,120,135' });
}
function pop(x, y, text, rgb){
  spawnPart({ kind:'pop', x, y:y-0.9, vx:0, vy:-0.55, grav:0, life:950, size:0.4, color:rgb, text:text });
}
function drawParts(g_){
  if (!parts.length) return;
  const keep = [];
  for (const p of parts){
    const age = clock - p.born;
    if (age >= p.life) continue;
    const f = age/1000;
    const x = g_.px(p.x + p.vx*f)+g_.txw/2, y = g_.py(p.y + p.vy*f + 0.5*p.grav*f*f)+g_.tyh/2;
    const fade = 1 - age/p.life;
    ctx.save(); ctx.globalAlpha = Math.max(0, fade);
    if (p.kind === 'pop'){
      ctx.font = 'bold '+(Math.max(9, g_.tyh*p.size)|0)+'px "VT323",monospace';
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillStyle = 'rgba('+p.color+',1)';
      ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 3;
      ctx.fillText(p.text, x, y);
    } else if (p.kind === 'spark'){
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba('+p.color+',1)';
      const s = Math.max(1, g_.tyh*p.size);
      ctx.fillRect(x-s/2, y-s/2, s, s);
    } else { /* dust / casing */
      ctx.fillStyle = 'rgba('+p.color+','+(p.kind==='casing'?1:0.5)+')';
      const s = Math.max(1, g_.tyh*p.size);
      ctx.fillRect(x-s/2, y-s/2, s, p.kind==='casing' ? s*1.6 : s);
    }
    ctx.restore();
    keep.push(p);
  }
  parts = keep;
}

/* ===== init: image loading + rAF start (browser only) ===== */
function load(k, src){
  return new Promise(res=>{
    const i = new Image();
    i.onload = ()=>res(IMGS[k]=i);
    i.onerror = ()=>{ console.warn('Render: failed to load', src); res(IMGS[k]=null); };
    i.src = src;
  });
}
function init(){
  if (readyP) return readyP;
  const d = g.document;
  if (!d) return Promise.reject(new Error('Render.init requires a browser'));
  board = d.getElementById('board');
  ctx = board.getContext('2d');
  META = g.AIWARS_ATLAS; CORE = g.AIWARS_CORE;
  readyP = Promise.all([
    load('a','../assets/sprites/atlas-a.png'),
    load('b','../assets/sprites/atlas-b.png'),
    load('coffA','../assets/sprites/core_off_a.png'), load('conA','../assets/sprites/core_on_a.png'),
    load('coffB','../assets/sprites/core_off_b.png'), load('conB','../assets/sprites/core_on_b.png'),
    load('tex','../assets/Board Canvas.png'),
  ]).then(()=>{
    thumbs(); avatars(); trollcrt();
    if (!rafOn){
      rafOn = true;
      g.requestAnimationFrame(frame);
      setInterval(hiddenTick, 500);
    }
  });
  return readyP;
}

/* ===== public state / queue API ===== */
function applyState(st){
  if (!st) return;
  const prev = scene.units;
  scene.units = new Map();
  (st.units||[]).forEach(u=>{
    const old = prev.get(u.id);
    scene.units.set(u.id, { id:u.id, side:String(u.side||'A').toLowerCase(), type:u.type,
      x:u.pos[0], y:u.pos[1], hp:u.hp, building:!!u.building, alpha:1,
      born: old ? old.born : 0, face: old ? old.face : 0 });
  });
  if (st.cores){
    scene.cores.A = { hp: st.cores.A ? st.cores.A.hp : scene.cores.A.hp };
    scene.cores.B = { hp: st.cores.B ? st.cores.B.hp : scene.cores.B.hp };
  }
  if (st.stances){
    try{ scene.stances = JSON.parse(JSON.stringify(st.stances)); }catch(e){}
  }
  rebuildEngagements();
}
/* who theatrically fights whom while nothing "real" is happening: every unit
   vs the CLOSEST enemy in its (stance-derived) range, plus cores vs anything
   in core range. Recomputed only when authoritative state changes. */
function rebuildEngagements(){
  engagements = [];
  const units = Array.from(scene.units.values());
  for (const u of units){
    if (u.alpha <= 0) continue;
    const R = rangeOf(u);
    let best = null, bestD = 1e9;
    for (const v of units){
      if (v.side === u.side || v.alpha <= 0) continue;
      const d = cheb([u.x,u.y],[v.x,v.y]);
      if (d <= R && d < bestD){ best = v; bestD = d; }
    }
    /* enemy core also engages melee-ish attackers standing next to it */
    if (!best){
      const foe = u.side==='a' ? 'B' : 'A';
      if (scene.cores[foe].hp > 0 && cheb([u.x,u.y], corePos(foe)) <= R)
        best = { id:'core_'+foe, core:foe };
    }
    if (best) engagements.push({ atkId:u.id, atkType:u.type, tgtId:best.id, side:u.side, lastCycle:-1 });
  }
  ['A','B'].forEach(s=>{
    if (scene.cores[s].hp <= 0) return;
    const cp = corePos(s), R = coreRange();
    const foes = units.filter(v=>v.side !== s.toLowerCase() && v.alpha > 0 && cheb(cp,[v.x,v.y]) <= R);
    if (foes.length){
      foes.sort((a,b)=>a.id<b.id?-1:1);
      engagements.push({ atkId:'core_'+s, atkType:'core', tgtId:foes[0].id, side:s.toLowerCase(), lastCycle:-1 });
    }
  });
}
function renderState(state){
  /* hard reset: drop pending animation, draw this snapshot */
  queue = []; job = null; parts = []; orderStates = null;
  applyState(state);
  flushIdle();
}
function enqueue(turnLog){ if (turnLog) queue.push(turnLog); }
function onIdle(cb){
  if (typeof cb !== 'function') return;
  if (!job && queue.length===0){ try{ cb(); }catch(e){} }
  else idleCbs.push(cb);
}
function flushIdle(){
  const cbs = idleCbs; idleCbs = [];
  cbs.forEach(cb=>{ try{ cb(); }catch(e){} });
}
function setSpeed(s){ if (s===1||s===2||s===4) speed = s; }
function setPaused(p){ paused = !!p; }
function skipAll(){
  const last = queue.length ? queue[queue.length-1] : (job ? job.log : null);
  queue = []; job = null;
  if (last && last.resultingState) applyState(last.resultingState);
  flushIdle();
}

/* ===== interaction helpers for ui.js ===== */
function tileAt(clientX, clientY){
  if (!board) return null;
  const r = board.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const px = (clientX - r.left) * (board.width / r.width);
  const py = (clientY - r.top)  * (board.height / r.height);
  const g_ = geom();
  const x = Math.floor((px - g_.gx0) / g_.txw);
  const y = Math.floor((py - g_.gy0) / g_.tyh);
  return (x>=0 && x<NX && y>=0 && y<NY) ? [x,y] : null;
}
function setHighlight(tiles, color){ highlight = { tiles: tiles||[], color: color||'a' }; }
function clearHighlight(){ highlight = null; selection = null; }
function setSelection(tile){ selection = tile || null; }
/* order-state outlines (human half only). ui.js rebuilds the whole map at its
   refreshOrderInfo choke point; values are {st, target?} objects (legacy plain
   strings accepted). The unordered->ordered transition is detected here so the
   220ms flip flash needs no extra API. null clears everything. */
function setOrderStates(map){
  if (!map || !map.size){ orderStates = map ? new Map() : null; return; }
  const next = new Map();
  map.forEach((v, id)=>{
    const st = typeof v === 'string' ? v : v.st;
    const target = (v && typeof v === 'object' && Array.isArray(v.target)) ? v.target : null;
    const prev = orderStates && orderStates.get(id);
    const flipAt = st==='ordered' ? (prev && prev.st==='ordered' ? prev.flipAt : clock) : 0;
    next.set(id, { st, flipAt, target });
  });
  orderStates = next;
}
function emote(side, text){
  bubbles.push({ side: String(side||'a').toLowerCase()==='b'?'b':'a',
                 text: String(text==null?'?':text).slice(0,12), born: clock });
}

/* ===== half-turn job machine ===== */
function startJob(log){
  /* choreographed movement: departures staggered (id order = deterministic),
     duration grows with distance so nothing reads as a teleport */
  const rawMoves = [];
  (log.ordersApplied||[]).forEach(o=>{
    if (!o || !o.from || !o.to) return;
    if (o.from[0]===o.to[0] && o.from[1]===o.to[1]) return;
    const u = scene.units.get(o.unit); if (!u) return;
    rawMoves.push({ u, from:[o.from[0],o.from[1]], to:[o.to[0],o.to[1]] });
  });
  rawMoves.sort((a,b)=>a.u.id<b.u.id?-1:1);
  let moveEnd = 0;
  const moves = rawMoves.map((m,i)=>{
    const tiles = Math.max(1, cheb(m.from, m.to));
    const dur = Math.min(MOVE_MAX, MOVE_BASE + tiles*MOVE_PER_TILE);
    const delay = i*MOVE_STAGGER;
    moveEnd = Math.max(moveEnd, delay+dur);
    return { u:m.u, from:m.from, to:m.to, tiles, dur, delay,
             dirx: Math.sign(m.to[0]-m.from[0]), hopIdx:-1 };
  });

  const spawns = [];
  (log.buildsCompleted||[]).forEach(b=>{
    if (b && b.unitId) spawns.push({ id:b.unitId, side:String(b.unitId).charAt(0), type:b.produces, pos:b.pos });
  });
  (log.coreSpawns||[]).forEach(s=>{
    if (s && s.unitId) spawns.push({ id:s.unitId, side:s.side, type:'worker', pos:s.pos });
  });
  const combat = (log.combatEvents||[]).map(ev=>Object.assign({}, ev, {
    coreFrom: (!scene.units.has(ev.attacker) && coreSideOf(ev.attacker)) || null,
  }));
  const coreHits = (log.coreDamage||[]).slice();
  const deaths = (log.deaths||[]).filter(id=>scene.units.get(id));

  const T = {};
  T.move   = moves.length ? moveEnd : 0;
  T.spawn  = T.move + ((spawns.length || (log.buildsStarted||[]).length) ? DUR_SPAWN : 0);
  T.combat = T.spawn + ((combat.length || coreHits.length) ? DUR_COMBAT : 0);
  T.death  = T.combat + (deaths.length ? DUR_DEATH : 0);
  T.total  = Math.max(T.death, DUR_MIN);

  const targets = new Set();
  combat.forEach(ev=>{ if (scene.units.has(ev.target)) targets.add(ev.target); });
  const coreFire = { A:false, B:false };
  combat.forEach(ev=>{ if (ev.coreFrom) coreFire[ev.coreFrom] = true; });
  const coreHit = { A:false, B:false };
  coreHits.forEach(c=>{ if (c && (c.core==='A'||c.core==='B')) coreHit[c.core] = true; });

  job = { log, moves, spawns, combat, coreHits, deaths, T, targets, coreFire, coreHit,
          elapsed:0, marked:false, hitSfx:false, deathSfx:false, popped:false, movesFinal:false };
  if (moves.length) sfx('move');
}
function gaitEase(type, p){
  if (type === 'vehicle')  return easeInOutCubic(p);
  if (type === 'triangle') return easeOutBack(easeInOutSine(p));  /* glide + settle overshoot */
  return p;   /* worker: linear base, the hops carry the personality */
}
function stepJob(){
  const T = job.T, e = job.elapsed;
  /* choreographed movement — runs until finalization actually happened, so a
     big elapsed jump (frame hitch, 4x speed, hiddenTick chunk) can never
     strand a unit mid-tween with a stale gait */
  if (T.move > 0 && !job.movesFinal){
    if (e >= T.move) job.movesFinal = true;   /* this pass computes p=1 for all movers */
    job.moves.forEach(m=>{
      const p = Math.min(1, Math.max(0, (e - m.delay)/m.dur));
      if (p <= 0){ delete m.u.mv; return; }
      const q = gaitEase(m.u.type, p);
      m.u.x = m.from[0] + (m.to[0]-m.from[0])*q;
      m.u.y = m.from[1] + (m.to[1]-m.from[1])*q;
      if (m.dirx) m.u.face = m.dirx;
      if (p < 1){
        m.u.mv = { p, tiles:m.tiles, dirx:m.dirx || (m.u.side==='a'?1:-1), type:m.u.type };
        /* worker hop landings + vehicle dust trail (once per hop / per tile) */
        const hop = Math.floor(p*m.tiles + 0.0001);
        if (hop !== m.hopIdx){
          m.hopIdx = hop;
          if (m.u.type === 'worker' && hop > 0) dust(m.u.x, m.u.y, hash(m.u.id)+hop*17);
          if (m.u.type === 'vehicle') dust(m.u.x - (m.dirx||0)*0.4, m.u.y, hash(m.u.id)+hop*29);
        }
      } else {
        m.u.x = m.to[0]; m.u.y = m.to[1];
        delete m.u.mv;
      }
    });
  }
  /* build starts + spawns at end of movement */
  if (!job.marked && e >= T.move){
    job.marked = true;
    const bs = job.log.buildsStarted||[];
    bs.forEach(b=>{ const u = scene.units.get(b.worker); if (u) u.building = true; });
    if (bs.length) sfx('buildStart');
    if (job.spawns.length){
      job.spawns.forEach(s=>{
        if (scene.units.has(s.id)) return;
        scene.units.set(s.id, { id:s.id, side:String(s.side||'A').toLowerCase(), type:s.type||'worker',
          x:s.pos?s.pos[0]:0, y:s.pos?s.pos[1]:0, hp:1, building:false, alpha:1, born:clock, face:0 });
        if (s.pos) dust(s.pos[0], s.pos[1], hash(s.id));
      });
      (job.log.buildsCompleted||[]).forEach(b=>{ const u = scene.units.get(b.worker); if (u) u.building = false; });
      sfx('buildDone');
    }
    rebuildEngagements();
  }
  /* combat window: sfx + damage pops fire once at window start */
  if (!job.hitSfx && T.combat > T.spawn && e >= T.spawn){
    job.hitSfx = true; sfx('hit');
    if (job.coreHits.length) sfx('coreHit');
  }
  if (!job.popped && T.combat > T.spawn && e >= T.spawn + (T.combat-T.spawn)*0.45){
    job.popped = true;
    job.combat.forEach(ev=>{
      const P = posOf(ev.target);
      if (P && ev.dmg) pop(P[0], P[1], '-'+ev.dmg, rgbOf(ev.attacker));
    });
    job.coreHits.forEach(cd=>{
      if (!cd || !(cd.core==='A'||cd.core==='B') || !cd.dmg) return;
      const P = corePos(cd.core);
      pop(P[0], P[1], '-'+cd.dmg, rgbOf(cd.from||''));
    });
  }
  /* death fades (sink + fade) */
  if (T.death > T.combat && e >= T.combat){
    if (!job.deathSfx){ job.deathSfx = true; sfx('death'); }
    const p = Math.min(1, (e-T.combat)/(T.death-T.combat));
    job.deaths.forEach(id=>{ const u = scene.units.get(id); if (u){ u.alpha = 1-p; u.sink = p; } });
  }
  /* done: reconcile to authoritative post-state, chain next half-turn */
  if (e >= T.total){
    const st = job.log.resultingState;
    job = null;
    if (st) applyState(st);
    if (queue.length) startJob(queue.shift());
    else flushIdle();
  }
}
/* progress (0..1) of the current combat window, or null when not in it */
function combatWin(){
  if (!job) return null;
  const s = job.T.spawn, en = job.T.combat;
  if (en <= s) return null;
  if (job.elapsed < s || job.elapsed >= en) return null;
  return (job.elapsed - s) / (en - s);
}

/* ===== theatrics: idle volleys between half-turns (the "thinking" time) =====
   Attack loops are pure theater — anticipation -> action -> recovery on a
   per-attacker cycle, phase-offset by unit hash so the board never fires in
   unison. No damage, no pops; the real combat window owns those. */
function updateTheatrics(){
  fxOps = [];
  scene.units.forEach(u=>{ delete u.volley; });
  if (job) return;   /* real half-turn animation owns the stage */
  for (const en of engagements){
    const V = VOLLEY[en.atkType] || VOLLEY.worker;
    const ph = hash(en.atkId) % V.period;
    const cyc = Math.floor((clock + ph) / V.period);
    const local = (clock + ph) % V.period;
    const A = posOf(en.atkId), B = posOf(en.tgtId);
    if (!A || !B) continue;
    const atkU = scene.units.get(en.atkId);
    if (atkU){
      atkU.face = Math.sign(B[0]-A[0]) || atkU.face || (atkU.side==='a'?1:-1);
      if (atkU.mv) continue;   /* don't fire mid-stride */
    }
    if (local < V.antic){
      /* anticipation */
      const p = local/V.antic;
      if (atkU) atkU.volley = { phase:'antic', p, tx:B[0], ty:B[1] };
      if (en.atkType==='triangle') fxOps.push({ kind:'charge', at:A, p, rgb:SIDE_RGB[en.side] });
    } else if (local < V.antic + V.action){
      /* action */
      const p = (local-V.antic)/V.action;
      if (atkU) atkU.volley = { phase:'action', p, tx:B[0], ty:B[1] };
      if (en.atkType==='vehicle'){
        fxOps.push({ kind:'rocket', from:A, to:B, p, rgb:SIDE_RGB[en.side], seed:cyc*31+hash(en.atkId), intensity:0.8 });
        if (en.lastCycle !== cyc){
          en.lastCycle = cyc;
          dust(A[0], A[1], cyc*7+hash(en.atkId));            /* launch backblast */
          sfx('volley');                                     /* rAF-only path: silent in hidden tabs */
        }
        if (en.lastBoom !== cyc && p > 0.82){
          en.lastBoom = cyc;
          sparkBurst(B[0], B[1], '255,176,60', 4, cyc*13+hash(en.atkId));
        }
      } else if (en.atkType==='triangle'){
        fxOps.push({ kind:'shock', from:A, to:B, p, rgb:SIDE_RGB[en.side], seed:cyc*17+hash(en.atkId), intensity:0.55 });
        if (en.lastCycle !== cyc){ en.lastCycle = cyc; sparkBurst(B[0], B[1], SIDE_RGB[en.side], 3, cyc*11+hash(en.atkId)); sfx('volley'); }
      } else if (en.atkType==='worker'){
        fxOps.push({ kind:'melee', at:B, from:A, p, rgb:SIDE_RGB[en.side], seed:cyc*23+hash(en.atkId), intensity:0.8 });
        if (en.lastCycle !== cyc && p > 0.4){
          en.lastCycle = cyc;
          sparkBurst(B[0], B[1], '230,230,240', 2, cyc*19+hash(en.atkId));
          sfx('volley');
        }
      } else if (en.atkType==='core'){
        fxOps.push({ kind:'corepulse', side:en.atkId.slice(-1).toUpperCase(), to:B, p, intensity:0.5 });
      }
    }
    /* recovery: no ops — the held beat before the next volley */
  }
}
/* screen shake: explosions kick it, draw() applies it around the whole scene */
let shakeMag = 0, shakeUntil = 0;
function shakeKick(mag, ms){
  shakeUntil = Math.max(shakeUntil, clock + (ms || 220));
  shakeMag = Math.max(shakeMag, mag);
}
/* pixel-art missile: chunky grid-mask rocket pointing +x, rotated to velocity.
   .=empty D=dark fin B=hull W=nose N=hot nozzle */
const MISSILE_GRID = [
  '.D.....',
  '.DBBB..',
  'NBBBBW.',
  'NBBBBWW',
  'NBBBBW.',
  '.DBBB..',
  '.D.....',
];
function drawMissileSprite(rx, ry, ux, uy, cs, rgb, flick){
  const rows = MISSILE_GRID.length, cols = MISSILE_GRID[0].length;
  const pal = {
    D: 'rgba(52,56,70,.95)',
    B: 'rgba(198,204,216,.95)',
    W: 'rgba('+rgb+',.95)',
    N: flick ? 'rgba(255,238,170,.95)' : 'rgba(255,150,40,.9)',
  };
  ctx.save();
  ctx.translate(rx, ry);
  ctx.rotate(Math.atan2(uy, ux));
  ctx.translate(-cols*cs/2, -rows*cs/2);
  for (let r = 0; r < rows; r++){
    for (let c = 0; c < cols; c++){
      const ch = MISSILE_GRID[r][c];
      if (ch === '.') continue;
      ctx.fillStyle = pal[ch];
      ctx.fillRect(Math.round(c*cs), Math.round(r*cs), Math.ceil(cs), Math.ceil(cs));
    }
  }
  /* exhaust flame: 1-2 flickering cells trailing the nozzle */
  ctx.fillStyle = flick ? 'rgba(255,190,80,.9)' : 'rgba(255,240,180,.95)';
  ctx.fillRect(Math.round(-cs), Math.round(3*cs), Math.ceil(cs), Math.ceil(cs));
  if (flick) ctx.fillRect(Math.round(-2*cs), Math.round(3*cs), Math.ceil(cs), Math.ceil(cs));
  ctx.restore();
}
/* vehicle missile: arced pixel rocket with flame + smoke; impact detonates a
   real boom — flash frame, pixel shockwave ring, fireball, debris, shake.
   p 0..1 over the whole shot: 0-0.78 flight, 0.78-1 explosion. */
function drawRocket(g_, op){
  const x0 = g_.px(op.from[0])+g_.txw/2, y0 = g_.py(op.from[1])+g_.tyh*.4;
  const x1 = g_.px(op.to[0])+g_.txw/2,   y1 = g_.py(op.to[1])+g_.tyh*.5;
  const FLY = 0.78;
  if (op.p < FLY){
    const fp = op.p/FLY;
    /* arc: parabolic lift, peaks mid-flight */
    const lift = Math.sin(fp*Math.PI)*g_.tyh*0.9;
    const rx = x0+(x1-x0)*fp, ry = y0+(y1-y0)*fp - lift;
    /* velocity direction for body orientation (derivative of the arc) */
    const vx = (x1-x0), vy = (y1-y0) - Math.cos(fp*Math.PI)*Math.PI*g_.tyh*0.9;
    const vlen = Math.hypot(vx,vy)||1, ux = vx/vlen, uy = vy/vlen;
    /* smoke puffs shed along the path (particle pool handles fade) */
    if (rng(op.seed+((clock/50)|0)) > 0.45){
      spawnPart({ kind:'dust', x:op.from[0]+(op.to[0]-op.from[0])*fp, y:op.from[1]+(op.to[1]-op.from[1])*fp - lift/g_.tyh,
        vx:(rng(op.seed+fp*97)-.5)*0.1, vy:-0.05, grav:0.06, life:420, size:0.055, color:'150,150,160' });
    }
    ctx.save();
    ctx.globalAlpha = op.intensity;
    drawMissileSprite(rx, ry, ux, uy, Math.max(1.5, g_.tyh*0.085), op.rgb, (clock%120) < 60);
    ctx.restore();
  } else {
    const bp = (op.p-FLY)/(1-FLY);
    /* one-shot boom side effects on detonation entry */
    if (bp < 0.12){
      shakeKick(g_.tyh*0.09*op.intensity, 260);
      if (rng(op.seed + ((clock/40)|0)) > 0.5){
        const a = rng(op.seed*3+((clock/40)|0))*Math.PI*2, sp = 0.5+rng(op.seed*7+bp*99)*0.9;
        spawnPart({ kind:'spark', x:op.to[0], y:op.to[1], vx:Math.cos(a)*sp, vy:Math.sin(a)*sp*0.7-0.4,
          grav:2.2, life:520, size:0.06, color:'255,176,60' });
        spawnPart({ kind:'dust', x:op.to[0], y:op.to[1]-0.2, vx:(rng(op.seed+bp*31)-.5)*0.4, vy:-0.35,
          grav:-0.05, life:900, size:0.09, color:'120,116,110' });
      }
    }
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    /* stage 1: white detonation flash */
    if (bp < 0.18){
      ctx.globalAlpha = op.intensity*(1-bp/0.18);
      ctx.fillStyle = 'rgba(255,252,240,.95)';
      ctx.beginPath(); ctx.arc(x1, y1, g_.tyh*0.85, 0, 7); ctx.fill();
    }
    /* stage 2: fireball — bigger, hotter, longer than before */
    const R = g_.tyh*(0.3+1.15*bp);
    ctx.globalAlpha = op.intensity*(1-bp);
    const gr = ctx.createRadialGradient(x1,y1,0,x1,y1,R);
    gr.addColorStop(0,'rgba(255,244,210,.98)');
    gr.addColorStop(0.4,'rgba(255,158,52,.85)');
    gr.addColorStop(0.75,'rgba(200,70,20,.5)');
    gr.addColorStop(1,'rgba(90,30,8,0)');
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.arc(x1,y1,R,0,7); ctx.fill();
    /* stage 3: pixelated shockwave — chunky squares expanding on the ring */
    const SR = g_.tyh*(0.4+1.5*bp);
    const px = Math.max(2, Math.round(g_.tyh*0.09));
    ctx.globalAlpha = op.intensity*(1-bp)*0.9;
    ctx.fillStyle = 'rgba(255,214,140,.9)';
    for (let i = 0; i < 14; i++){
      const a = i*(Math.PI*2/14) + op.seed%7;
      ctx.fillRect(Math.round(x1+Math.cos(a)*SR-px/2), Math.round(y1+Math.sin(a)*SR*0.82-px/2), px, px);
    }
    ctx.restore();
  }
}
/* worker melee: quick slash arc across the target + impact flash. The lunge
   itself is body language (idlePose volley); this is the contact read. */
function drawMelee(g_, op){
  const x1 = g_.px(op.at[0])+g_.txw/2, y1 = g_.py(op.at[1])+g_.tyh*.45;
  const dir = Math.sign((op.at[0]-(op.from?op.from[0]:op.at[0]-1))) || 1;
  /* contact window: slash sweeps through the middle of the action beat */
  const w0 = 0.35, w1 = 0.75;
  if (op.p < w0 || op.p > 1) return;
  const sp = Math.min(1, (op.p-w0)/(w1-w0));   /* 0..1 slash sweep */
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  const R = g_.tyh*0.42;
  /* arc sweeps top-to-bottom on the facing side */
  const a0 = dir===1 ? -1.1 : Math.PI+1.1;
  const a1 = dir===1 ?  1.1 : Math.PI-1.1;
  const cur = a0 + (a1-a0)*sp;
  const trail = 0.85;
  ctx.globalAlpha = op.intensity*(op.p>w1 ? (1-op.p)/(1-w1) : 1);
  ctx.strokeStyle = 'rgba(240,245,255,.95)'; ctx.lineWidth = Math.max(1.5, g_.tyh*.08); ctx.lineCap='round';
  ctx.beginPath(); ctx.arc(x1, y1, R, cur-trail*(dir===1?1:-1), cur, dir!==1); ctx.stroke();
  ctx.strokeStyle = 'rgba('+op.rgb+',.6)'; ctx.lineWidth = Math.max(1, g_.tyh*.045);
  ctx.beginPath(); ctx.arc(x1, y1, R*1.12, cur-trail*(dir===1?1:-1), cur, dir!==1); ctx.stroke();
  /* impact star at mid-sweep */
  if (sp > 0.45 && sp < 0.9){
    const k = Math.sin((sp-0.45)/0.45*Math.PI);
    ctx.globalAlpha = op.intensity*k;
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    const r = g_.tyh*0.16*k;
    ctx.beginPath();
    for (let i=0;i<8;i++){
      const a = i*Math.PI/4 + sp*2, rr = i%2 ? r : r*0.4;
      ctx[i?'lineTo':'moveTo'](x1+Math.cos(a)*rr, y1+Math.sin(a)*rr);
    }
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}
/* charge-up glow before a triangle shock */
function drawCharge(g_, op){
  const x = g_.px(op.at[0])+g_.txw/2, y = g_.py(op.at[1])+g_.tyh*.35;
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.25 + 0.45*op.p;
  const r = g_.tyh*(0.12+0.14*op.p);
  const gr = ctx.createRadialGradient(x,y,0,x,y,r*2.2);
  gr.addColorStop(0,'rgba('+op.rgb+',.8)'); gr.addColorStop(1,'rgba('+op.rgb+',0)');
  ctx.fillStyle = gr;
  ctx.beginPath(); ctx.arc(x,y,r*2.2,0,7); ctx.fill();
  ctx.restore();
}

/* ===== geometry + drawing (ported from mockup) ===== */
function geom(){
  const W = board.width, H = board.height;
  /* cover the board cutout by height; width over-fills and bleeds off the sides */
  const imgH = H, imgW = H*IMG_ASPECT, imgX = (W-imgW)/2, imgY = 0;
  const gx0 = imgX + CK.x0*imgW, gy0 = imgY + CK.y0*imgH;
  const gw = (CK.x1-CK.x0)*imgW, gh = (CK.y1-CK.y0)*imgH;
  const txw = gw/NX, tyh = gh/NY;
  return { W,H,imgX,imgY,imgW,imgH,gx0,gy0,gw,gh,txw,tyh,tile:tyh,
    px:cx=>gx0+cx*txw, py:cy=>gy0+cy*tyh };
}
function drawTiles(g_){
  ctx.clearRect(0,0,g_.W,g_.H);
  ctx.fillStyle = '#0b0810'; ctx.fillRect(0,0,g_.W,g_.H);
  if (IMGS.tex) ctx.drawImage(IMGS.tex,0,0,IMGS.tex.width,IMGS.tex.height,g_.imgX,g_.imgY,g_.imgW,g_.imgH);
  /* faint cell lines over the checker for tactical crispness */
  ctx.strokeStyle = 'rgba(150,160,200,.09)'; ctx.lineWidth = 1;
  for (let x=1;x<NX;x++){ const X=(g_.gx0+x*g_.txw)|0; ctx.beginPath(); ctx.moveTo(X,g_.gy0); ctx.lineTo(X,g_.gy0+g_.gh); ctx.stroke(); }
  for (let y=1;y<NY;y++){ const Y=(g_.gy0+y*g_.tyh)|0; ctx.beginPath(); ctx.moveTo(g_.gx0,Y); ctx.lineTo(g_.gx0+g_.gw,Y); ctx.stroke(); }
}
function drawHighlight(g_, t){
  if (highlight && highlight.tiles && highlight.tiles.length){
    const col = SIDE_RGB[highlight.color] || LIME_RGB;
    ctx.save();
    highlight.tiles.forEach(tl=>{
      const x=tl[0], y=tl[1];
      if (x<0||x>=NX||y<0||y>=NY) return;
      ctx.fillStyle = 'rgba('+col+',.14)';
      ctx.fillRect(g_.px(x), g_.py(y), g_.txw, g_.tyh);
      ctx.strokeStyle = 'rgba('+col+',.35)'; ctx.lineWidth = 1;
      ctx.strokeRect(g_.px(x)+1, g_.py(y)+1, g_.txw-2, g_.tyh-2);
    });
    ctx.restore();
  }
  /* selection is rendered as an amber sprite-edge outline in drawUnit
     (outlineFor) — no tile square anymore */
}
/* planning-phase unit outlines are drawn as SPRITE-EDGE silhouettes inside
   drawUnit (outlineFor decides color/alpha); this pass draws only the plotted
   ORDER PATHS: a marching pixel-dash line from each ordered unit to its
   assigned tile, plus corner brackets on the destination. Blue = committed
   (same coding as the order ledger). */
function drawOrderPaths(g_, t){
  if (!orderStates || !orderStates.size) return;
  ctx.save();
  orderStates.forEach((os, id)=>{
    if (os.st !== 'ordered' || !os.target) return;
    const u = scene.units.get(id);
    if (!u || u.alpha <= 0) return;
    const x0 = g_.px(u.x)+g_.txw/2, y0 = g_.py(u.y)+g_.tyh/2;
    const x1 = g_.px(os.target[0])+g_.txw/2, y1 = g_.py(os.target[1])+g_.tyh/2;
    const dx = x1-x0, dy = y1-y0, len = Math.hypot(dx,dy);
    if (len < 2) return;
    const ux = dx/len, uy = dy/len;
    /* marching pixel dashes: chunky squares, phase-scrolled toward the target */
    const step = Math.max(6, g_.tyh*0.36);
    const size = Math.max(2, Math.round(g_.tyh*0.1));
    const phase = (t/900*step) % step;
    ctx.fillStyle = 'rgba('+BLUE_RGB+',.85)';
    for (let d = phase + g_.tyh*0.45; d < len - g_.tyh*0.3; d += step){
      const px = x0+ux*d, py = y0+uy*d;
      ctx.fillRect(Math.round(px-size/2), Math.round(py-size/2), size, size);
    }
    /* destination brackets: four pixel corners on the assigned tile */
    const X = Math.round(g_.px(os.target[0])), Y = Math.round(g_.py(os.target[1]));
    const Wt = Math.round(g_.txw), Ht = Math.round(g_.tyh);
    const L = Math.max(3, Math.round(g_.tyh*0.22)), th = 2;
    const a = .6 + .3*Math.sin(t/220);
    ctx.fillStyle = 'rgba('+BLUE_RGB+','+a.toFixed(3)+')';
    [[X,Y,L,th],[X,Y,th,L], [X+Wt-L,Y,L,th],[X+Wt-th,Y,th,L],
     [X,Y+Ht-th,L,th],[X,Y+Ht-L,th,L], [X+Wt-L,Y+Ht-th,L,th],[X+Wt-th,Y+Ht-L,th,L]]
      .forEach(r=>ctx.fillRect(r[0],r[1],r[2],r[3]));
  });
  ctx.restore();
}
/* tinted sprite silhouettes for edge outlines, cached per (sprite rect, color) */
const silCache = new Map();
function silhouetteOf(img, m, rgb){
  const key = m.x+'_'+m.y+'_'+rgb;
  let c = silCache.get(key);
  if (c) return c;
  c = g.document.createElement('canvas');
  c.width = m.w; c.height = m.h;
  const sctx = c.getContext('2d');
  sctx.drawImage(img, m.x, m.y, m.w, m.h, 0, 0, m.w, m.h);
  sctx.globalCompositeOperation = 'source-in';
  sctx.fillStyle = 'rgb('+rgb+')';
  sctx.fillRect(0, 0, m.w, m.h);
  silCache.set(key, c);
  return c;
}
/* what outline (if any) a unit wears right now: amber = selected, lime breathe
   = awaiting orders, blue (with white flip flash) = order locked, grey = building */
function outlineFor(u, t){
  const tx = Math.round(u.x), ty = Math.round(u.y);
  if (selection && selection[0]===tx && selection[1]===ty)
    return { rgb: AMBER, alpha: .75 + .25*Math.sin(t/180) };
  const os = orderStates && orderStates.get(u.id);
  if (!os) return null;
  if (os.st === 'building') return { rgb: GREY_RGB, alpha: .5 };
  if (os.st === 'ordered'){
    const k = Math.min(1, Math.max(0, (t - os.flipAt) / 220));         /* flip flash: white -> blue */
    const kq = Math.round(k*4)/4;   /* quantized: 5 colors max per sprite in the silhouette cache */
    const rgb = Math.round(61+(255-61)*(1-kq))+','+Math.round(155+(255-155)*(1-kq))+',255';
    return { rgb, alpha: .95 - .2*k };
  }
  return { rgb: LIME_RGB, alpha: .5 + .35*(0.5 + 0.5*Math.sin(t/175)) };
}
/* per-type idle personality: distinct frequency + amplitude + fidgets,
   phase-offset per unit so the board never moves in lockstep */
function idlePose(u, t, g_){
  const ph = hash(u.id)%1000;
  const out = { ox:0, oy:0, rot:0, sx:1, sy:1 };
  if (u.type === 'worker'){
    out.oy = -Math.abs(Math.sin((t+ph)/260))*g_.tyh*0.03;             /* busy scuttle-bounce */
    const fidT = (t + ph*7.9) % 5200;                                  /* double-hop fidget */
    if (fidT < 460){
      const f = fidT/460;
      out.oy -= Math.abs(Math.sin(f*Math.PI*2))*g_.tyh*0.07;
      out.sy = 1 - Math.abs(Math.sin(f*Math.PI*2))*0.06;
    }
    if (u.building){                                                    /* hammering */
      out.rot = Math.sin((t+ph)/110)*0.09;
      out.oy -= Math.abs(Math.sin((t+ph)/110))*g_.tyh*0.02;
    }
  } else if (u.type === 'vehicle'){
    out.oy = Math.sin((t+ph)/70)*g_.tyh*0.008                          /* engine rumble */
           + Math.sin((t+ph)/950)*g_.tyh*0.015;                        /* suspension sway */
  } else if (u.type === 'triangle'){
    out.oy = Math.sin((t+ph)/620)*g_.tyh*0.07;                         /* hover float */
    out.rot = Math.sin((t+ph)/840)*0.06;                               /* lazy tilt */
    out.sx = out.sy = 1 + Math.sin((t+ph)/620)*0.018;
  }
  /* volley body language on top of idle */
  if (u.volley){
    const dir = (u.face||1);
    if (u.type === 'vehicle'){
      if (u.volley.phase==='action') out.ox -= dir*g_.tyh*0.05*Math.abs(Math.sin(u.volley.p*Math.PI*4)); /* recoil judder */
    } else if (u.type === 'worker'){
      const p = u.volley.p;
      if (u.volley.phase==='antic') out.ox -= dir*g_.tyh*0.06*p;                   /* wind up back */
      else out.ox += dir*g_.tyh*0.16*Math.sin(Math.min(1,p*1.4)*Math.PI);           /* jab lunge */
    } else if (u.type === 'triangle'){
      if (u.volley.phase==='antic') out.sy = out.sx = 1 + 0.05*u.volley.p;          /* charge swell */
      else out.sy = out.sx = 1 + 0.05*(1-u.volley.p);
    }
  }
  /* movement gaits layered during tweens */
  if (u.mv){
    if (u.type === 'worker'){
      out.oy -= Math.abs(Math.sin(u.mv.p*Math.PI*u.mv.tiles))*g_.tyh*0.12;          /* hop arcs */
      out.sy = 1 - Math.abs(Math.cos(u.mv.p*Math.PI*u.mv.tiles))*0.05;              /* squash on land */
    } else if (u.type === 'vehicle'){
      /* the face mirror already orients travel toward local +x, so the lean is
         a constant positive rotation — no side/direction compensation needed */
      if (u.mv.dirx) out.rot = 0.06 * Math.sin(Math.min(1,u.mv.p)*Math.PI);          /* tilt into motion */
    } else if (u.type === 'triangle'){
      if (u.mv.dirx) out.rot = 0.16 * Math.sin(u.mv.p*Math.PI);                      /* banking */
      out.oy -= Math.sin(u.mv.p*Math.PI)*g_.tyh*0.1;                                 /* rises mid-flight */
    }
  }
  return out;
}
function drawUnit(g_, u, t){
  if (!META) return;
  const img = IMGS[u.side]; if (!img) return;
  const sideUp = u.side==='a' ? 'A' : 'B';
  const stance = (scene.stances && scene.stances[sideUp] && scene.stances[sideUp][u.type]) || 'default';
  const m = META.sprites[u.type+'_'+stance] || META.sprites[u.type+'_default'];
  if (!m) return;
  const mult = u.type==='vehicle' ? 1.55 : u.type==='triangle' ? 1.35 : 1.2;
  const sc = (g_.tyh*mult)/Math.max(m.w,m.h);
  let w = m.w*sc, h = m.h*sc;
  let alpha = (u.alpha==null ? 1 : u.alpha);
  let spawnScale = 1;
  if (u.born){
    const a = Math.min(1, (clock-u.born)/260);
    alpha *= a;
    spawnScale = easeOutBack(a)*0.4 + 0.6;   /* pop-in: 0.6 -> overshoot -> 1 */
  }
  if (alpha <= 0) return;
  const pose = idlePose(u, t, g_);
  const cx = g_.px(u.x)+g_.txw/2 + pose.ox;
  const cy = g_.py(u.y)+g_.tyh + (u.sink ? u.sink*g_.tyh*0.25 : 0);
  /* facing: engagement/movement sets u.face; default faces the enemy core */
  const face = u.face || (u.side==='a' ? 1 : -1);
  ctx.save();
  ctx.globalAlpha = alpha;
  /* shadow stays unmirrored under the unit; hovers cast a looser one */
  ctx.fillStyle = 'rgba(0,0,5,'+(u.type==='triangle'?'.3':'.45')+')';
  const shW = w*.32*(u.type==='triangle' ? 1+pose.oy/(g_.tyh*0.4) : 1);
  ctx.beginPath(); ctx.ellipse(cx, cy-g_.tyh*.06, Math.max(2,shW), g_.tyh*.1, 0, 0, 7); ctx.fill();
  /* local frame at the unit's feet: mirror/rotate/scale around it */
  ctx.translate(cx, cy);
  if (face < 0) ctx.scale(-1,1);
  if (pose.rot) ctx.rotate(pose.rot);
  ctx.scale(pose.sx*spawnScale, pose.sy*spawnScale);
  const dy = -h + pose.oy - g_.tyh*.08;
  /* sprite-edge glow outline (selection / order state): the tinted silhouette
     stamped at 8 chunky offsets hugs the pixel edges — reads as a highlight of
     the sprite itself, not a box around its tile */
  const ol = outlineFor(u, t);
  if (ol){
    const sil = silhouetteOf(img, m, ol.rgb);
    const o = Math.max(1, Math.round(g_.tyh*0.055));
    ctx.save();
    ctx.globalAlpha = alpha * ol.alpha;
    for (const off of [[o,0],[-o,0],[0,o],[0,-o],[o,o],[o,-o],[-o,o],[-o,-o]])
      ctx.drawImage(sil, -w/2 + off[0], dy + off[1], w|0, h|0);
    /* soft phosphor halo: second ring, additive, farther out and fainter */
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = alpha * ol.alpha * 0.28;
    for (const off of [[2*o,0],[-2*o,0],[0,2*o],[0,-2*o]])
      ctx.drawImage(sil, -w/2 + off[0], dy + off[1], w|0, h|0);
    ctx.restore();
  }
  ctx.drawImage(img, m.x, m.y, m.w, m.h, -w/2, dy, w|0, h|0);
  /* layered FX: combat target flash (flicker) / mid-build pulse */
  const cw = combatWin();
  const flashed = cw!==null && job.targets.has(u.id) && (clock%240 < 120);
  const pulse = u.building ? (0.18 + 0.14*Math.sin(clock/160)) : 0;
  if (flashed || pulse > 0){
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = alpha * (flashed ? 0.6 : pulse);
    ctx.drawImage(img, m.x, m.y, m.w, m.h, -w/2, dy, w|0, h|0);
  }
  ctx.restore();
  /* under-construction badge: floats above the worker, unmirrored screen frame */
  if (u.building){
    ctx.save();
    ctx.globalAlpha = alpha * (0.8 + 0.2*Math.sin(t/260));
    ctx.font = (Math.max(8, g_.tyh*0.42)|0)+'px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    const bobBadge = Math.sin((t + hash(u.id)%1000)/300)*g_.tyh*0.05;
    ctx.fillText('\u{1F6E0}️', cx, cy - h - g_.tyh*0.12 + bobBadge);
    ctx.restore();
  }
}
function drawCore(g_, side, t){
  if (!CORE) return;
  const sideL = side.toLowerCase();
  const pos = corePos(side);
  const cw = combatWin();
  const firing = cw!==null && job.coreFire[side];
  const img = IMGS[firing ? (sideL==='a'?'conA':'conB') : (sideL==='a'?'coffA':'coffB')];
  if (!img) return;
  const sc = (g_.tyh*2.4)/CORE.bodyW, cx = g_.px(pos[0])+g_.txw/2, cy = g_.py(pos[1])+g_.tyh;
  /* idle heartbeat glow so cores never read as dead scenery */
  if (scene.cores[side].hp > 0){
    const col = SIDE_RGB[sideL];
    const beat = 0.05 + 0.035*Math.sin(t/560 + (side==='B'?2.1:0));
    ctx.save(); ctx.globalCompositeOperation='lighter'; ctx.globalAlpha = beat;
    const gr = ctx.createRadialGradient(cx,cy-g_.tyh*.8,0,cx,cy-g_.tyh*.8,g_.tyh*2.2);
    gr.addColorStop(0,'rgba('+col+',1)'); gr.addColorStop(1,'rgba('+col+',0)');
    ctx.fillStyle=gr; ctx.beginPath(); ctx.arc(cx,cy-g_.tyh*.8,g_.tyh*2.2,0,7); ctx.fill();
    ctx.restore();
  }
  ctx.save(); ctx.translate(cx,cy); if (sideL==='b') ctx.scale(-1,1);
  ctx.drawImage(img, -CORE.ax*sc, -CORE.ay*sc, CORE.w*sc, CORE.h*sc);
  ctx.restore();
  const col = SIDE_RGB[sideL];
  if (firing){
    /* zap ring — mockup drawCore "on" code, range from CONST */
    const RG = coreRange(), ph = cw;
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.beginPath(); ctx.rect(g_.gx0,g_.gy0,g_.gw,g_.gh); ctx.clip();
    ctx.fillStyle = 'rgba('+col+','+(0.10+0.05*Math.sin(t/70)).toFixed(3)+')';
    ctx.fillRect(g_.px(pos[0]-RG), g_.py(pos[1]-RG), g_.txw*(RG*2+1), g_.tyh*(RG*2+1));
    for (let k=0;k<3;k++){
      const p = (ph*2.2 + k/3)%1, rx = (0.5+RG*p)*g_.txw, ry = (0.5+RG*p)*g_.tyh;
      ctx.strokeStyle = 'rgba('+col+','+(0.75*(1-p)).toFixed(3)+')';
      ctx.lineWidth = Math.max(1.5, g_.tyh*0.08*(1-p));
      ctx.strokeRect(g_.px(pos[0])+g_.txw/2-rx, g_.py(pos[1])+g_.tyh/2-ry, rx*2, ry*2);
    }
    ctx.restore();
  }
  /* core hit flash when it takes damage this half-turn */
  if (cw!==null && job.coreHit[side] && (clock%220 < 120)){
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = .5;
    ctx.translate(cx,cy); if (sideL==='b') ctx.scale(-1,1);
    ctx.drawImage(img, -CORE.ax*sc, -CORE.ay*sc, CORE.w*sc, CORE.h*sc);
    ctx.restore();
  }
}
function bolt(x0,y0,x1,y1,jit,seed){
  const dx=x1-x0, dy=y1-y0, len=Math.hypot(dx,dy)||1, nx=-dy/len, ny=dx/len;
  ctx.beginPath(); ctx.moveTo(x0,y0);
  for (let s=1;s<8;s++){
    const f=s/8, off=(rng(s*7.7+seed)-.5)*2*jit*Math.sin(f*Math.PI);
    ctx.lineTo(x0+dx*f+nx*off, y0+dy*f+ny*off);
  }
  ctx.lineTo(x1,y1); ctx.stroke();
}
function drawShockAt(g_, from, to, rgb, seedBase, intensity){
  const k = intensity==null ? 1 : intensity;
  const x0=g_.px(from[0])+g_.txw/2, y0=g_.py(from[1])+g_.tyh*.35;
  const x1=g_.px(to[0])+g_.txw/2,   y1=g_.py(to[1])+g_.tyh*.45;
  const seed=((clock/90)|0)+seedBase, flick=clock%260<150, jit=g_.tyh*.14;
  ctx.save(); ctx.globalCompositeOperation='lighter'; ctx.lineCap='round';
  ctx.globalAlpha = k;
  ctx.strokeStyle='rgba('+rgb+',.35)'; ctx.lineWidth=g_.tyh*.2;  bolt(x0,y0,x1,y1,jit,seed);
  ctx.strokeStyle='rgba('+rgb+',.9)';  ctx.lineWidth=g_.tyh*.07; bolt(x0,y0,x1,y1,jit,seed);
  ctx.strokeStyle=flick?'#fff':'#e6ffff'; ctx.lineWidth=g_.tyh*.03; bolt(x0,y0,x1,y1,jit,seed);
  const Rr=(flick?0.38:0.26)*g_.tyh*k;
  ctx.fillStyle='rgba(255,255,255,'+(0.9*k)+')'; ctx.beginPath();
  for (let i=0;i<16;i++){
    const a=i*Math.PI/8+clock/700, r=i%2?Rr:Rr*.38;
    ctx[i?'lineTo':'moveTo'](x1+Math.cos(a)*r, y1+Math.sin(a)*r);
  }
  ctx.closePath(); ctx.fill(); ctx.restore();
}
/* real combat window FX: attack identity per type.
   worker: melee slash (theatrical reach; engine atk 0 elsewhere).
   vehicle: rocket. triangle: electric shock — the ONLY shock user.
   core: zap ring (drawCore) + its own arcs. */
function drawCombatFx(g_){
  const cw = combatWin();
  if (cw===null) return;
  job.combat.forEach((ev,i)=>{
    if (ev.coreFrom){
      /* core zaps its victims: thin arcs on top of the ring */
      const B = posOf(ev.target);
      if (B) drawShockAt(g_, corePos(ev.coreFrom), B, SIDE_RGB[ev.coreFrom.toLowerCase()], 90+i*7, 0.5);
      return;
    }
    const A = posOf(ev.attacker), B = posOf(ev.target);
    if (!A || !B) return;
    const ty = unitTypeOf(ev.attacker);
    if (ty === 'vehicle'){
      drawRocket(g_, { from:A, to:B, p:cw, rgb:rgbOf(ev.attacker), seed:i*13, intensity:1 });
    } else if (ty === 'triangle'){
      drawShockAt(g_, A, B, rgbOf(ev.attacker), i*7, 1);
    } else if (ty === 'worker' || cheb(A,B) <= 1){
      drawMelee(g_, { at:B, from:A, p:cw, rgb:rgbOf(ev.attacker), seed:i*23, intensity:1 });
    } else {
      drawRocket(g_, { from:A, to:B, p:cw, rgb:rgbOf(ev.attacker), seed:i*13, intensity:0.8 });   /* unknown ranged fallback */
    }
  });
  /* ranged fire into cores taking damage */
  job.coreHits.forEach((cd,i)=>{
    if (!cd || !cd.from || !(cd.core==='A'||cd.core==='B')) return;
    const A = posOf(cd.from); if (!A) return;
    const B = corePos(cd.core);
    const ty = unitTypeOf(cd.from);
    if (ty === 'triangle') drawShockAt(g_, A, B, rgbOf(cd.from), 40+i*7, 1);
    else drawRocket(g_, { from:A, to:B, p:cw, rgb:rgbOf(cd.from), seed:40+i*13, intensity:1 });
  });
}
function drawTheatricFx(g_){
  for (const op of fxOps){
    if (op.kind==='rocket') drawRocket(g_, op);
    else if (op.kind==='melee') drawMelee(g_, op);
    else if (op.kind==='shock') drawShockAt(g_, op.from, op.to, op.rgb, op.seed, op.intensity);
    else if (op.kind==='charge') drawCharge(g_, op);
    else if (op.kind==='corepulse'){
      /* soft single expanding square from the core toward its range edge */
      const side = op.side, col = SIDE_RGB[side.toLowerCase()], pos = corePos(side);
      const RG = coreRange(), p = op.p;
      ctx.save(); ctx.globalCompositeOperation='lighter';
      ctx.globalAlpha = op.intensity*(1-p);
      const rx=(0.5+RG*p)*g_.txw, ry=(0.5+RG*p)*g_.tyh;
      ctx.strokeStyle='rgba('+col+',.8)'; ctx.lineWidth=Math.max(1, g_.tyh*0.05*(1-p));
      ctx.strokeRect(g_.px(pos[0])+g_.txw/2-rx, g_.py(pos[1])+g_.tyh/2-ry, rx*2, ry*2);
      ctx.restore();
    }
  }
}
function drawBubble(g_, b){
  const ph = (clock-b.born)/BUBBLE_MS;
  if (ph >= 1) return false;
  const pos = corePos(b.side==='b' ? 'B' : 'A');
  const bx = g_.px(pos[0])+g_.txw*.9;
  const by = g_.py(pos[1])-g_.tyh*.55 - ph*g_.tyh*.5;
  const fade = ph < .75 ? 1 : (1-ph)/.25;
  const col = b.side==='a' ? '#00f1f0' : '#f70395';
  ctx.save(); ctx.globalAlpha = fade;
  ctx.font = 'bold '+(Math.max(8,g_.tyh*.34)|0)+'px "VT323",monospace';
  ctx.textAlign='center'; ctx.textBaseline='middle';
  const w = ctx.measureText(b.text).width+g_.tyh*.4;
  ctx.fillStyle='#04141a'; ctx.strokeStyle=col; ctx.lineWidth=1;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(bx-w/2,by-g_.tyh*.28,w,g_.tyh*.56,4);
  else ctx.rect(bx-w/2,by-g_.tyh*.28,w,g_.tyh*.56);
  ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(bx-3,by+g_.tyh*.26); ctx.lineTo(bx+3,by+g_.tyh*.26); ctx.lineTo(bx-1,by+g_.tyh*.44);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle=col; ctx.fillText(b.text,bx,by+1);
  ctx.restore();
  return true;
}

/* ===== main loop ===== */
function advance(dt){
  if (paused) return;
  clock += dt*speed;
  if (!job && queue.length) startJob(queue.shift());
  if (job){ job.elapsed += dt*speed; stepJob(); }
}
let lastFrameAt = 0;
function frame(ts){
  const dt = lastTs ? Math.min(100, ts-lastTs) : 16;
  lastTs = ts;
  lastFrameAt = Date.now();
  advance(dt);
  draw(clock);
  g.requestAnimationFrame(frame);
}
/* rAF-starvation fallback: browsers freeze rAF in hidden AND occluded tabs —
   which in web-tab mode is exactly when the user is off watching the chatbot
   type. The match loop awaits onIdle per half-turn, so without this the game
   would stop sending turns until the tab is foregrounded again. Timer ticks
   the job machine only (drawing stays rAF-only); hidden-tab timers are
   clamped to ~1s, which advance() handles fine as a chunky dt. */
let starvedLast = 0;
function hiddenTick(){
  const now = Date.now();
  if (lastFrameAt && now - lastFrameAt < 1500){ starvedLast = 0; return; }   /* rAF alive */
  const dt = starvedLast ? Math.min(1500, now - starvedLast) : 500;
  starvedLast = now;
  lastTs = 0;   /* don't double-count the frozen gap on the next real frame */
  advance(dt);
}
function draw(t){
  if (!ctx || !board.width || !board.height) return;
  ctx.imageSmoothingEnabled = false;   /* crisp pixel scaling (resets on resize) */
  const g_ = geom();
  /* explosion screen shake: clear in identity space, draw the scene shifted */
  let shaking = false;
  if (t < shakeUntil && shakeMag > 0){
    shaking = true;
    ctx.clearRect(0, 0, g_.W, g_.H);
    ctx.fillStyle = '#0b0810'; ctx.fillRect(0, 0, g_.W, g_.H);
    const f = (shakeUntil - t) / 260;
    ctx.save();
    ctx.translate((rng((t|0)*1.7)-.5)*2*shakeMag*f, (rng((t|0)*2.3+7)-.5)*2*shakeMag*f);
  } else {
    shakeMag = 0;
  }
  drawTiles(g_);
  drawHighlight(g_, t);
  drawOrderPaths(g_, t);
  updateTheatrics();
  drawCore(g_, 'A', t); drawCore(g_, 'B', t);
  const us = Array.from(scene.units.values()).sort((a,b)=>a.y-b.y);
  us.forEach(u=>drawUnit(g_, u, t));
  drawTheatricFx(g_);
  drawCombatFx(g_);
  drawParts(g_);
  bubbles = bubbles.filter(b=>drawBubble(g_, b));
  if (shaking) ctx.restore();
}

/* ===== HUD canvas helpers (thumbs / avatars / trollcrt) — from mockup ===== */
function fitDraw(c,img,sx,sy,sw,sh,cw,ch,pad){
  pad = pad||0;
  const s = Math.min((cw-pad*2)/sw,(ch-pad*2)/sh);
  c.drawImage(img,sx,sy,sw,sh,(cw-sw*s)/2,(ch-sh*s)/2,sw*s,sh*s);
}
function thumbs(){
  if (!META || !IMGS.a) return;
  g.document.querySelectorAll('[data-thumb]').forEach(el=>{
    el.width = el.height = 52;
    const c = el.getContext('2d'); c.imageSmoothingEnabled = false;
    const m = META.sprites[el.dataset.thumb]; if (!m) return;
    fitDraw(c,IMGS.a,m.x,m.y,m.w,m.h,52,52,1);
  });
}
function avatars(){
  if (!CORE) return;
  [['avA','coffA'],['avB','coffB']].forEach(pair=>{
    const id=pair[0], key=pair[1];
    const el = g.document.querySelector('#'+id+' canvas');
    if (!el || !IMGS[key]) return;
    el.width = el.height = 96;
    const c = el.getContext('2d'); c.imageSmoothingEnabled = false;
    /* crop the core BODY (screen+dish) from the off frame */
    fitDraw(c,IMGS[key],CORE.ax-CORE.bodyW/2,CORE.ay-CORE.bodyH,CORE.bodyW,CORE.bodyH,96,96,2);
    c.fillStyle = id==='avA' ? 'rgba(0,241,240,.08)' : 'rgba(247,3,149,.08)';
    c.fillRect(0,0,96,96);
  });
}
function trollcrt(){
  if (!CORE || !IMGS.coffA) return;
  const c = g.document.getElementById('trollcrt');
  if (!c) return;
  c.width = CORE.bodyW; c.height = CORE.bodyH;
  const g2 = c.getContext('2d'); g2.imageSmoothingEnabled = false;
  g2.drawImage(IMGS.coffA,CORE.ax-CORE.bodyW/2,CORE.ay-CORE.bodyH,CORE.bodyW,CORE.bodyH,0,0,CORE.bodyW,CORE.bodyH);
}

NS.Render = {
  init, renderState, enqueue, onIdle, setSpeed, setPaused, skipAll,
  tileAt, setHighlight, clearHighlight, setSelection, setOrderStates, emote,
};
})(typeof window !== 'undefined' ? window : globalThis);
