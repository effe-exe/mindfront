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
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import http from "http";
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
  AllPlayers,
  UnitType,
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
import type { TileRef } from "../src/core/game/GameMap";
import { NodeGameMapLoader } from "../tests/perf/fullgame/NodeGameMapLoader";
import { systemPrompt } from "./decide";
import { createArenaServer, ToolLine } from "./mcp/server";
import { hasFreeLandBorder, trackHistory, recordNukeLaunch } from "./observe";
import { runPlayer } from "./player";
import { DEFAULT_INTERVAL_TICKS, EventLine, PlayerCtx, RosterEntry } from "./types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------- flags ----------

const flags = {
  roster: "arena/roster.json",
  map: "World",
  size: "Normal",
  bots: 120,
  /** scripted nations (real countries at their map position); 0 = none */
  nations: 0,
  difficulty: "Easy" as keyof typeof Difficulty,
  interval: DEFAULT_INTERVAL_TICKS,
  timer: 40,
  recordsDir: "arena/records",
  noLlm: false,
  mcpPort: 9200,
  record: true,
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
      case "--nations":
        flags.nations = parseInt(next(), 10);
        break;
      case "--difficulty":
        flags.difficulty = next() as keyof typeof Difficulty;
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
      case "--mcp-port":
        flags.mcpPort = parseInt(next(), 10);
        break;
      case "--no-record":
        flags.record = false;
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
  lastDecisionTick: number;
  /** last tick this seat sent an intent (MCP action or safety-net expand) */
  lastActionTick: number;
  /** stops this seat's internal player loop (death, shutdown) */
  abort: AbortController;
  /** pre-match briefing done (plan written) */
  briefed: boolean;
  /** attack ids already announced to this seat */
  seenAttacks: Set<string>;
  /** seat.errors when the safety net last fired */
  errorsAtLastAction: number;
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
  lastDecisionTick: 0,
  pending: false,
  consecutiveDrops: 0,
  sawLobbyInfo: false,
  me: null,
  life: "unspawned",
  recentEvents: [],
  decisions: 0,
  drops: 0,
  errors: 0,
  lastActionTick: 0,
  abort: new AbortController(),
  briefed: false,
  seenAttacks: new Set(),
  errorsAtLastAction: 0,
}));

// ---------- lobby ----------

