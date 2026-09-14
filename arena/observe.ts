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
  computeNukeBlastCounts,
  wouldNukeBreakAlliance,
} from "../src/core/execution/Util";
import {
  type Action,
  type ActResult,
  type BBox,
  BUILDABLE_UNITS,
  NUKE_TYPES,
  type NukeType,
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
const NUKE_MAP: Record<NukeType, UnitType> = {
  "Atom Bomb": UnitType.AtomBomb,
  "Hydrogen Bomb": UnitType.HydrogenBomb,
  MIRV: UnitType.MIRV,
};

export const UNIT_MAP: Record<BuildableUnit, UnitType> = {
  City: UnitType.City,
  Port: UnitType.Port,
  "Defense Post": UnitType.DefensePost,
  "Missile Silo": UnitType.MissileSilo,
  "SAM Launcher": UnitType.SAMLauncher,
  Factory: UnitType.Factory,
  Warship: UnitType.Warship,
};

const UNIT_NAME = new Map(BUILDABLE_UNITS.map((u) => [UNIT_MAP[u], u]));

const RELATION_NAMES: Relation[] = [
  "hostile",
  "distrustful",
  "neutral",
  "friendly",
];

/**
 * Land-only "free land touches me": sharesBorderWith(terraNullius) is true for
 * every coastal player because water is unowned too (engine's own AI has the
 * same helper, AiAttackBehavior.hasLandBorderWithTerraNullius).
 */
export function hasFreeLandBorder(game: Game, p: Player): boolean {
  for (const b of p.borderTiles()) {
    for (const n of game.neighbors(b)) {
      if (game.isLand(n) && !game.hasOwner(n)) return true;
    }
  }
  return false;
}

export function kindOf(p: Player): ObsNeighbor["kind"] {
  return p.type() === PlayerType.Human ? "llm" : p.type() === PlayerType.Nation ? "nation" : "tribe";
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------- per-player history (brain calls trackHistory every ~100 ticks) ----------

interface Sample {
  tick: number;
  tiles: number;
  goldEarned: number;
  tradeGold: number;
  trainGold: number;
}
/** warheads launched at a seat, by victim smallID; fed by the brain from UnitIncoming */
const nukeLaunches = new Map<number, { tick: number; from: number; kind: string }[]>();
export function recordNukeLaunch(victim: number, from: number, kind: string, tick: number): void {
  const arr = nukeLaunches.get(victim) ?? [];
  arr.push({ tick, from, kind });
  nukeLaunches.set(victim, arr.slice(-10));
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
      tradeGold: Number(p.tradeGold()),
      trainGold: Number(p.trainGold()),
    });
    if (arr.length > HISTORY_LEN) arr.shift();
  }
}

/** Growth over the last minute, extrapolated from whatever history exists. */
function deltas(
  p: Player,
  tick: number,
): { tiles: number; gold: number; trade: number; train: number } {
  const arr = history.get(p.smallID());
  const none = { tiles: 0, gold: 0, trade: 0, train: 0 };
  if (arr === undefined || arr.length === 0) return none;
  const span = tick - arr[0].tick;
  if (span <= 0) return none;
  const scale = TICKS_PER_MIN / span;
  return {
    tiles: Math.round((p.numTilesOwned() - arr[0].tiles) * scale),
    gold: Math.round((Number(p.goldEarned()) - arr[0].goldEarned) * scale),
    trade: Math.round((Number(p.tradeGold()) - arr[0].tradeGold) * scale),
    train: Math.round((Number(p.trainGold()) - arr[0].trainGold) * scale),
  };
}

// ---------- water ----------

/** Water bodies touching a player's shore border tiles (≤600 sampled at a
 * stride across the border) and whether any of them is ocean (isOceanShore:
 * a lake shore is not "coastal", but a shared lake is still a boat route, as
 * the engine's closestReachableShore only asks for a shared component).
 * Memoised on the border and water versions: every player is asked on every
 * observe. ponytail: a huge inland border with a few shore tiles can be
 * missed by the stride; scan fully if that ever shows up. */
const shoreMemo = new Map<number, { tiles: number; water: number; ocean: boolean; comps: Set<number> }>();
function shoreWater(game: Game, p: Player): { ocean: boolean; comps: Set<number> } {
  const tiles = p.tileChangeVersion();
  const water = game.map().waterVersion();
  const hit = shoreMemo.get(p.smallID());
  if (hit !== undefined && hit.tiles === tiles && hit.water === water) return hit;
  const border = p.borderTiles();
  const stride = Math.max(1, Math.floor(border.size / 600));
  let ocean = false;
  const comps = new Set<number>();
  let i = 0;
  for (const t of border) {
    if (i++ % stride !== 0 || !game.isShore(t)) continue;
    if (game.isOceanShore(t)) ocean = true;
    const c = game.getWaterComponent(t);
    if (c !== null) comps.add(c);
  }
  const entry = { tiles, water, ocean, comps };
  shoreMemo.set(p.smallID(), entry);
  return entry;
}

