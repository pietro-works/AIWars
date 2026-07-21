# AI Wars — agent index

Browser LLM-vs-LLM pixel strategy game. Plain `<script>` tags, no build step, deterministic
engine. Everything hangs off the `AIWARS` (`NS`) namespace. Entry point is `game/index.html`,
which loads `game/js/*.js` and `assets/sprites/*.js` in order; the match engine is
`game/js/engine.js`; the splash is a separate `assets/splash/splash.html` loaded in an iframe.

## PACS Registry

PACS codes tag **load-bearing invariants**: a coupling where one edit (adding a producer, a
type, a message, a field) forces a matching edit at a **distant, non-obvious** site, and missing
that second edit **fails silently** — no error, no crash, just wrong or dead behavior. The
registry below is the source of truth; each code is also tagged in the code at its anchor as
`// PACS#### — … — AGENTS.md` (`/* */` in CSS/template strings, `<!-- -->` in markup, `#` in
shell; JSON files carry no tag and are covered by the registry only).

**Minting** (same change that introduces the coupling): take the next free number (append-only,
never reuse), add a row here, tag the anchor in code. **Consuming**: before editing near a
`PACS####` tag, read its row and satisfy every touch-point. **Report**: name the PACS codes you
touched when you finish. Range `0001–0099` = code-enforced (carry a tag); `0100+` = process rules.

