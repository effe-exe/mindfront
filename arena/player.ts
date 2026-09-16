// Package P2: generic MCP-client player loop for OpenRouter models.
// Talks to arena/mcp/server.ts (or any MCP server exposing the same tool
// surface) over the SDK's Client, drives it with an OpenRouter model.
import assert from "node:assert";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { systemPrompt } from "./decide";
import { LOCAL_MODEL_PREFIX, LOCAL_TOOLS, compactObs, localSystemPrompt, shortDescription, slimParameters } from "./local/prompt";
import type { PlayerCtx } from "./types";

/** models whose providers reject the `reasoning` parameter (learned at runtime) */
const NO_REASONING = new Set<string>();

/** OpenRouter by default; MINDFRONT_LLM_URL points every seat at another
 * OpenAI-compatible endpoint (the local sidecar in arena/local/serve.py). */
const OPENROUTER_URL = process.env.MINDFRONT_LLM_URL ?? "https://openrouter.ai/api/v1/chat/completions";

/** USD spent by every seat in this process (OpenRouter reports `usage.cost` per
 * response) and the ceiling after which seats stop calling models. */
export const spend = { usd: 0, budgetUsd: Infinity };
function charge(data: { usage?: { cost?: number } } | undefined): void {
  spend.usd += data?.usage?.cost ?? 0;
}

export interface RunPlayerOpts {
  url: string;
  token: string;
  model: string;
  name: string;
  persona: string;
  /** min ms between the start of two rounds, default 1000 */
  minGapMs?: number;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /** total tool calls executed per round before forcing a stop, default 8 */
  maxToolCallsPerRound?: number;
  signal?: AbortSignal;
  onRound?: (info: { latencyMs: number; calls: number; fallback: boolean }) => void;
  /** called once the pre-match briefing (manual read + written plan) is done */
  onBriefed?: (plan: string) => void;
}

