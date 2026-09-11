/**
 * MindFront arena contract. Every arena module codes against this file.
 * Owned by the orchestrator; do not change without updating docs/PLAN.md.
 *
 * Flow per LLM player every `intervalTicks`:
 *   observe(game, me, ctx) -> Obs
 *   decide(ctx, obs)       -> Decision           (OpenRouter; never throws)
 *   toIntents(game, me, obs, decision, ctx) -> { intents, dropped }
 * brain.ts sends `intents` on the player's socket and appends an EventLine.
 */
import { z } from "zod";
import type { Game, Player } from "../src/core/game/Game";
import type { Intent } from "../src/core/Schemas";

// ---------- roster ----------

export interface RosterEntry {
  /** OpenRouter model id, e.g. "anthropic/claude-sonnet-4" */
  model: string;
  /** Display name in game. Letters/digits/space, 3–20 chars. */
  name: string;
  /** Persona paragraph appended to the system prompt. */
  persona: string;
}

// ---------- per-player mutable state (brain-owned, agent-read/written) ----------

export interface PlayerCtx extends RosterEntry {
  clientID: string;
  /** game player id (player.id()), used in intents */
  playerID: string;
  /** model's scratchpad, echoed back next call */
  notes: string;
  /** what happened to the previous decision (drops, fallback), echoed back */
  lastResult: string;
  /** EMA of decide() latency in ms; timeouts count as 20_000 */
  latencyEma: number;
  /** minimum gap between decisions (ticks) */
  intervalTicks: number;
  /** a decide() call is in flight */
  pending: boolean;
  /** same action dropped N times in a row -> forced fallback */
  consecutiveDrops: number;
}

// ---------- observation ----------

export type Relation = "hostile" | "distrustful" | "neutral" | "friendly";

export type Compass = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ObsNeighbor {
  /** smallID; the only id space the model ever sees */
  id: number;
  name: string;
  kind: "llm" | "tribe";
  tiles: number;
  troops: number;
  relation: Relation;
  allied: boolean;
  attackingMe: boolean;
  coastal: boolean;
  gold: number;
  maxTroops: number;
  /** troops as a percentage of their cap */
  troopsPct: number;
  isTraitor: boolean;
  betrayals: number;
  /** smallIDs they are allied with */
  allies: number[];
  /** smallIDs they have publicly marked as targets */
  targets: number[];
  /** smallIDs they currently have an attack running against */
  attacking: number[];
  /** smallIDs currently attacking them */
  attackedBy: number[];
  /** tiles gained (or lost) over the last minute */
  tilesDelta1m: number;
  /** how many of MY border tiles touch them */
  sharedBorderTiles: number;
  /** 8-way compass from my cluster centre to theirs */
  direction: Compass;
  /** manhattan distance between cluster centres, in tiles */
  distance: number;
  structures: Record<BuildableUnit, number>;
}

export interface Obs {
  tick: number;
  minute: number;
  /** compact match constants; the full briefing lives in the `game_info` tool */
  game: {
    tick: number;
    /** minutes until the timer ends, null when the match is untimed */
    minutesLeft: number | null;
    totalLandTiles: number;
    mapWidth: number;
    mapHeight: number;
  };
  me: {
    id: number;
    name: string;
    tiles: number;
    landPct: number;
    troops: number;
    gold: number;
    cities: number;
    ports: number;
    defensePosts: number;
    silos: number;
    boatsInFlight: number;
    allies: number[];
    pendingAllianceRequestsFrom: number[];
    incomingAttacks: { from: number; troops: number }[];
    outgoingAttacks: {
      to: number | "land";
      troops: number;
      troopsRemaining: number;
    }[];
    maxTroops: number;
    /** troops as a percentage of my cap */
    troopsPct: number;
    /** gold earned over the last minute */
    goldIncomePerMin: number;
    /** tiles gained (or lost) over the last minute */
    tilesDelta1m: number;
    /** tick my spawn immunity ends; 0 when it is already over */
    immuneUntilTick: number;
    isTraitor: boolean;
    betrayals: number;
    allianceExpiry: { id: number; ticksLeft: number }[];
    pendingRequestExpiry: { id: number; ticksLeft: number }[];
    structures: Record<BuildableUnit, number>;
    center: { x: number; y: number };
    bbox: BBox;
  };
  neighbors: ObsNeighbor[];
  unclaimedLandAdjacent: boolean;
  /** top 3 coastal non-neighbors, only if I own a shore tile */
  reachableByBoat: ObsNeighbor[];
  /** top 5 by tiles, all players incl. me */
  leaderboard: ObsNeighbor[];
  /** structures affordable right now */
  canBuild: { unit: BuildableUnit; cost: number }[];
  /** current gold price of every structure, affordable or not */
  buildCosts: Record<BuildableUnit, number>;
  /** last ≤8 human-readable events involving me */
  recentEvents: string[];
  /** last ≤10 human-readable events involving anyone */
  globalEvents: string[];
  lastResult: string;
  notes: string;
}

