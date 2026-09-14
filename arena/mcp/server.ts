/**
 * MindFront MCP server (Phase 1.5, package P1).
 *
 * One seat = one game player = one bearer token. Every tool validates against
 * the live sim with sanitize() + toIntents() and sends the resulting intents
 * immediately; nothing is queued and there are no per-turn caps.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { PlayerType, type Game, type Player } from "../../src/core/game/Game";
import type { TileRef } from "../../src/core/game/GameMap";
import type { Intent } from "../../src/core/Schemas";
import { sanitize } from "../decide";
import {
  minutesLeft,
  observe,
  toIntents,
  UNIT_MAP,
  viewPlayer,
} from "../observe";
import {
  BUILDABLE_UNITS,
  type Action,
  type BuildableUnit,
  type EventLine,
  type PlayerCtx,
  NUKE_TYPES,
} from "../types";

/** events.jsonl line for one MCP tool call. Folded into types.ts by P3. */
export interface ToolLine {
  kind: "tool";
  t: number;
  player: string;
  tool: string;
  args: unknown;
  ok: boolean;
  reason?: string;
  latencyMs: number;
}

export interface SeatHandle {
  name: string;
  model: string;
  /** the sim Player, null until the seat spawns */
  me: () => Player | null;
  ctx: PlayerCtx;
  recentEvents: () => string[];
  /** events involving anyone, optional */
  globalEvents?: () => string[];
  send: (intent: Intent) => void;
  /** spectator feed only, no game effect */
  say?: (text: string) => void;
}

export interface ArenaServerOpts {
  game: () => Game | null;
  seats: Map<string, SeatHandle>;
  onEvent: (line: EventLine | ToolLine) => void;
  rules: string;
}

type Res = { ok: boolean; reason?: string; text?: string };

const RATIO_DESC =
  "fraction of your troops to send, 0.05-0.6 (clamped); defaults to 0.3.";

const UNIT_EFFECTS: Record<BuildableUnit, string> = {
  City: "Raises your troop cap by 250k per level once finished (20 ticks). Upgrade with the upgrade tool instead of building a second one when space is tight.",
  Port: "Trade ships and Warships. A Port pays only with a partner Port on the same sea (another AI player's; tribes keep none): observe.me.tradePartnerPorts counts them. Boats do NOT need a Port: they launch from any shore tile you own.",
  "Defense Post":
    "Multiplies attacker losses x5 and slows them x3 on your tiles within 30 tiles of it.",
  "Missile Silo":
    "Lets you launch nukes with the nuke tool; one missile per silo on a 90 tick cooldown.",
  "SAM Launcher":
    "Shoots down incoming nukes within 70 tiles at level 1. 90 tick cooldown.",
  Factory:
    "No direct gold: it builds the rail network, and trains from it pay gold at every City or Port they stop at.",
  Warship:
    "Needs one of your Ports; spawns on the water next to it. Hunts enemy transport boats and trade ships, shells the coast.",
};

const ATTACK_MATH = [
  "An attack you send keeps eating tiles on its own until its troops run out or you retreat.",
  "Troops sent: the ratio you pass, clamped to 5-60% of your army. A boat carries the same share.",
  "Per tile taken, the DEFENDER loses its average troops-per-tile (their army / their tiles). Thin, sprawling empires are cheap to eat; small dense ones are not.",
  "Per tile taken, YOU lose roughly terrain x how outnumbered you are x (a base cost + the defender's troop density). Send a big enough stack and the per-tile cost drops to its floor; send a small one into a big army and it climbs.",
  "Terrain multiplies both cost and speed: plains cheapest, highland ~25% worse, mountain ~50% worse.",
  "A Defense Post covering the tile multiplies your losses x5 and your time-per-tile x3.",
  "Fallout from a nuke multiplies losses and slowness by 3-5x.",
  "A traitor defends worse (recently broke an alliance), and bots die much more easily to humans and nations.",
  "Big territories are cheaper and faster to attack from AND into; the attacker's bonus is the bigger one.",
  "Speed: each tick your attack spends a budget proportional to its border width, so a wide front advances faster than a narrow one.",
].join(" ");

const MAX_MAP_SAMPLES = 20_000;

