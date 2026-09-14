// Package D: OpenRouter call, prompt, referential guardrails, self-check.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import quickChatData from "resources/QuickChat.json";
import { flattenedEmojiTable } from "src/core/Util";
import {
  ACT_TOOL_PARAMETERS,
  type Action,
  ActionSchema,
  type Decide,
  type Decision,
  DecisionSchema,
  FALLBACK_DECISION,
  type Obs,
  type ObsNeighbor,
  type PlayerCtx,
  RATIO_MAX,
  RATIO_MIN,
  type Sanitize,
} from "./types";

const QUICK_CHAT_KEYS = Object.entries(
  quickChatData as Record<string, { key: string }[]>,
).flatMap(([category, entries]) => entries.map((e) => `${category}.${e.key}`));
const QUICK_CHAT_KEY_SET = new Set(QUICK_CHAT_KEYS);
const EMOJI_SET = new Set<string>(flattenedEmojiTable);

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** The player's manual. Read once; it is also what the `rules` tool returns. */
const GUIDE_URL = new URL("./GUIDE.md", import.meta.url);
const GUIDE = fs.readFileSync(
  // vitest serves modules over http, so import.meta.url is not a file URL there.
  GUIDE_URL.protocol === "file:"
    ? GUIDE_URL
    : path.join(process.cwd(), "arena/GUIDE.md"),
  "utf8",
);

export function systemPrompt(ctx: PlayerCtx): string {
  return `You are playing OpenFront, a real-time territory conquest game, as "${ctx.name}".

${GUIDE}

Only "accept_alliance"/"reject_alliance" ids in pendingAllianceRequestsFrom; only "break_alliance"/"extend_alliance"/"donate" ids in me.allies. Keep a defensive reserve when incomingAttacks is non-empty.

PERSONA
${ctx.persona}

OUTPUT
Call the "act" tool exactly once with as many actions as you want. "reasoning" is 1-2 punchy in-character sentences shown live to spectators — perform, don't explain. "notes" is your private scratchpad, carried back to you next turn.
Valid emoji: ${flattenedEmojiTable.join(",")}
Valid chat keys: ${QUICK_CHAT_KEYS.join(",")}`;
}

function firstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractArgs(message: any): string | undefined {
  const toolArgs = message?.tool_calls?.[0]?.function?.arguments;
  if (typeof toolArgs === "string" && toolArgs.length > 0) return toolArgs;
  const content = message?.content;
  if (typeof content === "string") return firstJsonObject(content);
  return undefined;
}

function parseDecision(raw: string): { decision: Decision; fallback: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { decision: FALLBACK_DECISION, fallback: true };
  }
  const strict = DecisionSchema.safeParse(parsed);
  if (strict.success) return { decision: strict.data, fallback: false };

  // salvage: keep whatever individual actions parse, default the rest.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj = parsed as any;
  const actionsRaw = Array.isArray(obj?.actions) ? obj.actions : [];
  const salvaged: Action[] = [];
  for (const a of actionsRaw) {
    const r = ActionSchema.safeParse(a);
    if (r.success) salvaged.push(r.data);
    if (salvaged.length >= 3) break;
  }
  if (salvaged.length === 0)
    return { decision: FALLBACK_DECISION, fallback: true };
  const reasoning =
    typeof obj?.reasoning === "string"
      ? obj.reasoning.slice(0, 240)
      : "(unparseable)";
  const notes = typeof obj?.notes === "string" ? obj.notes.slice(0, 300) : "";
  return { decision: { reasoning, notes, actions: salvaged }, fallback: false };
}

