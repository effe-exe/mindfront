import { observe, toIntents, trackHistory } from "../../arena/observe";
import { PlayerCtx, RATIO_MAX } from "../../arena/types";
import { Game, Player, PlayerType, UnitType } from "../../src/core/game/Game";
import { playerInfo, setup } from "../util/Setup";

let game: Game;
let player1: Player;
let player2: Player;

function ctx(forPlayer: Player = player1): PlayerCtx {
  return {
    model: "test/model",
    name: "Tester",
    persona: "",
    clientID: "client1",
    playerID: forPlayer.id(),
    notes: "",
    lastResult: "",
    latencyEma: 0,
    intervalTicks: 50,
    pending: false,
    consecutiveDrops: 0,
  };
}

describe("arena/observe", () => {
  beforeEach(async () => {
    game = await setup(
      "plains",
      { infiniteGold: true, instantBuild: true, infiniteTroops: true },
      [
        playerInfo("player1", PlayerType.Human),
        playerInfo("player2", PlayerType.Human),
      ],
    );

    player1 = game.player("player1");
    player2 = game.player("player2");

    // Two separate blobs, far apart, so they never share a border.
    for (let x = 10; x <= 12; x++) {
      for (let y = 10; y <= 12; y++) {
        player1.conquer(game.ref(x, y));
      }
    }
    for (let x = 60; x <= 62; x++) {
      for (let y = 60; y <= 62; y++) {
        player2.conquer(game.ref(x, y));
      }
    }
  });

  test("observe returns the documented shape", () => {
    const obs = observe(game, player1, ctx(), []);

    expect(obs.me.tiles).toBeGreaterThan(0);
    expect(obs.unclaimedLandAdjacent).toBe(true);
    expect(obs.leaderboard.length).toBeGreaterThan(0);
    expect(obs.leaderboard.some((l) => l.id === player1.smallID())).toBe(true);
    expect(obs.me.id).toBe(player1.smallID());
    expect(obs.me.troops).toBeGreaterThan(0);
  });

  test("reports the P4 completeness fields after some ticks and a conquer", () => {
    for (let i = 0; i < 5; i++) game.executeNextTick();
    player1.conquer(game.ref(13, 11));
    const obs = observe(game, player1, ctx(), ["mine"], ["theirs"]);

    expect(obs.game.totalLandTiles).toBeGreaterThan(0);
    expect(obs.game.mapWidth).toBe(game.width());
    expect(obs.globalEvents).toEqual(["theirs"]);

    const me = obs.me;
    expect(me.maxTroops).toBeGreaterThan(0);
    expect(me.troopsPct).toBeGreaterThanOrEqual(0);
    expect(me.troopsPct).toBeLessThanOrEqual(100);
    expect(me.isTraitor).toBe(false);
    expect(me.betrayals).toBe(0);
    expect(me.allianceExpiry).toEqual([]);
    expect(me.pendingRequestExpiry).toEqual([]);
    expect(me.immuneUntilTick).toBeGreaterThanOrEqual(0);
    expect(me.structures.City).toBe(0);
    expect(me.center.x).toBeGreaterThanOrEqual(me.bbox.minX);
    expect(me.center.x).toBeLessThanOrEqual(me.bbox.maxX);
    expect(me.tiles).toBe(10);
  });

  test("gives direction and distance from me to the other human", () => {
    const obs = observe(game, player1, ctx(), []);
    const other = obs.leaderboard.find((l) => l.id === player2.smallID());

    // player1 sits around (11,11), player2 around (61,61): south-east, 100 apart.
    expect(other).toBeDefined();
    expect(other!.direction).toBe("SE");
    expect(other!.distance).toBe(100);
    expect(other!.maxTroops).toBeGreaterThan(0);
    expect(other!.allies).toEqual([]);
    expect(other!.attackedBy).toEqual([]);
    expect(other!.sharedBorderTiles).toBe(0);
    expect(other!.structures.Port).toBe(0);
  });

  test("trackHistory twice makes tilesDelta1m reflect growth", () => {
    trackHistory(game);
    for (let i = 0; i < 20; i++) game.executeNextTick();
    for (let y = 10; y <= 12; y++) player1.conquer(game.ref(13, y));
    trackHistory(game);

    const obs = observe(game, player1, ctx(), []);
    expect(obs.me.tilesDelta1m).toBeGreaterThan(0);
    expect(
      obs.leaderboard.find((l) => l.id === player2.smallID())!.tilesDelta1m,
    ).toBe(0);
  });

  test("an enemy boat sailing at my land shows in incomingBoats and alerts", () => {
    player2.buildUnit(UnitType.TransportShip, game.ref(60, 60), {
      troops: 700,
      targetTile: game.ref(11, 11),
    });
    // a recalled boat (target = its owner's own shore) is not incoming
    player2.buildUnit(UnitType.TransportShip, game.ref(61, 61), {
      troops: 5,
      targetTile: game.ref(60, 60),
    });
    const obs = observe(game, player1, ctx(), []);
    expect(obs.me.incomingBoats).toEqual([
      { from: player2.smallID(), troops: 700, tilesAway: 98 },
    ]);
    expect(obs.alerts.some((a) => /BOAT INCOMING/.test(a) && /700 troops/.test(a))).toBe(true);
    expect(observe(game, player2, ctx(player2), []).me.incomingBoats).toEqual([]);
  });

  test("nuke is refused while the blast would cover my own tiles", () => {
    player1.buildUnit(UnitType.MissileSilo, game.ref(11, 11), {});
    // TestConfig blast radius is 1: a target tile next to mine hits my land
    for (let x = 60; x <= 62; x++) for (let y = 60; y <= 62; y++) player2.relinquish(game.ref(x, y));
    player2.conquer(game.ref(13, 11));
    const obs = observe(game, player1, ctx(), []);
    expect(obs.nukes.affordable).toContain("Atom Bomb");
    const launch = () =>
      toIntents(game, player1, obs, { reasoning: "", notes: "", actions: [{ type: "nuke", target: player2.smallID(), nuke: "Atom Bomb" }] }, ctx());
    expect(launch().dropped[0].reason).toMatch(/your own tiles/);
    player2.relinquish(game.ref(13, 11));
    player2.conquer(game.ref(61, 61));
    expect(launch().intents[0]).toMatchObject({ type: "build_unit", unit: UnitType.AtomBomb, tile: game.ref(61, 61) });
  });

  test("drops an attack on a non-bordering player with a reason", () => {
    const obs = observe(game, player1, ctx(), []);
    expect(player1.sharesBorderWith(player2)).toBe(false);

    const result = toIntents(
      game,
      player1,
      obs,
      {
        reasoning: "test",
        notes: "",
        actions: [{ type: "attack", target: player2.smallID(), ratio: 0.3 }],
      },
      ctx(),
    );

    expect(result.intents).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].reason).toMatch(/border/);
  });

  test("drops an invented target id", () => {
    const obs = observe(game, player1, ctx(), []);

    const result = toIntents(
      game,
      player1,
      obs,
      {
        reasoning: "test",
        notes: "",
        actions: [{ type: "attack", target: 9999, ratio: 0.3 }],
      },
      ctx(),
    );

    expect(result.intents).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].reason).toMatch(/does not exist/);
  });

  test("clamps ratio to RATIO_MAX", () => {
    const obs = observe(game, player1, ctx(), []);

    const result = toIntents(
      game,
      player1,
      obs,
      { reasoning: "test", notes: "", actions: [{ type: "expand", ratio: 5 }] },
      ctx(),
    );

    expect(result.intents).toHaveLength(1);
    const intent = result.intents[0] as {
      type: "attack";
      targetID: null;
      troops: number;
    };
    expect(intent.troops).toBe(Math.floor(player1.troops() * RATIO_MAX));
  });

  test("translates expand into an attack intent with targetID null and positive troops", () => {
    const obs = observe(game, player1, ctx(), []);

    const result = toIntents(
      game,
      player1,
      obs,
      { reasoning: "test", notes: "", actions: [{ type: "expand" }] },
      ctx(),
    );

    expect(result.intents).toHaveLength(1);
    const intent = result.intents[0] as {
      type: string;
      targetID: null;
      troops: number;
    };
    expect(intent.type).toBe("attack");
    expect(intent.targetID).toBeNull();
    expect(intent.troops).toBeGreaterThan(0);
  });

  test("no per-turn caps: two expands both become intents", () => {
    const obs = observe(game, player1, ctx(), []);

    const result = toIntents(
      game,
      player1,
      obs,
      {
        reasoning: "test",
        notes: "",
        actions: [{ type: "expand" }, { type: "expand" }],
      },
      ctx(),
    );

    expect(result.intents).toHaveLength(2);
    expect(result.dropped).toHaveLength(0);
  });
});

