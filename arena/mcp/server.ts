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
import type { Game, Player } from "../../src/core/game/Game";
import type { Intent } from "../../src/core/Schemas";
import { sanitize } from "../decide";
import { observe, toIntents } from "../observe";
import {
  BUILDABLE_UNITS,
  type Action,
  type EventLine,
  type PlayerCtx,
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

    /** live sim + my player, or the reason I cannot act right now */
    function live(): { game: Game; me: Player } | { reason: string } {
      const game = opts.game();
      if (game === null) return { reason: "the match has not started yet" };
      if (game.inSpawnPhase()) {
        return { reason: "spawn phase: wait for the match to start" };
      }
      const me = seat?.me() ?? null;
      if (me === null) return { reason: "your player is not in the game" };
      if (!me.isAlive()) return { reason: "you are dead" };
      return { game, me };
    }

    function obsNow() {
      const l = live();
      if ("reason" in l) return l;
      return {
        ...l,
        obs: observe(l.game, l.me, seat!.ctx, seat!.recentEvents()),
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
          "The full MindFront briefing: how the game works and how to win.",
        inputSchema: {},
      },
      wrap("rules", () => ({ ok: true, text: opts.rules })),
    );

    server.registerTool(
      "observe",
      {
        description:
          "Your current view of the world as JSON: your tiles/troops/gold/structures, " +
          "bordering neighbors (with ids, relation, alliance), whether unclaimed land " +
          "touches you, boat-reachable coastal players, the leaderboard, what you can " +
          "afford to build and what everything costs, and recent events. Every id you " +
          "may reference in another tool comes from here; invented ids are rejected.",
        inputSchema: {},
      },
      wrap("observe", () => {
        const o = obsNow();
        if ("reason" in o) return { ok: false, reason: o.reason };
        return { ok: true, text: JSON.stringify(o.obs) };
      }),
    );

    server.registerTool(
      "inspect_player",
      {
        description:
          "Details on one player you can currently see (a neighbor, ally, attacker, " +
          "leaderboard or boat-reachable id from observe): tiles, troops, relation to " +
          "you, alliance, whether you share a border, coastal, attacks in and out.",
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
          o.obs.me.incomingAttacks.some((x) => x.from === id);
        if (p === undefined || !p.isPlayer() || !known) {
          return { ok: false, reason: `unknown id ${id}` };
        }
        const me = o.me;
        return {
          ok: true,
          text: JSON.stringify({
            id,
            name: p.name(),
            tiles: p.numTilesOwned(),
            troops: Math.round(p.troops()),
            relation:
              o.obs.neighbors.find((n) => n.id === id)?.relation ?? "neutral",
            allied: me.isAlliedWith(p),
            sharesBorder: me.sharesBorderWith(p),
            coastal: o.obs.neighbors.find((n) => n.id === id)?.coastal ?? true,
            incomingAttacks: p.incomingAttacks().length,
            outgoingAttacks: p.outgoingAttacks().length,
          }),
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
      "Break an alliance. Brands you a traitor. Only ids in observe.me.allies.",
      { target: z.number().int() },
      (a) => ({ type: "break_alliance", target: a.target as number }),
    );

    action(
      "build",
      "Build a structure with gold. City raises your troop cap; Port enables sea trade " +
        "and boats; Defense Post strengthens nearby borders; Factory boosts gold; " +
        "Warship (needs a Port) hunts enemy ships; Missile Silo launches nukes; SAM " +
        "Launcher shoots incoming nukes down. Only units listed in observe.canBuild are " +
        "affordable right now; observe.buildCosts shows every price so you can save up.",
      { unit: z.enum(BUILDABLE_UNITS) },
      (a) => ({ type: "build", unit: a.unit as Action["unit"] }),
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
          "Say one or two punchy in-character sentences to the spectator feed. No game " +
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