export const decide: Decide = async (ctx, obs, opts) => {
  const apiKey = opts?.apiKey ?? process.env.OPENROUTER_API_KEY;
  const timeoutMs = opts?.timeoutMs ?? 20_000;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const start = Date.now();
  try {
    const res = await fetchImpl(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://github.com/effe-exe/mindfront",
        "X-Title": "MindFront",
      },
      body: JSON.stringify({
        model: ctx.model,
        temperature: 0.7,
        max_tokens: 1500,
        reasoning: { effort: "low" },
        messages: [
          { role: "system", content: systemPrompt(ctx) },
          { role: "user", content: JSON.stringify(obs) },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "act",
              description: "Choose this turn's actions",
              parameters: ACT_TOOL_PARAMETERS,
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "act" } },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(
        `decide[${ctx.model}]: HTTP ${res.status} ${body.slice(0, 200)}`,
      );
      return { decision: FALLBACK_DECISION, latencyMs, fallback: true };
    }
    const data = await res.json();
    const raw = extractArgs(data?.choices?.[0]?.message);
    if (raw === undefined) {
      console.warn(
        `decide[${ctx.model}]: no tool_call or JSON content in response`,
      );
      return { decision: FALLBACK_DECISION, latencyMs, fallback: true };
    }
    const { decision, fallback } = parseDecision(raw);
    if (fallback) {
      console.warn(
        `decide[${ctx.model}]: unparseable decision: ${raw.slice(0, 200)}`,
      );
    }
    return { decision, latencyMs, fallback };
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      (err.name === "AbortError" || err.name === "TimeoutError");
    const latencyMs = isTimeout ? timeoutMs : Date.now() - start;
    console.warn(`decide[${ctx.model}]: ${String(err).slice(0, 200)}`);
    return { decision: FALLBACK_DECISION, latencyMs, fallback: true };
  }
};

