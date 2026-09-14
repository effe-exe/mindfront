# MindFront — Phase 1: LLMs play, humans spectate

## Context

Goal: daily Instagram reels of AI models (Claude, GPT, Gemini, Grok, DeepSeek, Llama…) fighting each other in the real-time strategy game OpenFront (github.com/openfrontio/OpenFrontIO). Later phases add an automatic camera + recording, HyperFrames graphics, Chatterbox-Nano voiceover, and posting. **This plan covers only phase 1**: a fork where LLM agents play a full match end to end on the game's own server, humans can watch live in the browser, and every match leaves a replayable record plus a structured decision/event log (the future highlight source).

Decisions already made by the user: OpenRouter as the single LLM gateway; LLM players + built-in "tribe" bots as filler (scripted Nations off); fork at `~/mindfront` on branch `arena`; local only, no GitHub fork yet.

### Why this shape (verified against the code, HEAD a83ba6ac)

- The server never simulates. It relays `Intent`s into a `Turn` every 100 ms; every client runs the deterministic sim (`src/core/GameRunner.ts`). So an LLM player is just a WebSocket client that sends intents, and one headless Node sim gives the brain ground-truth state. `tests/replay/ReplayGame.ts` already proves the headless sim works in Node.
- Dev auth is a no-op: `src/server/jwt.ts:24` accepts any UUID as a token when `GAME_ENV=dev`. Turnstile is skipped in dev. So **zero server patches** are needed.
- Spectating is first-class: `http://localhost:9000/game/<id>?spectate` (`src/client/Main.ts:1071`) works in-lobby and mid-game.
- `randomSpawn: true` makes the game auto-place every human player (`src/core/execution/utils/PlayerSpawner.ts`), so no spawn logic is needed.

## Architecture

```
npm run dev  (unmodified game: vite :9000, master :3000, workers :3001/:3002)
        ▲ WS ×N (one per LLM player)          ▲ browser spectators (?spectate)
arena/brain.ts  ── one process ──
  ├─ POST /api/create_game → private lobby
  ├─ N sockets: join, ping, send intents; socket 0 = lobby creator, feeds the sim
  ├─ ONE headless GameRunner (createGameRunner + NodeGameMapLoader)
  ├─ per player every K ticks: observe → OpenRouter → validate → Intents
  └─ writes arena/records/<id>.json (GameRecord) + <id>.events.jsonl
```

## Files

All new, inside the fork. No changes to `src/` beyond two optional one-liners.

| File | Responsibility |
|---|---|
| `arena/brain.ts` | CLI, lobby creation, sockets, start timer, headless sim, decision scheduler, pings, record + event writers, exit |
| `arena/agent.ts` | `observe(game, me)`, `decide(model, system, obs)` (OpenRouter fetch + zod parse + fallback), `toIntents(game, me, action)` (guards + tile selection), self-check under `import.meta.url === argv[1]` |
| `arena/roster.json` | `[{ "model": "anthropic/claude-sonnet-4", "name": "Claude", "persona": "..." }, ...]` (6 entries, one per vendor) |
| `arena/roster.test.json` | 2 cheap models for smoke runs |
| `arena/records/` | output, gitignored |
| `package.json` | add script `"arena": "tsx arena/brain.ts"` |
| `.gitignore` | add `arena/records/` |

Reuse (no copies): `createGameRunner` (`src/core/GameRunner.ts:35`), `NodeGameMapLoader` (`tests/perf/fullgame/NodeGameMapLoader.ts`), `encodeClientMessage` / `decodeServerMessage` / `createGameWireContext` (`src/core/ZbinWire.ts`), `createPartialGameRecord` (`src/core/Util.ts:289`), `flattenedEmojiTable` (`src/core/Util.ts`), `Intent` types from `src/core/Schemas.ts`, `ws`, `zod`, `tsx` (all already dependencies). Run scripts exactly like `replay:game` does: `npx tsx arena/brain.ts` from repo root (tsconfig `paths` alias `resources/*` resolves).

## Steps

### 0. Set up the fork
```bash
git clone https://github.com/openfrontio/OpenFrontIO ~/mindfront
cd ~/mindfront && git checkout -b arena && npm run inst   # npm ci --ignore-scripts; never npm install
```
Node 24 required (Docker base is node:24-slim). Confirm `npm run dev` serves `http://localhost:9000`.
License hygiene on the branch (see License section): `git rm -r proprietary/images proprietary/fonts proprietary/sounds` (keep `proprietary/LICENSE`), confirm the client boots with `/resources` fallbacks, add `ATTRIBUTION.md`.

### 1. `arena/brain.ts` — match runner
1. Parse flags: `--roster`, `--map` (World), `--size` (Normal|Compact), `--bots` (120), `--interval` ticks (50), `--timer` minutes (40).
2. `POST http://localhost:3001/api/create_game`, header `Authorization: Bearer <creatorUuid>` (`crypto.randomUUID()`). Body must be a **full** `GameConfig` (`CreateGameInputSchema` is all-or-`{}`, `src/core/WorkerSchemas.ts:4`):
   `{ gameMap, gameMapSize, difficulty:"Easy", gameType:"Private", gameMode:"Free For All", nations:"disabled", bots, randomSpawn:true, donateGold:true, donateTroops:true, infiniteGold:false, infiniteTroops:false, instantBuild:false, disabledUnits:[], startDelay:0, maxTimerValue:<timer> }`.
   Response has `gameID, workerIndex, workerPath`. Print `spectate: http://localhost:9000/game/<gameID>?spectate`.
