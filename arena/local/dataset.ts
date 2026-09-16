// Behaviour-cloning dataset from archived human games: replay each record
// headlessly and, whenever a kept human acts, pair the observation they saw
// (arena/observe.ts, exactly what a seat gets) with their intents translated
// into our tool vocabulary. Output = mlx-lm "tools" format (one JSON per line).
//
// Run it INSIDE the worktree that sits at the engine commit the records were
// played on (arena/local/sync-worktree.sh copies this file there), e.g.
//   cd ~/mindfront-replay && npx tsx arena/local/dataset.ts ~/mindfront/arena/records/human --out ~/mindfront/arena/local/data
//
// Flags: --out DIR  --max-games N  --window 50  --keep 2 (top finishers per game)  --valid 0.05
//        --idle 0.3 (share of empty windows kept when the previous window was empty too; every first idle window after activity is kept)
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import readline from "readline";
import { Config } from "../../src/core/configuration/Config";
import { Executor } from "../../src/core/execution/ExecutionManager";
import { PlayerInfo, PlayerType, UnitType, type Game, type Player } from "../../src/core/game/Game";
import { createGame } from "../../src/core/game/GameImpl";
import { GameUpdateType, type HashUpdate } from "../../src/core/game/GameUpdates";
import { createNationsForGame } from "../../src/core/game/NationCreation";
import { loadTerrainMap } from "../../src/core/game/TerrainMapLoader";
import { GameRunner } from "../../src/core/GameRunner";
import { PseudoRandom } from "../../src/core/PseudoRandom";
import type { GameRecord, GameStartInfo, Intent } from "../../src/core/Schemas";
import { decompressGameRecord, flattenedEmojiTable, simpleHash, toWireGameStartInfo } from "../../src/core/Util";
import { NodeGameMapLoader } from "../../tests/perf/fullgame/NodeGameMapLoader";
import { observe, trackHistory, UNIT_MAP } from "../observe";
import { RATIO_MAX, RATIO_MIN, type BuildableUnit, type PlayerCtx } from "../types";
import { compactObs, localSystemPrompt, RECENT_SECONDS, type RecentAction } from "./prompt";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? dflt : process.argv[i + 1];
};
const recordsDir = process.argv[2];
if (!recordsDir) throw new Error("usage: dataset.ts <recordsDir> --out <dir>");
const outDir = arg("--out", "arena/local/data");
const maxGames = Number(arg("--max-games", "1000000"));
const WINDOW = Number(arg("--window", "50"));
const KEEP = Number(arg("--keep", "2"));
const VALID = Number(arg("--valid", "0.05"));
const IDLE = Number(arg("--idle", "0.3"));
const MAX_CALLS = 8;

// The tool list the seat sees, taken from the arena's own MCP server so the
// training prompt renders the same tools block as inference. Generated once by
// arena/local/tools.json (see sync-worktree.sh).
const TOOLS = JSON.parse(fs.readFileSync(path.join(ROOT, "arena/local/tools.json"), "utf8")) as unknown[];

type ToolCall = { name: string; arguments: Record<string, unknown> };
type Example = { messages: unknown[]; tools: unknown[] };

const UNIT_NAME = new Map<UnitType, BuildableUnit>(Object.entries(UNIT_MAP).map(([k, v]) => [v, k as BuildableUnit]));
const NUKE_NAME: Partial<Record<UnitType, string>> = {
  [UnitType.AtomBomb]: "Atom Bomb",
  [UnitType.HydrogenBomb]: "Hydrogen Bomb",
  [UnitType.MIRV]: "MIRV",
};

function ratioOf(troops: number | null | undefined, me: Player): number {
  const total = me.troops();
  if (troops === null || troops === undefined || total <= 0) return 0.3;
  const r = Math.round((troops / total) * 100) / 100;
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, r));
}

/** `at` for a build: the rival whose land is nearest the tile (within 15), else "sea" on a shore, else nothing. */
function buildAt(game: Game, me: Player, tile: number): number | "sea" | undefined {
  const x = game.x(tile);
  const y = game.y(tile);
  const counts = new Map<number, number>();
  for (let dx = -15; dx <= 15; dx++) {
    for (let dy = -15; dy <= 15; dy++) {
      if (!game.isValidCoord(x + dx, y + dy)) continue;
      const t = game.ref(x + dx, y + dy);
      if (!game.hasOwner(t)) continue;
      const o = game.ownerID(t);
      if (o === me.smallID()) continue;
      counts.set(o, (counts.get(o) ?? 0) + 1);
    }
  }
  let best: number | undefined;
  let bestN = 0;
  for (const [id, n] of counts) if (n > bestN) [best, bestN] = [id, n];
  if (best !== undefined) return best;
  return game.isShore(tile) ? "sea" : undefined;
}