export const sanitize: Sanitize = (decision, obs) => {
  const dropped: { action: Action; reason: string }[] = [];
  const neighborIds = new Set(obs.neighbors.map((n) => n.id));
  const reachableIds = new Set(obs.reachableByBoat.map((r) => r.id));
  // any visible player whose shore shares a water body with mine is a boat target
  const seaIds = new Set(
    [...obs.neighbors, ...obs.reachableByBoat, ...obs.leaderboard]
      .filter((v) => v.sharesSea)
      .map((v) => v.id),
  );
  const pendingIds = new Set(obs.me.pendingAllianceRequestsFrom);
  const allyIds = new Set(obs.me.allies);
  const buildableUnits = new Set(obs.canBuild.map((c) => c.unit));
  const knownIds = new Set<number>([
    obs.me.id,
    ...neighborIds,
    ...reachableIds,
    ...allyIds,
    ...pendingIds,
    ...obs.leaderboard.map((l) => l.id),
    ...obs.me.incomingAttacks.map((a) => a.from),
    ...obs.me.incomingBoats.map((b) => b.from),
  ]);

  const kept: Action[] = [];

  for (const original of decision.actions) {
    const action: Action = { ...original };
    if (action.ratio !== undefined) {
      action.ratio = Math.min(RATIO_MAX, Math.max(RATIO_MIN, action.ratio));
    }

    let reason: string | undefined;
    switch (action.type) {
      case "attack":
        if (action.target === undefined || !neighborIds.has(action.target)) {
          reason = `target ${action.target} is not your neighbor; neighbors: [${[...neighborIds].join(",")}]`;
        } else if (allyIds.has(action.target)) {
          reason = `you are allied with ${action.target}; break_alliance first`;
        }
        break;
      case "ally":
        // The engine allows requests to anyone alive; the only requirement is that
        // the id is one you can see this turn.
        if (action.target === undefined || !knownIds.has(action.target)) {
          reason = `target ${action.target} is not a visible player id`;
        } else if (allyIds.has(action.target)) {
          reason = `you are already allied with ${action.target}`;
        }
        break;
      case "boat":
        if (action.target === undefined || !seaIds.has(action.target)) {
          reason = `target ${action.target} shares no water body with your shore; boat targets: [${[...seaIds].join(",")}]`;
        }
        break;
      case "accept_alliance":
      case "reject_alliance":
        if (action.target === undefined || !pendingIds.has(action.target)) {
          reason = `target ${action.target} has no pending alliance request`;
        }
        break;
      case "break_alliance":
      case "extend_alliance":
      case "donate":
        if (action.target === undefined || !allyIds.has(action.target)) {
          reason = `target ${action.target} is not your ally`;
        }
        break;
      case "recall_boats":
        if (obs.me.boatsInFlight === 0) reason = "you have no boat at sea";
        break;
      case "build":
        if (action.unit === undefined || !buildableUnits.has(action.unit)) {
          reason =
            action.unit === undefined
              ? "build needs a unit"
              : `${action.unit}: ${obs.build?.[action.unit]?.note ?? "cannot afford / not buildable now"}`;
        } else if (typeof action.at === "number" && !knownIds.has(action.at)) {
          reason = `at=${action.at} is not a visible player id`;
        }
        break;
      case "upgrade":
        if (action.unit === undefined) {
          reason = "upgrade needs a unit";
        } else if (!obs.build[action.unit].upgradable) {
          reason = `${action.unit} cannot be upgraded; build another one instead`;
        } else if (action.id !== undefined && !obs.me.units.some((u) => u.id === action.id)) {
          reason = `id ${action.id} is not one of your structures; ids: [${obs.me.units.map((u) => u.id).join(",")}]`;
        } else if (!obs.me.units.some((u) => u.type === action.unit)) {
          reason = `you own no ${action.unit}; build one first`;
        } else if (!obs.build[action.unit].affordable) {
          reason = `${action.unit} upgrade costs ${obs.build[action.unit].cost}; you have ${obs.me.gold}`;
        }
        break;
      case "emoji":
        if (action.emoji === undefined || !EMOJI_SET.has(action.emoji)) {
          reason = `unknown emoji: ${action.emoji}`;
        } else if (
          action.target !== undefined &&
          !knownIds.has(action.target)
        ) {
          reason = `target ${action.target} is not a known id`;
        }
        break;
      case "chat":
        if (action.key === undefined || !QUICK_CHAT_KEY_SET.has(action.key)) {
          reason = `unknown quick-chat key: ${action.key}`;
        } else if (
          action.target !== undefined &&
          !knownIds.has(action.target)
        ) {
          reason = `target ${action.target} is not a known id`;
        }
        break;
      case "retreat": {
        const running = new Set(obs.me.outgoingAttacks.map((a) => a.to));
        if (action.target !== undefined && !running.has(action.target)) {
          reason = `no attack of yours is running against ${action.target}; running: [${[...running].join(",")}]`;
        }
        break;
      }
      case "nuke":
        if (action.nuke === undefined) {
          reason = "nuke needs a warhead: Atom Bomb, Hydrogen Bomb or MIRV";
        } else if (action.target === undefined || !knownIds.has(action.target)) {
          reason = `target ${action.target} is not a visible player id`;
        } else if (allyIds.has(action.target)) {
          reason = `you are allied with ${action.target}; break_alliance first`;
        } else if (obs.nukes.silos === 0) {
          reason = `no Missile Silo; build one first (${obs.build["Missile Silo"].cost} gold)`;
        } else if (!obs.nukes.affordable.includes(action.nuke)) {
          reason = `${action.nuke} costs ${obs.nukes.costs[action.nuke]} gold; you have less`;
        }
        break;
      case "expand":
      case "wait":
        break;
    }

    if (reason) {
      dropped.push({ action, reason });
      continue;
    }

    kept.push(action);
  }

  return {
    decision: {
      reasoning: decision.reasoning.slice(0, 240),
      notes: (decision.notes ?? "").slice(0, 300),
      actions: kept,
    },
    dropped,
  };
};

