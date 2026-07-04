// AI WARS — audio.js — AIWARS.Audio (CONTRACTS §9, audio-event-contract.md, sound-design-skill.md)
// Optional-load soft synth. Procedural, warm, never bleepy: sine/triangle
// core palette (square only as a low-gain color layer behind triangle,
// lowpassed <=2.4kHz), gentle exponential envelopes, shared noise buffer,
// detune pairs + slow vibrato for warmth.
// Graph: sfxBus + ambientBus -> master(0.5, mute here) -> safety limiter
// (thr -18, knee 20, ratio 8, atk .003, rel .25) -> lowpass 6.8kHz -> out.
// Per-event cooldowns, hard 3-voices-per-50ms budget, +-2.5% pitch and
// +-10% gain randomization per voice (anti-fatigue).
// Every public function is a safe no-op before init() or without WebAudio.
(function(g){
  const NS = g.AIWARS = g.AIWARS || {};

  let ctx = null;         // AudioContext, created lazily by init()
  let master = null;      // master gain (mute lives here)
  let sfxBus = null;      // all one-shot voices
  let ambientBus = null;  // drone bed level + ducking
  let noiseBuf = null;    // shared 2s white-noise buffer, made once at init
  let initFailed = false;
  let muted = false;

  const MASTER_GAIN = 0.5;
  const LP_MASTER_HZ = 6800;
  const AMBIENT_GAIN = 0.30;
  const VOICE_BUDGET = 3;        // max voices starting per 50ms window
  const MUTE_KEY = 'aiwars.muted';

  // Restore persisted mute early so UI reads the right state pre-init.
  try {
    if (g.localStorage && g.localStorage.getItem(MUTE_KEY) === '1') muted = true;
  } catch (e){ /* storage blocked — default unmuted */ }

  const lastPlay = {};     // event -> ctx time of last accepted play (cooldown)
  let voiceStarts = [];    // scheduled voice start times (budget window)

  // Per-event-type cooldowns (seconds) — the anti-bleep valve.
  const COOLDOWN = {
    // existing 7
    move: 0.09,
    buildStart: 0.06,
    buildDone: 0.08,
    hit: 0.12,
    death: 0.18,
    coreHit: 0.25,
    matchEnd: 0.8,
    // polish-pass 13
    select: 0.05,
    orderSet: 0.08,
    deployQueued: 0.08,
    invalid: 0.15,
    endTurn: 0.5,
    turnStart: 0.5,
    emote: 0.4,
    chat: 0.12,
    volley: 0.15,
    uiTick: 0.05,
    victory: 2.0,
    defeat: 2.0,
    matchStart: 1.0
  };

  // Loudness tiers (Into-the-Breach law: frequent = quiet, rare = big).
  // Tier >= 2 ducks the ambient bed to 40% for ~0.5s.
  const TIER = {
    move: 0, select: 0, uiTick: 0, chat: 0, turnStart: 0, volley: 0,
    buildStart: 1, buildDone: 1, hit: 1, orderSet: 1, deployQueued: 1,
    invalid: 1, endTurn: 1, emote: 1,
    death: 2, coreHit: 2, matchStart: 2,
    matchEnd: 3, victory: 3, defeat: 3
  };

  function AC(){ return g.AudioContext || g.webkitAudioContext; }

  // init() — idempotent; safe to call anytime. Wire it to the first user
  // gesture (also auto-armed below) so the context isn't born suspended.
  function init(){
    if (ctx){ resume(); return; }
    if (initFailed || typeof AC() !== 'function'){ initFailed = true; return; }
    try {
      ctx = new (AC())();

      // Final tone control: everything exits through this lowpass.
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = LP_MASTER_HZ;
      lp.connect(ctx.destination);

      // Safety limiter — catches SFX pile-ups, not a glue compressor.
      let tail = lp;
      try {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -18;
        comp.knee.value = 20;
        comp.ratio.value = 8;
        comp.attack.value = 0.003;
        comp.release.value = 0.25;
        comp.connect(lp);
        tail = comp;
      } catch (e){ /* no compressor — degrade to plain lowpass */ }

      master = ctx.createGain();
      master.gain.value = muted ? 0 : MASTER_GAIN;
      master.connect(tail);

      sfxBus = ctx.createGain();
      sfxBus.gain.value = 1.0;
      sfxBus.connect(master);

      ambientBus = ctx.createGain();
      ambientBus.gain.value = AMBIENT_GAIN;
      ambientBus.connect(master);

      noiseBuf = makeNoiseBuf();
      watchVisibility();
      resume();
      if (ambientWanted) startAmbient();
    } catch (e){
      initFailed = true;
      ctx = null; master = null; sfxBus = null; ambientBus = null;
    }
  }

  function resume(){
    if (ctx && ctx.state === 'suspended'){
      try { ctx.resume(); } catch (e){ /* no-op */ }
    }
  }

  // Auto-init on the first user gesture (browser only; harmless elsewhere).
  if (typeof g.addEventListener === 'function' && typeof g.removeEventListener === 'function'){
    const arm = function(){
      g.removeEventListener('pointerdown', arm);
      g.removeEventListener('keydown', arm);
      init();
    };
    try {
      g.addEventListener('pointerdown', arm);
      g.addEventListener('keydown', arm);
    } catch (e){ /* environments without UI events */ }
  }

  // One shared 2s white-noise buffer, rendered once, reused forever.
  function makeNoiseBuf(){
    try {
      const len = Math.floor(ctx.sampleRate * 2);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      return buf;
    } catch (e){ return null; }
  }

  // Voice budget: at most VOICE_BUDGET voices starting within any 50ms window.
  function takeVoiceSlot(t0){
    voiceStarts = voiceStarts.filter(function(t){ return Math.abs(t0 - t) < 0.05 || t > t0; });
    let inWindow = 0;
    for (const t of voiceStarts){ if (Math.abs(t0 - t) < 0.05) inWindow++; }
    if (inWindow >= VOICE_BUDGET) return false;
    voiceStarts.push(t0);
    return true;
  }

  // One enveloped tonal voice. o: {type, freq, freqEnd, dur, gain, attack,
  // delay, at, lpf, pair, vibrato, square}.
  //   at      — absolute ctx time to schedule from (for sequencers); default now.
  //   pair    — two oscillators detuned +-4 cents into one envelope (warmth).
  //   vibrato — depth in cents; 5.5Hz LFO on detune (long notes only).
  //   square  — add quiet square color layer (0.3x gain, lowpass <=2.4kHz).
  // Applies +-2.5% pitch and +-10% gain randomization (anti-fatigue).
  function voice(o){
    if (!ctx || !sfxBus) return;
    const t0 = (o.at != null ? o.at : ctx.currentTime) + (o.delay || 0);
    if (!takeVoiceSlot(t0)) return;
    try {
      const dur = o.dur || 0.1;
      const attack = o.attack != null ? o.attack : 0.015;
      const end = t0 + Math.max(dur, attack + 0.06); // decay >=60ms kills clicks
      const rp = 1 + (Math.random() * 2 - 1) * 0.025;
      const rg = 1 + (Math.random() * 2 - 1) * 0.10;
      const peak = Math.max(0.0002, (o.gain || 0.06) * rg);

      // Soft exponential envelope — no hard on/off clicks.
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.exponentialRampToValueAtTime(peak, t0 + attack);
      env.gain.exponentialRampToValueAtTime(0.0001, end);

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = o.lpf || 3200;

      env.connect(lp); lp.connect(sfxBus);

      const oscs = [];
      function mkOsc(type, cents, dest){
        const osc = ctx.createOscillator();
        osc.type = type;
        if (cents) osc.detune.value = cents;
        osc.frequency.setValueAtTime(o.freq * rp, t0);
        if (o.freqEnd) osc.frequency.exponentialRampToValueAtTime(o.freqEnd * rp, t0 + dur);
        osc.connect(dest);
        oscs.push(osc);
      }

      const type = o.type || 'sine';
      if (o.pair){ mkOsc(type, 4, env); mkOsc(type, -4, env); }
      else mkOsc(type, 0, env);

      if (o.square){
        // Square only ever as a color layer: 0.3x gain, own lowpass <=2.4kHz.
        const cg = ctx.createGain(); cg.gain.value = 0.3;
        const clp = ctx.createBiquadFilter();
        clp.type = 'lowpass';
        clp.frequency.value = Math.min(2400, o.lpf || 2400);
        clp.connect(cg); cg.connect(env);
        mkOsc('square', 0, clp);
      }

      if (o.vibrato){
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 5.5;
        const lg = ctx.createGain();
        lg.gain.value = o.vibrato;
        lfo.connect(lg);
        for (const osc of oscs) lg.connect(osc.detune);
        lfo.start(t0); lfo.stop(end + 0.05);
      }

      for (const osc of oscs){ osc.start(t0); osc.stop(end + 0.05); }
    } catch (e){ /* never let audio kill the game loop */ }
  }

  // Filtered-noise voice (thocks, whooshes, rattles). o: {dur, gain, attack,
  // delay, at, filter, freq, freqEnd, q}. Counts toward the voice budget.
  function noise(o){
    if (!ctx || !sfxBus || !noiseBuf) return;
    const t0 = (o.at != null ? o.at : ctx.currentTime) + (o.delay || 0);
    if (!takeVoiceSlot(t0)) return;
    try {
      const dur = o.dur || 0.08;
      const attack = o.attack != null ? o.attack : 0.005;
      const end = t0 + Math.max(dur, attack + 0.06);
      const rg = 1 + (Math.random() * 2 - 1) * 0.10;
      const peak = Math.max(0.0002, (o.gain || 0.03) * rg);

      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = true;
      src.playbackRate.value = 1 + (Math.random() * 2 - 1) * 0.025;

      const f = ctx.createBiquadFilter();
      f.type = o.filter || 'lowpass';
      f.frequency.setValueAtTime(o.freq || 1000, t0);
      if (o.freqEnd) f.frequency.exponentialRampToValueAtTime(o.freqEnd, t0 + dur);
      if (o.q) f.Q.value = o.q;

      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.exponentialRampToValueAtTime(peak, t0 + attack);
      env.gain.exponentialRampToValueAtTime(0.0001, end);

      src.connect(f); f.connect(env); env.connect(sfxBus);
      src.start(t0);
      src.stop(end + 0.05);
    } catch (e){ /* never let audio kill the game loop */ }
  }

  // ---- Event palette — everything diatonic to C major / A minor. ----------
  // Interval law: ascending = positive, descending = loss, minor 2nd = error.
  const SOUNDS = {
    // near-inaudible tick, +2st chirp (elevated original)
    move: function(){
      voice({ type: 'sine', freq: 660, freqEnd: 740, dur: 0.05, gain: 0.02, attack: 0.008, lpf: 2200 });
    },
    // warm C4-E4-G4 arp up, detune pairs (elevated original)
    buildStart: function(){
      [262, 330, 392].forEach(function(f, i){
        voice({ type: 'triangle', freq: f, dur: 0.14, gain: 0.05, delay: i * 0.07, lpf: 2800, pair: true });
      });
    },
    // G4-B4-D5 a register up + C5 resolve note (elevated original)
    buildDone: function(){
      [392, 494, 587].forEach(function(f, i){
        voice({ type: 'triangle', freq: f, dur: 0.16, gain: 0.05, delay: i * 0.07, lpf: 3000, pair: true });
      });
      voice({ type: 'triangle', freq: 523, dur: 0.2, gain: 0.05, delay: 0.21, lpf: 3000, pair: true });
    },
    // soft pluck + noise thock — thock, not beep (elevated original)
    hit: function(){
      voice({ type: 'triangle', freq: 196, dur: 0.09, gain: 0.07, attack: 0.005, lpf: 1200 });
      noise({ dur: 0.06, gain: 0.03, filter: 'bandpass', freq: 1200, q: 1 });
    },
    // falling slide + swept noise tail — loss contour (elevated original)
    death: function(){
      voice({ type: 'sine', freq: 280, freqEnd: 120, dur: 0.35, gain: 0.06, lpf: 1600 });
      noise({ dur: 0.3, gain: 0.035, freq: 1400, freqEnd: 300, attack: 0.01 });
    },
    // weighty low pair + noise thump (elevated original; ducks ambient)
    coreHit: function(){
      voice({ type: 'sine', freq: 110, dur: 0.3, gain: 0.09, lpf: 900 });
      voice({ type: 'triangle', freq: 82, dur: 0.35, gain: 0.05, delay: 0.02, lpf: 700 });
      noise({ dur: 0.08, gain: 0.04, freq: 500 });
    },
    // neutral resolving phrase — fallback when no winner context (elevated)
    matchEnd: function(){
      [262, 330, 392, 523].forEach(function(f, i){
        voice({ type: 'sine', freq: f, dur: 0.5, gain: 0.06, delay: i * 0.16, lpf: 3000, pair: true, vibrato: i === 3 ? 7 : 0 });
      });
    },

    // whisper cursor tick, ascending micro-blip (A5 -> B5)
    select: function(){
      voice({ type: 'sine', freq: 880, freqEnd: 988, dur: 0.04, gain: 0.02, attack: 0.003, lpf: 2600 });
    },
    // soft confirm: ascending M3 pair C5 -> E5
    orderSet: function(){
      voice({ type: 'triangle', freq: 523, dur: 0.09, gain: 0.05, attack: 0.008, lpf: 3000 });
      voice({ type: 'triangle', freq: 659, dur: 0.09, gain: 0.05, delay: 0.055, attack: 0.008, lpf: 3000 });
    },
    // two-note up chirp A4 -> D5, distinct from buildStart's 3-note arp
    deployQueued: function(){
      voice({ type: 'triangle', freq: 440, freqEnd: 466, dur: 0.08, gain: 0.05, attack: 0.006, lpf: 2900 });
      voice({ type: 'triangle', freq: 587, freqEnd: 622, dur: 0.08, gain: 0.05, delay: 0.05, attack: 0.006, lpf: 2900 });
    },
    // muted minor-2nd rub B3+C4 — dull dunk, lowpassed, never a shriek
    invalid: function(){
      voice({ type: 'triangle', freq: 247, dur: 0.12, gain: 0.045, attack: 0.008, lpf: 1800 });
      voice({ type: 'triangle', freq: 262, dur: 0.12, gain: 0.045, attack: 0.008, lpf: 1800 });
    },
    // committing G3 thock + rising noise whoosh
    endTurn: function(){
      voice({ type: 'triangle', freq: 196, dur: 0.12, gain: 0.06, attack: 0.005, lpf: 2200 });
      noise({ dur: 0.3, gain: 0.022, filter: 'bandpass', freq: 500, freqEnd: 1800, q: 1.2, attack: 0.05 });
    },
    // quiet single tick, barely-there (fires every half-turn)
    turnStart: function(){
      voice({ type: 'sine', freq: 784, dur: 0.05, gain: 0.018, attack: 0.004, lpf: 3200 });
    },
    // playful mordent E5-G5-E5
    emote: function(){
      voice({ type: 'triangle', freq: 659, dur: 0.06, gain: 0.045, delay: 0,     attack: 0.006, lpf: 3000 });
      voice({ type: 'triangle', freq: 784, dur: 0.06, gain: 0.045, delay: 0.045, attack: 0.006, lpf: 3000 });
      voice({ type: 'triangle', freq: 659, dur: 0.06, gain: 0.045, delay: 0.09,  attack: 0.006, lpf: 3000 });
    },
    // near-subliminal typewriter tick
    chat: function(){
      voice({ type: 'sine', freq: 1200, dur: 0.025, gain: 0.012, attack: 0.003, lpf: 3000 });
    },
    // distant soft rattle, quieter than hit
    volley: function(){
      noise({ dur: 0.09, gain: 0.022, filter: 'bandpass', freq: 1000, q: 1.4 });
      voice({ type: 'sine', freq: 165, dur: 0.06, gain: 0.018, attack: 0.004, lpf: 900 });
    },
    // near-inaudible UI click
    uiTick: function(){
      voice({ type: 'sine', freq: 1047, dur: 0.03, gain: 0.015, attack: 0.003, lpf: 2800 });
    },
    // resolving C-major flourish, square color layer, vibrato on the hold
    victory: function(){
      [262, 330, 392, 523].forEach(function(f, i){
        voice({ type: 'triangle', freq: f, dur: 0.18, gain: 0.055, delay: i * 0.11, lpf: 3000, pair: true, square: true });
      });
      voice({ type: 'triangle', freq: 659, dur: 0.7, gain: 0.06, delay: 0.44, lpf: 3000, pair: true, square: true, vibrato: 8 });
    },
    // descending A-minor resolve, dignified, still gentle
    defeat: function(){
      [440, 330, 262].forEach(function(f, i){
        voice({ type: 'sine', freq: f, dur: 0.22, gain: 0.05, delay: i * 0.15, lpf: 1600, pair: true });
      });
      voice({ type: 'sine', freq: 220, dur: 0.8, gain: 0.05, delay: 0.45, lpf: 1600, pair: true, vibrato: 6 });
    },
    // systems-online power-up sweep C3 -> C5 + swept noise + landing blip
    matchStart: function(){
      voice({ type: 'sine', freq: 131, freqEnd: 523, dur: 0.45, gain: 0.05, attack: 0.02, lpf: 2600 });
      noise({ dur: 0.45, gain: 0.02, freq: 300, freqEnd: 2000, attack: 0.04 });
      voice({ type: 'triangle', freq: 523, dur: 0.16, gain: 0.04, delay: 0.42, lpf: 3000, pair: true });
    }
  };

  // ---- Ambient bed: C2+G2 open-fifth drone + lowpassed noise, 3 LFOs ------
  // LFO rates mutually irrational (0.071 / 0.047 / 0.113 Hz) so it never
  // repeats. ~12 nodes total, negligible CPU. Idempotent on/off with fades.
  let amb = null;            // live node handle, null when off
  let ambientWanted = false; // remembered across pre-init calls

  function makeLfo(rate, depth, param){
    const osc = ctx.createOscillator();
    osc.frequency.value = rate;
    const gn = ctx.createGain();
    gn.gain.value = depth;
    osc.connect(gn); gn.connect(param);
    osc.start();
    return osc;
  }

  function startAmbient(){
    if (!ctx || !ambientBus || !noiseBuf || amb) return; // never double the drone
    try {
      const t = ctx.currentTime;

      // Dedicated fade stage so ducking (on ambientBus) never fights fades.
      const fade = ctx.createGain();
      fade.gain.setValueAtTime(0.0001, t);
      fade.gain.setTargetAtTime(1, t, 0.7); // ~2s soft fade-in
      fade.connect(ambientBus);

      const droneGain = ctx.createGain();
      droneGain.gain.value = 0.022;
      droneGain.connect(fade);

      const oscA = ctx.createOscillator();
      oscA.type = 'triangle'; oscA.frequency.value = 65.41; oscA.detune.value = 3;
      const oscB = ctx.createOscillator();
      oscB.type = 'sine'; oscB.frequency.value = 98.0; oscB.detune.value = -4;
      oscA.connect(droneGain); oscB.connect(droneGain);

      const nlp = ctx.createBiquadFilter();
      nlp.type = 'lowpass'; nlp.frequency.value = 650;
      const noiseGain = ctx.createGain();
      noiseGain.gain.value = 0.010;
      const nsrc = ctx.createBufferSource();
      nsrc.buffer = noiseBuf; nsrc.loop = true;
      nsrc.connect(nlp); nlp.connect(noiseGain); noiseGain.connect(fade);

      const lfo1 = makeLfo(0.071, 180, nlp.frequency);    // filter breathes
      const lfo2 = makeLfo(0.047, 0.006, droneGain.gain); // drone swells
      const lfo3 = makeLfo(0.113, 5, oscA.detune);        // slow drift

      oscA.start(t); oscB.start(t); nsrc.start(t);
      amb = { fade: fade, nodes: [oscA, oscB, nsrc, lfo1, lfo2, lfo3] };
    } catch (e){ amb = null; }
  }

  function stopAmbient(){
    if (!ctx || !amb) return;
    const a = amb;
    amb = null; // released immediately: a new ambient(true) builds fresh
    try {
      const t = ctx.currentTime;
      a.fade.gain.cancelScheduledValues(t);
      a.fade.gain.setTargetAtTime(0.0001, t, 0.15); // soft fade-out
      for (const n of a.nodes){
        try { n.stop(t + 0.9); } catch (e){ /* already stopped */ }
      }
    } catch (e){ /* no-op */ }
  }

  // ambient(on) — idempotent, no-op safe pre-init (remembered until init).
  function ambient(on){
    ambientWanted = !!on;
    if (!ctx || !ambientBus) return;
    if (on) startAmbient(); else stopAmbient();
  }

  // Duck the bed to 40% under tier-2/3 events; recover over ~0.5s.
  // Gain automation, not compressor sidechain (WebAudio has none).
  function duckAmbient(){
    if (!ctx || !ambientBus || !amb) return;
    try {
      const t = ctx.currentTime;
      ambientBus.gain.cancelScheduledValues(t);
      ambientBus.gain.setTargetAtTime(AMBIENT_GAIN * 0.4, t, 0.02);
      ambientBus.gain.setTargetAtTime(AMBIENT_GAIN, t + 0.15, 0.35);
    } catch (e){ /* no-op */ }
  }

  // Silence the bed while the tab is hidden (scheduler-drift gotcha).
  function watchVisibility(){
    const doc = g.document;
    if (!doc || typeof doc.addEventListener !== 'function') return;
    try {
      doc.addEventListener('visibilitychange', function(){
        if (!ctx || !ambientBus) return;
        try {
          const t = ctx.currentTime;
          ambientBus.gain.cancelScheduledValues(t);
          ambientBus.gain.setTargetAtTime(doc.hidden ? 0.0001 : AMBIENT_GAIN, t, doc.hidden ? 0.1 : 0.3);
        } catch (e){ /* no-op */ }
      });
    } catch (e){ /* no-op */ }
  }

  // play('coreHit') — no-op when uninitialized, muted, unknown, or cooling down.
  function play(event){
    if (!ctx || !master || muted) return;
    const fn = SOUNDS[event];
    if (!fn) return;
    resume();
    const now = ctx.currentTime;
    const cd = COOLDOWN[event] != null ? COOLDOWN[event] : 0.1;
    if (lastPlay[event] != null && now - lastPlay[event] < cd) return;
    lastPlay[event] = now;
    if ((TIER[event] || 0) >= 2) duckAmbient();
    fn();
  }

  function setMuted(m){
    muted = !!m;
    try { if (g.localStorage) g.localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e){ /* no-op */ }
    if (master){
      try {
        const t = ctx.currentTime;
        master.gain.cancelScheduledValues(t);
        master.gain.setTargetAtTime(muted ? 0 : MASTER_GAIN, t, 0.02); // click-free
      } catch (e){
        master.gain.value = muted ? 0 : MASTER_GAIN;
      }
    }
  }

  function toggleMute(){
    setMuted(!muted);
    return muted;
  }

  function isMuted(){ return muted; }

  NS.Audio = {
    init: init,
    play: play,
    ambient: ambient,
    setMuted: setMuted,
    toggleMute: toggleMute,
    isMuted: isMuted
  };
})(typeof window !== 'undefined' ? window : globalThis);
