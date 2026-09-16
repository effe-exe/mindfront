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

export function localSystemPrompt(): string {
  return (
    "You are a MindFront seat: a player in OpenFront, a real-time territory strategy game, " +
    "acting only through the tools. Each round you receive one observation (JSON) and answer " +
    "with the tool calls you want executed now; several calls per round are fine; answer with " +
    "no tool call when nothing is worth doing. Targets are the numeric ids in the observation."
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
/** One of the seat's own recent calls, as the observation shows it (seconds ago). */
export type RecentAction = { ago: number; name: string; args: Record<string, unknown> };
export const RECENT_SECONDS = 10;
const FAR_FIELDS = ["id", "name", "kind", "tiles", "troops", "gold", "relationToMe", "allied", "direction", "distance"];
const NEAR_DROP = new Set(["allies", "betrayals", "maxTroops", "coastal", "relation", "teammate", "traitorTicksLeft", "distance", "sharesSea"]);
const ME_DROP = new Set(["bbox", "income", "team", "center", "cities", "ports", "defensePosts", "silos", "immuneUntilTick", "traitorTicksLeft", "betrayals", "pendingRequestExpiry", "betrayalCascade", "underConstruction"]);
// Constant in training (always empty or null there), so the trained seat never sees them.
const TOP_DROP = ["game", "buildCosts", "nukes", "recentEvents", "globalEvents", "lastResult", "notes", "plan", "build"];
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
 * tails cut (≤8 neighbours without the derived fields, ≤3 far dossiers of 10
 * fields, ≤6 units as id/type/x/y, zero-valued structure counts dropped, no
 * build table / costs / events) plus the seat's own calls of the last
 * RECENT_SECONDS. Applied identically at training (arena/local/dataset.ts) and
 * inference (arena/player.ts). ponytail: ~1.3k tokens instead of ~5k; widen
 * when a tuned seat provably misses something. */
export function compactObs(obs: Record<string, unknown>, recent: RecentAction[] = []): Record<string, unknown> {
  const o = { ...obs } as Record<string, unknown>;
  for (const k of TOP_DROP) delete o[k];
  const me: Dossier = {};
  for (const [k, v] of Object.entries(o.me as Dossier)) if (!ME_DROP.has(k)) me[k] = v;
  me.structures = nonZero(me.structures);
  if (Array.isArray(me.units)) {
    me.units = (me.units as Dossier[]).slice(0, 6).map((u) => ({ id: u.id, type: u.type, ...(Number(u.level) > 1 ? { level: u.level } : {}), x: u.x, y: u.y }));
  }
  o.me = me;
  o.neighbors = ((o.neighbors as Dossier[]) ?? []).slice(0, 8).map((n) => {
    const out: Dossier = {};
    for (const [k, v] of Object.entries(n)) if (!NEAR_DROP.has(k)) out[k] = k === "structures" ? nonZero(v) : v;
    return out;
  });
  o.reachableByBoat = ((o.reachableByBoat as Dossier[]) ?? []).slice(0, 3).map((n) => pick(n, FAR_FIELDS));
  o.leaderboard = ((o.leaderboard as Dossier[]) ?? []).slice(0, 3).map((n) => pick(n, FAR_FIELDS));
  o.myRecentActions = recent;
  return o;
}