/** One human intent -> one tool call in our vocabulary, or null when we do not expose it. */
function label(game: Game, me: Player, intent: Intent): ToolCall | null {
  const small = (id: string): number | null => {
    if (!game.hasPlayer(id)) return null;
    return game.player(id).smallID();
  };
  switch (intent.type) {
    case "attack": {
      if (intent.targetID === null) return { name: "expand", arguments: { ratio: ratioOf(intent.troops, me) } };
      const t = small(intent.targetID);
      return t === null ? null : { name: "attack", arguments: { target: t, ratio: ratioOf(intent.troops, me) } };
    }
    case "boat": {
      const owner = game.owner(intent.dst);
      if (!owner.isPlayer()) return null;
      return { name: "boat", arguments: { target: owner.smallID(), ratio: ratioOf(intent.troops, me) } };
    }
    case "build_unit": {
      const nuke = NUKE_NAME[intent.unit];
      if (nuke !== undefined) {
        const owner = game.owner(intent.tile);
        return owner.isPlayer() ? { name: "nuke", arguments: { target: owner.smallID(), nuke } } : null;
      }
      const unit = UNIT_NAME.get(intent.unit);
      if (unit === undefined) return null;
      const at = buildAt(game, me, intent.tile);
      return { name: "build", arguments: at === undefined ? { unit } : { unit, at } };
    }
    case "upgrade_structure": {
      const unit = UNIT_NAME.get(intent.unit);
      return unit === undefined ? null : { name: "upgrade", arguments: { unit, id: intent.unitId } };
    }
    case "move_warship":
      return { name: "move_warship", arguments: { id: intent.unitIds[0], x: game.x(intent.tile), y: game.y(intent.tile) } };
    case "cancel_attack": {
      const a = me.outgoingAttacks().find((x) => x.id() === intent.attackID);
      const t = a?.target();
      return { name: "retreat", arguments: t !== undefined && t.isPlayer() ? { target: t.smallID() } : {} };
    }
    case "cancel_boat":
      return { name: "recall_boats", arguments: {} };
    case "allianceRequest": {
      const t = small(intent.recipient);
      if (t === null) return null;
      const pending = me.incomingAllianceRequests().some((r) => r.requestor().smallID() === t);
      return { name: pending ? "accept_alliance" : "ally", arguments: { target: t } };
    }
    case "allianceReject": {
      const t = small(intent.requestor);
      return t === null ? null : { name: "reject_alliance", arguments: { target: t } };
    }
    case "breakAlliance": {
      const t = small(intent.recipient);
      return t === null ? null : { name: "break_alliance", arguments: { target: t } };
    }
    case "allianceExtension": {
      const t = small(intent.recipient);
      return t === null ? null : { name: "extend_alliance", arguments: { target: t } };
    }
    case "donate_troops": {
      const t = small(intent.recipient);
      return t === null || !intent.troops ? null : { name: "donate", arguments: { target: t, troops: Math.round(intent.troops) } };
    }
    case "donate_gold": {
      const t = small(intent.recipient);
      return t === null || !intent.gold ? null : { name: "donate", arguments: { target: t, gold: Math.round(intent.gold) } };
    }
    case "embargo": {
      const t = small(intent.targetID);
      return t === null ? null : { name: "embargo", arguments: intent.action === "stop" ? { target: t, stop: true } : { target: t } };
    }
    case "emoji": {
      const emoji = flattenedEmojiTable[intent.emoji];
      if (emoji === undefined) return null;
      if (intent.recipient === "AllPlayers") return { name: "emoji", arguments: { emoji } };
      const t = small(intent.recipient);
      return t === null ? null : { name: "emoji", arguments: { emoji, target: t } };
    }
    case "quick_chat": {
      const t = small(intent.recipient);
      return t === null ? null : { name: "chat", arguments: { key: intent.quickChatKey, target: t } };
    }
    default:
      return null; // spawn, targetPlayer, delete_unit, embargo_all, mark_disconnected, toggle_pause
  }
}

function ctxFor(p: Player): PlayerCtx {
  return {
    model: "",
    name: p.name(),
    persona: "",
    clientID: p.clientID() ?? "",
    playerID: p.id(),
    notes: "",
    lastResult: "",
    latencyEma: 0,
    intervalTicks: 0,
    pending: false,
    consecutiveDrops: 0,
  };
}