// ---------- action (what the LLM returns) ----------

export const BUILDABLE_UNITS = [
  "City",
  "Port",
  "Defense Post",
  "Missile Silo",
  "SAM Launcher",
  "Factory",
  "Warship",
] as const;
export type BuildableUnit = (typeof BUILDABLE_UNITS)[number];

export const ACTION_TYPES = [
  "attack",
  "expand",
  "boat",
  "ally",
  "accept_alliance",
  "reject_alliance",
  "break_alliance",
  "build",
  "emoji",
  "chat",
  "wait",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const RATIO_MIN = 0.05;
export const RATIO_MAX = 0.6;

export const ActionSchema = z
  .object({
    type: z.enum(ACTION_TYPES),
    /** smallID of the target player (attack/boat/ally/accept/reject/break/emoji/chat) */
    target: z.number().int().optional(),
    /** fraction of troops to send (attack/expand/boat); clamped to [RATIO_MIN, RATIO_MAX] */
    ratio: z.number().optional(),
    unit: z.enum(BUILDABLE_UNITS).optional(),
    /** emoji character, must exist in flattenedEmojiTable */
    emoji: z.string().optional(),
    /** quick chat key, must satisfy QuickChatKeySchema (resources/QuickChat.json) */
    key: z.string().optional(),
  })
  .strict();
export type Action = z.infer<typeof ActionSchema>;

export const DecisionSchema = z
  .object({
    /** 1–2 in-character sentences; shown to spectators; NOT fact-checked */
    reasoning: z.string().max(240),
    notes: z.string().max(300).default(""),
    actions: z.array(ActionSchema),
  })
  .strict();
export type Decision = z.infer<typeof DecisionSchema>;

/** JSON schema handed to OpenRouter as the `act` tool parameters. */
export const ACT_TOOL_PARAMETERS = {
  type: "object",
  required: ["reasoning", "actions"],
  additionalProperties: false,
  properties: {
    reasoning: { type: "string", maxLength: 240 },
    notes: { type: "string", maxLength: 300 },
    actions: {
      type: "array",
      items: {
        type: "object",
        required: ["type"],
        additionalProperties: false,
        properties: {
          type: { enum: [...ACTION_TYPES] },
          target: { type: "integer" },
          ratio: { type: "number", minimum: RATIO_MIN, maximum: RATIO_MAX },
          unit: { enum: [...BUILDABLE_UNITS] },
          emoji: { type: "string" },
          key: { type: "string" },
        },
      },
    },
  },
} as const;

export const FALLBACK_DECISION: Decision = {
  reasoning: "(fallback) holding position.",
  notes: "",
  actions: [{ type: "wait" }],
};

// ---------- toIntents result ----------

export interface Dropped {
  action: Action;
  /** human-readable, fed back to the model via ctx.lastResult */
  reason: string;
}

export interface ActResult {
  intents: Intent[];
  dropped: Dropped[];
}

// ---------- events.jsonl ----------

export type EventLine =
  | {
      kind: "decision";
      t: number;
      player: string;
      model: string;
      latencyMs: number;
      intervalTicks: number;
      fallback: boolean;
      reasoning: string;
      sent: Intent[];
      dropped: Dropped[];
    }
  | {
      kind: "sim";
      t: number;
      /** e.g. "conquest", "alliance", "betrayal", "nuke", "win", "death" */
      type: string;
      text: string;
      players: string[];
    };

// ---------- function signatures (implemented in agent.ts) ----------

export type Observe = (
  game: Game,
  me: Player,
  ctx: PlayerCtx,
  recentEvents: string[],
  globalEvents?: string[],
) => Obs;

export type Decide = (
  ctx: PlayerCtx,
  obs: Obs,
  opts?: { apiKey?: string; timeoutMs?: number; fetchImpl?: typeof fetch },
) => Promise<{ decision: Decision; latencyMs: number; fallback: boolean }>;

export type ToIntents = (
  game: Game,
  me: Player,
  obs: Obs,
  decision: Decision,
  ctx: PlayerCtx,
) => ActResult;

// ---------- shared constants ----------

export const TICK_MS = 100;
/** minimum gap between two decisions of the same player (ticks); a model
 * decides again as soon as its previous call resolved and this gap passed */
export const DEFAULT_INTERVAL_TICKS = 10;
export const DECIDE_TIMEOUT_MS = 20_000;

/**
 * Referential guardrail (layer 2): strips actions whose target/unit/emoji/key
 * was not offered in `obs`. Pure, no game access. Implemented in decide.ts.
 */
export type Sanitize = (
  decision: Decision,
  obs: Obs,
) => { decision: Decision; dropped: Dropped[] };