/** Coarse cols x rows text map of the world, majority owner per cell. */
function mapOverview(
  game: Game,
  me: Player | null,
  cols: number,
  rows: number,
): string {
  const w = game.width();
  const h = game.height();
  const step = Math.max(1, Math.ceil(Math.sqrt((w * h) / MAX_MAP_SAMPLES)));
  const cellW = w / cols;
  const cellH = h / rows;
  // -1 = sea, 0 = unowned land, >0 = player smallID
  const cells: Map<number, number>[] = [];
  for (let i = 0; i < cols * rows; i++) cells.push(new Map());
  const totals = new Map<number, { sx: number; sy: number; n: number }>();

  for (let y = 0; y < h; y += step) {
    const row = Math.min(rows - 1, Math.floor(y / cellH));
    for (let x = 0; x < w; x += step) {
      const t = game.ref(x, y);
      const owner = game.isLand(t) ? game.ownerID(t) : -1;
      const cell =
        cells[row * cols + Math.min(cols - 1, Math.floor(x / cellW))];
      cell.set(owner, (cell.get(owner) ?? 0) + 1);
      if (owner > 0) {
        const c = totals.get(owner);
        if (c === undefined) totals.set(owner, { sx: x, sy: y, n: 1 });
        else {
          c.sx += x;
          c.sy += y;
          c.n++;
        }
      }
    }
  }

  const mySmall = me?.smallID() ?? -2;
  const label = (owner: number): string => {
    if (owner === -1) return "~";
    if (owner === 0) return ".";
    if (owner === mySmall) return "me";
    const p = game.playerBySmallID(owner);
    if (p === undefined || !p.isPlayer()) return "?";
    return (p.type() === PlayerType.Human ? "L" : "T") + owner;
  };

  const shown = new Set<number>();
  const lines: string[] = [];
  const pad = (s: string) => s.padStart(4);
  lines.push(
    "    " + Array.from({ length: cols }, (_, c) => pad("c" + c)).join(""),
  );
  for (let r = 0; r < rows; r++) {
    let line = ("r" + r).padEnd(4);
    for (let c = 0; c < cols; c++) {
      let best = -1;
      let bestN = -1;
      for (const [owner, n] of cells[r * cols + c]) {
        if (n > bestN) {
          bestN = n;
          best = owner;
        }
      }
      if (best > 0) shown.add(best);
      line += pad(label(best));
    }
    lines.push(line);
  }

  // Legend: every label in the grid, then the next biggest players, capped.
  const ranked = [...totals.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [owner] of ranked) {
    if (shown.size >= 24) break;
    shown.add(owner);
  }
  const legend = ranked
    .filter(([owner]) => shown.has(owner))
    .map(([owner, c]) => {
      const p = game.playerBySmallID(owner);
      const name = p !== undefined && p.isPlayer() ? p.name() : "?";
      const col = Math.min(cols - 1, Math.floor(c.sx / c.n / cellW));
      const row = Math.min(rows - 1, Math.floor(c.sy / c.n / cellH));
      return `${label(owner)}=${name} at (c${col},r${row})`;
    });

  return [
    `Map ${cols}x${rows} cells over ${w}x${h} tiles, sampling 1 tile in ${step}. ` +
      "Columns c0.. run west to east, rows r0.. run north to south. " +
      'Each cell is whoever holds most of it. "~" = sea, "." = unclaimed land, ' +
      '"L<id>" = a rival AI, "T<id>" = a scripted tribe, "me" = you.',
    ...lines,
    "legend: " +
      (legend.length > 0 ? legend.join("; ") : "(nobody on the map yet)"),
  ].join("\n");
}

