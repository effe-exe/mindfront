/**
 * MindFront arena match runner (Package B).
 *
 * One process: creates a private lobby on the local dev server, opens one
 * WebSocket per roster entry, starts the game, feeds ONE headless GameRunner
 * from socket 0, and every `intervalTicks` asks each LLM player what to do
 * (observe -> decide -> sanitize -> toIntents) and sends the resulting intents
 * on that player's socket. Writes a replayable GameRecord and an events.jsonl.
 *
 *   npx tsx arena/brain.ts [--roster arena/roster.json] [--map World]
 *     [--size Normal] [--bots 120] [--interval 50] [--timer 40]
 *     [--records-dir arena/records] [--no-llm]
 */
import "dotenv/config";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocket } from "ws";
import {
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  Player,
} from "../src/core/game/Game";
import {
  ErrorUpdate,
  GameUpdateType,
  GameUpdateViewData,
} from "../src/core/game/GameUpdates";
import { createGameRunner, GameRunner } from "../src/core/GameRunner";
import type {
  AllPlayersStats,
  GameConfig,
  GameRecord,
  GameStartInfo,
  Intent,
  PlayerRecord,
  ServerMessage,
  Turn,
  Winner,
} from "../src/core/Schemas";
import { createPartialGameRecord, replacer } from "../src/core/Util";
import {
  createGameWireContext,
  decodeServerMessage,
  encodeClientMessage,
} from "../src/core/ZbinWire";
import { NodeGameMapLoader } from "../tests/perf/fullgame/NodeGameMapLoader";
import { decide, sanitize } from "./decide";
import { observe, toIntents } from "./observe";
import {
  adaptiveInterval,
  DECIDE_TIMEOUT_MS,
  DEFAULT_INTERVAL_TICKS,
  Dropped,
  EventLine,
  FALLBACK_DECISION,
  PlayerCtx,
  RosterEntry,
} from "./types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------- flags ----------

const flags = {
  roster: "arena/roster.json",
  map: "World",
  size: "Normal",
  bots: 120,
  interval: DEFAULT_INTERVAL_TICKS,
  timer: 40,
  recordsDir: "arena/records",
  noLlm: false,
};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${argv[i - 1]}`);
      return v;
    };
    switch (argv[i]) {
      case "--roster":
        flags.roster = next();
        break;
      case "--map":
        flags.map = next();
        break;
      case "--size":
        flags.size = next();
        break;
      case "--bots":
        flags.bots = parseInt(next(), 10);
        break;
      case "--interval":
        flags.interval = parseInt(next(), 10);
        break;
      case "--timer":
        flags.timer = parseInt(next(), 10);
        break;
      case "--records-dir":
        flags.recordsDir = next();
        break;
      case "--no-llm":
        flags.noLlm = true;
        break;
      default:
        throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
}

const gameMap = GameMapType[flags.map as keyof typeof GameMapType];
if (gameMap === undefined) throw new Error(`unknown map: ${flags.map}`);
const gameMapSize = GameMapSize[flags.size as keyof typeof GameMapSize];
if (gameMapSize === undefined) throw new Error(`unknown size: ${flags.size}`);

const roster: RosterEntry[] = JSON.parse(
  fs.readFileSync(path.resolve(ROOT, flags.roster), "utf8"),
);
if (roster.length === 0) throw new Error("roster is empty");

const recordsDir = path.resolve(ROOT, flags.recordsDir);
fs.mkdirSync(recordsDir, { recursive: true });

// ---------- per-socket state ----------

interface Seat extends PlayerCtx {
  ws: WebSocket;
  token: string;
  sawLobbyInfo: boolean;
  /** the headless sim's Player, resolved at start */
  me: Player | null;
  /** isAlive() is false until randomSpawn places the player, so track the arc */
  life: "unspawned" | "alive" | "dead";
  recentEvents: string[];
  decisions: number;
  drops: number;
  errors: number;
}

const seats: Seat[] = roster.map((r) => ({
  ...r,
  ws: null as unknown as WebSocket,
  token: randomUUID(),
  clientID: "",
  playerID: "",
  notes: "",
  lastResult: "",
  latencyEma: 0,
  intervalTicks: flags.interval,
  pending: false,
  consecutiveDrops: 0,
  sawLobbyInfo: false,
  me: null,
  life: "unspawned",
  recentEvents: [],
  decisions: 0,
  drops: 0,
  errors: 0,
}));

// ---------- lobby ----------

const config: GameConfig = {
  gameMap,
  gameMapSize,
  difficulty: Difficulty.Easy,
  gameType: GameType.Private,
  gameMode: GameMode.FFA,
  nations: "disabled",
  bots: flags.bots,
  randomSpawn: true,
  donateGold: true,
  donateTroops: true,
  infiniteGold: false,
  infiniteTroops: false,
  instantBuild: false,
  disabledUnits: [],
  startDelay: 0,
  maxTimerValue: flags.timer,
};

const created = await fetch("http://localhost:3001/api/create_game", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${seats[0].token}`,
  },
  body: JSON.stringify(config),
});
if (!created.ok) {
  throw new Error(
    `create_game failed: ${created.status} ${await created.text()}`,
  );
}
const lobby = (await created.json()) as {
  gameID: string;
  workerIndex: number;
  workerPath: string;
};
const gameID = lobby.gameID;
console.log(`spectate: http://localhost:9000/game/${gameID}?spectate`);

