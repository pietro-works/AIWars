# AI Wars — agent index

Browser LLM-vs-LLM pixel strategy game. Plain `<script>` tags, no build step, deterministic
engine. Everything hangs off the `AIWARS` (`NS`) namespace. Entry point is `game/index.html`,
which loads `game/js/*.js` and `assets/sprites/*.js` in order; the match engine is
`game/js/engine.js`; the splash is a separate `assets/splash/splash.html` loaded in an iframe.

PACS codes tag **load-bearing invariants**: a coupling where one edit (adding a producer, a
type, a message, a field) forces a matching edit at a **distant, non-obvious** site, and missing
that second edit **fails silently** — no error, no crash, just wrong or dead behavior. The YAML
block below is the source of truth; each code is also tagged at its anchor in code as
`// PACS#### — <rule> — AGENTS.md (known sites, not exhaustive)` (`/* */` in CSS/template
strings, `<!-- -->` in markup, `#` in shell; JSON files carry no tag and are covered by the
registry only). See [SPEC.md](../../stack/PACS/SPEC.md) for the normative rules.

> **Output signal — read this.** Whenever you consult this registry while producing a response,
> put `P.A.C.S ✅` on its own line at the very top of that response, before anything else. Only
> print it when you genuinely consulted the registry for that output — a checkmark you didn't
> earn is worse than none, because it makes the signal a lie.

**`sync_with` is a floor, not a ceiling.** Every list below names the touch-points somebody
already found. It is not exhaustive, and treating it as a checklist is the failure mode this
format exists to prevent: you do the four named sites, feel finished, and stop grepping. Before
you finish, grep the repo for the identifier, its literal value, and the underlying field name.
Any hit outside the anchor is a touch-point the entry has to list — add it in the same change.

**Minting** (same change that introduces the coupling): take the next free number (append-only,
never reuse), add an entry here, tag the anchor including the `(known sites, not exhaustive)`
suffix, then grep for touch-points and record what you actually verified. **Consuming**: before
editing near a `PACS####` tag, read its entry, satisfy every site it names, and grep for the ones
it doesn't. **Report**: name the codes you opened, touched, or minted, and where you confirmed
the touch-points. Range `0001–0099` = code-enforced (carry a tag); `0100+` = process rules.

Run `pacs check` from the project root to verify registry health.

## PACS Registry

