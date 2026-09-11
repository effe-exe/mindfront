// Package D: OpenRouter call, prompt, referential guardrails, self-check.
import assert from "node:assert";
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

export function systemPrompt(ctx: PlayerCtx): string {
  return `You are playing OpenFront, a real-time territory conquest game, as "${ctx.name}".

RULES
- Troop regen scales with how much land you hold. Cities raise your troop cap. Ports earn gold via trade.
- "expand" claims adjacent unclaimed land cheaply — do this early and often when unclaimedLandAdjacent is true.
- "attack" sends a fraction ("ratio") of your troops at a neighbor. Attacking well-defended land costs more troops than it gains.
- Structures (cost gold): City raises troop cap; Port enables sea trade and boats; Defense Post strengthens nearby borders; Factory boosts gold; Warship (needs a Port) hunts enemy ships; Missile Silo launches nukes at enemies; SAM Launcher shoots down incoming nukes.
- There is no cap on actions per turn and no fixed turn cadence: you are asked again as soon as your previous answer is processed. Faster, sharper decisions win. Illegal actions are dropped with a reason; everything legal is executed.
- Turns are ~5 seconds apart; an "attack" keeps fighting on its own after you send it, you do not need to repeat it every turn.
- Alliances last 5 minutes. Breaking one brands you a traitor and blocks attacks in both directions — treat alliances as temporary tools, not friendships.
- Boats can strike non-adjacent coastal targets, at most 3 in flight at once.
- You win by holding 80% of the land, or by having the most land when the match timer ends.
- Neighbors of kind "tribe" are dumb scripted NPCs — easy targets. Neighbors of kind "llm" are the real rivals: other AI models like you.
- Never send more than 60% of your troops in one action. Keep a defensive reserve if incomingAttacks is non-empty.
- Only "accept_alliance"/"reject_alliance" ids in pendingAllianceRequestsFrom; only "break_alliance" ids in me.allies.
- You may reference only ids that appear in this turn's observation JSON. An invented id gets the action dropped.

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
  if (salvaged.length === 0) return { decision: FALLBACK_DECISION, fallback: true };
  const reasoning =
    typeof obj?.reasoning === "string" ? obj.reasoning.slice(0, 240) : "(unparseable)";
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
      console.warn(`decide[${ctx.model}]: HTTP ${res.status} ${body.slice(0, 200)}`);
      return { decision: FALLBACK_DECISION, latencyMs, fallback: true };
    }
    const data = await res.json();
    const raw = extractArgs(data?.choices?.[0]?.message);
    if (raw === undefined) {
      console.warn(`decide[${ctx.model}]: no tool_call or JSON content in response`);
      return { decision: FALLBACK_DECISION, latencyMs, fallback: true };
    }
    const { decision, fallback } = parseDecision(raw);
    if (fallback) {
      console.warn(`decide[${ctx.model}]: unparseable decision: ${raw.slice(0, 200)}`);
    }
    return { decision, latencyMs, fallback };
  } catch (err) {
    const isTimeout =
      err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
    const latencyMs = isTimeout ? timeoutMs : Date.now() - start;
    console.warn(`decide[${ctx.model}]: ${String(err).slice(0, 200)}`);
    return { decision: FALLBACK_DECISION, latencyMs, fallback: true };
  }
};


export const sanitize: Sanitize = (decision, obs) => {
  const dropped: { action: Action; reason: string }[] = [];
  const neighborIds = new Set(obs.neighbors.map((n) => n.id));
  const reachableIds = new Set(obs.reachableByBoat.map((r) => r.id));
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
        if (action.target === undefined || !neighborIds.has(action.target)) {
          reason = `target ${action.target} is not your neighbor; neighbors: [${[...neighborIds].join(",")}]`;
        }
        break;
      case "boat":
        if (action.target === undefined || !reachableIds.has(action.target)) {
          reason = `target ${action.target} is not reachable by boat`;
        }
        break;
      case "accept_alliance":
      case "reject_alliance":
        if (action.target === undefined || !pendingIds.has(action.target)) {
          reason = `target ${action.target} has no pending alliance request`;
        }
        break;
      case "break_alliance":
        if (action.target === undefined || !allyIds.has(action.target)) {
          reason = `target ${action.target} is not your ally`;
        }
        break;
      case "build":
        if (action.unit === undefined || !buildableUnits.has(action.unit)) {
          reason = "cannot afford / not buildable now";
        }
        break;
      case "emoji":
        if (action.emoji === undefined || !EMOJI_SET.has(action.emoji)) {
          reason = `unknown emoji: ${action.emoji}`;
        } else if (action.target !== undefined && !knownIds.has(action.target)) {
          reason = `target ${action.target} is not a known id`;
        }
        break;
      case "chat":
        if (action.key === undefined || !QUICK_CHAT_KEY_SET.has(action.key)) {
          reason = `unknown quick-chat key: ${action.key}`;
        } else if (action.target !== undefined && !knownIds.has(action.target)) {
          reason = `target ${action.target} is not a known id`;
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const CANNED_OBS: Obs = {
    tick: 500,
    minute: 5,
    me: {
      id: 1,
      name: "Tester",
      tiles: 1000,
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
      outgoingAttacks: [],
    },
    neighbors: [
      {
        id: 3,
        name: "Three",
        kind: "llm",
        tiles: 800,
        troops: 700,
        relation: "neutral",
        allied: false,
        attackingMe: false,
        coastal: true,
      },
      {
        id: 7,
        name: "Seven",
        kind: "llm",
        tiles: 600,
        troops: 500,
        relation: "friendly",
        allied: true,
        attackingMe: false,
        coastal: true,
      },
    ],
    unclaimedLandAdjacent: true,
    reachableByBoat: [{ id: 12, name: "Twelve", tiles: 400 }],
    leaderboard: [
      { id: 1, name: "Tester", tiles: 1000 },
      { id: 3, name: "Three", tiles: 800 },
    ],
    canBuild: [{ unit: "City", cost: 100 }],
    recentEvents: [],
    lastResult: "",
    notes: "",
  };

  const mk = (actions: Action[]): Decision => ({ reasoning: "test", notes: "", actions });

  // drops
  {
    const { decision, dropped } = sanitize(mk([{ type: "attack", target: 99, ratio: 0.3 }]), CANNED_OBS);
    assert.equal(decision.actions.length, 0, "invented id attack should be dropped");
    assert.equal(dropped.length, 1);
  }
  {
    const { decision } = sanitize(mk([{ type: "attack", target: 7, ratio: 0.3 }]), CANNED_OBS);
    assert.equal(decision.actions.length, 0, "attack on ally should be dropped");
  }
  {
    const { decision } = sanitize(mk([{ type: "attack", target: 3, ratio: 5 }]), CANNED_OBS);
    assert.equal(decision.actions.length, 1, "attack with ratio 5 should be kept, clamped");
    assert.equal(decision.actions[0].ratio, RATIO_MAX);
  }
  {
    const { decision } = sanitize(mk([{ type: "break_alliance", target: 3 }]), CANNED_OBS);
    assert.equal(decision.actions.length, 0, "break_alliance on non-ally should be dropped");
  }
  {
    const { decision } = sanitize(mk([{ type: "accept_alliance", target: 7 }]), CANNED_OBS);
    assert.equal(decision.actions.length, 0, "accept_alliance on non-pending should be dropped");
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
    const { decision } = sanitize(mk([{ type: "emoji", emoji: "🛸" }]), CANNED_OBS);
    assert.equal(decision.actions.length, 0, "unknown emoji should be dropped");
  }
  {
    const { decision } = sanitize(mk([{ type: "chat", key: "not.a.real.key" }]), CANNED_OBS);
    assert.equal(decision.actions.length, 0, "bad chat key should be dropped");
  }

  // keeps
  {
    const { decision } = sanitize(mk([{ type: "expand", ratio: 0.3 }]), CANNED_OBS);
    assert.equal(decision.actions.length, 1);
    assert.equal(decision.actions[0].ratio, 0.3);
  }
  {
    const { decision } = sanitize(mk([{ type: "attack", target: 3, ratio: 0.3 }]), CANNED_OBS);
    assert.equal(decision.actions.length, 1);
  }
  {
    const { decision } = sanitize(mk([{ type: "accept_alliance", target: 3 }]), CANNED_OBS);
    assert.equal(decision.actions.length, 1);
  }
  {
    const { decision } = sanitize(mk([{ type: "build", unit: "City" }]), CANNED_OBS);
    assert.equal(decision.actions.length, 1);
  }
  {
    const { decision } = sanitize(mk([{ type: "boat", target: 12, ratio: 0.2 }]), CANNED_OBS);
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
  const mockFetch = (impl: () => Promise<any>) => impl as unknown as typeof fetch;

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
      const { decision, fallback } = await decide(CTX, CANNED_OBS, { apiKey: "x", fetchImpl });
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
                  JSON.stringify({ reasoning: "hi2", notes: "", actions: [{ type: "expand", ratio: 0.3 }] }) +
                  "\n```",
              },
            },
          ],
        }),
        text: async () => "",
      }));
      const { decision, fallback } = await decide(CTX, CANNED_OBS, { apiKey: "x", fetchImpl });
      assert.equal(fallback, false, "(b) fenced content should parse");
      assert.equal(decision.actions[0].type, "expand");
    }

    // (c) garbage content
    {
      const fetchImpl = mockFetch(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "not json at all, sorry" } }] }),
        text: async () => "",
      }));
      const { fallback } = await decide(CTX, CANNED_OBS, { apiKey: "x", fetchImpl });
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
      const { fallback } = await decide(CTX, CANNED_OBS, { apiKey: "x", fetchImpl });
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