const eventsPath = path.join(recordsDir, `${gameID}.events.jsonl`);
const recordPath = path.join(recordsDir, `${gameID}.json`);
fs.writeFileSync(eventsPath, "");
function writeEvent(line: EventLine) {
  fs.appendFileSync(eventsPath, JSON.stringify(line, replacer) + "\n");
}

// ---------- game state ----------

let ctx: ReturnType<typeof createGameWireContext> | undefined;
let runner: GameRunner | null = null;
let game: Game | null = null;
let gameStartInfo: GameStartInfo | null = null;
let startMs = 0;
const turns: Turn[] = [];
const hashes = new Map<number, number>();
let winner: Winner;
let allPlayersStats: AllPlayersStats = {};
let finished = false;

function send(seat: Seat, msg: Parameters<typeof encodeClientMessage>[0]) {
  if (seat.ws.readyState !== WebSocket.OPEN) return;
  seat.ws.send(encodeClientMessage(msg, ctx));
}

function simEvent(type: string, text: string, players: string[]) {
  writeEvent({ kind: "sim", t: game?.ticks() ?? 0, type, text, players });
  for (const seat of seats) {
    if (!players.includes(seat.name)) continue;
    seat.recentEvents.push(text);
    if (seat.recentEvents.length > 8) seat.recentEvents.shift();
  }
}

// ---------- sockets ----------

function openSocket(seat: Seat): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(
      `ws://localhost:${3001 + lobby.workerIndex}/${lobby.workerPath}`,
    );
    seat.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.on("open", () => {
      ws.send(
        encodeClientMessage(
          {
            type: "join",
            token: seat.token,
            gameID,
            username: seat.name,
            clanTag: null,
            turnstileToken: null,
            spectator: false,
            gitCommit: process.env.GIT_COMMIT ?? "DEV",
          },
          undefined,
        ),
      );
      resolve();
    });
    ws.on("message", (data: ArrayBuffer | Buffer) => {
      let msg: ServerMessage;
      try {
        msg = decodeServerMessage(new Uint8Array(data as ArrayBuffer), ctx);
      } catch (e) {
        console.error(`[${seat.name}] decode failed:`, e);
        return;
      }
      onMessage(seat, msg);
    });
    ws.on("close", (code, reason) =>
      console.log(`[${seat.name}] closed ${code} ${reason.toString()}`),
    );
    ws.on("error", (e) => console.error(`[${seat.name}] socket error:`, e));
  });
}

function onMessage(seat: Seat, msg: ServerMessage) {
  switch (msg.type) {
    case "error":
      console.error(
        `[${seat.name}] server error: ${msg.error} ${msg.message ?? ""}` +
          (msg.error === "version_mismatch"
            ? ` (server commit ${msg.gitCommit}; start it with GIT_COMMIT=DEV)`
            : ""),
      );
      return;
    case "lobby_info":
      seat.clientID = msg.myClientID;
      if (!seat.sawLobbyInfo) {
        seat.sawLobbyInfo = true;
        console.log(`[${seat.name}] joined as ${msg.myClientID}`);
        if (seats.every((s) => s.sawLobbyInfo)) {
          console.log("all seats in lobby, starting timer");
          send(seats[0], {
            type: "intent",
            intent: { type: "toggle_game_start_timer" },
          });
        }
      }
      return;
    case "start":
      if (msg.myClientID !== undefined) seat.clientID = msg.myClientID;
      // The start message seeds the dictionary for every later frame.
      ctx ??= createGameWireContext(msg.gameStartInfo.players);
      if (seat === seats[0] && runner === null)
        void onStart(msg.gameStartInfo, msg.turns);
      return;
    case "turn":
      if (seat !== seats[0] || runner === null) return;
      turns.push(msg.turn);
      runner.addTurn(msg.turn);
      runner.executeNextTick();
      return;
    default:
      return;
  }
}

// ---------- sim ----------

