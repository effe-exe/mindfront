# MindFront manual (OpenFront engine; numbers verified against `src/core`)

<!-- prettier-ignore-start -->

## 0. Contract

1. Win: >80% of non-fallout land at any 10-tick check (`percentageTilesOwnedToWin`), else most tiles when `game.minutesLeft` ends (the engine clock skips the 60 s spawn phase: ~60 s after it reads 0; 170-min hard cap). Tribes and nations count and can win.
2. Death: 0 tiles, or any attack leaving a player under 100 tiles (§8); everything lost.
3. No action cap or cadence; internal seats ≤8 tool calls per round, rounds ≥1 s apart. Intents (every sending tool; read-only tools and `say` are free) ≤10/s and ≤150/min per seat, silently dropped beyond (`ClientMsgRateLimiter`); `retreat()`/`recall_boats()` without a target send one per attack/boat. Attacks and boats run on after one send; never re-send a running one.
4. Every `target` = a numeric `id` from the current `observe`. Actions return `{ok:true}` or `{ok:false, reason}`; drops cost nothing. Gold is charged a tick after the send, so purchases in the same round are checked against one purse (the second is refused, not silently lost).
5. Spawn phase 600 ticks (60 s; a cold model round can take 20–30 s, so call `spawn` first, prose after): `observe` = `{phase:"spawn", ticksLeft, myPick, picks, map}`; `spawn(col,row)`, re-pick freely; other tools refuse; no pick → placed far from everyone.
6. Briefing: manual first, then a written plan that returns in every observation as `plan`; the spawn phase waits for every seat's plan.
7. `alerts` = first key: what needs a decision now, severest first. `notes` = last `say` text; `lastResult` = last round's tool calls and results (≤5).
8. `emoji` / `chat` `key`: only the `Valid emoji:` / `Valid chat keys:` lists after this manual.

## 1. Clock

- 1 tick = 100 ms; 600/min. After the spawn phase, 50 ticks immunity (`spawnImmunityDuration`): AI seats cannot attack AI seats or nations and nobody can nuke (`me.immuneUntilTick` > 0); tribes and nations attack anyone from the first tick, and tribes are attackable anyway.
- Start: 25,000 troops (`startManpower`), 0 gold; tribes 10,000.

## 2. Economy

- `maxTroops = 100,000 + 2,000 × tiles^0.6 + 250,000 × Σ completed City levels` (`Config.maxTroops`; tribes ÷3): 1,000 tiles → 226k; 10,000 → 602k; 100,000 → 2.1M.
- Regen/tick = `(10 + troops^0.73 / 4) × (1 − troops/maxTroops)` (`troopIncreaseRate`; tribes ×0.5); negative above cap. Per minute: 25k/100k → +187k; 100k/400k → +507k. `troopsPct` 80 → 20% of unthrottled regen; 100 → 0.
- Gold +100/tick = 60,000/min flat regardless of land (`goldAdditionRate`; tribes 50); plus trade ships, trains, conquest. Gold buys structures and nukes only; troops are never bought.

## 3. Land attacks

- `expand(ratio)` = attack on unclaimed land; `attack(target, ratio)` on a bordering player. Sent = `floor(troops × ratio)`, ratio 0.05–0.6, default 0.3.
- Runs until troops < 1 or the front is empty (survivors return, no malus). A second send at the same target merges (boat landings never merge). `retreat(target?)`: the attack freezes at once, survivors are refunded 20 ticks later (`RetreatExecution`), −25% vs a player, 0 vs unclaimed.
- Counter-cancel: attacking a player whose attack runs on me deletes the smaller stack and reduces the larger by it.
- Per tile taken: defender loses `D / defTiles`; attacker loses `M × clamp(D/A, 0.6, 2) × (0.463 × G + 0.0039 × D/defTiles)` (`attackLogic`); tile time (budget 1/tick) `C × clamp(D/A, 0.82, 7.5) × clamp(D/A ÷ 20, 1, 50) / 7.77 / front`. D = defender troops, A = attack troops now, front = attack border tiles + 0–5.
- M = 80 / 100 / 120, C = 16.5 / 20 / 25 for plains / highland / mountain. Multipliers (loss, time): defender Defense Post within 30 tiles ×5, ×3; fallout ×(5 − 2 × falloutShare) both; traitor defender ×0.5, ×0.8; tribe defender ×0.7, ×1. G = `1 − depth / (1 + (300,000/tiles)^2.5)`, depth 0.7 on attacker tiles (0.73 for time), 0.3 on defender tiles; ≈1 under 50k tiles.
- Plains, small, density 10: 24/tile at D/A ≤ 0.6, 80 at D/A ≥ 2; ≈0.57 × front tiles/tick at D/A ≤ 0.82, 9× slower at 7.5.
- Unclaimed: flat 16 / 20 / 24 per tile (×fallout); time `clamp(2,000 × C / A, 5, 100) / (2 × front)` → 0.4 × front tiles/tick once A ≥ 6,600 / 8,000 / 10,000; more troops only last longer (≈ A/16 plains tiles).
- Attacking a player (land or landing): their relation to me −60, they embargo me 5 min (no trade ships either way), their pending offer to me is rejected.