3. One `ws` socket per roster entry to `ws://localhost:${3001+workerIndex}/${workerPath}`. Open socket 0 first (creator; if it drops pre-start the lobby dies, `GameServer.ts:734`). On open send `{type:"join", token, gameID, username:name, clanTag:null, turnstileToken:null, spectator:false, gitCommit: process.env.GIT_COMMIT ?? "DEV"}` via `encodeClientMessage(msg, undefined)`. Username 3–20 chars, letters/digits/space. Log `close` code/reason and any `error` frame (`version_mismatch` = server not started with `GIT_COMMIT=DEV`).
4. Decode frames with `decodeServerMessage(bytes, ctx)`; `ctx = undefined` until `start`, then `createGameWireContext(start.gameStartInfo.players)` (shared by all sockets). Each socket records its `myClientID` from `lobby_info`/`start`.
5. When every socket has seen one `lobby_info`, socket 0 sends intent `{type:"toggle_game_start_timer"}`. Server prestarts within 1 s and starts 2 s later.
6. On socket 0 `start`: `runner = await createGameRunner(gameStartInfo, undefined, new NodeGameMapLoader(path.join(ROOT,"resources/maps")), onUpdate)`; `runner.init()`; `console.debug = () => {}`. Build `players[] = {socket, clientID, playerID: game.playerByClientID(clientID).id(), model, name, persona, notes, pending:false, lastResult}`.
7. On socket 0 `turn`: `turns.push(turn); runner.addTurn(turn); runner.executeNextTick()`. Other sockets ignore turns.
8. `onUpdate(gu)`: store `updates[GameUpdateType.Hash]` per tick; append Conquest / AllianceRequest / AllianceRequestReply / BrokeAlliance / Win / DisplayEvent(nukes, conquered) to a ring buffer and to `events.jsonl` (resolve smallIDs via `game.playerBySmallID`). If `tick % interval === 0 && !game.inSpawnPhase()`: for each alive LLM player with `!pending`, fire `decide()` **without awaiting** in the tick path; on resolve → `toIntents` → send each as `{type:"intent", intent}` (encoded with `ctx`) → log `{tick, player, action, reasoning, sent, dropped}` to `events.jsonl` and console.
9. `setInterval(5000)`: `{type:"ping"}` on every socket (server prunes sockets silent for 60 s, `GameServer.ts:1382`).
10. End: on `updates[Win][0]`, or all LLM players dead (`!isAlive()`), or wall-clock cap → socket 0 sends `{type:"winner", winner, allPlayersStats}` (our sockets share one IP so this is the majority vote); write record; close sockets; exit 0.
11. Record: `createPartialGameRecord(gameID, config, playerRecords, turnsWithHashes, startMs, Date.now(), winner, lobbyCreatedAt, visibleAt, tribes)` + `gitCommit`, mirroring `GameServer.archiveGame` (`GameServer.ts:1700-1720`) for `playerRecords` (`stats` from `win.allPlayersStats[clientID]`, `persistentID:null`). Stamp `turn.hash` from the stored hashes so `replay:game` can verify.

### 2. `arena/agent.ts` — observe / decide / act

**Observation** (JSON, ~1k tokens; ids are `smallID` numbers):
```
{ tick, minute, me:{id,name,tiles,landPct,troops,gold,cities,ports,defensePosts,silos,boatsInFlight,
     allies:[id], pendingAllianceRequestsFrom:[id], incomingAttacks:[{from,troops}], outgoingAttacks:[{to|"land",troops}]},
  neighbors:[{id,name,kind:"llm"|"tribe",tiles,troops,relation,allied,attackingMe,coastal}],   // me.nearby() ∩ sharesBorderWith
  unclaimedLandAdjacent:bool,            // me.sharesBorderWith(game.terraNullius())
  reachableByBoat:[{id,name,tiles}],     // top 3 coastal non-neighbors, only if I own a shore tile
  leaderboard:[{id,name,tiles}],         // top 5
  canBuild:[{unit,cost}],                // structures affordable now
  recentEvents:[string], lastResult:string, notes:string }
```

**Action** — one forced tool call `act`:
```
{ reasoning:string(≤240), notes:string(≤300),
  actions:[≤3 × { type: attack|expand|boat|ally|accept_alliance|reject_alliance|break_alliance|build|emoji|chat|wait,
                  target?:int, ratio?:0.05–0.8, unit?:City|Port|Defense Post|Missile Silo|SAM Launcher|Factory|Warship,
                  emoji?:string, key?:string }] }
```

