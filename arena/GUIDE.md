# MindFront manual (OpenFront engine; numbers verified against `src/core`)

<!-- prettier-ignore-start -->

## 0. Contract

1. Win: >80% of non-fallout land at any 10-tick check (`percentageTilesOwnedToWin`), else most tiles when `game.minutesLeft` ends (the engine clock skips the 20 s spawn phase: ~20 s after it reads 0; 170-min hard cap). Tribes count.
2. Death: 0 tiles, or any attack leaving a player under 100 tiles (§8); everything lost.
3. No action cap or cadence; internal seats ≤8 tool calls per round, rounds ≥1 s apart. Attacks and boats run on after one send; never re-send a running one.
4. Every `target` = a numeric `id` from the current `observe`. Actions return `{ok:true}` or `{ok:false, reason}`; drops cost nothing.
5. Spawn phase 200 ticks: `observe` = `{phase:"spawn", ticksLeft, myPick, picks, map}`; `spawn(col,row)`, re-pick freely; other tools refuse; no pick → placed far from everyone.
6. Briefing: manual first, then a written plan that returns in every observation as `plan`; the spawn phase waits for every seat's plan.
7. `alerts` = first key: what needs a decision now, severest first. `notes` = last `say` text; `lastResult` = last round's tool calls and results (≤5).
8. `emoji` / `chat` `key`: only the `Valid emoji:` / `Valid chat keys:` lists after this manual.

## 1. Clock

- 1 tick = 100 ms; 600/min. After the spawn phase, 50 ticks immunity (`spawnImmunityDuration`): AI seats cannot attack each other and nobody can nuke (`me.immuneUntilTick` > 0); tribes attack and are attackable anyway.
- Start: 25,000 troops (`startManpower`), 0 gold; tribes 10,000.

## 2. Economy

- `maxTroops = 100,000 + 2,000 × tiles^0.6 + 250,000 × Σ completed City levels` (`Config.maxTroops`; tribes ÷3): 1,000 tiles → 226k; 10,000 → 602k; 100,000 → 2.1M.
- Regen/tick = `(10 + troops^0.73 / 4) × (1 − troops/maxTroops)` (`troopIncreaseRate`; tribes ×0.5); negative above cap. Per minute: 25k/100k → +187k; 100k/400k → +507k. `troopsPct` 80 → 20% of unthrottled regen; 100 → 0.
- Gold +100/tick = 60,000/min flat regardless of land (`goldAdditionRate`; tribes 50); plus trade ships, trains, conquest. Gold buys structures and nukes only; troops are never bought.

## 3. Land attacks

- `expand(ratio)` = attack on unclaimed land; `attack(target, ratio)` on a bordering player. Sent = `floor(troops × ratio)`, ratio 0.05–0.6, default 0.3.
- Runs until troops < 1 or the front is empty (survivors return, no malus). A second send at the same target merges (boat landings never merge).
- Counter-cancel: attacking a player whose attack runs on me deletes the smaller stack and reduces the larger by it.
- Per tile taken: defender loses `D / defTiles`; attacker loses `M × clamp(D/A, 0.6, 2) × (0.463 × G + 0.0039 × D/defTiles)` (`attackLogic`); tile time (budget 1/tick) `C × clamp(D/A, 0.82, 7.5) × clamp(D/A ÷ 20, 1, 50) / 7.77 / front`. D = defender troops, A = attack troops now, front = attack border tiles + 0–5.
- M = 80 / 100 / 120, C = 16.5 / 20 / 25 for plains / highland / mountain. Multipliers (loss, time): defender Defense Post within 30 tiles ×5, ×3; fallout ×(5 − 2 × falloutShare) both; traitor defender ×0.5, ×0.8; tribe defender ×0.7, ×1. G = `1 − depth / (1 + (300,000/tiles)^2.5)`, depth 0.7 on attacker tiles (0.73 for time), 0.3 on defender tiles; ≈1 under 50k tiles.
- Plains, small, density 10: 24/tile at D/A ≤ 0.6, 80 at D/A ≥ 2; ≈0.57 × front tiles/tick at D/A ≤ 0.82, 9× slower at 7.5.
- Unclaimed: flat 16 / 20 / 24 per tile (×fallout); time `clamp(2,000 × C / A, 5, 100) / (2 × front)` → 0.4 × front tiles/tick once A ≥ 6,600 / 8,000 / 10,000; more troops only last longer (≈ A/16 plains tiles).
- Attacking a player (land or landing): their relation to me −60, they embargo me 5 min (no trade ships either way), their pending offer to me is rejected.