## 4. Sea

- `boat(target, ratio)`: `floor(troops × ratio)`, ≤3 in flight (`boatMaxNumber`), free, no Port. Lands on their shore tile nearest my centre on a water body my shore touches (a lake counts), sailing from my shore tile nearest by water, 1 tile/tick; takes the beach tile, then a land attack from it. 1 HP: one warship shell sinks all aboard. Ally on landing → troops return. `recall_boats(target?)`: every boat at sea (or those sailing at `target`) turns back to my nearest shore and lands 75% of its troops (`cancel_boat`, 25% malus). Targets: any visible id with `sharesSea` (neighbours too: a landing behind their lines); `reachableByBoat` = the 10 nearest non-neighbours; dropped without a water route or during their immunity.
- Port trade: every 10 ticks one roll per level, chance `1 / floor(100 / (misses+1) / base)`, base ≈1 under ~200 trade ships worldwide, 0.5 at 400, ~0 by 600 (`tradeShipSpawnRate`): ≈1 ship / 120 ticks per level early. Destination: a random non-embargoed player's Port on the same water. Arrival pays BOTH port owners in full `75,000 / (1 + e^(−0.03 × (dist − 300))) + 50 × dist` (`tradeShipGold`, dist = route length): 100 → 5.2k, 300 → 52.5k, 600 → 105k, 1000 → 125k. Ships need a partner Port on the same sea (another AI's; tribes keep none): `me.tradePartnerPorts` = partner Ports now, `me.aiOnMySea` = AI players whose shore touches my sea, i.e. partners the moment they build. A pair 300 tiles apart ≈ 4 ships/min per Port × 52.5k to BOTH owners ≈ 400k/min each, 7× the base income: the first Port on a shared sea is the best purchase in the game and the second builder is paid from its first ship; rivals with a Port also feed my Warships (§4).
- Warship: 1,000 HP; hunts within 130 tiles (`warshipTargettingRange`): transports first (no reload), then warships, then trade ships within its 100-tile patrol; shells 200–300 per 20 ticks; a captured trade ship pays its whole payout to the captor.

## 5. Structures

n = already built of that type, upgrades included. Gold charged at start, never refunded. ≥15 tiles between structures (`structureMinDist`). `upgrade(unit, id?)`: +1 level on a finished structure of mine, instant, same price as the next new one (`UpgradeStructureExecution`, `canUpgradeUnit`), no spacing; City, Port, Factory, Missile Silo, SAM Launcher only (`upgradable`); `id` from `me.units`, omitted = my lowest-level finished one. Level = effect multiplier: City +250k cap per level, Port one trade roll per level, Factory one train per level, Silo/SAM one missile per level. A structure only counts once finished (`me.underConstruction`). A structure changes hands with its tile (Defense Post destroyed instead); a tile made unowned by a nuke destroys it; tribes delete any structure they hold within ~30 s.

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

`nuke(target, nuke)`: nearest ready silo fires at the aim point on the target's land that deletes the most of their structures (Cities = their cap, Silos, SAMs, Ports) and strips the most tiles, else the middle of their land; refused when the outer radius would cover any tile of mine (the blast strips tiles and deletes units of EVERY owner inside it, mine included) or break an alliance; no range limit; blocked during spawn immunity; flight 10 tiles/tick. Inner radius destroyed, outer ring 50% per tile, all units inside the outer radius deleted. Troops killed per impacted tile `5 × troops / tilesLeft` (`nukeDeathFactor`) from stock, running attacks and boats; MIRV warheads instead crush troops toward 3% of cap. Destroyed land = fallout until conquered: §3 multiplier, out of the win denominator.

