// The local seat's system prompt: short, no manual. Used verbatim by the
// arena (arena/player.ts) and by the dataset builder (arena/local/dataset.ts)
// so that training and inference see the same text.
export const LOCAL_MODEL_PREFIX = "local/";

/** The trained seat only ever calls action tools (the player loop calls
 * observe itself; the read-only helpers and spawn are not in the training
 * labels), so it is not shown them: ~1.5k tokens less per round. */
export const LOCAL_TOOLS = new Set([
  "expand", "attack", "boat", "ally", "accept_alliance", "reject_alliance", "break_alliance",
  "extend_alliance", "donate", "recall_boats", "embargo", "move_warship", "build", "upgrade",
  "retreat", "nuke", "emoji", "chat",
]);

export function localSystemPrompt(persona: string): string {
  return (
    "You are a MindFront seat: a player in OpenFront, a real-time territory strategy game, " +
    "acting only through the tools. Each round you receive one observation (JSON) and answer " +
    "with the tool calls you want executed now; several calls per round are fine; answer with " +
    "no tool call when nothing is worth doing. Targets are the numeric ids in the observation." +
    (persona ? `\n\n${persona}` : "")
  );
}

/** The local seat sees one-sentence tool descriptions (the fine-tune carries the
 * rest); training (arena/local/tools.ts) and inference (arena/player.ts) both use this. */
export function shortDescription(description: string | undefined): string {
  const first = (description ?? "").split(/(?<=\.)\s/)[0] ?? "";
  return first.length > 160 ? first.slice(0, 157) + "..." : first;
}

/** Strip schema noise (draft URLs, ±2^53 integer bounds) from a tool's JSON schema. */
export function slimParameters(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(slimParameters);
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === "$schema") continue;
    if ((k === "minimum" || k === "maximum") && typeof v === "number" && Math.abs(v) === 9007199254740991) continue;
    out[k] = slimParameters(v);
  }
  return out;
}

type Dossier = Record<string, unknown>;
const FAR_FIELDS = ["id", "name", "kind", "tiles", "troops", "gold", "relationToMe", "allied", "teammate", "sharesSea", "direction", "distance", "tilesDelta1m"];
const NEAR_DROP = new Set(["allies", "betrayals", "maxTroops", "coastal"]);
function pick(d: Dossier, fields: string[]): Dossier {
  const out: Dossier = {};
  for (const f of fields) if (d[f] !== undefined) out[f] = d[f];
  return out;
}
function nonZero(rec: unknown): unknown {
  if (rec === null || typeof rec !== "object") return rec;
  return Object.fromEntries(Object.entries(rec as Record<string, number>).filter(([, v]) => v !== 0));
}

/** The local seat's observation: the arena's `observe()` output with the long
 * tails cut (far dossiers to their essentials, ≤12 units, no prose notes,
 * zero-valued structure counts dropped, no build table, far dossiers to 13
 * fields). Applied identically at training (arena/local/dataset.ts) and
 * inference (arena/player.ts). ponytail: ~1.5k tokens instead of ~5k; widen
 * when a tuned seat provably misses something. */
export function compactObs(obs: Record<string, unknown>): Record<string, unknown> {
  const o = { ...obs } as Record<string, unknown>;
  const me = { ...(o.me as Dossier) };
  delete me.bbox;
  me.structures = nonZero(me.structures);
  me.underConstruction = nonZero(me.underConstruction);
  if (Array.isArray(me.units)) me.units = (me.units as Dossier[]).slice(0, 8);
  delete me.income;
  o.me = me;
  o.neighbors = ((o.neighbors as Dossier[]) ?? []).map((n) => {
    const out: Dossier = {};
    for (const [k, v] of Object.entries(n)) if (!NEAR_DROP.has(k)) out[k] = k === "structures" ? nonZero(v) : v;
    return out;
  });
  o.reachableByBoat = ((o.reachableByBoat as Dossier[]) ?? []).slice(0, 4).map((n) => pick(n, FAR_FIELDS));
  o.leaderboard = ((o.leaderboard as Dossier[]) ?? []).map((n) => pick(n, FAR_FIELDS));
  delete o.build; // canBuild + buildCosts carry what the trained seat uses
  return o;
}
