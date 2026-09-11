/**
 * MindFront arena — Package C: observe() + toIntents().
 * Coded against arena/types.ts (the contract). Do not change types.ts here.
 */
import {
  AllPlayers,
  type Game,
  type Player,
  PlayerType,
  UnitType,
} from "../src/core/game/Game";
import type { TileRef } from "../src/core/game/GameMap";
import { QuickChatKeySchema, type Intent } from "../src/core/Schemas";
import { flattenedEmojiTable } from "../src/core/Util";
import {
  type Action,
  type ActResult,
  type BuildableUnit,
  BUILDABLE_UNITS,
  type Decision,
  type Dropped,
  type Obs,
  type ObsNeighbor,
  type PlayerCtx,
  RATIO_MAX,
  RATIO_MIN,
  type Relation,
} from "./types";

// arena's BuildableUnit strings are the same literals as UnitType enum values;
// spelled out explicitly so a UnitType rename doesn't silently desync us.
const UNIT_MAP: Record<BuildableUnit, UnitType> = {
  City: UnitType.City,
  Port: UnitType.Port,
  "Defense Post": UnitType.DefensePost,
  "Missile Silo": UnitType.MissileSilo,
  "SAM Launcher": UnitType.SAMLauncher,
  Factory: UnitType.Factory,
  Warship: UnitType.Warship,
};

const RELATION_NAMES: Relation[] = ["hostile", "distrustful", "neutral", "friendly"];

// Cheap coastal check: scan at most `cap` border tiles instead of the whole
// border (borders can be thousands of tiles on a big blob).
function hasCoast(game: Game, p: Player, cap = 300): boolean {
  let i = 0;
  for (const tile of p.borderTiles()) {
    if (game.isShore(tile)) return true;
    if (++i >= cap) break;
  }
  return false;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function observe(
  game: Game,
  me: Player,
  ctx: PlayerCtx,
  recentEvents: string[],
): Obs {
  const neighborPlayers = me
    .nearby()
    .filter((p): p is Player => p.isPlayer() && me.sharesBorderWith(p));
  const neighborIds = new Set(neighborPlayers.map((p) => p.smallID()));
  const incomingAttackers = new Set(me.incomingAttacks().map((a) => a.attacker()));

  const neighbors: ObsNeighbor[] = neighborPlayers.map((p) => ({
    id: p.smallID(),
    name: p.name(),
    kind: p.type() === PlayerType.Human ? "llm" : "tribe",
    tiles: p.numTilesOwned(),
    troops: Math.round(p.troops()),
    relation: RELATION_NAMES[me.relation(p)],
    allied: me.isAlliedWith(p),
    attackingMe: incomingAttackers.has(p),
    coastal: hasCoast(game, p),
  }));

  const iAmCoastal = hasCoast(game, me);
  const reachableByBoat = iAmCoastal
    ? game
        .players()
        .filter((p) => p !== me && !neighborIds.has(p.smallID()) && hasCoast(game, p))
        .sort((a, b) => b.numTilesOwned() - a.numTilesOwned())
        .slice(0, 3)
        .map((p) => ({ id: p.smallID(), name: p.name(), tiles: p.numTilesOwned() }))
    : [];

  const leaderboard = game
    .players()
    .slice()
    .sort((a, b) => b.numTilesOwned() - a.numTilesOwned())
    .slice(0, 5)
    .map((p) => ({ id: p.smallID(), name: p.name(), tiles: p.numTilesOwned() }));

  const gold = me.gold();
  const canBuild: { unit: BuildableUnit; cost: number }[] = [];
  for (const unit of BUILDABLE_UNITS) {
    const cost = game.unitInfo(UNIT_MAP[unit]).cost(game, me);
    if (cost <= gold) canBuild.push({ unit, cost: Number(cost) });
  }

  const tiles = me.numTilesOwned();
  const totalLand = game.totalLandTiles();

  return {
    tick: game.ticks(),
    minute: round1(game.ticks() / 600),
    me: {
      id: me.smallID(),
      name: me.name(),
      tiles,
      landPct: totalLand > 0 ? round1((tiles / totalLand) * 100) : 0,
      troops: Math.round(me.troops()),
      gold: Number(gold),
      cities: me.unitCount(UnitType.City),
      ports: me.unitCount(UnitType.Port),
      defensePosts: me.unitCount(UnitType.DefensePost),
      silos: me.unitCount(UnitType.MissileSilo),
      boatsInFlight: me.unitCount(UnitType.TransportShip),
      allies: me.allies().map((a) => a.smallID()),
      pendingAllianceRequestsFrom: me
        .incomingAllianceRequests()
        .map((r) => r.requestor().smallID()),
      incomingAttacks: me
        .incomingAttacks()
        .map((a) => ({ from: a.attacker().smallID(), troops: Math.round(a.troops()) })),
      outgoingAttacks: me.outgoingAttacks().map((a) => {
        const t = a.target();
        return {
          to: t.isPlayer() ? t.smallID() : ("land" as const),
          troops: Math.round(a.troops()),
        };
      }),
    },
    neighbors,
    unclaimedLandAdjacent: me.sharesBorderWith(game.terraNullius()),
    reachableByBoat,
    leaderboard,
    canBuild,
    recentEvents: recentEvents.slice(-8),
    lastResult: ctx.lastResult,
    notes: ctx.notes,
  };
}

// ---------- toIntents ----------

function clampRatio(r: number | undefined): number {
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, r ?? 0.3));
}