| Warhead | Gold | Radius in/out |
| --- | --- | --- |
| Atom Bomb | 750,000 | 12 / 30 |
| Hydrogen Bomb | 5,000,000 | 80 / 100 |
| MIRV | 25,000,000 + 15,000,000 × launched | 350 warheads × 12 / 18; needs an owned target tile; SAMs never hit the carrier |

A blast covering ≥100 weighted tiles (inner 1, outer 0.5) of an ally's land or any of their structures breaks the alliance (traitor mark, relation −100); a MIRV at an ally breaks it unconditionally; a new alliance deletes nukes in flight between the two.

Defence: only a SAM Launcher stops a warhead, with certainty, when the impact tile is within its range (70 tiles at level 1, `samRange`; 300 ticks to build, so buy it before the second bomb, next to the Cities and Silos it must cover); Defense Posts, troops and alliances with third parties do nothing against a nuke. `alerts` carries `NUKED` for 90 s after any launch at me.

## 7. Diplomacy

- `relation`: my ledger of their acts toward me, −100..100: attack −60, alliance break −100 (−40 with everyone else bordering the breaker), nuke −100, alliance +100; decays 0.05/tick to 0; labels hostile < −50, distrustful < 0, neutral < 50, else friendly. No mechanical effect; tribes ignore it.
- `ally(target)`: offer to any visible id, expires after 200 ticks (`allianceRequestDuration`); 300-tick cooldown before re-asking (`allianceRequestCooldown`); `accept_alliance` sends the offer back. Lasts 3,000 ticks = 5 min (`allianceDuration`), expires silently. `extend_alliance(target)`: once BOTH sides have called it, expiry resets to now + 3,000 (`AllianceExtensionExecution`; no time window, the remaining time is not added, so renew in the last 300 ticks); a tribe answers within its next act tick (40–80 ticks); `me.allianceExpiry[].theyAgreedToExtend` = they already asked, `iAgreedToExtend` = you did. Allied: attacks blocked both ways (one in flight retreats, no malus), temporary embargoes lifted, trains pay the ally rate; no shared vision or income.
- `break_alliance`: traitor 300 ticks (`traitorDuration`, countdown in `traitorTicksLeft`), `betrayals` +1 forever; no mark if the other side is already a traitor (breaking with a traitor is free). Traitor: §3 multipliers against me; each bordering tribe attacks me at 1-in-3 odds per attack tick (1-in-6 if allied, breaking it).
- Tribes (`kind: "tribe"`, 120 bots): act every 40–80 ticks; accept every alliance and extension request; never build (they delete structures they capture); expand while free land borders them; retaliate FIRST against their largest non-allied attacker regardless of troops; hunt a bordering traitor with 1/3 odds and break their own alliance with an allied traitor with 1/6 odds; otherwise attack only at ≥50–60% of cap, sending everything above a 30–40% reserve, skipping AI neighbours half the time; can boat. Weak on paper: cap ÷3, regen ×0.5, attacker losses ×0.7 against them. Conquered → all their gold (50/tick ≈ 30k per minute alive).
- Nations (`kind: "nation"`, only when the match enables them; real countries spawning near their true position during the spawn phase, hopping around it until it ends): scripted like tribes but full players (`AiAttackBehavior` + nation behaviours, difficulty Easy in this arena). Start 12,500 troops, cap ×0.5, regen ×0.9, gold 100/tick like AI seats, same spawn immunity. Act every 65–100 ticks. Build and keep structures: Cities first, then Ports/Factories ≈0.75 per City, Missile Silos 0.2 per City (max 3), SAMs; a Warship at 1/50 odds per act tick while they hold a Port; no Defense Posts on Easy. Their Ports are trade partners for mine. Attack order: whoever nuked them, then tribes (one at a time), retaliation against attackers, an ally's target, a betrayal, the most hated, the weakest; an attack on an AI seat goes ahead only 1 time in 4. Alliances: 10% of decisions are random; a traitor is refused 90%; accept when their relation to me is friendly, or in the first 5 min (90%), or when I hold ≥60–80% of their troops or ≥70–80% of their tiles (with ≥50% of their troops); offers to bordering players at 1/30 odds; renew when asked; never betray an AI seat on Easy. Embargo (no trade ships) while their relation to me is hostile. Nukes: with a silo and the gold, Hydrogen if affordable else Atom, at an ally's target, else the hostile player with the most hated relation unless that player's cap is under half theirs, else the tile leader once ahead of them by 40 points of land share; never at tribes. Conquered → all their gold.
- `donate(target, troops|gold)`: allies only; one donation per ally per 100 ticks, gold and troops share the cooldown (`donateCooldown`); troops capped at the room under their cap and at my stock; their relation to me +50 for ≥ ~1/12 of their cap in troops, +5 per 2,500 gold (chunk grows ~×2 per 5 min), max +100 (`DonateTroopsExecution`, `DonateGoldExecution`). Embargoes, target calls: no tool.