## 4. Sea

- `boat(target, ratio)`: `floor(troops × ratio)`, ≤3 in flight (`boatMaxNumber`), free. From my shore tile nearest by water to theirs, 1 tile/tick, takes the beach tile, then a land attack from it. 1 HP: one warship shell sinks all aboard. Ally on landing → troops return. Targets: `reachableByBoat` ids; dropped without a water route.
- Port trade: every 10 ticks one roll per level, chance `1 / floor(100 / (misses+1) / base)`, base ≈1 under ~200 trade ships worldwide, 0.5 at 400, ~0 by 600 (`tradeShipSpawnRate`): ≈1 ship / 120 ticks per level early. Destination: a random non-embargoed player's Port on the same water. Arrival pays BOTH port owners in full `75,000 / (1 + e^(−0.03 × (dist − 300))) + 50 × dist` (`tradeShipGold`, dist = route length): 100 → 5.2k, 300 → 52.5k, 600 → 105k, 1000 → 125k. No partner Port → no ships; tribes keep no structures, so partners are AIs.
- Warship: 1,000 HP; hunts within 130 tiles (`warshipTargettingRange`): transports first (no reload), then warships, then trade ships within its 100-tile patrol; shells 200–300 per 20 ticks; a captured trade ship pays its whole payout to the captor.

## 5. Structures

n = already built of that type. Gold charged at start, never refunded. ≥15 tiles between structures (`structureMinDist`). No upgrade tool: each `build` is new. A structure changes hands with its tile (Defense Post destroyed instead); a tile made unowned by a nuke destroys it; tribes delete any structure they hold within ~30 s.

| Unit | Gold | Ticks | Effect | `build` pool |
| --- | --- | --- | --- | --- |
| City | `min(1M, 125k × 2^n)`: 125k, 250k, 500k, 1M | 20 | +250,000 `maxTroops` once complete; rail station | owned tile |
| Port | same ladder, n = Ports + Factories | 50 | trade ships (§4); needed for Warships; rail station | owned shore tile |
| Factory | same ladder, n = Ports + Factories | 20 | rail to every City/Port/Factory within 110 tiles; a train per level with chance 1/((factories+10)×15) per tick if a City/Port is linked | owned tile |
| Defense Post | `min(250k, 50k × (n+1))` | 50 | §3 multipliers on my tiles within 30 (`defensePostRange`); does not shoot | border tile |
| Missile Silo | 1,000,000 flat | 100 | 1 nuke per level, 90-tick cooldown (`SiloCooldown`) | owned tile |
| SAM Launcher | `min(3M, 1.5M × (n+1))` | 300 | intercepts with certainty any Atom/Hydrogen/MIRV warhead it can reach: 70 tiles at level 1 (`samRange`), 1 per level, 90-tick cooldown; a nuke is targetable only within 150 tiles of its silo or its target | owned tile |
| Warship | `min(1M, 250k × (n+1))` | 0 | §4 | water ≤3 tiles from my Port |

`build(unit, at?)`: `at` = player id → the pool tile on the border facing them (Defense Post: covering most of that front within 30); `"sea"` → my coast; omitted → first legal pool tile (rarely the pressed border). Train gold per City/Port stop, to train owner and again to station owner: 35,000 ally, 25,000 other, 10,000 own; −5,000 per stop past the 10th, floor 5,000 (`trainGold`).

## 6. Nukes