/** PortExecution.tradingPorts: a trade ship sails only to another player's Port
 * (no embargo either way) on a water component touching my Port. */
function tradePartnerPorts(game: Game, me: Player): number {
  const comps = new Set<number>();
  const myPorts = me.units(UnitType.Port);
  if (myPorts.length === 0) {
    for (const c of shoreWater(game, me).comps) comps.add(c);
  }
  for (const port of myPorts) {
    for (const n of game.neighbors(port.tile())) {
      if (!game.isWater(n)) continue;
      const c = game.getWaterComponent(n);
      if (c !== null) comps.add(c);
    }
  }
  if (comps.size === 0) return 0;
  let n = 0;
  for (const p of game.players()) {
    if (p === me || !p.canTrade(me)) continue;
    for (const port of p.units(UnitType.Port)) {
      for (const c of comps) {
        if (game.hasWaterComponent(port.tile(), c)) {
          n++;
          break;
        }
      }
    }
  }
  return n;
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

/** Sum of levels per type; `unitCount` also counts units still building, which
 * have no effect yet (maxTroops skips unfinished Cities). */
function structuresOf(p: Player, underConstruction = false): Record<BuildableUnit, number> {
  const out = {} as Record<BuildableUnit, number>;
  for (const u of BUILDABLE_UNITS) {
    let n = 0;
    for (const unit of p.units(UNIT_MAP[u])) {
      if (unit.isUnderConstruction() === underConstruction) n += underConstruction ? 1 : unit.level();
    }
    out[u] = n;
  }
  return out;
}

/** PlayerImpl.getTraitorRemainingTicks is public but not on the Player interface. */
function traitorTicksLeft(p: Player): number {
  const impl = p as unknown as { getTraitorRemainingTicks?: () => number };
  return Math.max(0, impl.getTraitorRemainingTicks?.() ?? (p.isTraitor() ? 1 : 0));
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
  const mySeas = shoreWater(game, me).comps;
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

  // How many of my border tiles touch each other player. The whole border:
  // its insertion order puts the oldest, static fronts first, so a prefix
  // misses the moving frontier; four typed-array reads per tile are cheap.
  const borderCounts = new Map<number, number>();
  const nbrs: TileRef[] = [0, 0, 0, 0];
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
      kind: kindOf(p),
      tiles: p.numTilesOwned(),
      troops: Math.round(troops),
      relation: p === me ? "neutral" : RELATION_NAMES[me.relation(p)],
      relationToMe: p === me ? "neutral" : RELATION_NAMES[p.relation(me)],
      allied: me.isAlliedWith(p),
      attackingMe: incoming.has(id),
      coastal: shoreWater(game, p).ocean,
      sharesSea: p !== me && [...shoreWater(game, p).comps].some((c) => mySeas.has(c)),
      gold: Number(p.gold()),
      maxTroops: Math.round(maxTroops),
      troopsPct: maxTroops > 0 ? Math.round((troops / maxTroops) * 100) : 0,
      traitorTicksLeft: traitorTicksLeft(p),
      betrayals: p.betrayals(),
      allies: p.allies().map((a) => a.smallID()),
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
  // The engine's timer runs from the end of the spawn phase, not from tick 0.
  return round1(Math.max(0, max - game.elapsedGameSeconds() / 60));
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

  const reachableByBoat = game
    .players()
    .filter((p) => p !== me && !neighborIds.has(p.smallID()) && p.isAlive())
    .map(view)
    .filter((v) => v.sharesSea)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 10);

  // How much room is left to expand: distinct unclaimed land tiles touching my
  // border, exact up to 2,000 (whole border scanned: a prefix reads the oldest,
  // static fronts, a stride skips a small far frontier). ≈0 = boxed in / island.
  const freeLand = new Set<TileRef>();
  const nb4: TileRef[] = [0, 0, 0, 0];
  scan: for (const b of me.borderTiles()) {
    const n = game.neighbors4(b, nb4);
    for (let i = 0; i < n; i++) {
      if (game.isLand(nb4[i]) && !game.hasOwner(nb4[i])) {
        freeLand.add(nb4[i]);
        if (freeLand.size >= 2000) break scan;
      }
    }
  }
  const freeLandAtBorder = freeLand.size;

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
  const ownShore = shoreWater(game, me).comps.size > 0;
  const partnerPorts = tradePartnerPorts(game, me);
  const aiOnMySea = game
    .players()
    .filter((p) => p !== me && p.isAlive() && p.type() !== PlayerType.Bot)
    .filter((p) => view(p).sharesSea).length;
  // Warships launch from a finished Port only (PlayerImpl.canBuildUnitType).
  const ports = me.units(UnitType.Port).filter((u) => !u.isUnderConstruction()).length;
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
        ? [ownShore, ownShore ? `on one of your coastal tiles (at:"sea"); trade pays both owners once a rival AI has a Port on this sea: ${partnerPorts} partner Port${partnerPorts === 1 ? "" : "s"} now, ${aiOnMySea} AI player${aiOnMySea === 1 ? "" : "s"}/nation${aiOnMySea === 1 ? "" : "s"} on your sea who could build one` : "needs a coastal tile you own; you have none"]
        : unit === "Warship"
          ? [ports > 0, ports > 0 ? "launched from one of your finished Ports" : "needs a finished Port; you have none"]
          : [ownsLand, "on any of your land tiles, spaced away from your other structures"];
    const note = `${affordable ? "affordable" : `need ${Number(cost) - Number(gold)} more gold`}; ${where}`;
    build[unit] = { cost: Number(cost), affordable, placeable, upgradable: Boolean(game.unitInfo(UNIT_MAP[unit]).upgradable), note };
    if (affordable && placeable) canBuild.push({ unit, cost: Number(cost) });
  }

  const silos = me.unitCount(UnitType.MissileSilo);
  const nukeCosts = {} as Record<NukeType, number>;
  const nukesAffordable: NukeType[] = [];
  for (const n of NUKE_TYPES) {
    const c = game.unitInfo(NUKE_MAP[n]).cost(game, me);
    nukeCosts[n] = Number(c);
    if (silos > 0 && c <= gold) nukesAffordable.push(n);
  }
  const nukes = { silos, costs: nukeCosts, affordable: nukesAffordable };

  const tiles = me.numTilesOwned();
  const totalLand = game.totalLandTiles();
  const tick = game.ticks();
  const cfg = game.config();
  const myMaxTroops = cfg.maxTroops(me);
  const myBox = clusterBox(game, me);
  const myStructures = structuresOf(me);
  const myUnits = me
    .units(Object.values(UNIT_MAP))
    .map((u) => ({
      id: u.id(),
      type: UNIT_NAME.get(u.type())!,
      level: u.level(),
      underConstruction: u.isUnderConstruction(),
      x: game.x(u.tile()),
      y: game.y(u.tile()),
    }))
    .sort((a, b) => Math.abs(a.x - myBox.center.x) + Math.abs(a.y - myBox.center.y) - Math.abs(b.x - myBox.center.x) - Math.abs(b.y - myBox.center.y))
    .slice(0, 40);
  const myDeltas = deltas(me, tick);
  // isImmune() is the truth; elapsedGameSeconds is the only public clock that
  // matches the engine's spawn-immunity countdown.
  const immunityTicksLeft = me.isImmune()
    ? Math.max(0, cfg.spawnImmunityDuration() - game.elapsedGameSeconds() * 10)
    : 0;

  // Alerts: the few facts that should override any plan, in severity order.
  const alerts: string[] = [];
  const incoming = me.incomingAttacks();
  const totalIncoming = incoming.reduce((s, a) => s + a.troops(), 0);
  if (incoming.length > 0) {
    const by = incoming
      .map((a) => `${a.attacker().name()} (id ${a.attacker().smallID()}, ${Math.round(a.troops())} troops)`)
      .join(", ");
    const share = me.troops() > 0 ? Math.round((totalIncoming / me.troops()) * 100) : 999;
    alerts.push(
      `UNDER ATTACK by ${by}: ${Math.round(totalIncoming)} troops incoming = ${share}% of your army. ` +
        "Options: attack back on that border, build a Defense Post there, keep troops home, ally someone else, retreat other attacks.",
    );
  }
  // Enemy boats heading for my shore (their targetTile is a tile I own; a
  // recalled boat targets its owner's shore instead).
  const incomingBoats: Obs["me"]["incomingBoats"] = [];
  for (const b of game.units(UnitType.TransportShip)) {
    const dst = b.targetTile();
    if (b.owner() === me || dst === undefined || game.owner(dst) !== me) continue;
    incomingBoats.push({ from: b.owner().smallID(), troops: Math.round(b.troops()), tilesAway: game.manhattanDist(b.tile(), dst) });
  }
  for (const b of incomingBoats) {
    const from = game.playerBySmallID(b.from);
    alerts.push(
      `BOAT INCOMING from ${from.isPlayer() ? from.name() : "?"} (id ${b.from}, ${b.troops} troops), ~${b.tilesAway} ticks out: it takes the beach tile on landing, then attacks from there. ` +
        "Keep troops home, or build(Defense Post, at:\"sea\") on that coast.",
    );
  }
  // Warheads launched at me in the last 90 s: the one threat a Defense Post
  // does nothing about (Gemini Flash took 4 bombs while building 20 posts).
  const recentNukes = (nukeLaunches.get(me.smallID()) ?? []).filter((n) => tick - n.tick <= 900);
  if (recentNukes.length > 0) {
    const byFrom = new Map<number, number>();
    for (const n of recentNukes) byFrom.set(n.from, (byFrom.get(n.from) ?? 0) + 1);
    const who = [...byFrom].map(([id, k]) => { const p = game.playerBySmallID(id) as Player | undefined; return `${p?.isPlayer() ? p.name() : "?"} (id ${id}) ×${k}`; }).join(", ");
    const sams = me.units(UnitType.SAMLauncher).length;
    alerts.unshift(
      `NUKED: ${recentNukes.length} warhead${recentNukes.length === 1 ? "" : "s"} launched at you in the last 90 s by ${who}. ` +
        `Each blast deletes every structure in its radius and turns the land to fallout. Defense Posts do nothing against nukes. ` +
        (sams > 0 ? `Your ${sams} SAM${sams === 1 ? "" : "s"} only cover 70 tiles each. ` : "You have no SAM Launcher. ") +
        "Options: build(SAM Launcher) near your Cities and Silos (1.5M, 300 ticks to finish, intercepts every warhead landing within 70 tiles); " +
        "build(Missile Silo) + nuke(them) at their structures; ally(them) (a new alliance deletes their warheads in flight).",
    );
  }
  for (const a of me.incomingAllianceRequests()) {
    alerts.push(`ALLIANCE REQUEST from ${a.requestor().name()} (id ${a.requestor().smallID()}): accept_alliance or reject_alliance before it expires.`);
  }
  for (const al of me.alliances()) {
    const left = al.expiresAt() - game.ticks();
    const other = al.other(me);
    if (left <= 300)
      alerts.push(
        `ALLIANCE with ${other.name()} (id ${other.smallID()}) expires in ${Math.max(0, left)} ticks: that border reopens both ways. ` +
          (al.agreedToExtend(me)
            ? `You asked to renew; waiting for them.`
            : al.agreedToExtend(other)
              ? `They asked to renew: extend_alliance(${other.smallID()}) seals 5 more minutes.`
              : `extend_alliance(${other.smallID()}) to renew (both must ask; tribes always agree).`),
      );
  }
  const unclaimedLandAdjacent = hasFreeLandBorder(game, me);
  if (!unclaimedLandAdjacent && freeLandAtBorder === 0)
    alerts.push("NO FREE LAND at your border: expand gains nothing; grow by attack or boat.");
  if (me.numTilesOwned() < 100)
    alerts.unshift(`ONLY ${me.numTilesOwned()} TILES: below 100, the next tile lost to any attack ends you (all land and gold to the attacker). Grow past 100 now.`);
  if (myMaxTroops > 0 && me.troops() / myMaxTroops >= 0.85)
    alerts.push(`TROOPS AT ${Math.round((me.troops() / myMaxTroops) * 100)}% OF CAP: regen is throttled; spend troops or build a City.`);

  return {
    alerts,
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
      freeLandAtBorder,
      landPct: totalLand > 0 ? round1((tiles / totalLand) * 100) : 0,
      troops: Math.round(me.troops()),
      gold: Number(gold),
      cities: myStructures.City,
      ports: myStructures.Port,
      defensePosts: myStructures["Defense Post"],
      silos: myStructures["Missile Silo"],
      boatsInFlight: me.unitCount(UnitType.TransportShip),
      allies: me.allies().map((a) => a.smallID()),
      // NationAllianceBehavior.maybeBetray: on Medium and up a nation breaks
      // with a traitor ally whose troops are under 1.2× its own.
      betrayalCascade:
        cfg.gameConfig().difficulty === "Easy"
          ? []
          : me
              .allies()
              .filter((a) => a.type() === PlayerType.Nation && me.troops() < a.troops() * 1.2)
              .map((a) => a.smallID()),
      pendingAllianceRequestsFrom: me
        .incomingAllianceRequests()
        .map((r) => r.requestor().smallID()),
      incomingAttacks: me
        .incomingAttacks()
        .map((a) => ({
          from: a.attacker().smallID(),
          troops: Math.round(a.troops()),
        })),
      incomingBoats,
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
      income: {
        baseGold: Number(cfg.goldAdditionRate(me)) * TICKS_PER_MIN,
        tradeGold: myDeltas.trade,
        trainGold: myDeltas.train,
        lootGold: Math.max(0, myDeltas.gold - Number(cfg.goldAdditionRate(me)) * TICKS_PER_MIN - myDeltas.trade - myDeltas.train),
      },
      tradePartnerPorts: partnerPorts,
      aiOnMySea,
      tilesDelta1m: myDeltas.tiles,
      immuneUntilTick:
        immunityTicksLeft > 0 ? Math.round(tick + immunityTicksLeft) : 0,
      traitorTicksLeft: traitorTicksLeft(me),
      betrayals: me.betrayals(),
      allianceExpiry: me.alliances().map((a) => ({
        id: a.other(me).smallID(),
        ticksLeft: a.expiresAt() - tick,
        theyAgreedToExtend: a.agreedToExtend(a.other(me)),
        iAgreedToExtend: a.agreedToExtend(me),
      })),
      pendingRequestExpiry: me.incomingAllianceRequests().map((r) => ({
        id: r.requestor().smallID(),
        ticksLeft: r.createdAt() + cfg.allianceRequestDuration() - tick,
      })),
      structures: myStructures,
      underConstruction: structuresOf(me, true),
      units: myUnits,
      center: myBox.center,
      bbox: myBox.bbox,
    },
    neighbors,
    unclaimedLandAdjacent,
    reachableByBoat,
    leaderboard,
    canBuild,
    buildCosts,
    build,
    nukes,
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