/** `obs` is already compacted (compactObs) so training renders exactly what the seat gets. */
function example(obs: unknown, calls: ToolCall[]): Example {
  const assistant =
    calls.length === 0
      ? { role: "assistant", content: "Holding." }
      : {
          role: "assistant",
          content: "",
          tool_calls: calls.map((c, i) => ({ id: `call_${i + 1}`, type: "function", function: { name: c.name, arguments: c.arguments } })),
        };
  return {
    messages: [
      { role: "system", content: localSystemPrompt() },
      { role: "user", content: JSON.stringify(obs) },
      assistant,
    ],
    tools: TOOLS,
  };
}

/** Humans worth cloning: the winner plus the top KEEP survivors by final tiles. */
function keptClientIDs(record: GameRecord): Set<string> {
  const info = record.info;
  const keep = new Set<string>();
  if (info.winner?.[0] === "player") keep.add(info.winner[1]);
  const ranked = info.players
    .filter((p) => p.stats?.killedAt === undefined)
    .map((p) => ({ id: p.clientID, tiles: Number(p.stats?.finalTiles ?? 0) }))
    .sort((a, b) => b.tiles - a.tiles);
  for (const p of ranked.slice(0, KEEP)) if (p.tiles > 0) keep.add(p.id);
  return keep;
}

async function replayRecord(file: string): Promise<{ examples: Example[]; synced: boolean; ticks: number }> {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as GameRecord;
  const record = decompressGameRecord(raw);
  const info = record.info;
  const gameStart: GameStartInfo = toWireGameStartInfo({
    gameID: info.gameID,
    lobbyCreatedAt: info.lobbyCreatedAt,
    config: info.config,
    players: info.players,
    tribes: info.tribes,
  });
  const config = new Config(info.config, null, false);
  const terrain = await loadTerrainMap(info.config.gameMap, info.config.gameMapSize, new NodeGameMapLoader(path.join(ROOT, "resources/maps")), false);
  const random = new PseudoRandom(simpleHash(gameStart.gameID));
  const humans = gameStart.players.map(
    (p) => new PlayerInfo(p.username, PlayerType.Human, p.clientID, random.nextID(), p.isLobbyCreator ?? false, p.clanTag, p.friends ?? [], p.teamIndex ?? null),
  );
  const nations = createNationsForGame(gameStart, terrain.nations, terrain.additionalNations, humans.length, random);
  const game = createGame(humans, nations, terrain.gameMap, terrain.miniGameMap, config, terrain.teamGameSpawnAreas);
  const computed = new Map<number, number>();
  let fatal: string | undefined;
  const runner = new GameRunner(
    game,
    new Executor(game, gameStart.gameID, undefined, gameStart.tribes?.map((t) => t.name)),
    (gu) => {
      if ("errMsg" in gu) {
        fatal = `${gu.errMsg}\n${(gu as { stack?: string }).stack ?? ""}`;
        return;
      }
      for (const hu of gu.updates[GameUpdateType.Hash] as HashUpdate[]) computed.set(hu.tick, hu.hash);
    },
  );
  runner.init();

  const keep = keptClientIDs(record);
  const examples: Example[] = [];
  const open = new Map<string, { until: number; obs: unknown; calls: ToolCall[] }>();
  const lastIntent = new Map<string, number>();
  // The human's own calls of the last RECENT_SECONDS, shown in every observation
  // (a seat without them re-decides from scratch every round).
  const recent = new Map<string, { tick: number; call: ToolCall }[]>();
  const recentFor = (cid: string, tick: number): RecentAction[] => {
    const list = (recent.get(cid) ?? []).filter((r) => tick - r.tick < RECENT_SECONDS * 10);
    recent.set(cid, list);
    return list.map((r) => ({ ago: (tick - r.tick) / 10, name: r.call.name, args: r.call.arguments }));
  };
  const view = (me: Player, tick: number) => compactObs(observe(game, me, ctxFor(me), [], []) as unknown as Record<string, unknown>, recentFor(me.clientID() ?? "", tick));
  let synced = true;
  for (const turn of record.turns) {
    const tick = game.ticks();
    if (tick % 100 === 0) trackHistory(game);
    if (!game.inSpawnPhase()) {
      // Close windows that ran out.
      for (const [cid, w] of open) {
        if (tick >= w.until) {
          examples.push(example(w.obs, w.calls));
          open.delete(cid);
        }
      }
      // Human intents this tick, observed BEFORE they execute.
      for (const intent of turn.intents) {
        if (!keep.has(intent.clientID)) continue;
        const me = game.playerByClientID(intent.clientID);
        if (me === null || !me.isAlive()) continue;
        lastIntent.set(intent.clientID, tick);
        let w = open.get(intent.clientID);
        if (w === undefined) {
          w = { until: tick + WINDOW, obs: view(me, tick), calls: [] };
          open.set(intent.clientID, w);
        }
        const call = label(game, me, intent);
        if (call === null) continue;
        if (w.calls.length < MAX_CALLS) w.calls.push(call);
        recent.get(intent.clientID)?.push({ tick, call }) ?? recent.set(intent.clientID, [{ tick, call }]);
      }
      // Windows in which the human did nothing. The first idle window after
      // activity is always kept (that is the "stop" signal); long pauses are
      // sampled at IDLE so "Holding." does not dominate the loss (v2: 60 % of
      // examples, and the seat learned the prior instead of the decision).
      if (tick % WINDOW === 0) {
        for (const cid of keep) {
          if (open.has(cid)) continue;
          const afterAction = (lastIntent.get(cid) ?? -1) >= tick - WINDOW;
          if (!afterAction && Math.random() > IDLE) continue;
          const me = game.playerByClientID(cid);
          if (me === null || !me.isAlive()) continue;
          examples.push(example(view(me, tick), []));
        }
      }
    }
    runner.addTurn(turn);
    if (!runner.executeNextTick()) {
      console.warn(`${info.gameID}: tick failed at ${turn.turnNumber}: ${fatal}`);
      synced = false;
      break;
    }
    const c = computed.get(turn.turnNumber);
    if (c !== undefined && turn.hash !== null && turn.hash !== undefined && c !== turn.hash) {
      console.warn(`${info.gameID}: hash mismatch at turn ${turn.turnNumber}; keeping examples up to here`);
      synced = false;
      break;
    }
  }
  for (const w of open.values()) examples.push(example(w.obs, w.calls));
  return { examples: examples.filter((e) => (e.messages[2] as { tool_calls?: unknown[] }).tool_calls?.length !== 0), synced, ticks: game.ticks() };
}

