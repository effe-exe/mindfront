// Dump the arena's MCP tool list (OpenAI function format) to arena/local/tools.json
// so training examples render the same tools block the live seat sees.
//   npx tsx arena/local/tools.ts
import fs from "fs";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createArenaServer } from "../mcp/server";
import { shortDescription, slimParameters } from "./prompt";

async function main() {
  const { server } = createArenaServer({ game: () => null as never, seats: new Map(), onEvent: () => {}, rules: "" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tools-dump", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const tools = (await client.listTools()).tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: shortDescription(t.description), parameters: slimParameters(t.inputSchema) },
  }));
  const out = path.resolve(path.dirname(new URL(import.meta.url).pathname), "tools.json");
  fs.writeFileSync(out, JSON.stringify(tools, null, 1) + "\n");
  console.log(`${tools.length} tools -> ${out}`);
  process.exit(0);
}
void main();