// ---------- self-check ----------

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const NO_STRUCTURES = {
    City: 0,
    Port: 0,
    "Defense Post": 0,
    "Missile Silo": 0,
    "SAM Launcher": 0,
    Factory: 0,
    Warship: 0,
  };
  // minimal enriched-player fixture; only the fields sanitize() reads vary
  const nb = (
    p: Partial<ObsNeighbor> & { id: number; name: string },
  ): ObsNeighbor => ({
    kind: "llm",
    tiles: 100,
    troops: 100,
    relation: "neutral",
    allied: false,
    attackingMe: false,
    coastal: true,
    sharesSea: true,
    gold: 0,
    maxTroops: 1000,
    troopsPct: 10,
    traitorTicksLeft: 0,
    betrayals: 0,
    allies: [],
    attacking: [],
    attackedBy: [],
    tilesDelta1m: 0,
    sharedBorderTiles: 0,
    direction: "N",
    distance: 10,
    structures: { ...NO_STRUCTURES },
    ...p,
  });

  const CANNED_OBS: Obs = {
    alerts: [],
    tick: 500,
    minute: 5,
    game: {
      tick: 500,
      minutesLeft: 25,
      totalLandTiles: 1_000_000,
      mapWidth: 1000,
      mapHeight: 500,
    },
    me: {
      id: 1,
      name: "Tester",
      tiles: 1000,
      freeLandAtBorder: 40,
      landPct: 0.1,
      troops: 1000,
      gold: 500,
      cities: 1,
      ports: 0,
      defensePosts: 0,
      silos: 0,
      boatsInFlight: 0,
      allies: [7],
      pendingAllianceRequestsFrom: [3],
      incomingAttacks: [],
      incomingBoats: [],
      outgoingAttacks: [],
      maxTroops: 10_000,
      troopsPct: 10,
      goldIncomePerMin: 100,
      income: { baseGold: 60000, tradeGold: 0, trainGold: 0, lootGold: 0 },
      tradePartnerPorts: 0,
      tilesDelta1m: 20,
      immuneUntilTick: 0,
      traitorTicksLeft: 0,
      betrayals: 0,
      allianceExpiry: [{ id: 7, ticksLeft: 1000, theyAgreedToExtend: false, iAgreedToExtend: false }],
      pendingRequestExpiry: [{ id: 3, ticksLeft: 100 }],
      structures: { ...NO_STRUCTURES, City: 1 },
      underConstruction: { ...NO_STRUCTURES },
      units: [{ id: 41, type: "City", level: 1, underConstruction: false, x: 100, y: 100 }],
      center: { x: 100, y: 100 },
      bbox: { minX: 80, minY: 80, maxX: 120, maxY: 120 },
    },
    neighbors: [
      nb({ id: 3, name: "Three", tiles: 800, troops: 700 }),
      nb({
        id: 7,
        name: "Seven",
        tiles: 600,
        troops: 500,
        relation: "friendly",
        allied: true,
      }),
    ],
    unclaimedLandAdjacent: true,
    reachableByBoat: [nb({ id: 12, name: "Twelve", tiles: 400 })],
    leaderboard: [
      nb({ id: 1, name: "Tester", tiles: 1000 }),
      nb({ id: 3, name: "Three", tiles: 800 }),
    ],
    canBuild: [{ unit: "City", cost: 100 }],
    buildCosts: {
      City: 125000,
      Port: 125000,
      "Defense Post": 50000,
      "Missile Silo": 1000000,
      "SAM Launcher": 1500000,
      Factory: 250000,
      Warship: 250000,
    },
    build: {
      City: { cost: 125000, affordable: true, placeable: true, upgradable: true, note: "affordable; on any of your land tiles" },
      Port: { cost: 125000, affordable: false, placeable: false, upgradable: true, note: "need 1 more gold; needs a coastal tile you own; you have none" },
      "Defense Post": { cost: 50000, affordable: false, placeable: true, upgradable: false, note: "need 1 more gold; on any of your land tiles" },
      "Missile Silo": { cost: 1000000, affordable: false, placeable: true, upgradable: true, note: "need gold" },
      "SAM Launcher": { cost: 1500000, affordable: false, placeable: true, upgradable: true, note: "need gold" },
      Factory: { cost: 250000, affordable: false, placeable: true, upgradable: true, note: "need gold" },
      Warship: { cost: 250000, affordable: false, placeable: false, upgradable: false, note: "needs a Port; you have none" },
    },
    nukes: { silos: 0, costs: { "Atom Bomb": 750000, "Hydrogen Bomb": 5000000, MIRV: 25000000 }, affordable: [] },
    recentEvents: [],
    globalEvents: [],
    lastResult: "",
    notes: "",
  };

  const mk = (actions: Action[]): Decision => ({
    reasoning: "test",
    notes: "",
    actions,
  });

  // drops
  {
    const { decision, dropped } = sanitize(
      mk([{ type: "attack", target: 99, ratio: 0.3 }]),
      CANNED_OBS,
    );
    assert.equal(
      decision.actions.length,
      0,
      "invented id attack should be dropped",
    );
    assert.equal(dropped.length, 1);
  }
  {
    const { decision } = sanitize(
      mk([{ type: "attack", target: 7, ratio: 0.3 }]),
      CANNED_OBS,
    );
    assert.equal(
      decision.actions.length,
      0,
      "attack on ally should be dropped",
    );
  }
  {
    const { decision } = sanitize(
      mk([{ type: "attack", target: 3, ratio: 5 }]),
      CANNED_OBS,
    );
    assert.equal(
      decision.actions.length,
      1,
      "attack with ratio 5 should be kept, clamped",
    );
    assert.equal(decision.actions[0].ratio, RATIO_MAX);
  }
  {
    const { decision } = sanitize(
      mk([{ type: "break_alliance", target: 3 }]),
      CANNED_OBS,
    );
    assert.equal(
      decision.actions.length,
      0,
      "break_alliance on non-ally should be dropped",
    );
  }
  {
    const { decision } = sanitize(
      mk([{ type: "accept_alliance", target: 7 }]),
      CANNED_OBS,
    );
    assert.equal(
      decision.actions.length,
      0,
      "accept_alliance on non-pending should be dropped",
    );
  }
  {
    const { decision } = sanitize(
      mk([{ type: "extend_alliance", target: 3 }, { type: "extend_alliance", target: 7 }]),
      CANNED_OBS,
    );
    assert.equal(decision.actions.length, 1, "extend_alliance only on an ally");
    assert.equal(decision.actions[0].target, 7);
  }
  {
    const { decision } = sanitize(
      mk([
        { type: "upgrade", unit: "City" },
        { type: "upgrade", unit: "City", id: 99 },
        { type: "upgrade", unit: "Port" },
      ]),
      CANNED_OBS,
    );
    assert.equal(decision.actions.length, 1, "upgrade only an owned structure with a real id");
  }
  {
    const { decision, dropped } = sanitize(
      mk([
        { type: "attack", target: 3, ratio: 0.3 },
        { type: "attack", target: 3, ratio: 0.2 },
      ]),
      CANNED_OBS,
    );
    assert.equal(decision.actions.length, 2, "no per-turn action caps");
    assert.equal(dropped.length, 0);
  }
  {
    const { decision } = sanitize(
      mk([{ type: "emoji", emoji: "🛸" }]),
      CANNED_OBS,
    );
    assert.equal(decision.actions.length, 0, "unknown emoji should be dropped");
  }
  {
    const { decision } = sanitize(
      mk([{ type: "chat", key: "not.a.real.key" }]),
      CANNED_OBS,
    );
    assert.equal(decision.actions.length, 0, "bad chat key should be dropped");
  }

  // keeps
  {
    const { decision } = sanitize(
      mk([{ type: "expand", ratio: 0.3 }]),
      CANNED_OBS,
    );
    assert.equal(decision.actions.length, 1);
    assert.equal(decision.actions[0].ratio, 0.3);
  }
  {
    const { decision } = sanitize(
      mk([{ type: "attack", target: 3, ratio: 0.3 }]),
      CANNED_OBS,
    );
    assert.equal(decision.actions.length, 1);
  }
  {
    const { decision } = sanitize(
      mk([{ type: "accept_alliance", target: 3 }]),
      CANNED_OBS,
    );
    assert.equal(decision.actions.length, 1);
  }
  {
    const { decision } = sanitize(
      mk([{ type: "build", unit: "City" }]),
      CANNED_OBS,
    );
    assert.equal(decision.actions.length, 1);
  }
  {
    const { decision } = sanitize(
      mk([{ type: "boat", target: 12, ratio: 0.2 }]),
      CANNED_OBS,
    );
    assert.equal(decision.actions.length, 1);
  }

  const CTX: PlayerCtx = {
    model: "test/model",
    name: "Tester",
    persona: "test persona",
    clientID: "c1",
    playerID: "p1",
    notes: "",
    lastResult: "",
    latencyEma: 0,
    intervalTicks: 50,
    pending: false,
    consecutiveDrops: 0,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockFetch = (impl: () => Promise<any>) =>
    impl as unknown as typeof fetch;

  void (async () => {
    // (a) proper tool_call response
    {
      const fetchImpl = mockFetch(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      arguments: JSON.stringify({
                        reasoning: "hi",
                        notes: "",
                        actions: [{ type: "wait" }],
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        text: async () => "",
      }));
      const { decision, fallback } = await decide(CTX, CANNED_OBS, {
        apiKey: "x",
        fetchImpl,
      });
      assert.equal(fallback, false, "(a) tool_call should parse");
      assert.equal(decision.actions[0].type, "wait");
    }

    // (b) content wrapped in ```json fence, no tool_calls
    {
      const fetchImpl = mockFetch(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  "```json\n" +
                  JSON.stringify({
                    reasoning: "hi2",
                    notes: "",
                    actions: [{ type: "expand", ratio: 0.3 }],
                  }) +
                  "\n```",
              },
            },
          ],
        }),
        text: async () => "",
      }));
      const { decision, fallback } = await decide(CTX, CANNED_OBS, {
        apiKey: "x",
        fetchImpl,
      });
      assert.equal(fallback, false, "(b) fenced content should parse");
      assert.equal(decision.actions[0].type, "expand");
    }

    // (c) garbage content
    {
      const fetchImpl = mockFetch(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "not json at all, sorry" } }],
        }),
        text: async () => "",
      }));
      const { fallback } = await decide(CTX, CANNED_OBS, {
        apiKey: "x",
        fetchImpl,
      });
      assert.equal(fallback, true, "(c) garbage should fall back");
    }

    // (d) HTTP 429
    {
      const fetchImpl = mockFetch(async () => ({
        ok: false,
        status: 429,
        json: async () => ({}),
        text: async () => "rate limited",
      }));
      const { fallback } = await decide(CTX, CANNED_OBS, {
        apiKey: "x",
        fetchImpl,
      });
      assert.equal(fallback, true, "(d) HTTP 429 should fall back");
    }

    // (e) fetch rejects with AbortError
    {
      const fetchImpl = mockFetch(async () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      });
      const { fallback, latencyMs } = await decide(CTX, CANNED_OBS, {
        apiKey: "x",
        timeoutMs: 1234,
        fetchImpl,
      });
      assert.equal(fallback, true, "(e) abort should fall back");
      assert.equal(latencyMs, 1234, "(e) latency should equal timeoutMs");
    }

    console.log("decide self-check OK");

    const liveIdx = process.argv.indexOf("--live");
    const liveModel = liveIdx !== -1 ? process.argv[liveIdx + 1] : undefined;
    if (process.env.OPENROUTER_API_KEY && liveModel) {
      const result = await decide({ ...CTX, model: liveModel }, CANNED_OBS);
      console.log("live decision:", JSON.stringify(result, null, 2));
    }
  })();
}
