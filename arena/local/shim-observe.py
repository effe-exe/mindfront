#!/usr/bin/env python3
"""Patch a copy of arena/observe.ts so it compiles against the engine commit the
public archive was played on (older than our fork). Usage:
  python3 arena/local/shim-observe.py <worktree>/arena/observe.ts
The observation shape stays identical; only the data sources differ."""
import sys
p = sys.argv[1]; s = open(p).read()
rep = [
    ("Number(p.goldEarned())", "goldStat(p, -1)"),
    ("Number(p.tradeGold())", "goldStat(p, 2)"),
    ("Number(p.trainGold())", "goldStat(p, 4) + goldStat(p, 5)"),
    ("const tiles = p.tileChangeVersion();", "const tiles = game.ticks();"),
    ("const water = game.map().waterVersion();", "const water = 0;"),
    ("game.totalLandTiles()", "Math.max(0, game.numLandTiles() - game.numTilesWithFallout())"),
]
for a, b in rep:
    n = s.count(a)
    assert n >= 1, a
    s = s.replace(a, b)
s = s.replace("function round1(n: number): number {", '''/** old engine: gold by source lives in the stats ledger (work 0, war 1, trade 2, steal 3, train 4/5); -1 = all */
let shimGame: Game;
function goldStat(p: Player, index: number): number {
  const g = (shimGame.stats().getPlayerStats(p)?.gold ?? []) as bigint[];
  return Number(index < 0 ? g.reduce((a, b) => a + b, 0n) : (g[index] ?? 0n));
}

function round1(n: number): number {''', 1)
s = s.replace("export function trackHistory(game: Game): void {", "export function trackHistory(game: Game): void {\n  shimGame = game;", 1)
open(p, "w").write(s)
print("shimmed", p)
