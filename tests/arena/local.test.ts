import { describe, expect, it } from "vitest";
import { compactObs } from "../../arena/local/prompt";

// The trained seat's observation must be the same at training and inference:
// constant-in-training keys gone, tails cut, own recent calls appended last.
describe("compactObs", () => {
  it("drops training-constant keys, trims tails, appends recent actions", () => {
    const obs = {
      alerts: ["x"],
      tick: 700,
      game: { tick: 700 },
      me: { id: 1, team: null, tiles: 10, structures: { City: 1, Port: 0 }, units: Array.from({ length: 9 }, (_, i) => ({ id: i, type: "City", level: i === 0 ? 2 : 1, underConstruction: false, x: i, y: i })), bbox: {}, center: {} },
      neighbors: Array.from({ length: 10 }, (_, i) => ({ id: i, relation: "neutral", relationToMe: "neutral", teammate: false, distance: 3, structures: { City: 0 } })),
      reachableByBoat: Array.from({ length: 5 }, (_, i) => ({ id: i, name: "n", sharesSea: true, tilesDelta1m: 1 })),
      leaderboard: Array.from({ length: 5 }, (_, i) => ({ id: i, allied: false })),
      buildCosts: {},
      nukes: {},
      recentEvents: ["e"],
      lastResult: "r",
      plan: "p",
    };
    const out = compactObs(obs, [{ ago: 2.5, name: "attack", args: { target: 3, ratio: 0.2 } }]);
    expect(Object.keys(out)).toEqual(["alerts", "tick", "me", "neighbors", "reachableByBoat", "leaderboard", "myRecentActions"]);
    const me = out.me as Record<string, unknown>;
    expect(me.structures).toEqual({ City: 1 });
    expect(me.team).toBeUndefined();
    expect(me.units).toHaveLength(6);
    expect((me.units as unknown[])[0]).toEqual({ id: 0, type: "City", level: 2, x: 0, y: 0 });
    expect((me.units as unknown[])[1]).toEqual({ id: 1, type: "City", x: 1, y: 1 });
    expect(out.neighbors).toHaveLength(8);
    expect((out.neighbors as Record<string, unknown>[])[0]).toEqual({ id: 0, relationToMe: "neutral", structures: {} });
    expect(out.reachableByBoat).toHaveLength(3);
    expect((out.reachableByBoat as Record<string, unknown>[])[0]).toEqual({ id: 0, name: "n" });
    expect(out.leaderboard).toHaveLength(3);
    expect(out.myRecentActions).toEqual([{ ago: 2.5, name: "attack", args: { target: 3, ratio: 0.2 } }]);
  });
});