async function onStart(info: GameStartInfo, missed: Turn[]) {
  gameStartInfo = info;
  startMs = Date.now();
  console.log(`start: ${info.players.length} players, ${info.config.gameMap}`);
  runner = await createGameRunner(
    info,
    undefined,
    new NodeGameMapLoader(path.join(ROOT, "resources/maps")),
    onUpdate,
  );
  game = runner.game;
  console.debug = () => {};
  for (const seat of seats) {
    const p = game.playerByClientID(seat.clientID);
    if (p === null) {
      console.error(
        `[${seat.name}] not in the sim (clientID ${seat.clientID})`,
      );
      continue;
    }
    seat.me = p;
    seat.playerID = p.id();
  }
  for (const t of missed) {
    turns.push(t);
    runner.addTurn(t);
    runner.executeNextTick();
  }
}

function onUpdate(gu: GameUpdateViewData | ErrorUpdate) {
  if ("errMsg" in gu) {
    console.error("sim error:", gu.errMsg);
    return;
  }
  if (game === null) return;
  const g = game;
  const u = gu.updates;

  for (const h of u[GameUpdateType.Hash]) hashes.set(h.tick, h.hash);

  for (const c of u[GameUpdateType.ConquestEvent]) {
    const a = g.player(c.conquerorId);
    const b = g.player(c.conqueredId);
    simEvent("conquest", `${a.name()} conquered ${b.name()}`, [
      a.name(),
      b.name(),
    ]);
  }
  for (const r of u[GameUpdateType.AllianceRequestReply]) {
    if (!r.accepted) continue;
    const a = g.playerBySmallID(r.request.requestorID);
    const b = g.playerBySmallID(r.request.recipientID);
    if (!a.isPlayer() || !b.isPlayer()) continue;
    simEvent("alliance", `${a.name()} allied with ${b.name()}`, [
      a.name(),
      b.name(),
    ]);
  }
  for (const b of u[GameUpdateType.BrokeAlliance]) {
    const t = g.playerBySmallID(b.traitorID);
    const v = g.playerBySmallID(b.betrayedID);
    if (!t.isPlayer() || !v.isPlayer()) continue;
    simEvent("betrayal", `${t.name()} betrayed ${v.name()}`, [
      t.name(),
      v.name(),
    ]);
  }
  for (const d of u[GameUpdateType.DisplayEvent]) {
    if (!/nuke|mirv/i.test(d.message)) continue;
    const p = d.playerID === null ? null : g.playerBySmallID(d.playerID);
    simEvent("nuke", d.message, p !== null && p.isPlayer() ? [p.name()] : []);
  }

  for (const seat of seats) {
    if (seat.me === null || seat.life === "dead") continue;
    if (seat.me.isAlive()) {
      seat.life = "alive";
    } else if (seat.life === "alive") {
      seat.life = "dead";
      simEvent("death", `${seat.name} was eliminated`, [seat.name]);
    }
  }

  const win = u[GameUpdateType.Win][0];
  if (win !== undefined && !finished) {
    winner = win.winner;
    allPlayersStats = win.allPlayersStats;
    simEvent("win", `winner: ${JSON.stringify(win.winner)}`, []);
    void shutdown("win");
    return;
  }

  if (gu.tick % 100 === 0) {
    console.log(
      `[t=${gu.tick}] ` +
        seats.map((s) => `${s.name}=${s.me?.numTilesOwned() ?? 0}`).join(" "),
    );
  }

  if (g.inSpawnPhase()) return;
  if (seats.every((s) => s.life === "dead") && !finished) {
    void shutdown("all LLM players dead");
    return;
  }
  for (const seat of seats) {
    if (seat.pending || seat.me === null || !seat.me.isAlive()) continue;
    if (gu.tick % seat.intervalTicks !== 0) continue;
    seat.pending = true;
    void step(seat, g, seat.me, gu.tick);
  }
}

// ---------- decision pipeline ----------

/** expand into unclaimed land, or nothing */
function fallbackIntents(g: Game, me: Player): Intent[] {
  if (!me.sharesBorderWith(g.terraNullius())) return [];
  return [{ type: "attack", targetID: null, troops: null }];
}

