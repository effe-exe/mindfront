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
import { manhattanDistFN, type TileRef } from "../src/core/game/GameMap";
import { type Intent, QuickChatKeySchema } from "../src/core/Schemas";
import { flattenedEmojiTable } from "../src/core/Util";
import {
  type Action,
  type ActResult,
  type BBox,
  BUILDABLE_UNITS,
  type BuildableUnit,
  type Compass,
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
export const UNIT_MAP: Record<BuildableUnit, UnitType> = {
  City: UnitType.City,
  Port: UnitType.Port,
  "Defense Post": UnitType.DefensePost,
  "Missile Silo": UnitType.MissileSilo,
  "SAM Launcher": UnitType.SAMLauncher,
  Factory: UnitType.Factory,
  Warship: UnitType.Warship,
};

const RELATION_NAMES: Relation[] = [
  "hostile",
  "distrustful",
  "neutral",
  "friendly",
];

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

// ---------- per-player history (brain calls trackHistory every ~100 ticks) ----------

interface Sample {
  tick: number;
  tiles: number;
  goldEarned: number;
}
/** smallID -> last ~7 samples. Module-level: one sim per process. */
const history = new Map<number, Sample[]>();
const HISTORY_LEN = 7;
const TICKS_PER_MIN = 600;

/** Snapshot every player's tiles + goldEarned. Call every ~100 ticks. */
export function trackHistory(game: Game): void {
  const tick = game.ticks();
  for (const p of game.players()) {
    let arr = history.get(p.smallID());
    if (arr === undefined) {
      arr = [];
      history.set(p.smallID(), arr);
    }
    // a new match restarts at tick 0: drop the previous game's samples
    if (arr.length > 0 && tick < arr[arr.length - 1].tick) arr.length = 0;
    arr.push({
      tick,
      tiles: p.numTilesOwned(),
      goldEarned: Number(p.goldEarned()),
    });
    if (arr.length > HISTORY_LEN) arr.shift();
  }
}

/** Growth over the last minute, extrapolated from whatever history exists. */
function deltas(p: Player, tick: number): { tiles: number; gold: number } {
  const arr = history.get(p.smallID());
  if (arr === undefined || arr.length === 0) return { tiles: 0, gold: 0 };
  const span = tick - arr[0].tick;
  if (span <= 0) return { tiles: 0, gold: 0 };
  const scale = TICKS_PER_MIN / span;
  return {
    tiles: Math.round((p.numTilesOwned() - arr[0].tiles) * scale),
    gold: Math.round((Number(p.goldEarned()) - arr[0].goldEarned) * scale),
  };
}

// ---------- geometry ----------

function clusterBox(
  game: Game,
  p: Player,
): { center: { x: number; y: number }; bbox: BBox } {
  const bb = p.largestClusterBoundingBox;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  // undefined until the cluster pass first runs, null when the player has none
  if (bb !== null && bb !== undefined) {
    minX = bb.min.x;
    minY = bb.min.y;
    maxX = bb.max.x;
    maxY = bb.max.y;
  } else {
    // No cluster pass has run yet: sample up to 256 owned tiles instead.
    let n = 0;
    for (const t of p.tiles()) {
      const x = game.x(t);
      const y = game.y(t);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (++n >= 256) break;
    }
    if (n === 0) {
      return {
        center: { x: 0, y: 0 },
        bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      };
    }
  }
  return {
    center: {
      x: Math.round((minX + maxX) / 2),
      y: Math.round((minY + maxY) / 2),
    },
    bbox: { minX, minY, maxX, maxY },
  };
}

const COMPASS: Compass[] = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"];

/** 8-way compass for a screen-space delta (y grows downward = south). */
function compass(dx: number, dy: number): Compass {
  if (dx === 0 && dy === 0) return "N";
  const i = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  return COMPASS[((i % 8) + 8) % 8];
}

function structuresOf(p: Player): Record<BuildableUnit, number> {
  const out = {} as Record<BuildableUnit, number>;
  for (const u of BUILDABLE_UNITS) out[u] = p.unitCount(UNIT_MAP[u]);
  return out;
}

function push(map: Map<number, number[]>, key: number, value: number): void {
  const arr = map.get(key);
  if (arr === undefined) map.set(key, [value]);
  else if (!arr.includes(value)) arr.push(value);
}

/**
 * Builds the enriched view of any player, from my point of view. All the
 * cross-player scans (everyone's attacks, my border ownership) happen once
 * here, not once per player.
 */
function makeViewer(game: Game, me: Player): (p: Player) => ObsNeighbor {
  const tick = game.ticks();
  const mySmall = me.smallID();
  const myCenter = clusterBox(game, me).center;
  const incoming = new Set(
    me.incomingAttacks().map((a) => a.attacker().smallID()),
  );

  const attacking = new Map<number, number[]>();
  const attackedBy = new Map<number, number[]>();
  for (const p of game.players()) {
    for (const a of p.outgoingAttacks()) {
      const t = a.target();
      if (!t.isPlayer()) continue;
      push(attacking, p.smallID(), t.smallID());
      push(attackedBy, t.smallID(), p.smallID());
    }
  }

  // How many of my border tiles touch each other player. Capped scan.
  const borderCounts = new Map<number, number>();
  const nbrs: TileRef[] = [0, 0, 0, 0];
  let scanned = 0;
  for (const t of me.borderTiles()) {
    const n = game.neighbors4(t, nbrs);
    let a = -1;
    let b = -1;
    for (let i = 0; i < n; i++) {
      const o = game.ownerID(nbrs[i]);
      if (o === 0 || o === mySmall || o === a || o === b) continue;
      if (a === -1) a = o;
      else b = o;
      borderCounts.set(o, (borderCounts.get(o) ?? 0) + 1);
    }
    if (++scanned >= 2000) break;
  }

  const cache = new Map<number, ObsNeighbor>();
  return (p: Player): ObsNeighbor => {
    const id = p.smallID();
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    const maxTroops = game.config().maxTroops(p);
    const troops = p.troops();
    const box = clusterBox(game, p);
    const view: ObsNeighbor = {
      id,
      name: p.name(),
      kind: p.type() === PlayerType.Human ? "llm" : "tribe",
      tiles: p.numTilesOwned(),
      troops: Math.round(troops),
      relation: p === me ? "neutral" : RELATION_NAMES[me.relation(p)],
      allied: me.isAlliedWith(p),
      attackingMe: incoming.has(id),
      coastal: hasCoast(game, p),
      gold: Number(p.gold()),
      maxTroops: Math.round(maxTroops),
      troopsPct: maxTroops > 0 ? Math.round((troops / maxTroops) * 100) : 0,
      isTraitor: p.isTraitor(),
      betrayals: p.betrayals(),
      allies: p.allies().map((a) => a.smallID()),
      targets: p.targets().map((t) => t.smallID()),
      attacking: attacking.get(id) ?? [],
      attackedBy: attackedBy.get(id) ?? [],
      tilesDelta1m: deltas(p, tick).tiles,
      sharedBorderTiles: borderCounts.get(id) ?? 0,
      direction: compass(box.center.x - myCenter.x, box.center.y - myCenter.y),
      distance:
        Math.abs(box.center.x - myCenter.x) +
        Math.abs(box.center.y - myCenter.y),
      structures: structuresOf(p),
    };
    cache.set(id, view);
    return view;
  };
}

/** The same enriched view of one player, for the `inspect_player` tool. */
export function viewPlayer(game: Game, me: Player, p: Player): ObsNeighbor {
  return makeViewer(game, me)(p);
}

/** Minutes until the match timer ends; null when the match is untimed. */
export function minutesLeft(game: Game): number | null {
  const max = game.config().gameConfig().maxTimerValue;
  if (typeof max !== "number") return null;
  return round1(Math.max(0, max - game.ticks() / TICKS_PER_MIN));
}

export function observe(
  game: Game,
  me: Player,
  ctx: PlayerCtx,
  recentEvents: string[],
  globalEvents: string[] = [],
): Obs {
  const view = makeViewer(game, me);
  const neighborPlayers = me
    .nearby()
    .filter((p): p is Player => p.isPlayer() && me.sharesBorderWith(p));
  const neighborIds = new Set(neighborPlayers.map((p) => p.smallID()));

  const neighbors: ObsNeighbor[] = neighborPlayers.map(view);

  const iAmCoastal = hasCoast(game, me);
  const reachableByBoat = iAmCoastal
    ? game
        .players()
        .filter(
          (p) => p !== me && !neighborIds.has(p.smallID()) && hasCoast(game, p),
        )
        .sort((a, b) => b.numTilesOwned() - a.numTilesOwned())
        .slice(0, 3)
        .map(view)
    : [];

  const leaderboard = game
    .players()
    .slice()
    .sort((a, b) => b.numTilesOwned() - a.numTilesOwned())
    .slice(0, 5)
    .map(view);

  const gold = me.gold();
  const canBuild: { unit: BuildableUnit; cost: number }[] = [];
  const buildCosts = {} as Record<BuildableUnit, number>;
  const build = {} as Obs["build"];
  const ownShore = hasCoast(game, me);
  const ports = me.unitCount(UnitType.Port);
  const ownsLand = me.numTilesOwned() > 0;
  for (const unit of BUILDABLE_UNITS) {
    const cost = game.unitInfo(UNIT_MAP[unit]).cost(game, me);
    buildCosts[unit] = Number(cost);
    const affordable = cost <= gold;
    // Placement rules (PlayerImpl.canSpawnUnitType): Port on a coastal tile you
    // own, Warship launched from one of your Ports, everything else on any of
    // your land tiles (kept apart from your other structures).
    const [placeable, where] =
      unit === "Port"
        ? [ownShore, ownShore ? "on one of your coastal tiles" : "needs a coastal tile you own; you have none"]
        : unit === "Warship"
          ? [ports > 0, ports > 0 ? "launched from one of your Ports" : "needs a Port; you have none"]
          : [ownsLand, "on any of your land tiles, spaced away from your other structures"];
    const note = `${affordable ? "affordable" : `need ${Number(cost) - Number(gold)} more gold`}; ${where}`;
    build[unit] = { cost: Number(cost), affordable, placeable, note };
    if (affordable && placeable) canBuild.push({ unit, cost: Number(cost) });
  }

  const tiles = me.numTilesOwned();
  const totalLand = game.totalLandTiles();
  const tick = game.ticks();
  const cfg = game.config();
  const myMaxTroops = cfg.maxTroops(me);
  const myBox = clusterBox(game, me);
  const myDeltas = deltas(me, tick);
  // isImmune() is the truth; elapsedGameSeconds is the only public clock that
  // matches the engine's spawn-immunity countdown.
  const immunityTicksLeft = me.isImmune()
    ? Math.max(0, cfg.spawnImmunityDuration() - game.elapsedGameSeconds() * 10)
    : 0;

  return {
    tick,
    minute: round1(game.ticks() / 600),
    game: {
      tick,
      minutesLeft: minutesLeft(game),
      totalLandTiles: totalLand,
      mapWidth: game.width(),
      mapHeight: game.height(),
    },
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
        .map((a) => ({
          from: a.attacker().smallID(),
          troops: Math.round(a.troops()),
        })),
      outgoingAttacks: me.outgoingAttacks().map((a) => {
        const t = a.target();
        const troops = Math.round(a.troops());
        return {
          to: t.isPlayer() ? t.smallID() : ("land" as const),
          troops,
          troopsRemaining: troops,
        };
      }),
      maxTroops: Math.round(myMaxTroops),
      troopsPct:
        myMaxTroops > 0 ? Math.round((me.troops() / myMaxTroops) * 100) : 0,
      goldIncomePerMin: myDeltas.gold,
      tilesDelta1m: myDeltas.tiles,
      immuneUntilTick:
        immunityTicksLeft > 0 ? Math.round(tick + immunityTicksLeft) : 0,
      isTraitor: me.isTraitor(),
      betrayals: me.betrayals(),
      allianceExpiry: me.alliances().map((a) => ({
        id: a.other(me).smallID(),
        ticksLeft: a.expiresAt() - tick,
      })),
      pendingRequestExpiry: me.incomingAllianceRequests().map((r) => ({
        id: r.requestor().smallID(),
        ticksLeft: r.createdAt() + cfg.allianceRequestDuration() - tick,
      })),
      structures: structuresOf(me),
      center: myBox.center,
      bbox: myBox.bbox,
    },
    neighbors,
    unclaimedLandAdjacent: me.sharesBorderWith(game.terraNullius()),
    reachableByBoat,
    leaderboard,
    canBuild,
    buildCosts,
    build,
    recentEvents: recentEvents.slice(-8),
    globalEvents: globalEvents.slice(-10),
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

/** Result of translating one action: either an intent to send, or a drop reason. */
type Translated = { intent: Intent } | { reason: string };

function translate(game: Game, me: Player, action: Action): Translated {
  switch (action.type) {
    case "expand": {
      if (!me.sharesBorderWith(game.terraNullius())) {
        return {
          reason:
            "no unclaimed land borders you right now; try attack or boat instead",
        };
      }
      const troops = Math.floor(me.troops() * clampRatio(action.ratio));
      if (troops <= 0) return { reason: "not enough troops to expand" };
      return { intent: { type: "attack", targetID: null, troops } };
    }

    case "attack": {
      const t = resolveTarget(game, action.target);
      if (!t)
        return {
          reason: `target ${action.target} does not exist; pick an id from neighbors`,
        };
      if (!t.isAlive())
        return { reason: `target ${action.target} is no longer alive` };
      if (me.isAlliedWith(t)) {
        return {
          reason: `target ${action.target} is your ally; break_alliance first if you want to attack`,
        };
      }
      if (!me.sharesBorderWith(t)) {
        return {
          reason: `target ${action.target} does not share a border with you; attack a neighbor instead`,
        };
      }
      if (!me.canAttackPlayer(t)) {
        return {
          reason: `cannot attack target ${action.target} right now (immune or otherwise blocked)`,
        };
      }
      const troops = Math.floor(me.troops() * clampRatio(action.ratio));
      if (troops <= 0) return { reason: "not enough troops to attack" };
      return { intent: { type: "attack", targetID: t.id(), troops } };
    }

    case "boat": {
      const t = resolveTarget(game, action.target);
      if (!t)
        return {
          reason: `target ${action.target} does not exist; pick an id from reachableByBoat`,
        };
      if (!t.isAlive())
        return { reason: `target ${action.target} is no longer alive` };
      if (me.unitCount(UnitType.TransportShip) >= 3) {
        return {
          reason: "already have 3 boats in flight; wait for one to land",
        };
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
      if (dst === undefined)
        return { reason: `target ${action.target} has no reachable shore` };
      if (me.bestTransportShipSpawn(dst) === false) {
        return {
          reason: `no sea route from your coast to target ${action.target}`,
        };
      }
      const troops = Math.floor(me.troops() * clampRatio(action.ratio));
      if (troops <= 0) return { reason: "not enough troops to send by boat" };
      return { intent: { type: "boat", troops, dst } };
    }

    case "ally":
    case "accept_alliance": {
      const t = resolveTarget(game, action.target);
      if (!t)
        return {
          reason: `target ${action.target} does not exist; pick an id from neighbors`,
        };
      if (action.type === "accept_alliance") {
        const pending = me
          .incomingAllianceRequests()
          .some((r) => r.requestor() === t);
        if (!pending)
          return {
            reason: `no pending alliance request from ${action.target}`,
          };
      }
      if (!me.canSendAllianceRequest(t)) {
        return {
          reason: `cannot send an alliance request to ${action.target} right now`,
        };
      }
      return { intent: { type: "allianceRequest", recipient: t.id() } };
    }

    case "reject_alliance": {
      const t = resolveTarget(game, action.target);
      if (!t) return { reason: `target ${action.target} does not exist` };
      const pending = me
        .incomingAllianceRequests()
        .some((r) => r.requestor() === t);
      if (!pending)
        return { reason: `no pending alliance request from ${action.target}` };
      return { intent: { type: "allianceReject", requestor: t.id() } };
    }

    case "break_alliance": {
      const t = resolveTarget(game, action.target);
      if (!t) return { reason: `target ${action.target} does not exist` };
      if (!me.isAlliedWith(t))
        return { reason: `you are not allied with ${action.target}` };
      return { intent: { type: "breakAlliance", recipient: t.id() } };
    }

    case "build": {
      if (action.unit === undefined)
        return { reason: "build needs a unit type" };
      const unitType = UNIT_MAP[action.unit];
      const needsBorder =
        unitType === UnitType.Port || unitType === UnitType.DefensePost;
      // Warships spawn on water near one of your Ports, never on land you own.
      const pool =
        unitType === UnitType.Warship
          ? me
              .units(UnitType.Port)
              .flatMap((p) => [
                ...game.bfs(p.tile(), manhattanDistFN(p.tile(), 3)),
              ])
              .filter((t) => game.isWater(t))
          : needsBorder
            ? me.borderTiles()
            : me.tiles();
      let tile: TileRef | undefined;
      let scanned = 0;
      for (const t of pool) {
        if (me.canBuild(unitType, t) !== false) {
          tile = t;
          break;
        }
        if (++scanned >= 200) break;
      }
      if (tile === undefined)
        return {
          reason:
            unitType === UnitType.Port
              ? "Port needs a coastal tile you own"
              : unitType === UnitType.Warship
                ? "Warship needs one of your Ports"
                : `no free spot for ${action.unit} (keep distance from your other structures)`,
        };
      return { intent: { type: "build_unit", unit: unitType, tile } };
    }

    case "emoji": {
      if (action.emoji === undefined)
        return { reason: "emoji needs an emoji character" };
      const idx = flattenedEmojiTable.indexOf(
        action.emoji as (typeof flattenedEmojiTable)[number],
      );
      if (idx === -1)
        return { reason: `"${action.emoji}" is not a supported emoji` };
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
      return {
        intent: {
          type: "quick_chat",
          recipient: t.id(),
          quickChatKey: action.key,
        },
      };
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

  for (const action of decision.actions) {
    if (action.type === "wait") continue;

    try {
      const result = translate(game, me, action);
      if ("intent" in result) {
        intents.push(result.intent);
      } else {
        dropped.push({ action, reason: result.reason });
      }
    } catch (err) {
      dropped.push({
        action,
        reason: `internal error translating action: ${String(err)}`,
      });
    }
  }

  return { intents, dropped };
}