**toIntents guards** (drop + note in `lastResult` on failure; never throw in the tick path):
- `expand` → `attack{targetID:null, troops:floor(troops*ratio)}` if adjacent to terra nullius.
- `attack` → `attack{targetID: t.id()}` if `me.sharesBorderWith(t) && me.canAttackPlayer(t)` (no shared border = attack fizzles, `AttackExecution.ts:63-140`). `targetID` is `player.id()`, **not** clientID.
- `boat` → `dst` = first `t.borderTiles()` tile that `game.isShore()` and `me.bestTransportShipSpawn(dst) !== false`; skip if `unitCount(TransportShip) >= 3`.
- `ally` / `accept_alliance` → `allianceRequest{recipient}` (accepting = sending a request back, `AllianceRequestExecution.ts:35-40`; requests expire after 200 ticks so interval must stay < 200). `reject_alliance` → `allianceReject{requestor}`. `break_alliance` → `breakAlliance{recipient}` if `isAlliedWith`.
- `build` → sample ≤200 own tiles (border tiles for Port/Defense Post), first `me.canBuild(unit, tile)` hit → `build_unit{unit, tile}`.
- `emoji` → `emoji{recipient: t.id()|"AllPlayers", emoji: flattenedEmojiTable.indexOf(e)}`; `chat` → `quick_chat{recipient, quickChatKey}` (keys in `resources/QuickChat.json`).
- Fallback (timeout / 429 / bad JSON / unknown id): `expand 0.3` if unclaimed land adjacent, else `wait`.

**OpenRouter call**: `POST https://openrouter.ai/api/v1/chat/completions`, `Authorization: Bearer $OPENROUTER_API_KEY`, `AbortSignal.timeout(20000)`, body `{model, temperature:0.7, max_tokens:400, messages:[system, user:JSON(obs)], tools:[act], tool_choice:{function:"act"}}`. Read `tool_calls[0].function.arguments`, fall back to `content` for models that ignore `tool_choice`. Stateless per call; memory rides in `notes` + `recentEvents`.

**System prompt** (~500 tokens): fixed rules summary (troops regen scales with land, Cities raise cap, Ports trade gold, expand is cheap, attack sends `ratio` of troops, Defense Posts, alliances 5 min and breaking = traitor, boats max 3, win = 80 % land or leader at timer end, tribes are dumb NPCs, LLM players are the rivals, never send >60 % troops, keep reserve if attacked) + persona from roster + contract (call `act` once, ≤3 actions, `reasoning` is 1–2 in-character sentences shown to spectators, `notes` is your scratchpad).

### 3. Guardrails against hallucinated / illegal actions (layered, all in `agent.ts`)
1. **Shape**: forced tool call + strict zod parse. Unknown action type, unknown unit, missing required field → that action dropped (not the whole turn).
2. **Referential**: the model may only reference ids it was shown this turn. `attack`/`ally` target ∈ `neighbors`; `boat` target ∈ `reachableByBoat`; `accept_alliance`/`reject_alliance` target ∈ `pendingAllianceRequestsFrom`; `break_alliance` target ∈ `me.allies`; `build.unit` ∈ `canBuild`. Anything else is dropped before touching the game. The brain never resolves an id the model invented.
3. **Game-legal**: the existing sim guards (`sharesBorderWith`, `canAttackPlayer`, `canBuild`, `canSendAllianceRequest`, `isAlliedWith`, `isImmune`) run on the real headless state; a guard failure drops the action.
4. **Sanity caps**: `ratio` clamped to 0.05–0.6; per decision at most 1 attack/expand/boat, 1 build, 1 diplomacy, 1 emoji/chat (extras dropped in order); `reasoning` ≤240 chars, `notes` ≤300; anything outside the schema stripped.
5. **Feedback loop**: every drop is written to `lastResult` with the reason ("target 17 does not border you") so the next call self-corrects. Same action dropped twice in a row → forced fallback (`expand`/`wait`) that turn and a warning in the log.
6. **Provenance**: every decision in `events.jsonl` carries `sent[]` and `dropped[{action, reason}]`. Dropped actions are content too ("Gemini tried to attack across the sea").
7. **Reasoning text is not fact-checked**: it is the model's own words and is labeled as such wherever it is shown. Only actions are validated.
8. Self-check: `npx tsx arena/agent.ts` feeds canned observations plus canned bad outputs (invented id, ally attack, ratio 5, garbage JSON) and asserts each is dropped or falls back.

### 4. Adaptive decision interval
- Per player, not global. `intervalTicks = clamp(base, ceil(latencyEma / 100ms) * 1.5, 180)`, where `latencyEma` is an exponential moving average of the last calls (timeouts count as 20 s). Hard cap 180 ticks stays under the 200-tick alliance-request expiry.
- Skip-if-pending remains as the backstop; a burst of slow calls stretches the interval instead of queueing.
- Log the effective interval per player in `events.jsonl` so slow models are visible in the leaderboard later ("GPT thinks 3× slower than Llama").

### 5. Budget defaults
- Base interval 50 ticks (5 s). 6 players × 40 min ≈ 2,900 calls ≈ 3.5 M tokens: ~$1–2/match on cheap models, $20–60 on frontier. Smoke runs: `--interval 100 --timer 8`, 2 cheap models ≈ 200 calls.
- ≤4 intents per decision → ≤48/min per client (limit 150/min, 10/s).

## Development approach: agent fleet

**Orchestrator** = this session (Fable). It owns the plan, the `arena` branch of github.com/effe-exe/mindfront, the single running dev server, all merges, and the integration test. It writes the contracts and small glue, and delegates the packages below. Agents never merge, never start the server, never edit the plan.

### Step A first, alone: the contract
The orchestrator writes `arena/types.ts` before any parallel work: `Obs`, `Action` (zod schema), `PlayerCtx` (socket, ids, model, notes, latencyEma), the `events.jsonl` line shape, and the three function signatures `observe`, `decide`, `toIntents`. Every package codes against this file. Changing it is an orchestrator-only action, announced to running agents via SendMessage.

### Work packages, run in parallel after A (each in its own `isolation: "worktree"`)