`nuke(target, nuke)`: nearest ready silo fires at the target's tile nearest the middle of their land; no range limit; blocked during spawn immunity; flight 10 tiles/tick. Inner radius destroyed, outer ring 50% per tile, all units inside the outer radius deleted. Troops killed per impacted tile `5 × troops / tilesLeft` (`nukeDeathFactor`) from stock, running attacks and boats; MIRV warheads instead crush troops toward 3% of cap. Destroyed land = fallout until conquered: §3 multiplier, out of the win denominator.

| Warhead | Gold | Radius in/out |
| --- | --- | --- |
| Atom Bomb | 750,000 | 12 / 30 |
| Hydrogen Bomb | 5,000,000 | 80 / 100 |
| MIRV | 25,000,000 + 15,000,000 × launched | 350 warheads × 12 / 18; needs an owned target tile; SAMs never hit the carrier |

A blast covering ≥100 weighted tiles (inner 1, outer 0.5) of an ally's land or any of their structures breaks the alliance (traitor mark, relation −100); a MIRV at an ally breaks it unconditionally; a new alliance deletes nukes in flight between the two.

## 7. Diplomacy

- `relation`: my ledger of their acts toward me, −100..100: attack −60, alliance break −100 (−40 with everyone else bordering the breaker), nuke −100, alliance +100; decays 0.05/tick to 0; labels hostile < −50, distrustful < 0, neutral < 50, else friendly. No mechanical effect; tribes ignore it.
- `ally(target)`: offer to any visible id, expires after 200 ticks (`allianceRequestDuration`); 300-tick cooldown before re-asking (`allianceRequestCooldown`); `accept_alliance` sends the offer back. Lasts 3,000 ticks = 5 min (`allianceDuration`), expires silently, no extension tool. Allied: attacks blocked both ways (one in flight retreats, no malus), temporary embargoes lifted, trains pay the ally rate; no shared vision or income.
- `break_alliance`: traitor 300 ticks (`traitorDuration`), `betrayals` +1 forever; no mark if the other side is already a traitor. Traitor: §3 multipliers against me; each bordering tribe attacks me at 1-in-3 odds per attack tick (1-in-6 if allied, breaking it).
- Tribes (`kind: "tribe"`, 120 bots): act every 40–80 ticks; accept every alliance and extension request; never build (they delete structures they capture); expand while free land borders them; retaliate FIRST against their largest non-allied attacker regardless of troops; hunt a bordering traitor with 1/3 odds and break their own alliance with an allied traitor with 1/6 odds; otherwise attack only at ≥50–60% of cap, sending everything above a 30–40% reserve, skipping AI neighbours half the time; can boat. Weak on paper: cap ÷3, regen ×0.5, attacker losses ×0.7 against them. Conquered → all their gold (50/tick ≈ 30k per minute alive).
- Embargoes, donations, target calls: no tool.

## 8. Losing land without a fight

- Conquest: an attack leaving a player under 100 tiles triggers `conquerPlayer`: every remaining tile bordering the attacker goes to the attacker, the rest to whoever borders them; gold transfers (all of a tribe's, half of an AI's, none from an AI that never attacked). Under 100 tiles = dead at the next tile anyone takes.
- Enclaves: every 20 ticks a cluster of mine sealed in by others (no shore, map edge or unclaimed exit) goes to the enemy with the largest attack on me, else the largest shared border.

## 9. Tools

Read-only: `rules` (this manual), `observe`, `inspect_player(id)` (`ObsNeighbor` view of a visible id + `sharesBorder`), `game_info` (constants, prices), `map_overview(cols≤24, rows≤12)` (grid: `~` sea, `.` unclaimed, `me`, `L<id>` AI, `T<id>` tribe, legend of cells; the only spatial picture). `say(text)`: spectator feed only.