// The engine keeps module-level caches that survive one game and crash the next
// ("_borderTiles of undefined" at tick 1), so a directory is processed one
// record per child process; a single file is processed in this process.
async function main() {
  console.debug = () => {};
  fs.mkdirSync(outDir, { recursive: true });
  if (fs.statSync(recordsDir).isDirectory()) {
    const files = fs.readdirSync(recordsDir).filter((f) => f.endsWith(".json") && !f.includes(".seats")).slice(0, maxGames);
    for (const name of ["train.jsonl", "valid.jsonl"]) fs.writeFileSync(path.join(outDir, name), "");
    for (const [i, f] of files.entries()) {
      process.stdout.write(`${i + 1}/${files.length} `);
      const r = spawnSync("npx", ["tsx", process.argv[1], path.join(recordsDir, f), ...process.argv.slice(3)], { stdio: ["ignore", "inherit", "ignore"] });
      if (r.status !== 0) console.log(`${f}: child exited ${r.status}`);
    }
    // Files run to hundreds of MB: count by streaming, never one big string.
    const count = async (name: string) => {
      let lines = 0;
      let chars = 0;
      const toolCounts = new Map<string, number>();
      for await (const line of readline.createInterface({ input: fs.createReadStream(path.join(outDir, name)) })) {
        if (!line) continue;
        lines++;
        chars += line.length;
        for (const tc of ((JSON.parse(line) as Example).messages[2] as { tool_calls?: { function: { name: string } }[] }).tool_calls ?? []) {
          toolCounts.set(tc.function.name, (toolCounts.get(tc.function.name) ?? 0) + 1);
        }
      }
      return { lines, chars, toolCounts };
    };
    const train = await count("train.jsonl");
    console.log(`train=${train.lines} valid=${(await count("valid.jsonl")).lines} ≈${Math.round(train.chars / 3.5 / 1000)}k tokens`);
    console.log([...train.toolCounts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" "));
    return;
  }
  const f = path.basename(recordsDir);
  const t0 = Date.now();
  let res: Awaited<ReturnType<typeof replayRecord>>;
  try {
    res = await replayRecord(recordsDir);
  } catch (err) {
    console.log(`${f}: ${String(err).slice(0, 200)}`);
    return;
  }
  const sink = path.join(outDir, Math.random() < VALID ? "valid.jsonl" : "train.jsonl");
  fs.appendFileSync(sink, res.examples.map((e) => JSON.stringify(e) + "\n").join(""));
  console.log(`${f} ${res.synced ? "in sync" : "DIVERGED"} ticks=${res.ticks} examples=${res.examples.length} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

void main();
