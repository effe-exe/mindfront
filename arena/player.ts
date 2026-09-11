// Package P2: generic MCP-client player loop for OpenRouter models.
// Talks to arena/mcp/server.ts (or any MCP server exposing the same tool
// surface) over the SDK's Client, drives it with an OpenRouter model.
import assert from "node:assert";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { systemPrompt } from "./decide";
import type { PlayerCtx } from "./types";

/** models whose providers reject the `reasoning` parameter (learned at runtime) */
const NO_REASONING = new Set<string>();

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

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
  } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const listed = await client.listTools();
  const tools: OpenAiTool[] = listed.tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));

  const ctxLike = { model, name, persona } as PlayerCtx;
  const baseSystemPrompt =
    systemPrompt(ctxLike) +
    "\nYou act by calling tools. Call `observe` any time for fresh state, `inspect_player` for details, action tools to act, and `say` only when your plan changes or something notable happens (at most every fifth round, under 15 words, in character). Do not narrate routine moves. Stop calling tools when you are done for this round.";

  let notes = "";
  let lastResult = "";

  while (!signal?.aborted) {
    const roundStart = Date.now();
    let fallback = false;
    let calls = 0;
    const resultsSummary: string[] = [];
    let sawSay: string | undefined;

    try {
      const obsRaw = extractText(await client.callTool({ name: "observe", arguments: {} }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let obsObj: any;
      try {
        obsObj = JSON.parse(obsRaw);
      } catch {
        obsObj = { raw: obsRaw };
      }
      obsObj.notes = notes;
      obsObj.lastResult = lastResult;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const messages: any[] = [
        { role: "system", content: baseSystemPrompt },
        { role: "user", content: JSON.stringify(obsObj) },
      ];

      roundLoop: while (calls < maxToolCallsPerRound) {
        const withReasoning = !NO_REASONING.has(model);
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
            max_tokens: 1500,
            // Some models have no provider that accepts the reasoning knob; retried without it below.
            ...(withReasoning ? { reasoning: { effort: "low" } } : {}),
            // Only providers that honor tools/tool_choice; Llama was routed to one that did not.
            provider: { require_parameters: true },
            messages,
            tools,
            tool_choice: "auto",
          }),
          signal: AbortSignal.timeout(20_000),
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
            if (toolName === "say" && typeof args.text === "string") sawSay = args.text;
          } catch (err) {
            resultText = `error: ${String(err).slice(0, 200)}`;
          }
          resultsSummary.push(`${toolName}(${JSON.stringify(args)}) -> ${resultText.slice(0, 200)}`);
          messages.push({ role: "tool", tool_call_id: tc.id, content: resultText });
        }
      }
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
      console.warn(`player[${model}]: ${isTimeout ? "timeout" : String(err).slice(0, 200)}`);
      fallback = true;
    }

    if (resultsSummary.length > 0) lastResult = resultsSummary.slice(-5).join("; ");
    if (sawSay !== undefined) notes = sawSay;

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
    server.registerTool(
      "say",
      { description: "say", inputSchema: { text: z.string() } },
      async (args) => {
        calls.push({ tool: "say", args });
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
                    { id: "3", function: { name: "say", arguments: JSON.stringify({ text: "go" }) } },
                  ],
                },
              },
            ],
          }),
          text: async () => "",
        };
      }
      if (fetchCall === 2) {
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
      onRound: (info) => {
        rounds++;
        seenFallback.push(info.fallback);
        if (rounds >= 2) controller.abort();
      },
    });

    assert.equal(rounds, 2, "loop should run exactly 2 rounds before abort");
    assert.deepEqual(seenFallback, [false, true], "round 1 ok, round 2 falls back on HTTP 429");
    assert.ok(
      calls.some((c) => c.tool === "expand"),
      "expand should have been invoked on the fake server",
    );
    assert.ok(
      calls.some((c) => c.tool === "say"),
      "say should have been invoked on the fake server",
    );

    await client.close();
    await server.close();

    console.log("player self-check OK");
  })();
}