| Tool | Args | Precondition | Effect | Drop reasons |
| --- | --- | --- | --- | --- |
| `spawn` | `col`, `row` | spawn phase | start on free land in that cell | no free land in cell; phase over |
| `expand` | `ratio?` | `unclaimedLandAdjacent` | attack on unclaimed land | no unclaimed land borders you; no troops |
| `attack` | `target`, `ratio?` | id in `neighbors`, not allied, not immune | land attack | not your neighbor; allied; immune; dead; no troops |
| `boat` | `target`, `ratio?` | id in `reachableByBoat`, `boatsInFlight` < 3 | §4 | not reachable; 3 in flight; no shore; no sea route; dead |
| `ally` | `target` | visible id, not allied, no pending offer, cooldown passed | offer, or accept theirs | not visible; already allied; cannot send now |
| `accept_alliance`, `reject_alliance` | `target` | id in `pendingAllianceRequestsFrom` | alliance / rejection | no pending request |
| `break_alliance` | `target` | id in `me.allies` | §7 | not your ally |
| `build` | `unit`, `at?` | unit in `canBuild`; `at` visible id or `"sea"` | new structure (§5) | `build[unit].note`; no spot 15 from others; no border with `at`; no coast |
| `retreat` | `target?` | a running attack (none = all, expands too) | survivors home, −25% vs a player, 0% vs unclaimed | no attack running |
| `nuke` | `target`, `nuke` | `nukes.silos` > 0, `nuke` in `nukes.affordable`, not allied | §6 | no silo; unaffordable; allied; no ready silo or immunity; target owns no land |
| `emoji`, `chat` | `emoji`/`key`, `target?` (chat: needed) | valid value; target visible (emoji omitted = all) | line in the recipient's `recentEvents` | unknown value; unknown target |

## 10. Observation

| Field | Meaning | Decision |
| --- | --- | --- |
| `alerts[]` | UNDER ATTACK (who, troops, % of my army); ALLIANCE REQUEST; ALLIANCE expiring ≤300 ticks; NO FREE LAND; TROOPS ≥85% OF CAP | handle first |
| `tick`, `minute`, `game.tick`, `game.minutesLeft`, `game.totalLandTiles`, `game.mapWidth`, `game.mapHeight` | clock (`minutesLeft` null = untimed); win denominator pre-fallout; map extent | endgame (§0.1); scale for `landPct`, `center`, `bbox` |
| `me.id`, `me.name`, `me.center{x,y}`, `me.bbox{minX,minY,maxX,maxY}` | my id (`me` on `map_overview`); centre and box of my largest cluster | never a target; with `direction`/`distance`, who is where |
| `me.tiles`, `me.landPct`, `me.tilesDelta1m` | land; % of all; net tiles last minute | stalled → new target or route |
| `me.freeLandAtBorder`, `unclaimedLandAdjacent` | distinct free tiles at my border (600 border tiles sampled); `expand` legal | ≈0 / false → boat or attack |
| `me.troops`, `me.maxTroops`, `me.troopsPct`, `me.gold`, `me.goldIncomePerMin` | army, cap (§2), throttle; treasury; gold last minute, all sources | high pct → spend or City; what to buy; is trade/rail paying |
| `me.cities`, `me.ports`, `me.defensePosts`, `me.silos`, `me.structures`, `me.boatsInFlight` | counts (`structures` = all 7 types); transports at sea, max 3 | next price on each ladder; can `boat` |
| `me.allies`, `me.allianceExpiry[{id,ticksLeft}]`, `me.pendingAllianceRequestsFrom`, `me.pendingRequestExpiry[{id,ticksLeft}]` | allies and ticks until each expires; offers awaiting me and ticks until they lapse | which border is frozen, how long; accept / reject |
| `me.incomingAttacks[{from,troops}]`, `me.outgoingAttacks[{to,troops,troopsRemaining}]` | attacks on me, current stacks; my running attacks (`to` = id or `"land"`; both troop fields = current stack) | reserve, counter-cancel (§3), Defense Post `at`=from; no re-send, `retreat` |
| `me.immuneUntilTick`, `me.isTraitor`, `me.betrayals` | tick immunity ends (0 = over); traitor now; lifetime count | AI attacks wait; tribe and cheap attacks while traitor |
| `neighbors[]`, `reachableByBoat[]`, `leaderboard[]` | land-border players; ≤6 coastal non-neighbours nearest first (only if I own shore); top 5 by tiles incl. me and tribes | `attack` ids; `boat` ids; who wins on timer |
| `id`, `name`, `kind`, `tiles`, `troops`, `maxTroops`, `troopsPct`, `gold` | id for every tool; `"llm"` or `"tribe"`; size, army, cap, throttle, treasury | tribe = cheap, full loot; `troops/tiles` = density (§3); <100 tiles = dead |
| `relation`, `allied`, `isTraitor`, `betrayals`, `allies[]`, `targets[]` | ledger (§7); allied with me; traitor now; lifetime; their allies; ids they marked | trust; traitor = cheap target; avoid allies of the strong |
| `attackingMe`, `attacking[]`, `attackedBy[]`, `tilesDelta1m` | attack on me; ids they attack; ids attacking them; their net tiles last minute | besieged or shrinking = cheap; growing = threat |
| `coastal`, `sharedBorderTiles`, `direction`, `distance`, `structures` | owns shore (sampled); my border tiles touching them (≤2,000 scanned); compass and Manhattan distance of cluster centres; counts | boat/port; front width = speed (§3); boat ticks = distance; posts, silos |
| `canBuild[{unit,cost}]`, `buildCosts`, `build[unit]{cost,affordable,placeable,note}`, `nukes{silos,costs,affordable}` | affordable-and-placeable now; every price; why a build fails; silos, warhead prices, launchable now | `build`; `nuke` |
| `recentEvents[]`, `globalEvents[]` | ≤8 involving me: attacks on me, conquests, alliances, betrayals, nukes, emoji/chat to me; ≤10 map-wide (`t<tick>` prefix) | threats; who fights whom |
| `plan`, `notes`, `lastResult` | §0.6–0.7 | continuity |

