// Download archived public FFA games (full records with every intent) from the
// OpenFront public API into arena/records/human/<gameID>.json.
//   npx tsx arena/local/fetch.ts [--days 14] [--max 300] [--min-players 8] [--map <mapName>] [--out arena/records/human]
// Listing windows are capped at 2 days by the API; records are fetched one per
// second to stay polite. Existing files are skipped, so re-runs only add.
import fs from "fs";
import path from "path";

const API = "https://api.openfront.io/public";
const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? dflt : process.argv[i + 1];
};
const days = Number(arg("--days", "14"));
const max = Number(arg("--max", "300"));
const minPlayers = Number(arg("--min-players", "8"));
const mapName = arg("--map", "");
const out = arg("--out", "arena/records/human");
fs.mkdirSync(out, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function listWindow(start: Date, end: Date): Promise<{ game: string; numPlayers: number; start: string }[]> {
  const games: { game: string; numPlayers: number; start: string }[] = [];
  for (let offset = 0; ; offset += 1000) {
    const mapParam = mapName ? `&gameMap=${encodeURIComponent(mapName)}` : "";
    const url = `${API}/games?start=${start.toISOString()}&end=${end.toISOString()}&type=Public&mode=${encodeURIComponent("Free For All")}&limit=1000&offset=${offset}${mapParam}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const page = (await res.json()) as { game: string; numPlayers: number; start: string }[];
    games.push(...page);
    const range = res.headers.get("content-range") ?? "";
    const total = Number(range.split("/")[1] ?? 0);
    if (page.length < 1000 || offset + 1000 >= total) break;
    await sleep(1000);
  }
  return games;
}

async function main() {
  const now = Date.now();
  const candidates: { game: string; numPlayers: number; start: string }[] = [];
  for (let d = 0; d < days; d += 2) {
    const end = new Date(now - d * 86_400_000);
    const start = new Date(end.getTime() - 2 * 86_400_000);
    const games = await listWindow(start, end);
    candidates.push(...games.filter((g) => g.numPlayers >= minPlayers));
    console.log(`${start.toISOString().slice(0, 10)}..${end.toISOString().slice(0, 10)}: ${games.length} games, ${candidates.length} candidates so far`);
    await sleep(1000);
  }
  // Biggest lobbies first: more human decisions per record.
  candidates.sort((a, b) => b.numPlayers - a.numPlayers || b.start.localeCompare(a.start));
  let fetched = 0;
  for (const c of candidates) {
    if (fetched >= max) break;
    const file = path.join(out, `${c.game}.json`);
    if (fs.existsSync(file)) continue;
    const res = await fetch(`${API}/game/${c.game}`);
    if (!res.ok) {
      console.warn(`${c.game}: HTTP ${res.status}`);
      await sleep(2000);
      continue;
    }
    const text = await res.text();
    fs.writeFileSync(file, text);
    fetched++;
    console.log(`${c.game} ${c.numPlayers} players ${(text.length / 1e6).toFixed(1)} MB (${fetched}/${max})`);
    await sleep(1000);
  }
  console.log(`done: ${fetched} new records in ${out}`);
}

void main();