## 8. Losing land without a fight

- Conquest: an attack leaving a player under 100 tiles triggers `conquerPlayer`: every remaining tile bordering the attacker goes to the attacker, the rest to whoever borders them; gold transfers (all of a tribe's, half of an AI's, none from an AI that never attacked). Under 100 tiles = dead at the next tile anyone takes.
- Enclaves: every 20 ticks a cluster of mine sealed in by others (no shore, map edge or unclaimed exit) goes to the enemy with the largest attack on me, else the largest shared border.

## 9. Tools

Read-only: `rules` (this manual), `observe`, `inspect_player(id)` (`ObsNeighbor` view of a visible id + `sharesBorder`), `game_info` (constants, prices), `map_overview(cols≤24, rows≤12)` (grid: `~` sea, `.` unclaimed, `me`, `L<id>` AI, `T<id>` tribe, legend of cells; the only spatial picture). `say(text)`: spectator feed only.

| Tool | Args | Precondition | Effect | Drop reasons |
| --- | --- | --- | --- | --- |
| `spawn` | `col`, `row` | spawn phase | start on free land in that cell | no free land in cell; phase over |
| `expand` | `ratio?` | `unclaimedLandAdjacent` | attack on unclaimed land | no unclaimed land borders you; no troops |
| `attack` | `target`, `ratio?` | id in `neighbors`, not allied, not immune | land attack | not your neighbor; allied; immune (ticks left given); dead; no troops |
| `boat` | `target`, `ratio?` | visible id with `sharesSea`, `boatsInFlight` < 3, not immune | §4 | no shared water; 3 at sea (ETA given); no sea route; immune; dead |
| `ally` | `target` | visible id, not allied, no pending offer, cooldown passed | offer, or accept theirs | not visible; already allied; offer pending (ticks left); cooldown (ticks left); dead |
| `accept_alliance`, `reject_alliance` | `target` | id in `pendingAllianceRequestsFrom` | alliance / rejection | no pending request |
| `break_alliance` | `target` | id in `me.allies` | §7 | not your ally |
| `extend_alliance` | `target` | id in `me.allies`, not yet asked by me | renew flag; both flags → +5 min from now (§7) | not your ally; already asked |
| `donate` | `target`, `troops` or `gold` | id in `me.allies`; 100 ticks since my last gift to them | §7 | not your ally; cooldown; both/neither amount; they are at cap |
| `recall_boats` | `target?` | `boatsInFlight` > 0 | boats turn home, 75% land (§4) | no boat at sea; none sailing at target |
| `build` | `unit`, `at?` | unit in `canBuild`; `at` visible id or `"sea"` | new structure (§5) | `build[unit].note`; no spot 15 from others; no border with `at`; no coast |
| `upgrade` | `unit`, `id?` | `build[unit].affordable`; a finished one of that type in `me.units` | +1 level, instant (§5) | not upgradable (Defense Post, Warship); none owned; still building; unknown id; gold |
| `retreat` | `target?` | a running attack (none = all, expands too) | attack frozen at once, survivors home after 20 ticks, −25% vs a player, 0% vs unclaimed | no attack running (an attacker id is named as such) |
| `nuke` | `target`, `nuke` | `nukes.silos` > 0, `nuke` in `nukes.affordable`, not allied; blast clear of my tiles and of any ally's land/structures (`wouldNukeBreakAlliance`) | §6 | no silo; unaffordable; allied; own tiles in blast; would break an alliance; no ready silo or immunity; target owns no land |
| `emoji`, `chat` | `emoji`/`key`, `target?` (chat: needed) | valid value; target visible (emoji omitted = all); 50 / 30 ticks since my last to that recipient | line in the recipient's `recentEvents` | unknown value; unknown target; cooldown |