## 11. Decision defaults (starting points, not rules)

1. Spawn: free land in more than one direction, coast plus interior; reject cells whose only exit is water or another's pick.
2. IF `unclaimedLandAdjacent` and `freeLandAtBorder` > ~50: `expand` (ratio 0.3–0.5); ≥6,600 troops saturates plains speed.
3. IF `troopsPct` ≥ 80: spend (expand/attack/boat) or `build City`.
4. IF `gold` covers the bottleneck: City when the cap throttles; Port only for trade (needs another AI's Port on the same sea) or Warships, never for boats (boats need only a shore tile); Defense Post `at` = the pressing neighbour; Factory once a City/Port stands within 110 tiles; SAM only when a rival's `structures["Missile Silo"]` > 0. Idle gold earns nothing; a second Port costs double.
5. IF `freeLandAtBorder` ≈ 0: target by §3: lowest `troops/tiles`, widest `sharedBorderTiles`, non-empty `attackedBy`, no Defense Posts, `tilesDelta1m` < 0; stack ≥ 1.7 × their troops (D/A ≤ 0.6).
6. IF `reachableByBoat` has a tribe with high `gold` and low `troops/tiles`: `boat` with troops above their army, then `expand` from the beachhead.
7. IF `incomingAttacks` non-empty: keep ≥1/3 of troops home; counter-cancel (§3) when my stack matches theirs; `retreat` elsewhere first.
8. IF an `outgoingAttacks` stack falls faster than the target's tiles: `retreat(target)` early (75% back vs a player).
9. IF fighting elsewhere: `ally` the strong neighbour for a 5-min quiet border; let alliances expire; break only for a decisive gain.
10. IF a target is under 100 tiles or shrinking under another's attack: take one tile, collect the conquest.
11. Every minute: main border covered? `troopsPct`? `goldIncomePerMin` above the 60,000 base? Which purchase removes the bottleneck?
12. IF `game.minutesLeft` < 3: convert everything to tiles; the timer pays the tile leader.
13. Nukes need an economy: silo + Atom Bomb = 1.75M, only behind trade, rail, loot.

<!-- prettier-ignore-end -->