describe("arena/observe border scans", () => {
  test("free land on the newest front and a long static front are both counted", async () => {
    const g = await setup("big_plains", { infiniteGold: true, instantBuild: true }, [
      playerInfo("player1", PlayerType.Human),
      playerInfo("player2", PlayerType.Human),
    ]);
    const p1 = g.player("player1");
    const p2 = g.player("player2");
    // player2: a frame on the north, west and east edges (200x200 map)
    for (let x = 0; x < 200; x++) for (let y = 0; y < 2; y++) p2.conquer(g.ref(x, y));
    for (let y = 2; y < 200; y++) {
      p2.conquer(g.ref(0, y));
      p2.conquer(g.ref(199, y));
    }
    // player1 fills rows 2..119 inside the frame, row by row: the tiles touching
    // player2 enter the border set first, the free front (row 119) last, and the
    // border is ~800 tiles, more than the old 600-tile prefix scan.
    for (let y = 2; y < 120; y++) for (let x = 1; x < 199; x++) p1.conquer(g.ref(x, y));
    expect(p1.borderTiles().size).toBeGreaterThan(600);

    const obs = observe(g, p1, ctx(p1), []);
    expect(obs.me.freeLandAtBorder).toBe(198);
    expect(obs.unclaimedLandAdjacent).toBe(true);
    const n = obs.neighbors.find((x) => x.id === p2.smallID())!;
    expect(n.sharedBorderTiles).toBe(198 + 118 + 118 - 2); // corner tiles count once
  });
});