| Code | Kind | Anchor (file · symbol) | Must stay in sync with | Silent failure if missed |
|---|---|---|---|---|
| PACS0001 | cross-module-registry | `engine.js` · `CONST.UNITS` | render dispatch (`VOLLEY`, `gaitEase`, `idlePose`, `drawUnit` scale+sprite, `drawCombatFx`), `validate.js` `CLASSES`/`BUILDABLE`, `engine.js` `TYPES`/`TYPE_LETTER`, `bots.js` build logic, `index.html` deploy cards, `atlas.js` (PACS0017). Only `llm-client` `Object.keys(C.UNITS)` self-syncs | A type added only to `UNITS` renders blank / default 1.2 scale / linear gait / no idle / worker-melee FX; validate strips its stance+fire_policy+builds; `mintId` emits `A_undefined1`. No throw. |
| PACS0002 | allowlist | `engine.js` · `CONST.BUILD_TURNS` keys | `validate.js` `BUILDABLE` (+ `applyBuildStarts` gate); producers `llm-client` prompt, `bots.js` | A buildable type in one but not both is silently dropped at sanitize (`validate.js`) or skipped in `applyBuildStarts` — the build never starts, no log. |
| PACS0003 | duplicated-const | `engine.js` · `CONST.BUILD_TURNS` values | `index.html` deploy cards (`3 TURNS` / `2 TURNS`, static, never rewritten by JS) | Change a build time and the deploy card keeps the old number forever — nothing overwrites that text. |
| PACS0004 | duplicated-const | `engine.js` · `STANCES` | `validate.js` `STANCES`, `bots.js` `STANCES`, `llm-client.js` `stanceNames` (+prompt text), `ui.js` stance `<select>`, and `CONST.UNITS` per-stance stat blocks | A new stance missing from one mirror is coerced back to `default` by validate/`statFor`, never offered in the UI, never documented to the model — it silently does not exist. |
| PACS0005 | determinism | `engine.js` · top-of-file contract comment | `bots.js` seeded `mulberry32` (never `Math.random`), engine tie-breaks (focus-fire id-ascending, movement array order, `freeLanding` ring walk), `integration.test.js` determinism assert | Any `Math.random`/`Date.now`/wall-clock or non-fixed tie-break in the sim path makes identical-order reruns diverge; replay re-sim and A/B fairness silently stop matching. |
| PACS0006 | id-format | `engine.js` · `mintId` (`side + '_' + TYPE_LETTER…`) | `render.js` build-spawn `String(b.unitId).charAt(0)` (the `buildsCompleted` log has no side field) | Move the side off char 0 and `charAt(0)` yields a non-a/b key; `IMGS[u.side]` misses and the freshly built unit renders blank through its spawn animation. |
| PACS0007 | duplicated-const | `engine.js` · `CONST.CORE_WORKER_EVERY` | `ui.js` sysnote `ONE EVERY 4 TURNS` (hardcodes the literal; engine/prompt/HUD self-sync) | Change the cadence and the disabled-worker-card note lies to the player. |
| PACS0008 | message-contract | `engine.js` · core attacker id `cs + '_core'` | `render.js` `coreSideOf` regex + `coreFrom`/`posOf`/`drawCombatFx` core branch | Rename the core attacker token past the regex and the core-attack shock arc silently never renders; damage popup falls back to lime. |
| PACS0009 | message-contract | `validate.js` · `sanitizeOrders` field shape (`orders[].unit/.target`, `builds[].worker/.produces`, `fire_policy[].mode/.target`) | every producer: `bots.js`, `ui.js` human orders, `llm-client.js` OUTPUT PROTOCOL example; every consumer in `engine.js` | Rename a field (or add a category) on one producer and sanitize drops it via `continue` — units hold, builds never start, indistinguishable from a passive turn. |
| PACS0010 | cross-module-registry | `llm-client.js` · `_buildSystemPrompt` export | `openai-client.js`, `ollama-client.js`, `webtab-client.js` (all defer here) | A new client that inlines its own ruleset plays a stale prompt after CONST drifts; no crash, just a side quietly playing a different game. |
| PACS0011 | message-contract | `webtab-client.js` · `__aiwars_bridge:'req'` envelope | `extension/bridge.js` + `extension/background.js` read every field by name (no spread); `res` envelope back in `webtab-client.js` | A renamed/added page-side field crosses the process boundary as `undefined`; the turn silently times out to a no-op. |
| PACS0012 | id-format | `webtab-client.js` · reply markers `AIWARS_RESULT`/`AIWARS_END` | `extension/handoff.js` scraper regexes (byte-match, line-anchored) | Reword a marker on one side and extraction returns null; the web-tab turn dies as a silent multi-minute timeout. |
| PACS0013 | duplicated-const | `content.js` · `DEFAULT_PACK` | `game/content/tone-pack.json` (registry-only mirror; http overrides the embedded pack) | Edit one copy and http vs file:// visitors drift; a key in only one copy makes `Content.get` return the literal path string, no throw. |
| PACS0014 | allowlist | `audio.js` · `SOUNDS` table | every `sfx()`/`NS.Audio.play()` producer in `render.js`/`ui.js` | An event emitted with no `SOUNDS` key hits `if(!fn) return` — permanent silence for that cue, easily misread as mute/cooldown. |
| PACS0015 | allowlist | `audio.js` · `TIER` table | `play()` `duckAmbient` gate; `meltdownSiren` is the sanctioned self-ducking exception | A loud cue missing from `TIER` defaults to 0 and never ducks the beds — muddier mix, no error. |
| PACS0016 | message-contract | `splash.html` · `onMsg` handler | `ui.js` `postMessage({type:'aiwars:…'})` sites (`enterbg`, `sndtoggle`) | A new parent→splash message with no case here silently no-ops; the splash ignores the command and keeps its prior state. |
| PACS0017 | allowlist | `atlas.js` · `AIWARS_ATLAS.sprites` (keyed `<type>_<stance>`) | `render.js` sprite lookup + `thumbs()`, `index.html` deploy-card `data-thumb`, `CONST.UNITS` (PACS0001) | A type with no `<type>_default` sprite draws nothing (`if(!m) return`) and its card thumbnail paints blank, no error. |
| PACS0018 | lifecycle | `ui.js` · `amb(true)`/`mus(true)` at match/replay entry | every terminal path that still owns the audio (`showResult`, no-result branch, `catch`) must `amb(false)`/`mus(false)`; gen-mismatch bailouts must NOT | A new exit branch returning without `off()` leaves the ambient drone + 25ms music scheduler running forever over a dead screen. |
| PACS0019 | allowlist | `replay.js` · `KINDS` | `ui.js` `KIND_PREFIXES` + `human`/`bot`; `normPlayer` coerces unknown → `bot` | A provider wired into setup but missing from `KINDS` is silently recorded as `bot` in the exported replay — wrong provenance, no error. |
| PACS0020 | schema-version | `replay.js` · `SPEC_VERSION` | `resultingState` snapshot schema (`engine.js` clone); `importJSON` checks only the version string + container existence | A leaf-field rename without a version bump lets an old replay import, then every unit/HUD derefs `undefined` and renders NaN through playback. |
| PACS0021 | build/deploy | `bin/deploy-aiwars.sh` · cache-bust `sed` (`[a-z-]*\.js`) | `index.html` `<script src>` basenames (must stay lowercase-hyphen); `STAMPED >= 15` guard sits at the exact count | A new js with a digit/underscore/uppercase basename ships un-stamped and later serves from the 30-day cache; the count guard can't detect one un-stamped file. (`deploy-aiwars.sh` is gitignored — tag is local-only.) |
| PACS0022 | allowlist | `extension/manifest.json` · `content_scripts[].matches` | deploy `DEST` host + `index.html` canonical host (the host serving the game) | Serve from a host not in `matches` and `bridge.js` never injects; web-tab mode falsely reports the extension missing. (JSON — registry-only; happened once in commit 764abd8.) |

_All 22 came out of a 5-territory discovery sweep plus per-invariant adversarial verification; five candidates were rejected as either same-file (HIFI, sound cooldown), whole-function purity rather than a coupling (bots determinism folded into PACS0005), or real-but-loud/self-healing (`hudState` rewrite, webtab bot-lockstep)._