## 10. Observation

| Field | Meaning | Decision |
| --- | --- | --- |
| `alerts[]` | NUKED (warheads launched at me in the last 90 s, by whom, my SAM cover); UNDER ATTACK (who, troops, % of my army); BOAT INCOMING (who, troops, ticks out); ALLIANCE REQUEST; ALLIANCE expiring ≤300 ticks (who asked to renew); NO FREE LAND; TROOPS ≥85% OF CAP | handle first |
| `tick`, `minute`, `game.tick`, `game.minutesLeft`, `game.totalLandTiles`, `game.mapWidth`, `game.mapHeight` | clock (`minutesLeft` null = untimed); win denominator pre-fallout; map extent | endgame (§0.1); scale for `landPct`, `center`, `bbox` |
| `me.id`, `me.name`, `me.center{x,y}`, `me.bbox{minX,minY,maxX,maxY}` | my id (`me` on `map_overview`); centre and box of my largest cluster | never a target; with `direction`/`distance`, who is where |
| `me.tiles`, `me.landPct`, `me.tilesDelta1m` | land; % of all; net tiles last minute | stalled → new target or route |
| `me.freeLandAtBorder`, `unclaimedLandAdjacent` | distinct free tiles touching my whole border, exact, capped at 2,000; `expand` legal | ≈0 / false → boat or attack |
| `me.troops`, `me.maxTroops`, `me.troopsPct`, `me.gold`, `me.goldIncomePerMin`, `me.income{baseGold,tradeGold,trainGold,lootGold}`, `me.tradePartnerPorts`, `me.aiOnMySea` | army, cap (§2), throttle; treasury; gold last minute, all sources; per minute by source (flat 60,000; ships; trains; conquest/piracy/gifts, one-off); partner Ports on my water now; AI players who can become partners (§4) | high pct → spend or City; what to buy; is trade/rail paying; `aiOnMySea` > 0 → Port early |
| `me.cities`, `me.ports`, `me.defensePosts`, `me.silos`, `me.structures`, `me.underConstruction`, `me.boatsInFlight` | Σ levels of finished structures (`structures` = all 7 types); still building per type (no effect yet); transports at sea, max 3 | next price on each ladder; wait before counting on it; can `boat` |
| `me.units[{id,type,level,underConstruction,x,y}]` | every structure I own, ≤40 nearest my centre | `upgrade` id; which City/Port is exposed |
| `me.allies`, `me.allianceExpiry[{id,ticksLeft,theyAgreedToExtend,iAgreedToExtend}]`, `me.pendingAllianceRequestsFrom`, `me.pendingRequestExpiry[{id,ticksLeft}]` | allies; ticks until each expires and who has asked to renew; offers awaiting me and ticks until they lapse | which border is frozen, how long; `extend_alliance` when `ticksLeft` ≤ 300 or they asked; accept / reject |
| `me.incomingAttacks[{from,troops}]`, `me.incomingBoats[{from,troops,tilesAway}]`, `me.outgoingAttacks[{to,troops,troopsRemaining}]` | attacks on me, current stacks; enemy transports sailing at my land (1 tile/tick); my running attacks (`to` = id or `"land"`; both troop fields = current stack) | reserve, counter-cancel (§3), Defense Post `at`=from or `"sea"`; no re-send, `retreat` |
| `me.immuneUntilTick`, `me.traitorTicksLeft`, `me.betrayals` | tick immunity ends (0 = over); ticks my traitor mark lasts (0 = none); lifetime count | AI attacks wait; tribe and cheap attacks while traitor |
| `neighbors[]`, `reachableByBoat[]`, `leaderboard[]` | land-border players; ≤10 non-neighbours sharing a water body with my shore, nearest first; top 5 by tiles incl. me and tribes | `attack` ids; `boat` ids (any view with `sharesSea`); who wins on timer |
| `id`, `name`, `kind`, `tiles`, `troops`, `maxTroops`, `troopsPct`, `gold` | id for every tool; `"llm"`, `"tribe"` or `"nation"` (§7); size, army, cap, throttle, treasury | tribe = cheap, full loot; nation = builds, allies, nukes, full loot; `troops/tiles` = density (§3); <100 tiles = dead |
| `relation`, `allied`, `traitorTicksLeft`, `betrayals`, `allies[]` | how I regard them: my ledger of their acts on me (§7), not theirs of mine; allied with me; ticks their traitor mark lasts; lifetime; their allies | trust; traitor = half-cost target while > 0; avoid allies of the strong |
| `attackingMe`, `attacking[]`, `attackedBy[]`, `tilesDelta1m` | attack on me; ids they attack; ids attacking them; their net tiles last minute | besieged or shrinking = cheap; growing = threat |
| `coastal`, `sharesSea`, `sharedBorderTiles`, `direction`, `distance`, `structures` | owns ocean shore (sampled); their shore and mine touch the same water body = `boat` legal; my border tiles touching them (exact, whole border); compass and Manhattan distance of cluster centres; Σ levels of finished structures | port; boat; front width = speed (§3); boat ticks ≈ distance; posts, silos |
| `canBuild[{unit,cost}]`, `buildCosts`, `build[unit]{cost,affordable,placeable,upgradable,note}`, `nukes{silos,costs,affordable}` | affordable-and-placeable now; every price; why a build fails; levellable type; silos, warhead prices, launchable now | `build`; `upgrade`; `nuke` |
| `recentEvents[]`, `globalEvents[]` | ≤8 involving me: attacks, boats and nukes launched at me, conquests, alliances, betrayals, emoji/chat to me; ≤10 map-wide (`t<tick>` prefix) | threats; who fights whom |
| `plan`, `notes`, `lastResult` | §0.6–0.7 | continuity |