```yaml
PACS0001:
  kind: cross-module-registry
  anchor: "game/js/engine.js:CONST.UNITS"
  sync_with:              # KNOWN sites, not exhaustive — grep for more before you finish
    - "game/js/render.js"
    - "game/js/validate.js"
    - "game/js/bots.js"
    - "assets/sprites/atlas.js"
    - "game/index.html"
  fails_silently: "A type added only to CONST.UNITS renders blank, takes the default 1.2 scale, gets a linear gait and no idle pose, and shows worker-melee combat FX; validate.js strips its stance, fire_policy and builds; mintId emits A_undefined1. Nothing throws."
  justification: "Seven independent keyed-by-type sites (render dispatch VOLLEY/gaitEase/idlePose/drawUnit/drawCombatFx, validate CLASSES and BUILDABLE, engine TYPES and TYPE_LETTER, bots build logic, atlas sprites, index.html deploy cards) none of which are derived from CONST.UNITS, so nothing forces them to move together"
  notes: "Same-file mirrors: engine.js TYPES + TYPE_LETTER. Only llm-client.js self-syncs, via Object.keys(C.UNITS). Sprite half of the coupling is PACS0017. game/content/tone-pack.json and game/js/content.js carry a unitFlavorNames block keyed by type — verified 2026-08-09 to have no consumer, so it is not a touch-point yet; it becomes one the moment anything reads it."

PACS0002:
  kind: allowlist
  anchor: "game/js/engine.js:CONST.BUILD_TURNS"
  sync_with:              # KNOWN sites, not exhaustive — grep for more before you finish
    - "game/js/validate.js"
    - "game/js/llm-client.js"
    - "game/js/bots.js"
  fails_silently: "A buildable type present in one list but not the other is dropped at sanitize time in validate.js, or skipped by applyBuildStarts. The build never starts and nothing is logged."
  justification: "validate.js BUILDABLE and the applyBuildStarts gate are two separate allowlists derived from neither each other nor BUILD_TURNS, and a produces value that fails either one is discarded by a bare continue"

PACS0003:
  kind: duplicated-const
  anchor: "game/js/engine.js:CONST.BUILD_TURNS values"
  sync_with:              # KNOWN sites, not exhaustive — grep for more before you finish
    - "game/index.html"
  fails_silently: "Change a build time and the deploy card keeps showing the old number forever."
  justification: "The deploy cards hardcode 3 TURNS / 2 TURNS as static markup and no JS ever rewrites that text, so the card and the engine can disagree indefinitely"

PACS0004:
  kind: duplicated-const
  anchor: "game/js/engine.js:STANCES"
  sync_with:              # KNOWN sites, not exhaustive — grep for more before you finish
    - "game/js/validate.js"
    - "game/js/bots.js"
    - "game/js/llm-client.js"
    - "game/js/ui.js"
  fails_silently: "A stance missing from any one mirror gets coerced back to default by validate or statFor, is never offered in the UI dropdown, and is never described to the model. It silently does not exist."
  justification: "Five independent copies of the same three-string vocabulary (engine, validate, bots, the llm prompt text, the ui select) plus the per-stance stat blocks inside CONST.UNITS, and the coercion path swallows anything unrecognized"
  notes: "Same-file mirror: the per-stance stat blocks in CONST.UNITS. llm-client.js carries both stanceNames and the prose in the prompt."

PACS0005:
  kind: determinism
  anchor: "game/js/engine.js:top-of-file contract comment"
  sync_with:              # KNOWN sites, not exhaustive — grep for more before you finish
    - "game/js/bots.js"
    - "game/tests/integration.test.js"
  fails_silently: "Any Math.random, Date.now, wall-clock read, or non-fixed tie-break in the sim path makes identical-order reruns diverge. Replay re-sim and A/B fairness stop matching, with no error at the point of divergence."
  justification: "Determinism here is a whole-path property, not a single call site: bots must use the seeded mulberry32, and the engine tie-breaks (focus-fire id-ascending, movement array order, freeLanding ring walk) must all stay fixed-order for the integration determinism assert to mean anything"

PACS0006:
  kind: id-format
  anchor: "game/js/engine.js:mintId"
  sync_with:              # KNOWN sites, not exhaustive — grep for more before you finish
    - "game/js/render.js"
  fails_silently: "Move the side off character 0 and render.js charAt(0) yields a key that is neither a nor b; IMGS[u.side] misses and the freshly built unit renders blank through its whole spawn animation."
  justification: "The buildsCompleted log entry has no side field, so render.js recovers the side by slicing character 0 of the unit id — the id format is the only carrier of that information"

PACS0007:
  kind: duplicated-const
  anchor: "game/js/engine.js:CONST.CORE_WORKER_EVERY"
  sync_with:              # KNOWN sites, not exhaustive — grep for more before you finish
    - "game/js/ui.js"
  fails_silently: "Change the cadence and the disabled-worker-card sysnote keeps telling the player ONE EVERY 4 TURNS."
  justification: "The engine, the prompt and the HUD all read the constant, but the ui.js sysnote hardcodes the literal number in prose that nothing regenerates"

PACS0008:
  kind: message-contract
  anchor: "game/js/engine.js:core attacker id cs + '_core'"
  sync_with:              # KNOWN sites, not exhaustive — grep for more before you finish
    - "game/js/render.js"
  fails_silently: "Rename the core attacker token past the regex and the core-attack shock arc never renders; the damage popup quietly falls back to lime."
  justification: "render.js coreSideOf parses the side back out of that id with a regex, and coreFrom/posOf/drawCombatFx all branch on the result, so a rename turns a matched branch into an unmatched one with no error path"

PACS0009:
  kind: message-contract
  anchor: "game/js/validate.js:sanitizeOrders"
  sync_with:              # KNOWN sites, not exhaustive — grep for more before you finish
    - "game/js/bots.js"
    - "game/js/ui.js"
    - "game/js/llm-client.js"
    - "game/js/engine.js"
  fails_silently: "Rename a field, or add a category, on one producer and sanitize drops it via continue. Units hold position, builds never start, and the turn is indistinguishable from a deliberately passive one."
  justification: "Four independent producers emit the same action shape (orders[].unit/.target, builds[].worker/.produces, fire_policy[].mode/.target) and sanitize discards anything off-shape silently, so a producer-side rename looks exactly like a quiet turn"
  notes: "llm-client.js carries the shape twice: as prose and as the OUTPUT PROTOCOL example the model copies."

PACS0010:
  kind: cross-module-registry
  anchor: "game/js/llm-client.js:_buildSystemPrompt"
  sync_with:              # KNOWN sites, not exhaustive — grep for more before you finish
    - "game/js/openai-client.js"
    - "game/js/ollama-client.js"
    - "game/js/webtab-client.js"
  fails_silently: "A new client that inlines its own ruleset plays a stale prompt once CONST drifts. No crash — one side is just quietly playing a different game."
  justification: "Three provider clients already defer to this single builder, and nothing in the code stops a fourth from inlining its own copy of the rules"

PACS0011:
  kind: message-contract
  anchor: "game/js/webtab-client.js:__aiwars_bridge 'req' envelope"
  sync_with:              # KNOWN sites, not exhaustive — grep for more before you finish
    - "extension/bridge.js"
    - "extension/background.js"
  fails_silently: "A renamed or added page-side field crosses the process boundary as undefined and the turn times out to a no-op."
  justification: "bridge.js and background.js read every envelope field by name rather than spreading the object, so an unmatched name is undefined on the far side of a process boundary where nothing validates it"
  notes: "The res envelope coming back into webtab-client.js is the other half of the same contract."

PACS0012:
  kind: id-format
  anchor: "game/js/webtab-client.js:reply markers AIWARS_RESULT/AIWARS_END"
  sync_with:              # KNOWN sites, not exhaustive — grep for more before you finish
    - "extension/handoff.js"
  fails_silently: "Reword a marker on one side and extraction returns null; the web-tab turn dies as a silent multi-minute timeout."
  justification: "handoff.js scrapes the reply with line-anchored byte-match regexes, so the marker strings are a literal wire format shared across the extension boundary"

PACS0013:
  kind: duplicated-const
  anchor: "game/js/content.js:DEFAULT_PACK"
  sync_with:              # KNOWN sites, not exhaustive — grep for more before you finish
    - "game/content/tone-pack.json"
  fails_silently: "Edit one copy and http visitors see different strings than file:// visitors; a key present in only one copy makes Content.get return the literal path string, no throw."
  justification: "The JSON pack overrides the embedded one over http but is unreachable from file://, so the two copies serve different audiences and neither one is generated from the other"
  notes: "JSON side carries no tag — registry-only."

PACS0014:
  kind: allowlist
  anchor: "game/js/audio.js:SOUNDS"
  sync_with:              # KNOWN sites, not exhaustive — grep for more before you finish
    - "game/js/render.js"
    - "game/js/ui.js"
  fails_silently: "An event emitted with no SOUNDS key hits if(!fn) return — permanent silence for that cue, easily misread as mute or a cooldown."
  justification: "Every sfx() and NS.Audio.play() call site passes a bare string key, and the lookup miss is swallowed by an early return rather than a throw"

PACS0015:
  kind: allowlist
  anchor: "game/js/audio.js:TIER"
  sync_with:              # KNOWN sites, not exhaustive — grep for more before you finish
    - "game/js/render.js"
    - "game/js/ui.js"
  fails_silently: "A loud cue missing from TIER defaults to 0 and never ducks the beds. The mix just gets muddier."
  justification: "The duckAmbient gate in play() reads TIER by cue name, so a producer that adds a loud cue without a TIER row gets a silent zero rather than a missing-key error"
  notes: "Same-file consumer: the duckAmbient gate in play(). meltdownSiren is the sanctioned self-ducking exception."

PACS0016:
  kind: message-contract
  anchor: "assets/splash/splash.html:onMsg"
  sync_with:              # KNOWN sites, not exhaustive — grep for more before you finish
    - "game/js/ui.js"
  fails_silently: "A new parent-to-splash message with no case here no-ops; the splash ignores the command and holds its prior state."
  justification: "onMsg is a switch over aiwars:* type strings with no default branch, and it sits across an iframe boundary where ui.js gets no acknowledgement either way"
  notes: "Live producers in ui.js: enterbg, sndtoggle. The sndtoggle case is kept deliberately even though the parent no longer posts it."

PACS0017:
  kind: allowlist
  anchor: "assets/sprites/atlas.js:AIWARS_ATLAS.sprites"
  sync_with:              # KNOWN sites, not exhaustive — grep for more before you finish
    - "game/js/render.js"
    - "game/index.html"
    - "game/js/engine.js"
  fails_silently: "A type with no <type>_default sprite draws nothing (if(!m) return) and its deploy-card thumbnail paints blank. No error."
  justification: "Sprites are keyed <type>_<stance> and looked up by string concatenation in both render.js and thumbs(), while index.html data-thumb hardcodes the same keys in markup"
  notes: "Type half of the coupling is PACS0001."

PACS0018:
  kind: lifecycle
  anchor: "game/js/ui.js:amb(true)/mus(true) at match and replay entry"
  sync_with:              # KNOWN sites, not exhaustive — grep for more before you finish
    - "game/js/ui.js"
    - "game/js/audio.js"
  fails_silently: "A new exit branch that returns without off() leaves the ambient drone and the 25ms music scheduler running forever over a dead screen."
  justification: "Ownership of the audio beds is claimed at one entry point and released at several unrelated terminal paths (showResult, the no-result branch, catch), and a new early return is a plain return with nothing to flag the leak"
  notes: "Generation-mismatch bailouts must NOT call off() — they no longer own the audio."

PACS0019:
  kind: allowlist
  anchor: "game/js/replay.js:KINDS"
  sync_with:              # KNOWN sites, not exhaustive — grep for more before you finish
    - "game/js/ui.js"
  fails_silently: "A provider wired into setup but missing from KINDS is recorded as bot in the exported replay — wrong provenance, no error."
  justification: "normPlayer coerces anything outside KINDS to bot rather than rejecting it, so the replay file is written with a plausible-looking wrong value"

PACS0020:
  kind: schema-version
  anchor: "game/js/replay.js:SPEC_VERSION"
  sync_with:              # KNOWN sites, not exhaustive — grep for more before you finish
    - "game/js/engine.js"
    - "game/js/render.js"
    - "game/js/ui.js"
    - "game/fixtures/sample-match.json"
  fails_silently: "A leaf-field rename without a version bump lets an old replay import cleanly, then every unit and HUD deref hits undefined and renders NaN through the whole playback."
  justification: "importJSON validates only the version string and the presence of the top-level containers, so any leaf-level schema change is invisible to the gate that is supposed to catch it"
  notes: "The resultingState snapshot schema comes from the engine.js clone. game/tests/integration.test.js asserts the top-level key list, which fails loudly and is not the risk here."

PACS0021:
  kind: build-deploy
  anchor: "bin/deploy-aiwars.sh:cache-bust sed"
  sync_with:              # KNOWN sites, not exhaustive — grep for more before you finish
    - "game/index.html"
  fails_silently: "A new js file whose basename has a digit, underscore or uppercase letter ships un-stamped and then serves from the 30-day cache."
  justification: "The cache-bust sed matches [a-z-]*.js only, and the STAMPED >= 15 guard sits at the exact current count, so it cannot tell an un-stamped file from a correct run"
  notes: "bin/ is gitignored — this tag is local-only."

PACS0022:
  kind: allowlist
  anchor: "extension/manifest.json:content_scripts[].matches"
  sync_with:              # KNOWN sites, not exhaustive — grep for more before you finish
    - "game/index.html"
    - "bin/deploy-aiwars.sh"
  fails_silently: "Serve the game from a host that is not in matches and bridge.js never injects; web-tab mode then falsely reports the extension as missing."
  justification: "The host allowlist lives in extension manifest JSON while the actual serving host is set by the deploy destination and the canonical URL in index.html, three places with no shared source"
  notes: "JSON — registry-only, no tag in the manifest. This one already bit us once, in commit 764abd8."
```

_All 22 came out of a 5-territory discovery sweep plus per-invariant adversarial verification;
five candidates were rejected as either same-file (HIFI, sound cooldown), whole-function purity
rather than a coupling (bots determinism folded into PACS0005), or real-but-loud/self-healing
(`hudState` rewrite, webtab bot-lockstep)._