describe("arena/observe trade partners", () => {
  test("tradePartnerPorts counts another player's Port on my water", async () => {
    const g = await setup(
      "half_land_half_ocean",
      { infiniteGold: true, instantBuild: true, infiniteTroops: true },
      [playerInfo("player1", PlayerType.Human), playerInfo("player2", PlayerType.Human)],
    );
    const p1 = g.player("player1");
    const p2 = g.player("player2");
    // 16x16 map, land on the left half: two coastal blobs on rows 2 and 12
    const coast =
      [...Array(g.width()).keys()].find((x) => g.isWater(g.ref(x, 2)))! - 1;
    for (let x = coast - 2; x <= coast; x++) p1.conquer(g.ref(x, 2));
    for (let x = coast - 2; x <= coast; x++) p2.conquer(g.ref(x, 12));
    p1.buildUnit(UnitType.Port, g.ref(coast, 2), {});

    let obs = observe(g, p1, ctx(p1), []);
    expect(obs.me.tradePartnerPorts).toBe(0);
    expect(obs.build.Port.note).toMatch(/0 such Ports/);
    expect(obs.me.income.baseGold).toBeGreaterThan(0);
    expect(obs.me.income.tradeGold).toBe(0);

    p2.buildUnit(UnitType.Port, g.ref(coast, 12), {});
    obs = observe(g, p1, ctx(p1), []);
    expect(obs.me.tradePartnerPorts).toBe(1);
    // a player without a Port still learns whether one would pay
    expect(observe(g, p2, ctx(p2), []).me.tradePartnerPorts).toBe(1);
  });
});