export function createArenaServer(opts: ArenaServerOpts): {
  server: McpServer;
  handleHttp: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} {
  function buildServer(seat: SeatHandle | undefined): McpServer {
    const server = new McpServer({ name: "mindfront", version: "0.1.0" });

    // Every tool call: time it, never throw, log an event line.
    const wrap =
      (name: string, fn: (args: Record<string, unknown>) => Res) =>
      async (args: any) => {
        const start = Date.now();
        let r: Res;
        try {
          r = seat
            ? fn(args ?? {})
            : { ok: false, reason: "no seat for this token" };
        } catch (e) {
          r = { ok: false, reason: `internal error: ${String(e)}` };
        }
        opts.onEvent({
          kind: "tool",
          t: opts.game()?.ticks() ?? 0,
          player: seat?.name ?? "?",
          tool: name,
          args,
          ok: r.ok,
          reason: r.reason,
          latencyMs: Date.now() - start,
        });
        return {
          content: [
            {
              type: "text" as const,
              text:
                r.text ??
                JSON.stringify(
                  r.ok
                    ? { ok: true }
                    : { ok: false, reason: r.reason ?? "failed" },
                ),
            },
          ],
        };
      };

    /** sim + my player, whatever the phase */
    function present(): { game: Game; me: Player } | { reason: string } {
      const game = opts.game();
      if (game === null) return { reason: "the match has not started yet" };
      const me = seat?.me() ?? null;
      if (me === null) return { reason: "your player is not in the game" };
      return { game, me };
    }

    /** live sim + my player, or the reason I cannot act right now */
    function live(): { game: Game; me: Player } | { reason: string } {
      const p = present();
      if ("reason" in p) return p;
      if (p.game.inSpawnPhase()) {
        return { reason: "spawn phase: pick your start with spawn(col,row); actions open when it ends" };
      }
      if (!p.me.isAlive()) return { reason: "you are dead" };
      return p;
    }

    const SPAWN_COLS = 24;
    const SPAWN_ROWS = 12;
    /** what a seat sees during the spawn phase: the map and everyone's current pick */
    function spawnView(game: Game, me: Player) {
      const cellW = game.width() / SPAWN_COLS;
      const cellH = game.height() / SPAWN_ROWS;
      const cellOf = (p: Player) => {
        const t = p.tiles().values().next().value as TileRef;
        return { col: Math.floor(game.x(t) / cellW), row: Math.floor(game.y(t) / cellH) };
      };
      const picks = game
        .players()
        .filter((p) => p.numTilesOwned() > 0 && p !== me)
        .map((p) => ({ name: p.name(), kind: p.type() === PlayerType.Human ? "llm" : "tribe", ...cellOf(p) }));
      return {
        phase: "spawn",
        ticksLeft: game.config().numSpawnPhaseTurns() - game.ticks(),
        howTo:
          `Call spawn(col,row) with a cell of the ${SPAWN_COLS}x${SPAWN_ROWS} grid below (c0..c${SPAWN_COLS - 1} west to east, ` +
          `r0..r${SPAWN_ROWS - 1} north to south). You may re-pick until ticksLeft reaches 0; if you never pick, ` +
          "you are placed automatically. Others' picks are listed as they happen.",
        myPick: me.numTilesOwned() > 0 ? cellOf(me) : null,
        picks,
        map: mapOverview(game, me, SPAWN_COLS, SPAWN_ROWS),
      };
    }

    function obsNow() {
      const l = live();
      if ("reason" in l) return l;
      return {
        ...l,
        obs: observe(
          l.game,
          l.me,
          seat!.ctx,
          seat!.recentEvents(),
          seat!.globalEvents?.() ?? [],
        ),
      };
    }

    /** validate one action against the live sim and send whatever it becomes */
    function act(action: Action): Res {
      const o = obsNow();
      if ("reason" in o) return { ok: false, reason: o.reason };
      const clean = sanitize(
        { reasoning: "", notes: "", actions: [action] },
        o.obs,
      );
      if (clean.dropped.length > 0) {
        return { ok: false, reason: clean.dropped[0].reason };
      }
      const acted = toIntents(o.game, o.me, o.obs, clean.decision, seat!.ctx);
      if (acted.dropped.length > 0) {
        return { ok: false, reason: acted.dropped[0].reason };
      }
      for (const intent of acted.intents) seat!.send(intent);
      return { ok: true };
    }

    const action = (
      name: string,
      description: string,
      inputSchema: Record<string, z.ZodTypeAny>,
      build: (a: Record<string, unknown>) => Action,
    ) =>
      server.registerTool(
        name,
        { description, inputSchema },
        wrap(name, (a) => act(build(a))),
      );

    server.registerTool(
      "rules",
      {
        description:
          "The full MindFront game manual: goal and win rules, the clock, troop " +
          "and gold economy, how attacks resolve, sea and structures, diplomacy, " +
          "every tool, and how to read your observation.",
        inputSchema: {},
      },
      wrap("rules", () => ({ ok: true, text: opts.rules })),
    );

    server.registerTool(
      "observe",
      {
        description:
          "Your current view of the world as JSON: your tiles/troops/troop cap/gold/" +
          "income/structures/map position, bordering neighbors (ids, relation, " +
          "alliances, their armies, who they are fighting, their direction and " +
          "distance from you), whether unclaimed land touches you, boat-reachable " +
          "coastal players, the leaderboard, what you can afford to build and what " +
          "everything costs, and recent events. Every id you may reference in another " +
          "tool comes from here; invented ids are rejected. See also game_info and " +
          "map_overview.",
        inputSchema: {},
      },
      wrap("observe", () => {
        const p = present();
        if ("reason" in p) return { ok: false, reason: p.reason };
        if (p.game.inSpawnPhase()) return { ok: true, text: JSON.stringify(spawnView(p.game, p.me)) };
        const o = obsNow();
        if ("reason" in o) return { ok: false, reason: o.reason };
        return { ok: true, text: JSON.stringify(o.obs) };
      }),
    );

    server.registerTool(
      "inspect_player",
      {
        description:
          "Full dossier on one player you can currently see (a neighbor, ally, " +
          "attacker, leaderboard or boat-reachable id from observe): tiles, troops and " +
          "troop cap, gold, structures, relation, alliances and targets, who they are " +
          "attacking and who is attacking them, traitor record, growth over the last " +
          "minute, shared border with you, and their direction/distance from you.",
        inputSchema: { id: z.number().int().describe("smallID from observe") },
      },
      wrap("inspect_player", (a) => {
        const o = obsNow();
        if ("reason" in o) return { ok: false, reason: o.reason };
        const id = a.id as number;
        const p = o.game.playerBySmallID(id);
        const known =
          o.obs.neighbors.some((n) => n.id === id) ||
          o.obs.reachableByBoat.some((r) => r.id === id) ||
          o.obs.leaderboard.some((l) => l.id === id) ||
          o.obs.me.allies.includes(id) ||
          o.obs.me.pendingAllianceRequestsFrom.includes(id) ||
          o.obs.me.incomingAttacks.some((x) => x.from === id) ||
          o.obs.me.incomingBoats.some((x) => x.from === id);
        if (p === undefined || !p.isPlayer() || !known) {
          return { ok: false, reason: `unknown id ${id}` };
        }
        return {
          ok: true,
          text: JSON.stringify({
            ...viewPlayer(o.game, o.me, p),
            sharesBorder: o.me.sharesBorderWith(p),
          }),
        };
      }),
    );

    server.registerTool(
      "game_info",
      {
        description:
          "The match constants that never change mid-game: map and size, land tiles, " +
          "clock, win rule, alliance and immunity timers, defense post range, what " +
          "every structure costs and does, how attack losses are actually computed, " +
          "and the rate limits. Read this once at the start.",
        inputSchema: {},
      },
      wrap("game_info", () => {
        const game = opts.game();
        if (game === null)
          return { ok: false, reason: "the match has not started yet" };
        const cfg = game.config();
        const gc = cfg.gameConfig();
        const me = seat?.me() ?? null;
        const units: Record<string, { cost: number | null; effect: string }> =
          {};
        for (const u of BUILDABLE_UNITS) {
          units[u] = {
            cost:
              me === null
                ? null
                : Number(game.unitInfo(UNIT_MAP[u]).cost(game, me)),
            effect: UNIT_EFFECTS[u],
          };
        }
        return {
          ok: true,
          text: JSON.stringify({
            map: gc.gameMap,
            mapSize: gc.gameMapSize,
            mapWidth: game.width(),
            mapHeight: game.height(),
            totalLandTiles: game.totalLandTiles(),
            tick: game.ticks(),
            ticksPerSecond: 10,
            minutesLeft: minutesLeft(game),
            winRule:
              "Hold 80% of the land to win outright; otherwise the most land when the " +
              "timer runs out wins. With overtime enabled the 80% bar drops over time.",
            spawnImmunityTicks: cfg.spawnImmunityDuration(),
            allianceDurationTicks: cfg.allianceDuration(),
            allianceRequestDurationTicks: cfg.allianceRequestDuration(),
            allianceRequestCooldownTicks: cfg.allianceRequestCooldown(),
            defensePostRange: cfg.defensePostRange(),
            units,
            attackMath: ATTACK_MATH,
            rateLimits:
              "10 tool calls per second, 150 per minute. Over that you get errors, " +
              "not actions.",
            cadence:
              "No cap on actions per turn and no fixed cadence: act as soon as you " +
              "have something worth doing. An attack keeps fighting on its own after " +
              "you send it, so do not re-send it every turn.",
            minGapTicks: seat?.ctx.intervalTicks ?? 0,
          }),
        };
      }),
    );

    server.registerTool(
      "map_overview",
      {
        description:
          "A coarse text map of the whole world: a grid where each cell names the " +
          "player holding most of it, plus a legend with each player's cell " +
          "coordinates. Use it to see who is where and which direction to grow.",
        inputSchema: {
          cols: z.number().int().min(2).max(24).optional(),
          rows: z.number().int().min(2).max(12).optional(),
        },
      },
      wrap("map_overview", (a) => {
        const game = opts.game();
        if (game === null)
          return { ok: false, reason: "the match has not started yet" };
        return {
          ok: true,
          text: mapOverview(
            game,
            seat?.me() ?? null,
            Math.min(24, Math.max(2, (a.cols as number) ?? 12)),
            Math.min(12, Math.max(2, (a.rows as number) ?? 6)),
          ),
        };
      }),
    );

    action(
      "expand",
      "Claim adjacent unclaimed land. Cheap growth: do this early and often while " +
        "observe reports unclaimedLandAdjacent. More land means faster troop regen. " +
        `ratio: ${RATIO_DESC}`,
      { ratio: z.number().optional() },
      (a) => ({ type: "expand", ratio: a.ratio as number | undefined }),
    );

    action(
      "attack",
      "Send troops at a bordering player. The attack keeps fighting on its own after " +
        "you send it, so do not repeat it every turn. Attacking well-defended land can " +
        "cost more troops than it gains, and you cannot attack an ally without breaking " +
        `the alliance first. target: a neighbor id from observe. ratio: ${RATIO_DESC}`,
      { target: z.number().int(), ratio: z.number().optional() },
      (a) => ({
        type: "attack",
        target: a.target as number,
        ratio: a.ratio as number | undefined,
      }),
    );

    action(
      "boat",
      "Amphibious assault on a coastal player you do not border. Only ids from " +
        `observe.reachableByBoat, at most 3 boats in flight at once. ratio: ${RATIO_DESC}`,
      { target: z.number().int(), ratio: z.number().optional() },
      (a) => ({
        type: "boat",
        target: a.target as number,
        ratio: a.ratio as number | undefined,
      }),
    );

    action(
      "ally",
      "Offer an alliance to a neighbor. Alliances last 5 minutes and block attacks in " +
        "both directions; treat them as temporary tools, not friendships.",
      { target: z.number().int() },
      (a) => ({ type: "ally", target: a.target as number }),
    );

    action(
      "accept_alliance",
      "Accept a pending alliance request. Only ids in observe.me.pendingAllianceRequestsFrom.",
      { target: z.number().int() },
      (a) => ({ type: "accept_alliance", target: a.target as number }),
    );

    action(
      "reject_alliance",
      "Reject a pending alliance request. Only ids in observe.me.pendingAllianceRequestsFrom.",
      { target: z.number().int() },
      (a) => ({ type: "reject_alliance", target: a.target as number }),
    );

    action(
      "break_alliance",
      "Break an alliance. Brands you a traitor for 30 seconds: attackers take half " +
        "losses against you and tribes hunt you. Only ids in observe.me.allies.",
      { target: z.number().int() },
      (a) => ({ type: "break_alliance", target: a.target as number }),
    );

    action(
      "extend_alliance",
      "Ask an ally to renew: when both sides have called this, the alliance resets to a full " +
        "5 minutes from that moment (no time window; tribes always agree within ~8 s). Best in the " +
        "last 300 ticks; observe.me.allianceExpiry shows who has already asked. Only ids in observe.me.allies.",
      { target: z.number().int() },
      (a) => ({ type: "extend_alliance", target: a.target as number }),
    );

    action(
      "donate",
      "Give an ally troops OR gold (exactly one, a whole number). Allies only; one donation per " +
        "ally per 10 s (gold and troops share the cooldown). Troops are capped at the room under " +
        "their troop cap, and a gift of at least ~1/12 of their cap raises their relation to you " +
        "by 50; gold raises it 5 per 2,500 (chunk grows with match time). Use it to prop up an ally " +
        "who is being eaten by the rival you both fear. Only ids in observe.me.allies.",
      { target: z.number().int(), troops: z.number().int().positive().optional(), gold: z.number().int().positive().optional() },
      (a) => ({ type: "donate", target: a.target as number, troops: a.troops as number | undefined, gold: a.gold as number | undefined }),
    );

    action(
      "recall_boats",
      "Turn your boats around: every transport at sea, or only those sailing at target. They " +
        "return to your nearest shore and land 75% of the troops (25% lost). Use it when a warship " +
        "or a Defense Post appears on the landing shore. Needs observe.me.boatsInFlight > 0.",
      { target: z.number().int().optional() },
      (a) => ({ type: "recall_boats", target: a.target as number | undefined }),
    );

    action(
      "build",
      "Build a structure with gold. City raises your troop cap; Port earns trade gold; " +
        "Defense Post strengthens nearby borders; Factory builds rail and trains that " +
        "earn gold; SAM Launcher shoots incoming nukes down. See game_info for what " +
        "each one does and costs. Only units listed in observe.canBuild are affordable " +
        "right now; observe.buildCosts shows every price so you can save up. " +
        "at: WHERE to put it: a player id places it on the border facing that player " +
        "(a Defense Post goes where it covers the most of that front, 30-tile range); " +
        "\"sea\" places it on your coast; omit it to let the arena pick any legal spot.",
      { unit: z.enum(BUILDABLE_UNITS), at: z.union([z.number().int(), z.literal("sea")]).optional() },
      (a) => ({ type: "build", unit: a.unit as Action["unit"], at: a.at as Action["at"] }),
    );

    action(
      "upgrade",
      "Raise one of your structures a level in place: instant, costs the same as the next new one " +
        "of that type (the shared price ladder advances), no 15-tile spacing needed. City +250k troop " +
        "cap per level; Port one more trade-ship roll per level; Missile Silo / SAM Launcher one more " +
        "missile per level; Factory one more train per level. Defense Post and Warship cannot be " +
        "upgraded. id: a structure id from observe.me.units; omitted = your lowest-level finished " +
        "one of that type. Needs observe.build[unit].affordable and a finished structure.",
      { unit: z.enum(BUILDABLE_UNITS), id: z.number().int().optional() },
      (a) => ({ type: "upgrade", unit: a.unit as Action["unit"], id: a.id as number | undefined }),
    );

    server.registerTool(
      "spawn",
      {
        description:
          "Spawn phase only: choose (or change) where you start. Pass a cell of the " +
          `${SPAWN_COLS}x${SPAWN_ROWS} grid that observe shows during the spawn phase; you land on free land ` +
          "near the middle of that cell. Re-pick as often as you like until the phase ends. " +
          "Others' picks appear in observe as they happen.",
        inputSchema: { col: z.number().int().min(0).max(SPAWN_COLS - 1), row: z.number().int().min(0).max(SPAWN_ROWS - 1) },
      },
      wrap("spawn", (a) => {
        const p = present();
        if ("reason" in p) return { ok: false, reason: p.reason };
        const { game } = p;
        if (!game.inSpawnPhase()) return { ok: false, reason: "the spawn phase is over" };
        const col = a.col as number;
        const row = a.row as number;
        const cellW = game.width() / SPAWN_COLS;
        const cellH = game.height() / SPAWN_ROWS;
        const x0 = Math.floor(col * cellW);
        const y0 = Math.floor(row * cellH);
        const cx = x0 + cellW / 2;
        const cy = y0 + cellH / 2;
        const step = Math.max(1, Math.floor(Math.min(cellW, cellH) / 12));
        let best: TileRef | null = null;
        let bestD = Infinity;
        for (let y = y0; y < y0 + cellH && y < game.height(); y += step) {
          for (let x = x0; x < x0 + cellW && x < game.width(); x += step) {
            const t = game.ref(x, y);
            if (!game.isLand(t) || game.hasOwner(t)) continue;
            const d = Math.abs(x - cx) + Math.abs(y - cy);
            if (d < bestD) {
              bestD = d;
              best = t;
            }
          }
        }
        if (best === null) return { ok: false, reason: `no free land in cell (c${col},r${row}); pick another cell` };
        seat!.send({ type: "spawn", tile: best });
        return { ok: true, text: JSON.stringify({ ok: true, cell: { col, row }, tile: { x: game.x(best), y: game.y(best) } }) };
      }),
    );

    action(
      "retreat",
      "Stop-loss: cancel your running attacks. With a target id, only the attack on that " +
        "player; without one, every attack you have running. Survivors walk home; the engine " +
        "keeps 25% of them as the price of retreating from a player (none when retreating from " +
        "unclaimed land). Use it when an attack is only feeding a stronger defense.",
      { target: z.number().int().optional() },
      (a) => ({ type: "retreat", target: a.target as number | undefined }),
    );

    action(
      "nuke",
      "Launch a warhead from one of your Missile Silos at a player's territory (the arena aims " +
        "at the middle of their land). Atom Bomb 750k gold, Hydrogen Bomb 5M, MIRV 25M+ " +
        "(350 warheads, needs an owned target tile). Destroys land into permanent fallout, kills " +
        "troops in the blast, and enemy SAM Launchers can intercept it. Nuking an ally breaks the " +
        "alliance and marks you a traitor. See observe.nukes for silos, prices and what you can launch now.",
      { target: z.number().int(), nuke: z.enum(NUKE_TYPES) },
      (a) => ({ type: "nuke", target: a.target as number, nuke: a.nuke as Action["nuke"] }),
    );

    action(
      "emoji",
      "Send an emoji to one player, or to everyone when target is omitted. No game " +
        "effect beyond the other players seeing it. Must be one of the game's emoji (see rules).",
      { emoji: z.string(), target: z.number().int().optional() },
      (a) => ({
        type: "emoji",
        emoji: a.emoji as string,
        target: a.target as number | undefined,
      }),
    );

    action(
      "chat",
      "Send a quick-chat message to one player. key must be a valid quick chat key " +
        '(see rules), e.g. "help.request_alliance".',
      { key: z.string(), target: z.number().int() },
      (a) => ({
        type: "chat",
        key: a.key as string,
        target: a.target as number,
      }),
    );

    server.registerTool(
      "say",
      {
        description:
          "One short in-character line (under 15 words) for the spectator feed, only when your plan changes or something notable happens. No game " +
          "effect: this is the line the audience sees. Perform, do not explain.",
        inputSchema: { text: z.string().max(240) },
      },
      wrap("say", (a) => {
        seat!.say?.(String(a.text));
        return { ok: true };
      }),
    );

    server.registerResource("rules", "mindfront://rules", {}, async (uri) => ({
      contents: [{ uri: uri.href, text: opts.rules }],
    }));

    return server;
  }

  const handleHttp = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, Mcp-Session-Id",
    );
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const token = (req.headers.authorization ?? "")
      .replace(/^Bearer\s+/i, "")
      .trim();
    const seat = opts.seats.get(token);
    if (seat === undefined) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unknown or missing seat token" }));
      return;
    }
    // A stateless transport serves exactly one request (SDK >=1.30 throws if
    // reused), so build a throwaway server bound to this seat per request.
    // Nothing lives in the server: all state is the sim behind opts.game().
    const server = buildServer(seat);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };

  // Standalone instance for the first seat, for in-process/in-memory clients
  // (tests, arena/player.ts). HTTP clients get their own per-token instance.
  return { server: buildServer(opts.seats.values().next().value), handleHttp };
}