| Package | Content | Model | Why |
|---|---|---|---|
| B `brain.ts` net + sim | create_game, N sockets, zbin encode/decode, start timer, headless runner, turn feed, pings, record writer, exit | **Opus** | wire-format and lifecycle details are where subtle bugs live |
| C `agent.ts` observe + toIntents | observation builder from `Player`/`Game`, all guards from Step 3, tile selection | **Sonnet** | well-specified against the contract and the sim API |
| D `agent.ts` decide + guardrails + self-check | OpenRouter call, zod parse, referential checks, feedback loop, adaptive interval, canned-garbage self-check | **Sonnet** | pure logic, testable without the server |
| E hygiene | remove `proprietary/*`, `ATTRIBUTION.md`, package.json script, .gitignore, roster files, README for `arena/` | **Haiku** | mechanical |
| Research / lookups | "what does `X` return", log triage, replay-check reading | **Explore (Haiku)** | cheap, read-only |
| Review before merge | one review agent per package: contract compliance, ponytail over-engineering pass, guard coverage | **Sonnet** | independent eyes, not the author |

Max 3 code agents at once (B, C, D). E and Explore are light and can overlap.

### Machine power (one Mac, shared)
- Only the orchestrator runs `npm run dev` (ports 3000–3002, 9000) and the browser spectator. Agents run `npx tsc --noEmit -p .` and their own `npx tsx arena/<file>.ts` self-checks only. No agent runs a full match.
- Worktrees share dependencies: after `EnterWorktree`, `ln -s ~/mindfront/node_modules node_modules` instead of a second `npm run inst` (saves ~1 GB and minutes per worktree).
- The headless sim on the World map is CPU-heavy; smoke matches use `--map Baltics --size Compact --bots 20`. Full World runs happen only when no code agents are active.
- Budget: agents report tokens spent in their final message; the orchestrator stops a package that has doubled its estimate and re-scopes it.

