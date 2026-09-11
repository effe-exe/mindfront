import { observe, toIntents } from "../../arena/observe";
import { PlayerCtx, RATIO_MAX } from "../../arena/types";
import { Game, Player, PlayerType } from "../../src/core/game/Game";
import { playerInfo, setup } from "../util/Setup";

let game: Game;
let player1: Player;
let player2: Player;

function ctx(): PlayerCtx {
  return {
    model: "test/model",
    name: "Tester",
    persona: "",
    clientID: "client1",
    playerID: player1.id(),
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
      [playerInfo("player1", PlayerType.Human), playerInfo("player2", PlayerType.Human)],
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

  test("drops an attack on a non-bordering player with a reason", () => {
    const obs = observe(game, player1, ctx(), []);
    expect(player1.sharesBorderWith(player2)).toBe(false);

    const result = toIntents(
      game,
      player1,
      obs,
      { reasoning: "test", notes: "", actions: [{ type: "attack", target: player2.smallID(), ratio: 0.3 }] },
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
      { reasoning: "test", notes: "", actions: [{ type: "attack", target: 9999, ratio: 0.3 }] },
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
    const intent = result.intents[0] as { type: "attack"; targetID: null; troops: number };
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
    const intent = result.intents[0] as { type: string; targetID: null; troops: number };
    expect(intent.type).toBe("attack");
    expect(intent.targetID).toBeNull();
    expect(intent.troops).toBeGreaterThan(0);
  });

  test("caps two move actions (attack/expand/boat) to one per decision", () => {
    const obs = observe(game, player1, ctx(), []);

    const result = toIntents(
      game,
      player1,
      obs,
      { reasoning: "test", notes: "", actions: [{ type: "expand" }, { type: "expand" }] },
      ctx(),
    );

    expect(result.intents).toHaveLength(1);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].reason).toMatch(/only one/);
  });
});