type OpenAiTool = {
  type: "function";
  function: { name: string; description?: string; parameters: unknown };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractText(result: any): string {
  if (!Array.isArray(result?.content)) return "";
  return result.content
    .filter((c: { type: string; text?: string }) => c.type === "text" && typeof c.text === "string")
    .map((c: { text: string }) => c.text)
    .join("\n");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/**
 * Drives an already-connected MCP `client` with an OpenRouter model until
 * `opts.signal` aborts. Never throws; every HTTP/parse failure just skips
 * the round. Exported separately from `runPlayer` so self-checks can wire
 * a client to an in-memory fake server instead of a real HTTP one.
 */
export async function runPlayerWithClient(client: Client, opts: RunPlayerOpts): Promise<void> {
  const {
    model,
    name,
    persona,
    minGapMs = 1000,
    apiKey,
    maxToolCallsPerRound = 8,
    signal,
    onRound,
    onBriefed,
  } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const listed = await client.listTools();
  // "local/..." seats: a fine-tuned model on the local server, short prompt,
  // one-line tool descriptions and a compact observation (the manual is baked
  // in by training), no briefing, no OpenRouter-only fields. "localfull/..."
  // = the same transport with the full manual: the untuned baseline.
  const local = model.startsWith(LOCAL_MODEL_PREFIX) || model.startsWith("localfull/");
  const shortPrompt = model.startsWith(LOCAL_MODEL_PREFIX);
  const tools: OpenAiTool[] = listed.tools.filter((t) => !shortPrompt || LOCAL_TOOLS.has(t.name)).map((t) => ({
    type: "function",
    function: { name: t.name, description: shortPrompt ? shortDescription(t.description) : t.description, parameters: shortPrompt ? slimParameters(t.inputSchema) : t.inputSchema },
  }));
  const ctxLike = { model, name, persona } as PlayerCtx;
  const baseSystemPrompt = shortPrompt ? localSystemPrompt() : // trained without a persona line
    systemPrompt(ctxLike) +
    "\nYou act by calling tools. While observe reports phase \"spawn\", pick your start with `spawn(col,row)` from the grid it shows (consider where others already are), then wait for the match. Call `observe` any time for fresh state, `inspect_player` for details, action tools to act. Do not narrate: tool calls are the only output that matters. Stop calling tools when you are done for this round.";

  // The manual is identical every round: mark it cacheable (Anthropic needs the
  // explicit breakpoint, ~90% off cached input; OpenAI/Google/xAI cache anyway).
  const systemMessage = local
    ? { role: "system", content: baseSystemPrompt }
    : { role: "system", content: [{ type: "text", text: baseSystemPrompt, cache_control: { type: "ephemeral" } }] };

  let lastResult = "";

  // Pre-match briefing: the manual is the system prompt; make the model process
  // it by writing its own plan before the spawn phase. The plan rides along in
  // every later observation as `plan`.
  let plan = "";
  if (local) onBriefed?.("");
  else try {
    const res = await fetchImpl(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey ?? process.env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://github.com/effe-exe/mindfront",
        "X-Title": "MindFront",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1500, // reasoning tokens count against it: 900 cut Gemini Flash Lite mid-plan
        usage: { include: true },
        ...(NO_REASONING.has(model) ? {} : { reasoning: { effort: "low" } }),
        messages: [
          systemMessage,
          {
            role: "user",
            content:
              "PRE-MATCH BRIEFING. The match has not started. Read the manual above carefully, then write " +
              "your private game plan in at most 250 words: (1) how you will choose your spawn cell and what " +
              "you reject; (2) your first three purchases and the trigger for each; (3) when you will use " +
              "boats and against whom; (4) your alliance and betrayal policy; (5) your stop-loss rule; " +
              "(6) three mechanics from the manual you consider decisive. Plain text, no tools.",
          },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.ok) {
      const data = await res.json();
      charge(data);
      plan = String(data?.choices?.[0]?.message?.content ?? "").trim().slice(0, 2000);
    } else {
      console.warn(`player[${model}]: briefing HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(`player[${model}]: briefing failed: ${String(err).slice(0, 120)}`);
  }
  if (!local) onBriefed?.(plan);

  let overBudget = false;
  while (!signal?.aborted) {
    if (spend.usd >= spend.budgetUsd) {
      if (!overBudget) console.warn(`player[${model}]: match spend $${spend.usd.toFixed(2)} reached the --budget ceiling; no more model calls`);
      overBudget = true;
      await sleep(5000, signal);
      continue;
    }
    const roundStart = Date.now();
    let fallback = false;
    let calls = 0;
    const resultsSummary: string[] = [];

    try {
      const obsRaw = extractText(await client.callTool({ name: "observe", arguments: {} }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let obsObj: any;
      try {
        obsObj = JSON.parse(obsRaw);
      } catch {
        obsObj = { raw: obsRaw };
      }
      if (obsObj?.ok === false && /not started/.test(String(obsObj.reason))) {
        // Lobby: nothing to decide yet, do not spend a model call.
        await sleep(2000, signal);
        continue;
      }
      if (shortPrompt && obsObj?.me !== undefined) obsObj = compactObs(obsObj);
      obsObj.plan = plan;
      // the trained seat saw plan: "" and lastResult: "" in every example
      obsObj.lastResult = shortPrompt ? "" : lastResult;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const messages: any[] = [
        systemMessage,
        { role: "user", content: JSON.stringify(obsObj) },
      ];

      roundLoop: while (calls < maxToolCallsPerRound) {
        const withReasoning = !NO_REASONING.has(model);
        // MINDFRONT_DUMP=<file>: append every request, to diff against the training data
        if (process.env.MINDFRONT_DUMP) fs.appendFileSync(process.env.MINDFRONT_DUMP, JSON.stringify({ messages, tools }) + "\n");
        const res = await fetchImpl(OPENROUTER_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey ?? process.env.OPENROUTER_API_KEY}`,
            "HTTP-Referer": "https://github.com/effe-exe/mindfront",
            "X-Title": "MindFront",
          },
          body: JSON.stringify({
            // mlx_lm.server serves the model it was started with under "default_model"
            model: local ? "default_model" : model,
            max_tokens: 1500,
            // a cloned human policy must be sampled: greedy decoding holds forever (offline check 16 Sep)
            ...(local ? { temperature: Number(process.env.MINDFRONT_TEMP ?? 1) } : {}),
            ...(local
              ? {}
              : {
                  usage: { include: true },
                  // Some models have no provider that accepts the reasoning knob; retried without it below.
                  ...(withReasoning ? { reasoning: { effort: "low" } } : {}),
                  // Only providers that honor tools/tool_choice; Llama was routed to one that did not.
                  provider: { require_parameters: true },
                }),
            messages,
            tools,
            tool_choice: "auto",
          }),
          // the sidecar prefills a few thousand tokens on the GPU before answering
          signal: AbortSignal.timeout(local ? 180_000 : 30_000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          if (withReasoning && (res.status === 404 || res.status === 400)) {
            NO_REASONING.add(model);
            console.warn(`player[${model}]: HTTP ${res.status}, retrying without the reasoning parameter`);
            continue roundLoop;
          }
          console.warn(`player[${model}]: HTTP ${res.status} ${body.slice(0, 200)}`);
          fallback = true;
          break roundLoop;
        }
        const data = await res.json();
        charge(data);
        // "low" effort is a hint some models ignore (DeepSeek v3.2: 1,200 reasoning
        // tokens, 49 s per round); once one over-thinks, stop asking it to think.
        const reasoningTokens = data?.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
        if (withReasoning && reasoningTokens > 800) {
          NO_REASONING.add(model);
          console.warn(`player[${model}]: ${reasoningTokens} reasoning tokens at low effort, dropping the reasoning parameter`);
        }
        const message = data?.choices?.[0]?.message;
        const toolCalls = message?.tool_calls;
        if (!Array.isArray(toolCalls) || toolCalls.length === 0) break roundLoop;

        messages.push({ role: "assistant", content: message.content ?? null, tool_calls: toolCalls });
        for (const tc of toolCalls) {
          if (calls >= maxToolCallsPerRound) break;
          calls++;
          const toolName: string = tc?.function?.name ?? "";
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let args: any = {};
          try {
            args = JSON.parse(tc?.function?.arguments || "{}");
          } catch {
            // leave args = {}
          }
          let resultText: string;
          try {
            const callRes = await client.callTool({ name: toolName, arguments: args });
            resultText = extractText(callRes);
          } catch (err) {
            resultText = `error: ${String(err).slice(0, 200)}`;
          }
          resultsSummary.push(`${toolName}(${JSON.stringify(args)}) -> ${resultText.slice(0, 200)}`);
          messages.push({ role: "tool", tool_call_id: tc.id, content: resultText });
        }
        // one assistant turn per observation, as in the training data
        if (shortPrompt) break roundLoop;
      }
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
      console.warn(`player[${model}]: ${isTimeout ? "timeout" : String(err).slice(0, 200)}`);
      fallback = true;
    }

    if (resultsSummary.length > 0) lastResult = resultsSummary.slice(-5).join("; ");

    onRound?.({ latencyMs: Date.now() - roundStart, calls, fallback });

    const elapsed = Date.now() - roundStart;
    await sleep(minGapMs - elapsed, signal);
  }
}

/** Connects to the MCP server at `opts.url` and runs the player loop until `opts.signal` aborts. */
export async function runPlayer(opts: RunPlayerOpts): Promise<void> {
  const client = new Client({ name: "mindfront-player", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(opts.url), {
    requestInit: { headers: { Authorization: `Bearer ${opts.token}` } },
  });
  await client.connect(transport);
  try {
    await runPlayerWithClient(client, opts);
  } finally {
    await client.close().catch(() => {});
  }
}

// ---------- self-check ----------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void (async () => {
    const CANNED_OBS = {
      tick: 500,
      minute: 5,
      me: { id: 1, name: "Tester", tiles: 1000 },
      neighbors: [],
      unclaimedLandAdjacent: true,
      reachableByBoat: [],
      leaderboard: [],
      canBuild: [],
      buildCosts: {},
      recentEvents: [],
      lastResult: "",
      notes: "",
    };

    const calls: { tool: string; args: unknown }[] = [];
    const server = new McpServer({ name: "fake-mindfront", version: "1.0.0" });
    server.registerTool("observe", { description: "state" }, async () => {
      calls.push({ tool: "observe", args: {} });
      return { content: [{ type: "text", text: JSON.stringify(CANNED_OBS) }] };
    });
    server.registerTool(
      "expand",
      { description: "expand", inputSchema: { ratio: z.number().optional() } },
      async (args) => {
        calls.push({ tool: "expand", args });
        return { content: [{ type: "text", text: "ok" }] };
      },
    );
    server.registerTool(
      "attack",
      { description: "attack", inputSchema: { target: z.number(), ratio: z.number().optional() } },
      async (args) => {
        calls.push({ tool: "attack", args });
        return { content: [{ type: "text", text: "ok" }] };
      },
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-player", version: "1.0.0" });
    await client.connect(clientTransport);

    let fetchCall = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fetchImpl = (async () => {
      fetchCall++;
      if (fetchCall === 1) {
        // pre-match briefing: a plain-text plan
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: "Plan: expand, then boats." } }] }),
          text: async () => "",
        };
      }
      if (fetchCall === 2) {
        // round 1, first ask: three tool calls
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  tool_calls: [
                    { id: "1", function: { name: "observe", arguments: "{}" } },
                    { id: "2", function: { name: "expand", arguments: JSON.stringify({ ratio: 0.3 }) } },
                  ],
                },
              },
            ],
          }),
          text: async () => "",
        };
      }
      if (fetchCall === 3) {
        // round 1, follow-up: done
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: {} }] }),
          text: async () => "",
        };
      }
      // round 2: HTTP 429
      return { ok: false, status: 429, json: async () => ({}), text: async () => "rate limited" };
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    let rounds = 0;
    let briefedPlan = "";
    const seenFallback: boolean[] = [];
    await runPlayerWithClient(client, {
      url: "unused",
      token: "unused",
      model: "test/model",
      name: "Tester",
      persona: "test persona",
      minGapMs: 1,
      apiKey: "x",
      fetchImpl,
      signal: controller.signal,
      onBriefed: (plan) => briefedPlan = plan,
      onRound: (info) => {
        rounds++;
        seenFallback.push(info.fallback);
        if (rounds >= 2) controller.abort();
      },
    });

    assert.equal(briefedPlan, "Plan: expand, then boats.", "briefing plan should be captured");
    assert.equal(rounds, 2, "loop should run exactly 2 rounds before abort");
    assert.deepEqual(seenFallback, [false, true], "round 1 ok, round 2 falls back on HTTP 429");
    assert.ok(
      calls.some((c) => c.tool === "expand"),
      "expand should have been invoked on the fake server",
    );

    await client.close();
    await server.close();

    console.log("player self-check OK");
  })();
}