/** Why canAttackPlayer(t) is false, and what to do instead. */
function blockedReason(game: Game, me: Player, t: Player): string {
  if (me.isAlliedWith(t)) return `${t.smallID()} is your ally; break_alliance first if you want to attack`;
  const left = Math.max(1, Math.round(game.config().spawnImmunityDuration() - game.elapsedGameSeconds() * 10));
  return `${t.smallID()} is under spawn immunity for ${left} more ticks (AI seats and nations; tribes are attackable now)`;
}

/** Result of translating one action: either an intent to send, or a drop reason. */
type Translated = { intent: Intent } | { intents: Intent[] } | { reason: string };

function translate(game: Game, me: Player, action: Action): Translated {
  switch (action.type) {
    case "expand": {
      if (!hasFreeLandBorder(game, me)) {
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
      if (!me.canAttackPlayer(t)) return { reason: blockedReason(game, me, t) };
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
      if (t === me) return { reason: "you cannot boat yourself" };
      if (!me.canAttackPlayer(t)) return { reason: blockedReason(game, me, t) };
      const boats = me.units(UnitType.TransportShip);
      if (boats.length >= game.config().boatMaxNumber()) {
        const eta = Math.min(...boats.map((b) => (b.targetTile() === undefined ? 0 : game.manhattanDist(b.tile(), b.targetTile()!))));
        return { reason: `already ${boats.length} boats at sea (the cap); the first lands in ~${eta} ticks` };
      }
      // Landing tile: their shore tile on a water body my shore touches, nearest
      // my centre (the engine's closestReachableShore takes it as is); the
      // engine's own AI does the same with closestTwoTiles. Up to three
      // candidates are checked for a water route.
      const mySeas = shoreWater(game, me).comps;
      const center = clusterBox(game, me).center;
      const border = t.borderTiles();
      const stride = Math.max(1, Math.floor(border.size / 300));
      const candidates: TileRef[] = [];
      let i = 0;
      for (const tile of border) {
        if (i++ % stride !== 0 || !game.isShore(tile)) continue;
        const c = game.getWaterComponent(tile);
        if (c !== null && mySeas.has(c)) candidates.push(tile);
      }
      if (candidates.length === 0)
        return { reason: `target ${action.target} has no shore on a water body you touch; pick an id whose sharesSea is true (reachableByBoat lists the nearest)` };
      const away = (tile: TileRef) => Math.abs(game.x(tile) - center.x) + Math.abs(game.y(tile) - center.y);
      candidates.sort((a, b) => away(a) - away(b));
      const dst = candidates.slice(0, 3).find((tile) => me.bestTransportShipSpawn(tile) !== false);
      if (dst === undefined)
        return { reason: `no sea route from your coast to target ${action.target}; try another id in reachableByBoat` };
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
        // PlayerImpl.canSendAllianceRequest, in its order of checks.
        if (!t.isAlive()) return { reason: `${action.target} is dead` };
        if (me.isAlliedWith(t)) return { reason: `you are already allied with ${action.target}` };
        const pending = me.outgoingAllianceRequests().find((r) => r.recipient() === t);
        if (pending !== undefined)
          return { reason: `your offer to ${action.target} is still pending for ${pending.createdAt() + game.config().allianceRequestDuration() - game.ticks()} more ticks; they must accept it` };
        const past = (me as unknown as { pastOutgoingAllianceRequests?: { recipient(): Player; createdAt(): number }[] }).pastOutgoingAllianceRequests ?? [];
        const last = past.filter((r) => r.recipient() === t).reduce((m, r) => Math.max(m, r.createdAt()), -Infinity);
        const wait = last + game.config().allianceRequestCooldown() - game.ticks();
        return { reason: wait > 0 ? `${action.target} declined or ignored your last offer; you can ask again in ${wait} ticks` : `cannot send an alliance request to ${action.target} right now (disconnected?)` };
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

    case "extend_alliance": {
      // AllianceExtensionExecution: each side flags its intent; when both have,
      // expiry resets to now + allianceDuration. No time window is enforced.
      const t = resolveTarget(game, action.target);
      if (!t) return { reason: `target ${action.target} does not exist` };
      const al = me.allianceWith(t);
      if (al === null)
        return { reason: `you are not allied with ${action.target}; ally(${action.target}) first` };
      if (al.agreedToExtend(me))
        return { reason: `you already asked ${action.target} to renew; it renews when they call extend_alliance too` };
      return { intent: { type: "allianceExtension", recipient: t.id() } };
    }

    case "donate": {
      // DonateTroops/GoldExecution: allies only (canDonate* = isFriendly), one
      // donation per recipient per donateCooldown (100 ticks) for gold and
      // troops together; troops capped at the recipient's free cap room, gold
      // and troops at what I hold (removeGold/removeTroops clamp).
      const t = resolveTarget(game, action.target);
      if (!t) return { reason: `target ${action.target} does not exist` };
      // Strict tool schemas make some models fill the unused field with 1
      // (GPT Luna: troops 300000, gold 1, eleven times): ≤1 means "not this one".
      const troops = (action.troops ?? 0) > 1 ? action.troops! : 0;
      const gold = (action.gold ?? 0) > 1 ? action.gold! : 0;
      if (troops > 0 && gold > 0)
        return { reason: "one gift per call: donate troops OR gold, not both (they share a 100-tick cooldown)" };
      if (troops === 0 && gold === 0)
        return { reason: "donate needs troops or gold, a whole number above 1" };
      if (!me.isAlliedWith(t))
        return { reason: `${action.target} is not your ally; donations go to allies only` };
      if (troops > 0 ? !me.canDonateTroops(t) : !me.canDonateGold(t))
        return { reason: `cannot donate to ${action.target} now: one donation per ally per 100 ticks (10 s), gold and troops share the cooldown` };
      if (troops > 0) {
        const room = Math.floor(game.config().maxTroops(t) - t.troops());
        if (room <= 0) return { reason: `${action.target} is at their troop cap; troops would be wasted` };
        const give = Math.min(troops, Math.floor(me.troops()), room);
        if (give <= 0) return { reason: "you have no troops to give" };
        return { intent: { type: "donate_troops", recipient: t.id(), troops: give } };
      }
      return { intent: { type: "donate_gold", recipient: t.id(), gold: Math.min(gold, Number(me.gold())) } };
    }

    case "recall_boats": {
      // cancel_boat -> BoatRetreatExecution: the boat sails back to my nearest
      // shore and lands 75% of its troops (malusForRetreat 25).
      const t = action.target === undefined ? null : resolveTarget(game, action.target);
      if (action.target !== undefined && !t)
        return { reason: `target ${action.target} does not exist` };
      const ids = me
        .units(UnitType.TransportShip)
        .filter((b) => {
          if (b.transportShipState().isRetreating) return false;
          if (t === null) return true;
          const dst = b.targetTile();
          return dst !== undefined && game.owner(dst) === t;
        })
        .map((b) => b.id());
      if (ids.length === 0)
        return { reason: t === null ? "you have no boat at sea" : `no boat of yours is sailing at ${action.target}; recall_boats() with no target recalls every boat` };
      return { intents: ids.map((unitID) => ({ type: "cancel_boat", unitID })) };
    }

    case "embargo": {
      // EmbargoExecution: a permanent embargo (isTemporary false) stops trade
      // ships both ways until I lift it; the 5-min one after an attack is the
      // engine's. Nations read it as −20 relation while it stands.
      const t = resolveTarget(game, action.target);
      if (!t) return { reason: `target ${action.target} does not exist` };
      if (t === me) return { reason: "you cannot embargo yourself" };
      const has = me.hasEmbargoAgainst(t);
      if (action.stop && !has) return { reason: `you have no embargo on ${action.target}` };
      if (!action.stop && has) return { reason: `you already embargo ${action.target}` };
      return { intent: { type: "embargo", targetID: t.id(), action: action.stop ? "stop" : "start" } };
    }

    case "move_warship": {
      // MoveWarshipExecution: sets the patrol centre; ignored when the tile is
      // not on the ship's water body.
      if (action.id === undefined || action.x === undefined || action.y === undefined)
        return { reason: "move_warship needs id, x and y" };
      const ship = me.units(UnitType.Warship).find((u) => u.id() === action.id);
      if (ship === undefined)
        return { reason: `no Warship of yours has id ${action.id}; Warship ids are in me.units` };
      if (!game.isValidCoord(action.x, action.y)) return { reason: `(${action.x},${action.y}) is off the map` };
      const tile = game.ref(action.x, action.y);
      if (!game.isWater(tile)) return { reason: `(${action.x},${action.y}) is land; a patrol point must be water` };
      const comp = game.getWaterComponent(tile);
      if (comp === null || !game.hasWaterComponent(ship.tile(), comp))
        return { reason: `(${action.x},${action.y}) is on another water body; the ship cannot reach it` };
      return { intent: { type: "move_warship", unitIds: [ship.id()], tile } };
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
      // Sample ~200 tiles spread over the whole pool: the first tiles of a
      // territory sit around the spawn where structures already crowd each other.
      const n = "size" in pool ? pool.size : pool.length;
      const stride = Math.max(1, Math.floor(n / 200));
      // Placement target: `at` = a player id (the border facing them) or "sea"
      // (own coast). A Defense Post covers 30 tiles (defensePostRange), so the
      // best tile is the one with the most of that front within range; other
      // structures go to the candidate nearest that front.
      const facing = action.at === undefined ? undefined : action.at === "sea" ? null : resolveTarget(game, action.at);
      if (action.at !== undefined && action.at !== "sea" && facing === undefined)
        return { reason: `at=${action.at} is not a visible player id` };
      const frontTiles: TileRef[] = [];
      if (facing !== undefined) {
        let scanned = 0;
        for (const b of me.borderTiles()) {
          for (const nb of game.neighbors(b)) {
            if (facing === null ? game.isWater(nb) : game.owner(nb) === facing) {
              frontTiles.push(b);
              break;
            }
          }
          if (++scanned >= 3000) break;
        }
        if (frontTiles.length === 0)
          return { reason: facing === null ? "you own no coastal tile" : `you share no border with ${action.at}` };
      }
      const range = unitType === UnitType.DefensePost ? game.config().defensePostRange() : 0;
      const score = (t: TileRef): number => {
        if (frontTiles.length === 0) return 0;
        if (range > 0) {
          let covered = 0;
          for (const f of frontTiles) if (game.manhattanDist(t, f) <= range) covered++;
          return covered;
        }
        let best = Infinity;
        for (const f of frontTiles) best = Math.min(best, game.manhattanDist(t, f));
        return -best;
      };
      let tile: TileRef | undefined;
      let bestScore = -Infinity;
      let i = 0;
      for (const t of pool) {
        if (i++ % stride !== 0) continue;
        if (me.canBuild(unitType, t) === false) continue;
        if (frontTiles.length === 0) {
          tile = t;
          break;
        }
        const sc = score(t);
        if (sc > bestScore) {
          bestScore = sc;
          tile = t;
        }
      }
      if (tile === undefined)
        return {
          reason:
            unitType === UnitType.Port
              ? "Port needs a coastal tile you own; none of your shore tiles is at least 15 tiles from your other structures"
              : unitType === UnitType.Warship
                ? "Warship needs a finished Port of yours"
                : `no tile for ${action.unit}: every structure needs 15 tiles from your other structures; grow, or upgrade(${JSON.stringify(action.unit)}) instead`,
        };
      return { intent: { type: "build_unit", unit: unitType, tile } };
    }

    case "upgrade": {
      // UpgradeStructureExecution -> canUpgradeUnit: type upgradable, gold >=
      // the next-unit price of that type, unit finished and mine. Instant.
      if (action.unit === undefined) return { reason: "upgrade needs a unit type" };
      const unitType = UNIT_MAP[action.unit];
      if (!game.unitInfo(unitType).upgradable)
        return { reason: `${action.unit} cannot be upgraded; build another one instead` };
      const mine = me.units(unitType);
      if (mine.length === 0) return { reason: `you have no ${action.unit}; build one first` };
      const u =
        action.id === undefined
          ? mine.filter((x) => !x.isUnderConstruction()).sort((a, b) => a.level() - b.level())[0]
          : mine.find((x) => x.id() === action.id);
      if (u === undefined)
        return {
          reason:
            action.id === undefined
              ? `every ${action.unit} of yours is still under construction; wait for it to finish`
              : `id ${action.id} is not one of your ${action.unit}s; ids are in me.units`,
        };
      if (u.isUnderConstruction())
        return { reason: `${action.unit} ${u.id()} is still under construction; wait for it to finish` };
      const cost = Number(game.unitInfo(unitType).cost(game, me));
      if (Number(me.gold()) < cost)
        return { reason: `upgrading ${action.unit} costs ${cost} (the next-unit price); you have ${Number(me.gold())}` };
      if (!me.canUpgradeUnit(u)) return { reason: `${action.unit} ${u.id()} cannot be upgraded right now` };
      return { intent: { type: "upgrade_structure", unit: unitType, unitId: u.id() } };
    }

    case "retreat": {
      // Cancel running attacks: against one target, or all of them when no target
      // is given. Survivors walk home; the engine keeps 25% as the malus when the
      // target is a player, nothing when it was unclaimed land.
      const t = action.target === undefined ? null : resolveTarget(game, action.target);
      if (action.target !== undefined && !t)
        return { reason: `target ${action.target} does not exist` };
      // A model "retreats from X" meaning either its own attack on X or X's
      // attack on it. Only its own attacks can be cancelled; say so plainly.
      const ids = me
        .outgoingAttacks()
        .filter((a) => !a.retreating() && (t === null || a.target() === t))
        .map((a) => a.id());
      if (ids.length === 0) {
        const attackedByT = t !== null && me.incomingAttacks().some((a) => a.attacker() === t);
        return {
          reason:
            t === null
              ? "you have no attack running"
              : attackedByT
                ? `${action.target} is attacking YOU; retreat only cancels your own attacks. To defend: keep troops home, build(Defense Post, at:${action.target}) or attack(${action.target}) to counter`
                : `no attack of yours is running against ${action.target}`,
        };
      }
      return { intents: ids.map((attackID) => ({ type: "cancel_attack", attackID })) };
    }

    case "nuke": {
      if (action.nuke === undefined) return { reason: "nuke needs a warhead type" };
      const t = resolveTarget(game, action.target);
      if (!t) return { reason: `target ${action.target} does not exist` };
      if (!t.isAlive()) return { reason: `target ${action.target} is no longer alive` };
      if (me.isAlliedWith(t))
        return { reason: `target ${action.target} is your ally; break_alliance first` };
      if (me.unitCount(UnitType.MissileSilo) === 0)
        return { reason: "you have no Missile Silo; build one first" };
      // Aim: the tile of theirs closest to the middle of their territory is the
      // fallback; each of their structures is a candidate too, scored by the
      // structures the blast would delete (a City is their cap, a Silo their
      // nukes) plus the tiles it strips, minus candidates that hit my own
      // tiles or an ally (NukeExecution deletes EVERY owner's units in the
      // outer radius; listNukeBreakAlliance breaks alliances hit).
      const box = t.largestClusterBoundingBox;
      const cx = box ? (box.min.x + box.max.x) / 2 : null;
      const cy = box ? (box.min.y + box.max.y) / 2 : null;
      let center: TileRef | undefined;
      let bestD = Infinity;
      let k = 0;
      const total = t.numTilesOwned();
      const step = Math.max(1, Math.floor(total / 400));
      for (const tile of t.tiles()) {
        if (k++ % step !== 0) continue;
        const d = cx === null ? 0 : Math.abs(game.x(tile) - cx) + Math.abs(game.y(tile) - (cy as number));
        if (d < bestD) {
          bestD = d;
          center = tile;
          if (cx === null) break;
        }
      }
      if (center === undefined) return { reason: `target ${action.target} owns no land` };
      const unitType = NUKE_MAP[action.nuke];
      let best: TileRef = center;
      // MIRV has no single magnitude: its 350 warheads spread over the
      // target's land, so only the ally check applies and it aims at the middle.
      if (unitType !== UnitType.MIRV) {
        const magnitude = game.config().nukeMagnitudes(unitType);
        const theirUnits = t.units(Object.values(UNIT_MAP));
        const allySmallIds = new Set(me.allies().map((a) => a.smallID()));
        const threshold = game.config().nukeAllianceBreakThreshold();
        const candidates = [center, ...theirUnits.slice(0, 30).map((u) => u.tile())];
        let bestScore = -Infinity;
        let ownAtCenter = 0;
        for (const tile of candidates) {
          const counts = computeNukeBlastCounts({ gm: game, targetTile: tile, magnitude });
          const own = counts.get(me.smallID()) ?? 0;
          if (tile === center) ownAtCenter = own;
          if (own > 0) continue;
          if (wouldNukeBreakAlliance({ game, targetTile: tile, magnitude, allySmallIds, threshold })) continue;
          const r2 = magnitude.outer * magnitude.outer;
          const structures = theirUnits.filter((u) => game.euclideanDistSquared(u.tile(), tile) <= r2).length;
          const score = structures * 200 + (counts.get(t.smallID()) ?? 0);
          if (score > bestScore) {
            bestScore = score;
            best = tile;
          }
        }
        if (bestScore === -Infinity)
          return {
            reason:
              ownAtCenter > 0
                ? `every ${action.nuke} aim point on ${action.target} (${magnitude.outer}-tile radius) would cover your own tiles (~${Math.ceil(ownAtCenter)} at their middle) or an ally; nuke a target farther from your border`
                : `every ${action.nuke} aim point on ${action.target} would hit an ally's land or structures and break that alliance (traitor mark); pick another target or break_alliance first`,
          };
      } else if (me.isAlliedWith(t)) {
        return { reason: `target ${action.target} is your ally; break_alliance first` };
      }
      if (me.canBuild(unitType, best) === false)
        return {
          reason: `cannot launch ${action.nuke} now (need ${Number(game.unitInfo(unitType).cost(game, me))} gold, a ready silo, and a target outside spawn immunity)`,
        };
      return { intent: { type: "build_unit", unit: unitType, tile: best } };
    }

    case "emoji": {
      if (action.emoji === undefined)
        return { reason: "emoji needs an emoji character" };
      const idx = flattenedEmojiTable.indexOf(
        action.emoji as (typeof flattenedEmojiTable)[number],
      );
      if (idx === -1)
        return { reason: `"${action.emoji}" is not a supported emoji` };
      const t = action.target === undefined ? AllPlayers : resolveTarget(game, action.target);
      if (t === undefined) return { reason: `target ${action.target} does not exist` };
      if (!me.canSendEmoji(t))
        return { reason: `emoji cooldown: one per recipient every ${game.config().emojiMessageCooldown()} ticks (the engine drops extras silently)` };
      return { intent: { type: "emoji", recipient: t === AllPlayers ? AllPlayers : t.id(), emoji: idx } };
    }

    case "chat": {
      if (action.key === undefined) return { reason: "chat needs a key" };
      if (!QuickChatKeySchema.safeParse(action.key).success) {
        return { reason: `"${action.key}" is not a valid quick chat key` };
      }
      if (action.target === undefined) return { reason: "chat needs a target" };
      const t = resolveTarget(game, action.target);
      if (!t) return { reason: `target ${action.target} does not exist` };
      if (!me.canSendQuickChat(t))
        return { reason: `chat cooldown: one per recipient every ${game.config().quickChatCooldown()} ticks (the engine drops extras silently)` };
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
      } else if ("intents" in result) {
        intents.push(...result.intents);
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