async function step(seat: Seat, g: Game, me: Player, tick: number) {
  const started = Date.now();
  let intents: Intent[] = [];
  let dropped: Dropped[] = [];
  let reasoning = FALLBACK_DECISION.reasoning;
  let latencyMs = 0;
  let fallback = true;
  try {
    if (flags.noLlm) throw new Error("--no-llm");
    const obs = observe(g, me, seat, seat.recentEvents);
    const out = await decide(seat, obs, { timeoutMs: DECIDE_TIMEOUT_MS });
    latencyMs = out.latencyMs;
    fallback = out.fallback;
    reasoning = out.decision.reasoning;
    const clean = sanitize(out.decision, obs);
    const acted = toIntents(g, me, obs, clean.decision, seat);
    intents = acted.intents;
    dropped = [...clean.dropped, ...acted.dropped];
    seat.notes = clean.decision.notes || seat.notes;
  } catch (e) {
    if (!flags.noLlm && seat.errors % 10 === 0) {
      console.error(`[${seat.name}] pipeline failed, using fallback:`, e);
    }
    seat.errors++;
    latencyMs = Date.now() - started;
    intents = fallbackIntents(g, me);
    dropped = [];
    fallback = true;
  }

  // Guardrail 5: an all-dropped decision twice in a row forces the fallback.
  if (intents.length === 0 && dropped.length > 0) {
    seat.consecutiveDrops++;
    if (seat.consecutiveDrops >= 2) {
      console.warn(
        `[${seat.name}] ${seat.consecutiveDrops} dropped decisions in a row, forcing fallback`,
      );
      intents = fallbackIntents(g, me);
      seat.consecutiveDrops = 0;
      fallback = true;
    }
  } else {
    seat.consecutiveDrops = 0;
  }

  seat.latencyEma =
    seat.latencyEma === 0 ? latencyMs : seat.latencyEma * 0.7 + latencyMs * 0.3;
  seat.intervalTicks = adaptiveInterval(flags.interval, seat.latencyEma);
  seat.lastResult =
    dropped.length === 0 ? "ok" : dropped.map((d) => d.reason).join("; ");
  seat.decisions++;
  seat.drops += dropped.length;

  for (const intent of intents) send(seat, { type: "intent", intent });

  writeEvent({
    kind: "decision",
    t: tick,
    player: seat.name,
    model: seat.model,
    latencyMs,
    intervalTicks: seat.intervalTicks,
    fallback,
    reasoning,
    sent: intents,
    dropped,
  });
  console.log(
    `[t=${tick}] ${seat.name} (${(latencyMs / 1000).toFixed(1)}s, int=${seat.intervalTicks}): ` +
      `"${reasoning}" sent=${intents.length} dropped=${dropped.length}`,
  );
  seat.pending = false;
}

// ---------- exit ----------

async function shutdown(reason: string) {
  if (finished) return;
  finished = true;
  console.log(`ending: ${reason}`);
  clearInterval(pingTimer);
  clearTimeout(capTimer);

  if (gameStartInfo !== null) {
    send(seats[0], { type: "winner", winner, allPlayersStats });
    for (const t of turns) {
      const h = hashes.get(t.turnNumber);
      if (h !== undefined) t.hash = h;
    }
    const playerRecords: PlayerRecord[] = gameStartInfo.players.map((p) => ({
      clientID: p.clientID,
      username: p.username,
      clanTag: p.clanTag,
      persistentID: null,
      stats: allPlayersStats[p.clientID],
      cosmetics: p.cosmetics,
      teamIndex: p.teamIndex,
      friends: p.friends,
      isLobbyCreator: p.isLobbyCreator,
    })) as PlayerRecord[];
    const record: GameRecord = {
      ...createPartialGameRecord(
        gameID,
        gameStartInfo.config,
        playerRecords,
        turns,
        startMs,
        Date.now(),
        winner,
        gameStartInfo.lobbyCreatedAt,
        gameStartInfo.visibleAt,
        gameStartInfo.tribes,
      ),
      gitCommit: (process.env.GIT_COMMIT ?? "DEV") as GameRecord["gitCommit"],
    };
    // Stats carry bigints (gold); the record schema reads them back as strings.
    fs.writeFileSync(recordPath, JSON.stringify(record, replacer));
    console.log(`record: ${recordPath}`);
  }
  console.log(`events: ${eventsPath}`);
  console.log(
    `summary: winner=${JSON.stringify(winner)} ticks=${game?.ticks() ?? 0} ` +
      seats
        .map(
          (s) =>
            `${s.name}[tiles=${s.me?.numTilesOwned() ?? 0} decisions=${s.decisions} drops=${s.drops}]`,
        )
        .join(" "),
  );

  // Give the winner frame a moment to leave the socket before closing.
  await new Promise((r) => setTimeout(r, 500));
  for (const s of seats) s.ws.close();
  process.exit(0);
}

// ---------- run ----------

for (const seat of seats) await openSocket(seat);

const pingTimer = setInterval(() => {
  for (const seat of seats) send(seat, { type: "ping" });
}, 5000);

const capTimer = setTimeout(
  () => void shutdown("wall-clock cap"),
  (flags.timer + 5) * 60_000,
);

process.on("SIGINT", () => void shutdown("SIGINT"));