const config: GameConfig = {
  gameMap,
  gameMapSize,
  difficulty: Difficulty[flags.difficulty] ?? Difficulty.Easy,
  gameType: GameType.Private,
  gameMode: GameMode.FFA,
  nations: flags.nations > 0 ? flags.nations : "disabled",
  bots: flags.bots,
  // AI seats pick their own start during the spawn phase (spawn tool); tribes
  // are still placed by the engine.
  randomSpawn: false,
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
// Every match is recorded unless --no-record: arena/record.mjs watches the
// spectator page in headless Chromium and writes <records>/<gameID>.mp4.
let recorderDone: Promise<void> = Promise.resolve();
if (flags.record) {
  const rec = spawn(
    process.execPath,
    [path.join(ROOT, "arena/record.mjs"), gameID, "--minutes", String(flags.timer + 6), "--out", recordsDir],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  recorderDone = new Promise((r) => rec.on("exit", (code) => { console.log(`recorder exited (${code})`); r(); }));
}

const eventsPath = path.join(recordsDir, `${gameID}.events.jsonl`);
const recordPath = path.join(recordsDir, `${gameID}.json`);
fs.writeFileSync(eventsPath, "");
// Live feed for spectators: SSE on --feed-port (default 9100), consumed by the
// client's <arena-feed> element. Replays the buffer, then streams new lines.
const feedBuffer: string[] = [];
const feedClients = new Set<http.ServerResponse>();
const feedPort = Number(process.env.ARENA_FEED_PORT ?? 9100);
http
  .createServer((req, res) => {
    if (req.url !== `/feed/${gameID}`) {
      res.writeHead(404, { "Access-Control-Allow-Origin": "*" }).end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    });
    for (const l of feedBuffer) res.write(`data: ${l}\n\n`);
    feedClients.add(res);
    req.on("close", () => feedClients.delete(res));
  })
  .listen(feedPort, () => console.log(`feed: http://localhost:${feedPort}/feed/${gameID}`));

function writeEvent(line: EventLine | ToolLine) {
  const json = JSON.stringify(line, replacer);
  fs.appendFileSync(eventsPath, json + "\n");
  feedBuffer.push(json);
  if (feedBuffer.length > 300) feedBuffer.shift();
  for (const c of feedClients) c.write(`data: ${json}\n\n`);
}

// ---------- MCP: the surface every player (internal or external) plays through ----------

const ACTION_TOOLS = new Set([
  "expand", "attack", "boat", "ally", "accept_alliance", "reject_alliance",
  "break_alliance", "extend_alliance", "donate", "recall_boats", "embargo",
  "move_warship", "build", "upgrade", "emoji", "chat", "retreat", "nuke", "spawn",
]);
const mcpUrl = `http://localhost:${flags.mcpPort}/mcp`;
fs.writeFileSync(
  path.join(recordsDir, `${gameID}.seats.json`),
  JSON.stringify(
    seats.map((s) => ({ name: s.name, model: s.model, token: s.token, url: mcpUrl })),
    null,
    2,
  ),
);
for (const s of seats) {
  if (s.model === "external") console.log(`external seat "${s.name}": token ${s.token}`);
}
const arena = createArenaServer({
  game: () => game,
  rules: systemPrompt({ ...seats[0], persona: "" }),
  seats: new Map(
    seats.map((s) => [
      s.token,
      {
        name: s.name,
        model: s.model,
        me: () => s.me,
        ctx: s,
        recentEvents: () => s.recentEvents,
        globalEvents: () => globalEvents,
        send: (intent: Intent) => {
          s.lastActionTick = game?.ticks() ?? 0;
          send(s, { type: "intent", intent });
        },
        say: (text: string) =>
          writeEvent({
            kind: "decision",
            t: game?.ticks() ?? 0,
            player: s.name,
            model: s.model,
            latencyMs: 0,
            intervalTicks: flags.interval,
            fallback: false,
            reasoning: text,
            sent: [],
            dropped: [],
          }),
      },
    ]),
  ),
  onEvent: (line) => {
    if (line.kind === "tool" && ACTION_TOOLS.has(line.tool)) {
      const s = seats.find((x) => x.name === line.player);
      if (s) line.ok ? s.decisions++ : s.drops++;
      console.log(
        `[t=${line.t}] ${line.player} → ${line.tool}(${JSON.stringify(line.args)}) ` +
          (line.ok ? "ok" : `dropped: ${line.reason}`),
      );
    }
    writeEvent(line);
  },
});
http
  .createServer((q, r) => void arena.handleHttp(q, r))
  .listen(flags.mcpPort, () => console.log(`mcp: ${mcpUrl}`));

let playersStarted = false;
/** One MCP-client loop per internal seat; external seats bring their own agent. */
function startPlayers() {
  playersStarted = true;
  if (flags.noLlm) return;
  for (const seat of seats) {
    if (seat.model === "external") continue;
    void runPlayer({
      url: mcpUrl,
      token: seat.token,
      model: seat.model,
      name: seat.name,
      persona: seat.persona,
      minGapMs: flags.interval * 100,
      signal: seat.abort.signal,
      onRound: (info) => {
        seat.latencyEma =
          seat.latencyEma === 0 ? info.latencyMs : seat.latencyEma * 0.7 + info.latencyMs * 0.3;
        if (info.fallback) seat.errors++;
      },
      onBriefed: (plan) => {
        seat.briefed = true;
        writeEvent({ kind: "sim", t: 0, type: "briefing", text: `${seat.name} plan: ${plan}`, players: [seat.name] });
        console.log(`[${seat.name}] briefed (${plan.length} chars)`);
        maybeStart();
      },
    });
  }
}

// The lobby waits for every internal seat to finish its briefing (or 3 min),
// so nobody meets the spawn phase without having processed the manual.
let startSent = false;
function maybeStart() {
  if (startSent || !seats.every((s) => s.sawLobbyInfo)) return;
  const pending = seats.filter((s) => s.model !== "external" && !flags.noLlm && !s.briefed);
  if (pending.length > 0 && Date.now() - lobbyReadyAt < 180_000) return;
  startSent = true;
  if (pending.length > 0) console.log(`starting without briefing from: ${pending.map((s) => s.name).join(", ")}`);
  console.log("all seats briefed, starting timer");
  send(seats[0], { type: "intent", intent: { type: "toggle_game_start_timer" } });
}
let lobbyReadyAt = 0;

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

/** something only this seat should know (a message addressed to it) */
function note(seat: Seat, text: string) {
  seat.recentEvents.push(text);
  if (seat.recentEvents.length > 8) seat.recentEvents.shift();
}

/** last 10 notable events anyone can see (conquests, betrayals, nukes, deaths) */
const globalEvents: string[] = [];
function simEvent(type: string, text: string, players: string[]) {
  writeEvent({ kind: "sim", t: game?.ticks() ?? 0, type, text, players });
  globalEvents.push(`t${game?.ticks() ?? 0} ${text}`);
  if (globalEvents.length > 10) globalEvents.shift();
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
          console.log("all seats in lobby, briefing players");
          lobbyReadyAt = Date.now();
          if (!playersStarted) startPlayers();
          maybeStart();
          setTimeout(maybeStart, 181_000);
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
  console.log(`sim: ${game.nations().length} nations (${game.nations().map((n) => n.playerInfo.name).join(", ") || "none"}), ${info.config.bots} tribes`);
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
    if (!/nuke|mirv|bomb_detonated|intercept/i.test(d.message)) continue;
    const p = d.playerID === null ? null : g.playerBySmallID(d.playerID);
    // d.message is an i18n key ("events_display.atom_bomb_detonated"); the
    // player it is shown to is the one whose land was hit.
    const text = d.message.replace(/^events_display\./, "").replace(/_/g, " ");
    simEvent("nuke", p !== null && p.isPlayer() ? `${text} on ${p.name()}` : text, p !== null && p.isPlayer() ? [p.name()] : []);
  }
  // Communication from other players lands in the recipient's recentEvents so
  // models can signal each other (alliances, threats) through emoji and chat.
  for (const e of u[GameUpdateType.Emoji]) {
    const from = g.playerBySmallID(e.emoji.senderID);
    if (!from.isPlayer()) continue;
    const all = e.emoji.recipientID === AllPlayers;
    for (const seat of seats) {
      if (seat.me === null || seat.me === from) continue;
      if (all || seat.me.smallID() === e.emoji.recipientID) {
        note(seat, `${from.name()} sent ${all ? "everyone" : "you"} ${e.emoji.message}`);
      }
    }
  }
  for (const c of u[GameUpdateType.DisplayChatEvent]) {
    if (c.isFrom || c.playerID === null) continue; // the sender-side copy
    const from = g.playerBySmallID(c.playerID);
    const seat = seats.find((x) => x.me?.id() === c.recipient);
    if (!from.isPlayer() || seat === undefined) continue;
    const about = c.target === undefined ? "" : ` (about ${g.player(c.target).name()})`;
    note(seat, `${from.name()} says "${c.category}.${c.key}"${about}`);
  }

  // Boats and nukes launched at a seat: the engine announces each unit once to
  // its target (TransportShipExecution.init, NukeExecution) as UnitIncoming.
  for (const x of u[GameUpdateType.UnitIncoming]) {
    const seat = seats.find((s) => s.me?.smallID() === x.playerID);
    const unit = g.unit(x.unitID);
    if (seat === undefined || unit === undefined) continue;
    const from = unit.owner();
    const what = unit.type() === UnitType.TransportShip ? `a boat with ${Math.round(unit.troops())} troops` : `a ${unit.type()}`;
    if (unit.type() !== UnitType.TransportShip) recordNukeLaunch(x.playerID, from.smallID(), unit.type(), g.ticks());
    note(seat, `t${g.ticks()} ${from.name()} (id ${from.smallID()}) launched ${what} at you`);
  }

  // A new attack on a seat is an event, not just a field: it must reach the
  // model even if the attack is over before its next observation.
  for (const seat of seats) {
    if (seat.me === null || seat.life !== "alive") continue;
    for (const a of seat.me.incomingAttacks()) {
      if (seat.seenAttacks.has(a.id())) continue;
      seat.seenAttacks.add(a.id());
      const from = a.attacker();
      note(seat, `t${g.ticks()} ${from.name()} (id ${from.smallID()}) started attacking you with ${Math.round(a.troops())} troops`);
    }
  }

  for (const seat of seats) {
    if (seat.me === null || seat.life === "dead") continue;
    if (seat.me.isAlive()) {
      seat.life = "alive";
    } else if (seat.life === "alive") {
      seat.life = "dead";
      seat.abort.abort();
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
    trackHistory(g);
    console.log(
      `[t=${gu.tick}] ` +
        seats.map((s) => `${s.name}=${s.me?.numTilesOwned() ?? 0}`).join(" "),
    );
  }

  if (!playersStarted) startPlayers();
  if (g.inSpawnPhase()) {
    // Anyone who has not picked a start by the last ticks of the spawn phase is
    // placed by the brain, as far from everyone else as the map allows.
    if (gu.tick >= g.config().numSpawnPhaseTurns() - 15) autoSpawn(g);
    return;
  }
  if (seats.every((s) => s.life === "dead") && !finished) {
    void shutdown("all LLM players dead");
    return;
  }
  for (const seat of seats) {
    if (seat.me === null || !seat.me.isAlive()) continue;
    // Safety net, only for a seat whose model is failing (timeouts/errors in
    // its last rounds) and idle 30 s: expand with a small stack, and tell it.
    if (gu.tick - seat.lastActionTick >= 300 && seat.errors > seat.errorsAtLastAction) {
      seat.lastActionTick = gu.tick;
      seat.errorsAtLastAction = seat.errors;
      const intents = fallbackIntents(g, seat.me);
      for (const intent of intents) send(seat, { type: "intent", intent });
      if (intents.length > 0)
        note(seat, `t${gu.tick} arena safety net: your model calls were failing, so the arena expanded into free land with 10% of your army`);
    }
  }
}

// ---------- decision pipeline ----------

const autoSpawned = new Set<Seat>();
function autoSpawn(g: Game) {
  const taken = g
    .players()
    .filter((p) => p.numTilesOwned() > 0)
    .map((p) => {
      const t = p.tiles().values().next().value as TileRef;
      return [g.x(t), g.y(t)] as const;
    });
  for (const seat of seats) {
    if (autoSpawned.has(seat) || seat.me === null || seat.me.numTilesOwned() > 0) continue;
    autoSpawned.add(seat);
    let best: TileRef | null = null;
    let bestD = -1;
    const w = g.width();
    const h = g.height();
    for (let i = 0; i < 600; i++) {
      const x = Math.floor(Math.random() * w);
      const y = Math.floor(Math.random() * h);
      const t = g.ref(x, y);
      if (!g.isLand(t) || g.hasOwner(t)) continue;
      // Room to grow: most of a 30-tile box around the spot must be free land,
      // otherwise the farthest point from everyone is a rock in the ocean.
      let free = 0;
      for (let dy = -15; dy <= 15; dy += 5) {
        for (let dx = -15; dx <= 15; dx += 5) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nt = g.ref(nx, ny);
          if (g.isLand(nt) && !g.hasOwner(nt)) free++;
        }
      }
      if (free < 30) continue; // of 49 samples
      const d = taken.length === 0 ? 1 : Math.min(...taken.map(([tx, ty]) => Math.abs(tx - x) + Math.abs(ty - y)));
      if (d > bestD) {
        bestD = d;
        best = t;
      }
    }
    if (best === null) continue;
    taken.push([g.x(best), g.y(best)]);
    send(seat, { type: "intent", intent: { type: "spawn", tile: best } });
    console.log(`[t=${g.ticks()}] ${seat.name} did not pick a spawn; placed at (${g.x(best)},${g.y(best)})`);
  }
}

/** expand into unclaimed land, or nothing */
function fallbackIntents(g: Game, me: Player): Intent[] {
  if (!hasFreeLandBorder(g, me)) return [];
  return [{ type: "attack", targetID: null, troops: Math.floor(me.troops() * 0.1) }];
}

// ---------- exit ----------

async function shutdown(reason: string) {
  if (finished) return;
  finished = true;
  for (const s of seats) s.abort.abort();
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
  // The recorder converts its WebM to MP4 after the record file appears;
  // exiting now would kill it mid-encode.
  await Promise.race([recorderDone, new Promise((r) => setTimeout(r, 180_000))]);
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