## 11. Decision defaults (starting points, not rules)

1. Spawn: free land in more than one direction, coast plus interior; reject cells whose only exit is water or another's pick.
2. IF `unclaimedLandAdjacent` and `freeLandAtBorder` > ~50: `expand` (ratio 0.3–0.5); ≥6,600 troops saturates plains speed.
3. IF `troopsPct` ≥ 80: spend (expand/attack/boat) or `build City` (`upgrade("City")` when no tile is 15 from my other structures: same price, same +250k).
4. IF `gold` covers the bottleneck: City when the cap throttles; Port early on a coast where `aiOnMySea` > 0 (trade pays both sides ≈ 400k/min at 300 tiles, §4; `at:"sea"`; never for boats, they need only a shore tile); Warship (needs a Port) when boats land on me or a rival's Port is within ~130 tiles: it sinks transports in one shell and captures their trade ships for the whole payout; Defense Post `at` = the pressing neighbour; Factory once a City/Port stands within 110 tiles; SAM Launcher (1.5M) as soon as a rival owns a Silo or a warhead has hit me, covering my Cities and Silos (the only counter, §6); Missile Silo (1M) once income allows: a 750k Atom Bomb deletes every structure in a 30-tile radius and the arena aims it at their densest structure cluster, so it removes a rival's cap, silos and SAMs, not just land. Idle gold earns nothing; Port and Factory share one price ladder, so either doubles the next of both.
5. IF `freeLandAtBorder` ≈ 0: target by §3: lowest `troops/tiles`, widest `sharedBorderTiles`, non-empty `attackedBy`, no Defense Posts, `tilesDelta1m` < 0; stack ≥ 1.7 × their troops (D/A ≤ 0.6).
6. IF `reachableByBoat` has a tribe with high `gold` and low `troops/tiles`: `boat` with troops above their army, then `expand` from the beachhead. A nation is a slower AI with half the cap: ally it early (it accepts 90% in the first 5 min and never betrays me), trade with its Port, take it late for all its gold.
7. IF `incomingAttacks` or `incomingBoats` non-empty: keep ≥1/3 of troops home; counter-cancel (§3) when my stack matches theirs; `retreat` elsewhere first.
8. IF an `outgoingAttacks` stack falls faster than the target's tiles: `retreat(target)` early (75% back vs a player).
9. IF fighting elsewhere: `ally` the strong neighbour for a 5-min quiet border; `extend_alliance` an allied tribe in its last 300 ticks for a permanent one (tribes always agree); let AI alliances expire; break only for a decisive gain.
10. IF a target is under 100 tiles or shrinking under another's attack: take one tile, collect the conquest.
11. Every minute: main border covered? `troopsPct`? `goldIncomePerMin` above the 60,000 base? Which purchase removes the bottleneck?
12. IF `game.minutesLeft` < 3: convert everything to tiles; the timer pays the tile leader.
13. Nukes need an economy: silo + Atom Bomb = 1.75M, only behind trade, rail, loot.

<!-- prettier-ignore-end -->
