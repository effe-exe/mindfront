import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  createArenaServer,
  type SeatHandle,
  type ToolLine,
} from "../../arena/mcp/server";
import type { EventLine, PlayerCtx } from "../../arena/types";
import { Game, Player, PlayerType } from "../../src/core/game/Game";
import type { Intent } from "../../src/core/Schemas";
import { playerInfo, setup } from "../util/Setup";

let game: Game;
let player1: Player;
let player2: Player;
let sent: Intent[];
let events: (EventLine | ToolLine)[];
let client: Client;

const TOKEN = "seat-token-1";

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

/** text payload of a tool call, parsed */
async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
  };
  return JSON.parse(res.content[0].text);
}

/** raw text payload of a tool call */
async function callText(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
  };
  return res.content[0].text;
}

function makeServer() {
  const seat: SeatHandle = {
    name: "Tester",
    model: "test/model",
    me: () => player1,
    ctx: ctx(),
    recentEvents: () => [],
    send: (i) => sent.push(i),
    say: () => {},
  };
  return createArenaServer({
    game: () => game,
    seats: new Map([[TOKEN, seat]]),
    onEvent: (l) => events.push(l),
    rules: "RULES TEXT",
  });
}

describe("arena/mcp", () => {
  beforeEach(async () => {
    game = await setup("plains", { instantBuild: true }, [
      playerInfo("player1", PlayerType.Human),
      playerInfo("player2", PlayerType.Human),
    ]);
    player1 = game.player("player1");
    player2 = game.player("player2");
    for (let x = 10; x <= 12; x++) {
      for (let y = 10; y <= 12; y++) player1.conquer(game.ref(x, y));
    }
    for (let x = 60; x <= 62; x++) {
      for (let y = 60; y <= 62; y++) player2.conquer(game.ref(x, y));
    }

    sent = [];
    events = [];
    const { server } = makeServer();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0.0.1" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  test("exposes every tool", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const expected of [
      "rules",
      "observe",
      "inspect_player",
      "game_info",
      "map_overview",
      "expand",
      "attack",
      "boat",
      "ally",
      "accept_alliance",
      "reject_alliance",
      "break_alliance",
      "extend_alliance",
      "build",
      "emoji",
      "chat",
      "say",
    ]) {
      expect(names).toContain(expected);
    }
  });

  test("observe returns the live observation", async () => {
    const obs = await call("observe");
    expect(obs.me.tiles).toBeGreaterThan(0);
    expect(obs.me.id).toBe(player1.smallID());
  });

  test("game_info returns the match constants and unit costs", async () => {
    const info = await call("game_info");
    expect(info).toHaveProperty("minutesLeft");
    expect(info.totalLandTiles).toBeGreaterThan(0);
    expect(info.mapWidth).toBe(game.width());
    expect(info.units.City.cost).toBeGreaterThan(0);
    expect(info.units.Port.effect).toBeTruthy();
    expect(info.allianceDurationTicks).toBeGreaterThan(0);
    expect(info.defensePostRange).toBeGreaterThan(0);
    expect(info.attackMath).toMatch(/troops/i);
    expect(info.rateLimits).toMatch(/150/);
  });

  test("map_overview returns a grid with a legend naming both players", async () => {
    const text = await callText("map_overview", { cols: 8, rows: 4 });
    const lines = text.split("\n");
    // header blurb + column header + 4 grid rows + legend
    expect(lines).toHaveLength(7);
    expect(lines.filter((l) => /^r\d/.test(l))).toHaveLength(4);
    const legend = lines[lines.length - 1];
    expect(legend.startsWith("legend: ")).toBe(true);
    expect(legend).toContain(player1.name());
    expect(legend).toContain(player2.name());
    expect(legend).toContain("me=");
  });

  test("inspect_player returns the enriched dossier", async () => {
    const p = await call("inspect_player", { id: player2.smallID() });
    expect(p.id).toBe(player2.smallID());
    expect(p.maxTroops).toBeGreaterThan(0);
    expect(p.direction).toBe("SE");
    expect(p.distance).toBeGreaterThan(0);
    expect(p.sharesBorder).toBe(false);
    expect(p.structures).toHaveProperty("City");
    expect(p.attacking).toEqual([]);
  });

  test("expand sends one land-grab intent", async () => {
    expect(await call("expand")).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "attack", targetID: null });
  });

  test("attack on an invented id is refused with a reason", async () => {
    const r = await call("attack", { target: 9999 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
    expect(sent).toHaveLength(0);
  });

  test("unaffordable build is refused", async () => {
    const r = await call("build", { unit: "City" });
    expect(r.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  test("extend_alliance sends the extension intent only to an ally", async () => {
    let r = await call("extend_alliance", { target: player2.smallID() });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not your ally/);
    player1.createAllianceRequest(player2)?.accept();
    const obs = await call("observe");
    expect(obs.me.allianceExpiry[0]).toMatchObject({
      id: player2.smallID(),
      theyAgreedToExtend: false,
      iAgreedToExtend: false,
    });
    r = await call("extend_alliance", { target: player2.smallID() });
    expect(r).toEqual({ ok: true });
    expect(sent[0]).toEqual({ type: "allianceExtension", recipient: player2.id() });
  });

  test("say emits a tool event line", async () => {
    expect(await call("say", { text: "hello world" })).toEqual({ ok: true });
    const line = events[events.length - 1] as ToolLine;
    expect(line.kind).toBe("tool");
    expect(line.tool).toBe("say");
    expect(line.player).toBe("Tester");
    expect(line.ok).toBe(true);
  });

  test("serves MCP over HTTP with a bearer token", async () => {
    const { handleHttp } = makeServer();
    const server = http.createServer((req, res) => void handleHttp(req, res));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const url = new URL(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    );

    const httpClient = new Client({ name: "http-test", version: "0.0.1" });
    await httpClient.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    const res = (await httpClient.callTool({
      name: "rules",
      arguments: {},
    })) as {
      content: { text: string }[];
    };
    expect(res.content[0].text).toBe("RULES TEXT");
    await httpClient.close();

    const bad = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer nope",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(bad.status).toBe(401);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