describe("arena/observe boats", () => {
  test("sharesSea gates boat targets; the boat lands on the target's shore", async () => {
    const g = await setup(
      "half_land_half_ocean",
      { infiniteGold: true, instantBuild: true, infiniteTroops: true },
      [
        playerInfo("player1", PlayerType.Human),
        playerInfo("player2", PlayerType.Human),
        playerInfo("player3", PlayerType.Human),
      ],
    );
    const p1 = g.player("player1");
    const p2 = g.player("player2");
    const p3 = g.player("player3");
    const coast =
      [...Array(g.width()).keys()].find((x) => g.isWater(g.ref(x, 2)))! - 1;
    for (let x = coast - 2; x <= coast; x++) p1.conquer(g.ref(x, 2));
    for (let x = coast - 2; x <= coast; x++) p2.conquer(g.ref(x, 12));
    for (let x = 1; x <= 3; x++) p3.conquer(g.ref(x, 7)); // inland
    for (let i = 0; i < 2; i++) g.executeNextTick();

    const obs = observe(g, p1, ctx(p1), []);
    const v2 = obs.leaderboard.find((v) => v.id === p2.smallID())!;
    const v3 = obs.leaderboard.find((v) => v.id === p3.smallID())!;
    expect(v2.coastal).toBe(true);
    expect(v2.sharesSea).toBe(true);
    expect(v3.coastal).toBe(false);
    expect(v3.sharesSea).toBe(false);
    expect(obs.reachableByBoat.map((v) => v.id)).toEqual([p2.smallID()]);

    const decide = (target: number) =>
      toIntents(g, p1, obs, { reasoning: "", notes: "", actions: [{ type: "boat", target, ratio: 0.3 }] }, ctx(p1));
    expect(decide(p3.smallID()).dropped[0].reason).toMatch(/no shore on a water body/);
    const ok = decide(p2.smallID());
    expect(ok.dropped).toEqual([]);
    const intent = ok.intents[0] as { type: string; dst: number; troops: number };
    expect(intent.type).toBe("boat");
    expect(g.owner(intent.dst)).toBe(p2);
    expect(g.isShore(intent.dst)).toBe(true);
    expect(intent.troops).toBeGreaterThan(0);
  });
});

describe("arena/observe build Warship", () => {
  test("translates build Warship into a build_unit intent on water near a Port", async () => {
    const g = await setup(
      "half_land_half_ocean",
      {
        infiniteGold: true,
        instantBuild: true,
        infiniteTroops: true,
      },
      [playerInfo("player1", PlayerType.Human)],
    );
    const p = g.player("player1");
    // half_land_half_ocean: land on the left, ocean on the right.
    const coast =
      [...Array(g.width()).keys()].find((x) => g.isWater(g.ref(x, 10)))! - 1;
    for (let x = coast - 2; x <= coast; x++) p.conquer(g.ref(x, 10));
    p.buildUnit(UnitType.Port, g.ref(coast, 10), {});

    const obs = observe(g, p, ctx(p), []);
    expect(obs.canBuild.some((b) => b.unit === "Warship")).toBe(true);
    const result = toIntents(
      g,
      p,
      obs,
      {
        reasoning: "test",
        notes: "",
        actions: [{ type: "build", unit: "Warship" }],
      },
      ctx(p),
    );
    expect(result.dropped).toHaveLength(0);
    const intent = result.intents[0] as {
      type: string;
      unit: string;
      tile: number;
    };
    expect(intent.type).toBe("build_unit");
    expect(intent.unit).toBe(UnitType.Warship);
    expect(g.isWater(intent.tile)).toBe(true);
  });
});