### Alignment between agents
- Each agent prompt contains: the plan file path, its package row, `arena/types.ts` verbatim, the exact files it may touch, and "do not touch anything else". Ponytail rules apply to every agent.
- Each agent ends with: files changed, the check it ran and its output, open questions. The orchestrator relays only what the user needs.
- Contract drift is the only known integration failure mode. Guard: `npx tsc --noEmit` on the merged branch after every merge, then `npx tsx arena/agent.ts` (self-check), then one smoke match. A package that fails goes back to its author via SendMessage with the error, not to a new agent.
- Decisions made during development (e.g. "boat dst = first shore border tile") go into a short **Decisions** list at the bottom of this plan, appended by the orchestrator only, so a later agent never re-litigates them.
- Order: A → (B ∥ C ∥ D ∥ E) → review each → merge B, then C, then D (D depends on C's `toIntents` only through the contract) → smoke match → real match.
- The Workflow tool (scripted multi-agent orchestration) is not used unless you ask for it with "use a workflow"; the Agent tool with worktrees covers this size of job.

## Verification

1. `npm run dev`, wait for `curl -sf http://localhost:9000`.
2. `OPENROUTER_API_KEY=... npx tsx arena/brain.ts --roster arena/roster.test.json --map Baltics --size Compact --bots 20 --interval 100 --timer 8`. Expect: game id + spectate URL within 1 s, `start` within ~5 s, spawn phase ends at tick 150, first decisions logged at tick 200 with reasoning lines.
3. Open the spectate URL in the in-app browser: both roster names visible on the map alongside tribes; territory changes each cycle; screenshot as proof.
4. After ~8 min: `Win` logged, `arena/records/<id>.json` and `<id>.events.jsonl` written. `npm run replay:game -- arena/records/<id>.json` → "Replay is IN SYNC" (a gitCommit warning is expected).
5. Load the record in the browser replay (Main menu → replay from file, or the archive link on the finished-game page) to confirm the record is client-replayable.
6. Negative: kill the brain mid-game → worker log shows ping timeout then `ending game`. `npx tsx arena/agent.ts` runs the built-in self-check (garbage LLM output → fallback action).
7. Then one real run: `--roster arena/roster.json --map World --bots 120 --interval 50 --timer 40` with the 6-vendor roster.

## License (checked: `LICENSE`, `LICENSE-ASSETS`, `LICENSING.md`, `proprietary/LICENSE`)

| Part | License | What it means for us |
|---|---|---|
| Code (`src/`, everything since Sept 2025) | AGPL v3 + Section 7 terms | Fork and modify freely, commercial use allowed. Must keep the "© OpenFront and Contributors" notices visible in the client (footer, loading screen) and not misrepresent the fork as official. If we ever host the spectator site publicly, AGPL's network clause requires publishing the fork's source. Plan: keep the `arena` branch of github.com/effe-exe/mindfront public-ready from day one. |
| `/resources` (maps, sprites, icons, flags, fonts, UI images) | CC BY-SA 4.0, attribution "OpenFront" | Reels that show the rendered map are derivative works. Every reel caption credits "Built on OpenFront (openfront.io), CC BY-SA 4.0" and the reels themselves are share-alike. Commercial use allowed. |
| `/proprietary` (OpenFront logo, `OpenFront.ttf` font, all music `openfront/war/win/of2/of4/evan.mp3`, `game-start-alert.mp3`) | All rights reserved, **no commercial use outside running OpenFront**, no extraction | **Must not appear in the reels.** Vite serves `/proprietary` over `/resources` (`vite.config.ts:169-170`); on the `arena` branch of github.com/effe-exe/mindfront, delete the `proprietary/` contents so the build falls back to open assets, and record with game audio muted. Use our own music and voiceover. |
| OpenFront servers, CDN, database assets, premium skins | Proprietary, access prohibited | The brain and spectator only ever talk to our local server; maps load from the repo's `resources/maps`. Never point anything at `openfront.io` or its CDN (`CDN_BASE` stays unset). |
| Name "OpenFront" | Not a licensed trademark grant | Name the show something else; use "OpenFront" only in the attribution line. |

Action items in Step 0: remove `proprietary/*` on the branch, verify the client still boots with the open fallbacks, keep copyright notices in the footer and loading screen, add an `ATTRIBUTION.md` with the CC BY-SA line for captions.

## Risks
- Server started without `GIT_COMMIT=DEV` → every join gets `version_mismatch`; brain logs it explicitly.
- Model slower than the interval → adaptive per-player interval (Step 4) plus skip-if-pending; it just acts less often.
- Hallucinated ids / illegal moves / bad JSON → layered guardrails (Step 3); never a throw in the tick loop.
- Username regex: keep roster display names simple (letters/digits/space, 3–20 chars).
- Proprietary asset leaking into a reel (music or logo) → removed at the branch level, not at edit time, so it cannot happen by accident.

## Later phases (hooks only, not built now)
- **Camera director + recording**: Playwright on the spectate URL; drive `document.querySelector("build-menu").{eventBus,transformHandler}` with `GoToPlayerEvent(player, zoom)` (`src/client/TransformHandler.ts`), picking targets from `events.jsonl` (big attacks, betrayals, kills, nukes). Record via Puppeteer `page.screencast()` or frame-step + ffmpeg. The repo's `.claude/skills/run-openfront/game.mjs` has the launch/pan helpers.
- **HyperFrames** (github.com/heygen-com/hyperframes, Node 22+, ffmpeg): install its skills with `npx skills add heygen-com/hyperframes`, then `/hyperframes` for overlays (leaderboard, "Claude betrays Gemini" cards, reasoning captions) composited over the recording.
- **Chatterbox-Nano** voiceover: `pip install chatterbox-tts`, `ChatterboxTurboTTS.from_pretrained(device="mps", nano=True)`; script generated from `events.jsonl` + each model's `reasoning` lines.
- **Daily loop + Instagram**: cron runs `npm run arena`, then the render pipeline, then posting (the Postiz-style scheduling connector already configured in this session can upload the reel).

## Decisions (appended by the orchestrator during the build)

- 2026-09-11: `arena/agent.ts` split into `arena/observe.ts` (observe + toIntents) and `arena/decide.ts` (OpenRouter + sanitize + prompt); contract in `arena/types.ts` gained a `Sanitize` type.
- 2026-09-11: `arena/**` added to `tsconfig.json` include; it was not typechecked before.
- 2026-09-11: reasoning models (gpt-5-nano) exhausted `max_tokens: 400` on hidden reasoning and returned empty content → `max_tokens: 1500` plus `reasoning: { effort: "low" }` on every call.
- 2026-09-11: first patch to `src/client`: `TransformHandler.centerAll` retries on the next frame when the canvas has no size yet. Spectators joining mid-game otherwise got scale 0 and a blank map.
- 2026-09-11: `index.html` stripped of Playwire `ramp.js`, AdShield, Google Ads/Analytics, Cloudflare insights and the CrazyGames SDK. The `window.ramp` stub stays so promo code no-ops.
- 2026-09-11: brain fallback when the LLM fails is `expand` into unclaimed land (not `wait`), so a dead model still grows.
- 2026-09-11: guardrail cap was one move action per decision; match 2 showed 35–67 drops per 47 decisions from it and both LLMs lost to a tribe. Now: one expand PLUS one attack/boat per turn.
- 2026-09-11: `isAlive()` is false before random spawn places a player; the brain tracks `unspawned | alive | dead` explicitly.
- 2026-09-11: records and events are serialized with the repo's bigint-safe `replacer` from `src/core/Util.ts`.

## Phase 1.5: MindFront MCP (decided 2026-09-11)

Goal: the game becomes something any agent can plug into over the Model Context Protocol, so MindFront is a benchmark others can enter, not just our harness. Decisions: local first but remote-ready (Streamable HTTP on localhost, per-seat bearer token); our own OpenRouter players use the same MCP surface as external agents (parity); no action caps and no fixed cadence (speed of decision is part of the score).

### Architecture
```
brain.ts (referee: owns the sim, validates, paces, logs, feeds spectators)
  ├─ MCP server  http://localhost:9200/mcp   (arena/mcp/server.ts, @modelcontextprotocol/sdk, Streamable HTTP)
  │     auth: Authorization: Bearer <seat token>; one seat = one game player
  └─ internal players: arena/player.ts × N, generic MCP client driven by an OpenRouter model
external agent: any MCP client with a seat token (Claude Desktop, Cursor, custom) → same server, same tools
```

### Tool surface (server; descriptions carry the rules)
- `rules()` → briefing text (also resource `mindfront://rules`)
- `observe()` → Obs JSON (from `observe.ts`), plus `turn_gap_ok: boolean`
- `inspect_player(id)` → details for one visible player (tiles, troops, relation, alliances, coast, attacks in/out)
- actions, each validated on the live sim with `sanitize` (referential) + `toIntents` (game-legal) and sent immediately; return `{ok:true}` or `{ok:false, reason}`:
  `expand(ratio?)`, `attack(target, ratio?)`, `boat(target, ratio?)`, `ally(target)`, `accept_alliance(target)`, `reject_alliance(target)`, `break_alliance(target)`, `build(unit)`, `emoji(emoji, target?)`, `chat(key, target)`
- `say(text)` → spectator feed only (the "reasoning" line), no game effect
- Every tool call is an EventLine (`kind:"tool"`, seat, tool, args, result, latency) → events.jsonl + SSE feed

### Seats
- `arena/roster.json` entries get a `token` at match start (printed by brain, also written to `arena/records/<gameID>.seats.json`, gitignored). `model: "external"` = seat reserved for an outside agent; brain does not drive it.
- Internal seats: brain starts one `player.ts` loop per seat in-process. Loop = `observe` → LLM with the MCP tools exposed as OpenAI-style tools → execute calls → repeat, min gap `--interval` ticks. Timeouts, 429s and garbage → skip this round, never crash.

### Benchmark logging
- Per seat per match: decisions, tool calls, illegal-call rate, mean latency, tiles over time, alliances made/broken, kills, death tick, final rank. Written into the record's player stats block and `events.jsonl`; leaderboard script later.

### Packages
- P1 `arena/mcp/server.ts` (Opus): server, auth, tools, EventLines, resource. Unit check: start against a headless game from `tests/util/Setup.ts` and call tools through the SDK's client with an in-memory transport.
- P2 `arena/player.ts` (Sonnet): MCP-client loop for OpenRouter models; reuses `systemPrompt`. Self-check with a mocked LLM and the in-memory server.
- P3 brain wiring (orchestrator): start server, mint tokens, replace the direct decide() loop with player loops, feed `kind:"tool"` lines; ArenaFeed renders tool lines.
- Docs: README "Connect your own agent" with a 10-line example client.

### P4: information completeness (decided 2026-09-11: "optimization for AI is key")
Goal: a model must know everything a strong human player can see or infer, in text. Verified engine APIs in parentheses.

Extend `Obs.me`: `maxTroops` (`config.maxTroops(me)`), `troopsPct` of cap, `goldIncomePerMin` (delta of `goldEarned()` over the last 600 ticks, tracked by the brain), `tilesDelta1m`, `attackTroopCost(target)` on demand, `immuneUntilTick` (`config.spawnImmunityDuration()`), `isTraitor`, `betrayals`, `allianceExpiresInTicks` per ally (`alliances()` + `config.allianceDuration()`), `pendingRequestExpiresInTicks` per pending request, `outgoingAttacks` with `troopsRemaining` and `target` (`Attack.troops()`), `structures` per type with counts (`units(type)`), `bbox` and `center` of my largest cluster (`largestClusterBoundingBox`).

Extend every neighbor/visible player: `gold`, `maxTroops`, `troopsPct`, `isTraitor`, `betrayals`, `allies: [id]` (who they are allied with), `targets: [id]` (`targets()`), `attacking: [id]` and `attackedBy: [id]` (from all players' `outgoingAttacks()`), `tilesDelta1m`, `sharedBorderTiles` (count my border tiles adjacent to them), `direction` from my center ("N", "SE", …) and `distance` (manhattan between cluster centers), `coastal`, `structures` counts, `kind`.

New tool `game_info` (also folded into the first `observe`): map name and size, `totalLandTiles`, tick, `minutesLeft` (`maxTimerValue`), win rule, `spawnImmunity`, `allianceDuration`, `allianceRequestCooldown`, `defensePostRange`, unit costs and one-line effects, attack math summary (`config.attackAmount`/`attackLogic` explained: defenders, defense posts, terrain), rate limits (10 intents/s, 150/min), no-cap no-cadence rule, this seat's min gap.

New tool `map_overview`: coarse text map: an N×M grid (e.g. 12×6) of the world where each cell names the majority owner (or "sea"/"free"), plus my cell and each rival's cell. Gives spatial reasoning to text-only models.

`recentEvents` becomes structured: last 20 events involving me and the top 10 global events (conquests, betrayals, big attacks > 10k troops, nukes) with tick and ids.

Implementation: fields computed in `arena/observe.ts` (shared by one-shot and MCP paths); `game_info`/`map_overview` in `arena/mcp/server.ts`; brain tracks per-player history (tiles, goldEarned per 600 ticks) and passes it in. Keep observe() cheap: sample tiles, cap scans, cache per tick.
- 2026-09-11: Phase 1.5 shipped. MCP server (`arena/mcp/server.ts`, :9200, per-seat bearer token, per-request server instance because SDK 1.30 stateless transports cannot be reused), reference player (`arena/player.ts`), brain wires seats and an idle safety net. P4 shipped: full observation dossier, `game_info`, `map_overview`, `trackHistory` sampled every 100 ticks. First MCP match: gpt-5-nano won outright at 80 % land (tick 3761); tool mix 111 expand / 29 attack / 15 build / 4 boat.
- 2026-09-11: `attackTroopCost(target)` was dropped from the spec: the true per-tile cost depends on the exact tile; `game_info.attackMath` explains the formula instead.
- 2026-09-11 (evening): `arena/GUIDE.md` is the full engine-verified manual (system prompt + `rules` tool); `nuke` tool launches Atom/Hydrogen/MIRV from silos at the middle of a target's land; alliance requests allowed to any visible player; build tiles sampled across the whole territory; `build` and `nukes` fields in the observation; rival emoji/chat delivered into recentEvents.
- 2026-09-11: recording is automatic (`arena/record.mjs` spawned by the brain, `--no-record` to skip). Headless Chromium has no GPU: the client accepts a software WebGL context when `localStorage.mindfront.softwaregl` is set (initGL.ts). The recorder stops when `<gameID>.json` appears.
- 2026-09-11: `say` is sparse (only on plan changes, <15 words) to save output tokens. Players retry without the `reasoning` parameter when no provider accepts it (Qwen), and require tool-capable providers (Llama).
- 2026-09-11: user roster policy: no frontier-only rosters; mid/mid-high tiers. 8-seat roster in `arena/roster.8.json`.
- 2026-09-11: spawn phase is player-chosen (`spawn(col,row)`, 24x12 grid, re-pick allowed, auto-placement with room-to-grow for no-shows). `freeLandAtBorder` and nearest-first `reachableByBoat` added after DeepSeek sat on an island expanding into nothing.
- 2026-09-11: lost one recording because the brain exited while the recorder was still encoding; the brain now awaits the recorder (≤3 min) and the recorder keeps the WebM until the MP4 is verified. Pipeline validated on a 5-minute cheap match before re-running the 8-model match.
- 2026-09-11: 8-model World match (arRvNRzjBg): Grok won; first AI-to-AI alliances (GPT-5 with Claude, Grok, Gemini); 5 silos built, no launch (nukes are unaffordable in 20 min at default gold). Match cost ≈ $12.75.
- 2026-09-11 (late): user observed idle gold and under-used boats; GUIDE.md gained section 13 "Base strategy" (mechanics-derived defaults: spend gold, boats to rich weak tribes, attack arithmetic, order of operations, alliances as timers, nukes need an economy). Benchmark still measures judgment: these are stated as starting points.
- Next session: Instagram posting pipeline (user's call), leaderboard script over events.jsonl, a "nuke-capable" match preset (longer timer or goldMultiplier), camera director for reels.
- 2026-09-12: folded openfront.fyi/strategies into GUIDE.md §13 after checking every number against Config.ts (cost ladders, 80 % cap rule, trade-by-distance, traitor window, natural alliance expiry). Added the `retreat(target?)` tool (engine `cancel_attack`, 25 % malus vs players) so stop-loss is possible; fixed the stale "Warship cannot be placed" note.
- 2026-09-14: pre-match briefing (each model writes a plan from the manual; echoed as `plan`); `alerts` first key of every observation; `build(unit, at)` placement (Defense Posts were clustering because our tile scan took the first legal tile: our code, not the models). GUIDE.md rewritten LLM-first (contract, formulas, tables, IF/THEN defaults; ~4.6k tokens).
- 2026-09-14: independent audit (`docs/AUDIT-2026-09-14.md`, 4 blockers / 20 wrong / 21 missing). Batch 1 (7cb52e74e): land-only free-land check (water is unowned, so every coastal player looked expandable), safety net only for failing seats (10 %, noted), "Port needed for boats" removed, clock from `elapsedGameSeconds`, <100-tile elimination alert, retreat-vs-attacker reason, nuke detonation keys. Batch 2 (11 commits): `extend_alliance`, `donate`, `recall_boats`, `upgrade` + `me.units`/`underConstruction` (structure counts = Σ levels of finished ones), `tradePartnerPorts` + income by source, `incomingBoats` + BOAT INCOMING alert (`UnitIncoming`), whole-border scans, `sharesSea` via water components (boat to any visible id sharing a sea), nuke refused when the blast covers own tiles or breaks an alliance, per-round purse (no double spend), traitorTicksLeft, every drop reason says what to do instead. Still open: O4/O8/O9/O10, T8 (RATIO_MAX), O11/O12, G9/G10, M9.
- 2026-09-14: `openai/gpt-5` timed out 41× at 20 s in one match; mid-high roster now uses `openai/gpt-5-mini`, per-call timeout 30 s.
- 2026-09-14: match aZxzNPzhUH (mid-high, all audit fixes): Qwen won on the timer; first nukes ever (Qwen 2× Atom Bomb, Gemini 2×; Gemini broke its alliance with Qwen to nuke it, re-allied, broke again); 17 extend_alliance, 15 upgrades, 2 donations, 138 boats. Claude and DeepSeek missed the 20 s spawn pick: a cold model round on the real prompt takes 11–12 s (Sonnet 4.5 on Bedrock) and 49 s for DeepSeek v3.2 with `reasoning: low` (1,200 reasoning tokens, ignores "low"; 11 s without). Fixes: spawn phase 200 → 600 ticks (`Config.ts`, fork constant, test updated); players drop the `reasoning` parameter for any model that spends >800 reasoning tokens at low effort. Known quirk: actions sent in the same round as `break_alliance` are still checked against the alliance (the break lands next tick); models recover next round.
- 2026-09-14: `arena/roster.fast.json` (Haiku 4.5, GPT-5.6 Luna, Gemini 3.1 Flash Lite, Grok 4.3, Qwen 3.8 Flash, GLM 5.3 Flash; measured 1–7 s per cold round; DeepSeek v4 Flash 13–24 s, Kimi k2.5 and Llama 4 Maverick rejected as slow/no tool call). System prompt sent as a cacheable block (Anthropic `cache_control`; OpenAI/Google/xAI/GLM cache on their own): Sonnet's ~$17 across matches was 8k uncached input tokens per round. Match aLoBLP5sXJ: GPT Luna won at 80 % (19:27); all six picked their own spawn inside the 60 s window; three chose the same cell and Haiku died at 2:43. `say` limited to one line per 300 ticks per seat (Gemini Flash Lite: 175 lines); `donate` treats a 0/1 in the unused field as absent (strict schemas made GPT Luna send `gold: 1` with every troop gift, 11 refusals); briefing max_tokens 1,500 (reasoning tokens truncated Gemini Flash Lite's plan at 900).
- 2026-09-14: user noticed Ports dried up (11 per match before batch 2 → 5 → 2). Cause: batch 2's honest-but-discouraging Port text ("pays only with a partner Port; 0 now") created a first-mover deterrent. Engine check: every trade-ship arrival pays BOTH owners in full (`TradeShipExecution.complete`), ≈4 ships/min per Port at <200 ships worldwide → a pair 300 tiles apart ≈ 400k/min each, 7× base. Guide §4/§10/§11, `game_info`, and the Port note now say so; new `me.aiOnMySea` (AI players whose shore touches my sea = partners once they build); Warship value spelled out (sinks transports in one shell, captures rival trade ships for the whole payout).
- 2026-09-14: match aXoXwwQ1LR (fast roster, ~$3.70): GPT Luna won at 80 % in 13:45 (second straight); Grok led at 2:00 with 2,892 tiles then launched 5 attacks at 0.4–0.5 each in two rounds and was dead at 2:20 of game time; 11 alliances, no betrayals, 5 Ports (old guide text), 1 silo, no launch. `say` cap held (72 accepted / 155 refused). Qwen Flash 8 timeouts, GLM 6.
- 2026-09-14: nations enabled on request (`--nations N`, `--difficulty` Easy|Medium|Hard|Impossible, default 0/Easy). `kind: "nation"` in every view, `N<id>` on the map overview, `game_info.nations/tribes/difficulty`, `aiOnMySea` counts nations (their Ports trade). Guide §7 nation paragraph verified against NationExecution/AiAttackBehavior/NationAllianceBehavior/NationNukeBehavior/NationStructureBehavior at Easy: 12,500 start troops, cap ×0.5, regen ×0.9, act every 65–100 ticks, build Cities → Ports/Factories/Silos/SAMs, attack AI seats 1 in 4, ally 90 % in the first 5 min, never betray an AI seat, nuke the most hated or a leader 40 points ahead. Nations respect and receive spawn immunity.
- 2026-09-14: user watched Gemini Flash take 4 Atom Bombs while building Defense Posts, and nukes land on empty land. Fixes: (1) `nuke` aims at the point on the target's land that deletes the most structures (each of their structures is a candidate, scored structures×200 + tiles stripped, skipping aim points that touch my tiles or an ally) instead of the geometric middle; (2) `NUKED` alert (first key) for 90 s after any launch at me, naming the launcher, my SAM cover, and the counters (SAM 1.5M/300 ticks/70-tile range next to Cities and Silos; Silo + bomb back; alliance deletes warheads in flight); (3) guide §6 "Defence" paragraph and §11.4: SAM as soon as a rival owns a Silo or a bomb has hit, Silo once income allows, Defense Posts irrelevant to nukes.
- 2026-09-14: full mechanics pass on request ("every mechanic, what it does and does not, how they interact"). Inventory = every Execution/Intent/UnitType in src/core. Added: `embargo(target, stop?)` (trade stops both ways; nations −20) and `move_warship(id, x, y)` (patrol point on the same water body) tools; `relationToMe` on every view (a nation acts on ITS ledger of me, not mine of it); guide: impassable peaks, Defense Post never shoots (engine targeting disabled) and does nothing vs nukes, Warship never shells land and heals near a Port, structures cannot be moved/sold/deleted, conquest gold skipped for a victim that never attacked, §12 interactions table (allied / traitor / attack / <100 tiles / nuke lands / immunity / embargo / Port lost / City lost / Defense Post / SAM / Warship / relation / timer end). Not offered on purpose: `delete_unit` (no upside), `embargo_all`, doomsday clock (off in the arena), team modes.
- 2026-09-14: match aCVSsZaZy2 (fast roster + 12 nations, ~$6.20): Gemini Flash won on the timer with 92,961 tiles despite absorbing ~30 Atom Bombs (GPT Luna 25,657, Haiku 24,051); 67 warheads launched (62 Atom, 5 Hydrogen: first H-bombs), 12 silos, 8 SAMs, 35 Warships, 11 Ports, 34 alliances, 9 betrayals (nations among themselves too), Qwen Flash dead at 0:22 of play (3 seats again crowded one cell), Grok at 8:51. Old guide text for Ports/nukes was live in this match; the nuke aiming and NUKED alert land next match. Spend $73.29 of $100.
- 2026-09-14: match aZNaWDwqAX (fast roster vs 12 nations on Hard): nation Siberia won; all six seats dead or tiny by 13 min. `say` removed on request (spectator line, no game effect, pure token burn); the feed keeps tool calls and events. Solo experiment next: one seat (`arena/roster.solo.json`, GPT-5.6 Terra) vs 12 Hard nations.