function resolveTarget(game: Game, id: number | undefined): Player | undefined {
  if (id === undefined) return undefined;
  const p = game.playerBySmallID(id);
  if (p === undefined || !p.isPlayer()) return undefined;
  return p;
}

type Category = "move" | "build" | "diplo" | "comm";

function categoryOf(type: Action["type"]): Category | null {
  switch (type) {
    case "attack":
    case "expand":
    case "boat":
      return "move";
    case "build":
      return "build";
    case "ally":
    case "accept_alliance":
    case "reject_alliance":
    case "break_alliance":
      return "diplo";
    case "emoji":
    case "chat":
      return "comm";
    default:
      return null; // wait
  }
}

/** Result of translating one action: either an intent to send, or a drop reason. */
type Translated = { intent: Intent } | { reason: string };

function translate(game: Game, me: Player, action: Action): Translated {
  switch (action.type) {
    case "expand": {
      if (!me.sharesBorderWith(game.terraNullius())) {
        return { reason: "no unclaimed land borders you right now; try attack or boat instead" };
      }
      const troops = Math.floor(me.troops() * clampRatio(action.ratio));
      if (troops <= 0) return { reason: "not enough troops to expand" };
      return { intent: { type: "attack", targetID: null, troops } };
    }

    case "attack": {
      const t = resolveTarget(game, action.target);
      if (!t) return { reason: `target ${action.target} does not exist; pick an id from neighbors` };
      if (!t.isAlive()) return { reason: `target ${action.target} is no longer alive` };
      if (me.isAlliedWith(t)) {
        return { reason: `target ${action.target} is your ally; break_alliance first if you want to attack` };
      }
      if (!me.sharesBorderWith(t)) {
        return { reason: `target ${action.target} does not share a border with you; attack a neighbor instead` };
      }
      if (!me.canAttackPlayer(t)) {
        return { reason: `cannot attack target ${action.target} right now (immune or otherwise blocked)` };
      }
      const troops = Math.floor(me.troops() * clampRatio(action.ratio));
      if (troops <= 0) return { reason: "not enough troops to attack" };
      return { intent: { type: "attack", targetID: t.id(), troops } };
    }

    case "boat": {
      const t = resolveTarget(game, action.target);
      if (!t) return { reason: `target ${action.target} does not exist; pick an id from reachableByBoat` };
      if (!t.isAlive()) return { reason: `target ${action.target} is no longer alive` };
      if (me.unitCount(UnitType.TransportShip) >= 3) {
        return { reason: "already have 3 boats in flight; wait for one to land" };
      }
      let dst: TileRef | undefined;
      let scanned = 0;
      for (const tile of t.borderTiles()) {
        if (game.isShore(tile)) {
          dst = tile;
          break;
        }
        if (++scanned >= 300) break;
      }
      if (dst === undefined) return { reason: `target ${action.target} has no reachable shore` };
      if (me.bestTransportShipSpawn(dst) === false) {
        return { reason: `no sea route from your coast to target ${action.target}` };
      }
      const troops = Math.floor(me.troops() * clampRatio(action.ratio));
      if (troops <= 0) return { reason: "not enough troops to send by boat" };
      return { intent: { type: "boat", troops, dst } };
    }

    case "ally":
    case "accept_alliance": {
      const t = resolveTarget(game, action.target);
      if (!t) return { reason: `target ${action.target} does not exist; pick an id from neighbors` };
      if (action.type === "accept_alliance") {
        const pending = me.incomingAllianceRequests().some((r) => r.requestor() === t);
        if (!pending) return { reason: `no pending alliance request from ${action.target}` };
      }
      if (!me.canSendAllianceRequest(t)) {
        return { reason: `cannot send an alliance request to ${action.target} right now` };
      }
      return { intent: { type: "allianceRequest", recipient: t.id() } };
    }

    case "reject_alliance": {
      const t = resolveTarget(game, action.target);
      if (!t) return { reason: `target ${action.target} does not exist` };
      const pending = me.incomingAllianceRequests().some((r) => r.requestor() === t);
      if (!pending) return { reason: `no pending alliance request from ${action.target}` };
      return { intent: { type: "allianceReject", requestor: t.id() } };
    }

    case "break_alliance": {
      const t = resolveTarget(game, action.target);
      if (!t) return { reason: `target ${action.target} does not exist` };
      if (!me.isAlliedWith(t)) return { reason: `you are not allied with ${action.target}` };
      return { intent: { type: "breakAlliance", recipient: t.id() } };
    }

    case "build": {
      if (action.unit === undefined) return { reason: "build needs a unit type" };
      const unitType = UNIT_MAP[action.unit];
      const needsBorder = unitType === UnitType.Port || unitType === UnitType.DefensePost;
      const pool = needsBorder ? me.borderTiles() : me.tiles();
      let tile: TileRef | undefined;
      let scanned = 0;
      for (const t of pool) {
        if (me.canBuild(unitType, t) !== false) {
          tile = t;
          break;
        }
        if (++scanned >= 200) break;
      }
      if (tile === undefined) return { reason: `no valid tile to build ${action.unit} right now` };
      return { intent: { type: "build_unit", unit: unitType, tile } };
    }

    case "emoji": {
      if (action.emoji === undefined) return { reason: "emoji needs an emoji character" };
      const idx = flattenedEmojiTable.indexOf(action.emoji as (typeof flattenedEmojiTable)[number]);
      if (idx === -1) return { reason: `"${action.emoji}" is not a supported emoji` };
      if (action.target === undefined) {
        return { intent: { type: "emoji", recipient: AllPlayers, emoji: idx } };
      }
      const t = resolveTarget(game, action.target);
      if (!t) return { reason: `target ${action.target} does not exist` };
      return { intent: { type: "emoji", recipient: t.id(), emoji: idx } };
    }

    case "chat": {
      if (action.key === undefined) return { reason: "chat needs a key" };
      if (!QuickChatKeySchema.safeParse(action.key).success) {
        return { reason: `"${action.key}" is not a valid quick chat key` };
      }
      if (action.target === undefined) return { reason: "chat needs a target" };
      const t = resolveTarget(game, action.target);
      if (!t) return { reason: `target ${action.target} does not exist` };
      return { intent: { type: "quick_chat", recipient: t.id(), quickChatKey: action.key } };
    }

    default:
      return { reason: `unknown action type ${(action as Action).type}` };
  }
}

export function toIntents(
  game: Game,
  me: Player,
  _obs: Obs,
  decision: Decision,
  _ctx: PlayerCtx,
): ActResult {
  const intents: Intent[] = [];
  const dropped: Dropped[] = [];
  const used = new Set<Category>();

  for (const action of decision.actions) {
    if (action.type === "wait") continue;

    const cat = categoryOf(action.type);
    if (cat !== null) {
      if (used.has(cat)) {
        dropped.push({ action, reason: `only one ${cat} action per turn; dropped extra ${action.type}` });
        continue;
      }
      used.add(cat);
    }

    try {
      const result = translate(game, me, action);
      if ("intent" in result) {
        intents.push(result.intent);
      } else {
        dropped.push({ action, reason: result.reason });
      }
    } catch (err) {
      dropped.push({ action, reason: `internal error translating action: ${String(err)}` });
    }
  }

  return { intents, dropped };
}
