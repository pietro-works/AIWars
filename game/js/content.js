// AI WARS — content.js — AIWARS.Content (CONTRACTS §8, masterplan §13)
// All user-facing strings flow through Content.get(path, vars). Copy lives in
// content/tone-pack.json (the swappable seam for the later tone pass); the
// same pack is embedded here as DEFAULT so the game also runs from file://
// where fetch() is unavailable. Keep both copies in sync.
(function(g){
  const NS = g.AIWARS = g.AIWARS || {};

  // Mirror of game/content/tone-pack.json — placeholder, functional tone only.
  // PACS0013 — embedded mirror of content/tone-pack.json; keep keys+copy identical (Content.get returns the path string on miss, no throw) — AGENTS.md
  const DEFAULT_PACK = {
    unitFlavorNames: {
      worker: ['Worker'],
      vehicle: ['Vehicle'],
      triangle: ['Triangle'],
      core: ['Core']
    },
    uiCopy: {
      titleScreen: 'AI WARS',
      matchSetup: 'Configure combatants',
      loadingLines: [
        'Booting battle grid...',
        'Aligning doctrine matrices...',
        'Waking the cores...'
      ],
      sendLines: [
        'gl hf, machine.',
        'The grid is watching.',
        'All units, look busy.',
        'This turn is sponsored by hubris.',
        'Ping received. Morale unchanged.',
        'Somebody feed the cores.'
      ],
      insultLines: [
        'Your pathfinding smells like dial-up.',
        'I have seen smarter heuristics in a toaster.',
        'Your core called. It wants a better general.',
        'Nice doctrine. Did a worker write it?',
        'You move like a 300ms ping.',
        'Your build queue is a cry for help.',
        'Even the spectators are embarrassed.'
      ]
    },
    eventLines: {
      matchStart: [
        'Match start. {labelA} vs {labelB}. Grid armed.',
        'Combat grid online. {labelA} against {labelB}.'
      ],
      turnStart: [
        'Turn {turn}. {label} to act.',
        'Turn {turn}: {label} takes the field.',
        'Turn {turn}. {label} has the floor.',
        'Turn {turn} — {label} moves.',
        'Turn {turn}. All eyes on {label}.'
      ],
      thinking: [
        '{label} is thinking...',
        '{label} computing orders...',
        '{label} weighing options...',
        '{label} consulting the doctrine...',
        '{label} crunching the board state...'
      ],
      buildStarted: [
        '{worker} started building a {produces}. Ready turn {completesTurn}.',
        '{worker} begins {produces} construction. ETA turn {completesTurn}.',
        '{worker} breaks ground on a {produces}. Done turn {completesTurn}.',
        '{worker} is assembling a {produces}. Online turn {completesTurn}.',
        'Blueprint accepted: {worker} builds a {produces} by turn {completesTurn}.'
      ],
      buildCompleted: [
        '{worker} finished a {produces}. {unit} deployed.',
        'Build complete: {unit} rolls off the line.',
        '{unit} assembled. Warranty void immediately.',
        'Fresh hardware: {unit} reports for duty.',
        '{unit} powered on. It did not ask to be born.'
      ],
      unitDied: [
        '{unit} destroyed.',
        '{unit} lost. Signal terminated.',
        '{unit} is scrap now.',
        '{unit} went dark.',
        '{unit} decommissioned, violently.',
        'Connection to {unit} lost. Permanently.'
      ],
      coreHit: [
        'Core {side} under attack. -{dmg} HP.',
        'Direct hit on core {side} for {dmg}.',
        'Core {side} takes {dmg}. Sparks everywhere.',
        'Core {side} integrity down {dmg}.',
        'Someone is chewing on core {side}: -{dmg}.'
      ],
      coreSpawn: [
        'Core {side} minted a worker: {unit} online.',
        'Passive production: {unit} joins side {side}.',
        'Core {side} prints labor: {unit}.',
        'New hire on side {side}: {unit}. No benefits.',
        '{unit} spawned at core {side}. Straight to work.'
      ],
      coreDestroyed: [
        'Core {side} destroyed.',
        'Core {side} has fallen.'
      ],
      parseFailed: [
        '{label} returned invalid orders. Turn skipped.',
        '{label} failed to produce valid JSON. No actions this turn.'
      ]
    },
    victoryBanners: {
      win: [
        '{label} wins by {reason}.',
        'Victory: {label}. Cause: {reason}.'
      ],
      loss: [
        '{label} is defeated.',
        '{label} loses the match.'
      ],
      draw: [
        'Draw. Both machines stand down.',
        'Stalemate. No victor this cycle.'
      ]
    }
  };

  let pack = DEFAULT_PACK;
  const cursors = {}; // per-path round-robin index, so repeated lines vary deterministically

  function resolve(path){
    if (typeof path !== 'string' || !path) return null;
    let node = pack;
    for (const key of path.split('.')){
      if (node == null || typeof node !== 'object') return null;
      node = node[key];
    }
    return node == null ? null : node;
  }

  function interpolate(str, vars){
    return str.replace(/\{(\w+)\}/g, function(m, k){
      return (vars && Object.prototype.hasOwnProperty.call(vars, k)) ? String(vars[k]) : m;
    });
  }

  // get('eventLines.coreHit', {side:'A', dmg:12}) -> one string.
  // Arrays rotate round-robin; unknown paths return the path itself so a
  // missing line is visible in the UI instead of throwing mid-match.
  function get(path, vars){
    const v = resolve(path);
    if (v == null) return String(path);
    let s;
    if (Array.isArray(v)){
      if (!v.length) return String(path);
      const i = (cursors[path] || 0) % v.length;
      cursors[path] = i + 1;
      s = String(v[i]);
    } else if (typeof v === 'string'){
      s = v;
    } else {
      return String(path); // pointed at a branch, not a leaf
    }
    return interpolate(s, vars);
  }

  // Swap in a different tone pack (the whole point of the seam).
  function setPack(p){
    if (p && typeof p === 'object' && !Array.isArray(p)) pack = p;
  }

  // Optional async load of an external pack (e.g. 'content/tone-pack.json').
  // Never throws; resolves true on success, false otherwise. The embedded
  // DEFAULT_PACK stays active until then, so nothing depends on this.
  function load(url){
    if (typeof g.fetch !== 'function') return Promise.resolve(false);
    return g.fetch(url)
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(json){ if (json){ setPack(json); return true; } return false; })
      .catch(function(){ return false; });
  }

  NS.Content = { get: get, setPack: setPack, load: load };
})(typeof window !== 'undefined' ? window : globalThis);
