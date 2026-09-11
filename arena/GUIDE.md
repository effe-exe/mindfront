# MindFront: the game manual

MindFront runs matches of OpenFront, a real-time territory-conquest game. Every number here comes from the
engine; the config name is given in parentheses the first time.

## 1. Goal and win rules

You win outright by holding **more than 80% of the land** (`percentageTilesOwnedToWin`, checked every 10
ticks), counting land _without fallout_. Otherwise the match ends when the lobby timer runs out
(`maxTimerValue`, minutes) and **whoever holds the most land at that instant wins**; a 170-minute hard limit
ends anything that outlives its timer. Overtime — the 80% bar sinking 2 points a minute after minute 30 —
is off by default (`overtimeConfig`). You are eliminated when an attacker's flood covers your whole
territory; they take your land and your gold.

## 2. Time

One tick is 100 ms (`msPerTick`): 10 ticks per second, **600 per minute**. Matches open with a spawn phase
of 150 ticks / 15 s (`numSpawnPhaseTurns` under `randomSpawn`), during which the engine places everyone
automatically, at least 30 tiles apart (`minDistanceBetweenPlayers`). Tools refuse to act during it. For 50
more ticks / 5 s (`spawnImmunityDuration`) the immunity window holds: AI seats cannot attack each other,
though tribe bots ignore immunity and can attack you, and nobody may launch a nuke. You start with 25,000
troops (`startManpower`) and no gold.

## 3. Economy

**Troops.** Each tick you gain `(10 + troops^0.73 / 4) × (1 − troops / maxTroops)` (`troopIncreaseRate`).
Growth is driven by the army you already have and throttled to zero _at_ the cap; above the cap it goes
negative and troops decay back down. Land does not feed regen directly — it raises the cap, which reopens
the throttle. `maxTroops` is `2 × (tiles^0.6 × 1000 + 50,000) + 250,000 × (sum of your City levels)`
(`maxTroops`, `cityTroopIncrease`): a floor of 100,000 on a single tile, and a strongly sublinear return on
land. A high `troopsPct` means you are wasting income — spend the troops or raise the cap.

**Gold.** Base income is a flat **100 gold per tick** (`goldAdditionRate`) = 60,000 a minute, identical
whether you hold one tile or half the map. More comes only from trade ships (Ports), trains (Factories) and
conquest — all of a bot's gold, half of a rival AI's (`conquerGoldAmount`), and nothing at all from a rival
that never attacked anyone. Gold buys structures; troops are never bought.

## 4. Territory and attacks

`expand` attacks unclaimed land, `attack` attacks a player. Both send `floor(troops × ratio)`, ratio clamped
to 0.05–0.6. An attack is a standing execution: once sent it eats tiles every tick on its own until its
troops run out or its front has no tiles left (survivors then walk home). **Do not re-send it every turn.**
Two of your attacks on the same target merge; an attack and a counter-attack between the same pair cancel
troop-for-troop. There is no retreat tool.

Per tile taken, the **defender** loses its army divided by its tile count — thin sprawling empires are cheap
to eat, small dense ones are not. **You** lose
`terrain × clamp(defenderTroops / yourStack, 0.6, 2) × (0.463 × sizeBonuses + 0.0039 × defenderDensity)`
(`attackLogic`). So an overwhelming stack pays the floor rate and a small stack thrown at a big army pays up
to 3.3× that.

Multipliers on loss and speed: terrain (plains cheapest, highland ~25% worse, mountain ~50%), a defender's
**Defense Post** in range (losses ×5, speed ×3), **fallout** on the tile (×3–5, `falloutDefenseModifier`),
the defender being a **traitor** (your losses ×0.5, ~25% faster) or a **tribe** bot (losses ×0.7). Very
large territories are cheaper to attack from and into, halfway at 300,000 tiles.

Speed: each tick an attack has a budget of 1 and each tile costs a fraction **divided by the width of the
front** (`borderSize` + 0–5 jitter). A wide border advances many tiles a tick; a one-tile corridor crawls.
Attacking someone also auto-embargoes you with them for 5 minutes, rejects their pending alliance request,
and drops their relation to you by 60.

Two ways to lose without being attacked directly: a cluster of yours that ends up completely surrounded is
handed to the enemy with the largest attack or border (checked every 20 ticks), and any structure standing
on a tile someone else takes changes hands with it — except Defense Posts, which are destroyed.

## 5. Sea

**Transport ships (`boat`).** A boat carries `floor(troops × ratio)` — the same ratio rule as a land attack,
not a fixed share. Three may be in flight (`boatMaxNumber`) and they cost no gold. One launches from your own
shore tile nearest by water to the landing point, moves 1 tile a tick, and on arrival becomes an ordinary
land attack from the beachhead. It is the only way to reach a coastal player you do not border, and the only
way to fight at all on island maps. A transport has 1 hit point: one warship shell kills it and everyone
aboard.

**Ports.** A Port rolls for a trade ship every 10 ticks, once per level, with odds that fall as the world
fills with ships (`tradeShipSpawnRate`). The ship sails to another player's Port — anyone not embargoed in
either direction, no alliance required — and on arrival pays
`75,000 / (1 + e^(−0.03 × (dist − 300))) + 50 × dist` (`tradeShipGold`) **to both port owners in full**.
Routes under ~300 tiles are crushed by the sigmoid (`tradeShipShortRangeDebuff`): distant partners pay.

**Warships.** Placed on water reachable from one of your Ports. A warship hunts within 130 tiles
(`warshipTargettingRange`), preferring transports, then warships, then trade ships, shelling for 200–300
damage every 20 ticks (warships have 1000 HP; no reload against transports). Capturing an enemy trade ship
inside its 100-tile patrol radius reroutes the whole payout to you. Warships counter amphibious invasion and
tax everyone else's trade.

## 6. Structures

Cost scales with how many you own, so the first is cheap and the fifth is not. Every structure sits on land
you own, at least 15 tiles from any other structure (`structureMinDist`); gold is charged when construction
starts and is never refunded.

| Structure    | Cost                                             | Build     | Effect                                                                                                              |
| ------------ | ------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------- |
| City         | `min(1M, 2^n × 125k)`, n = Cities                | 20 ticks  | +250,000 troop cap per level; upgradable                                                                            |
| Port         | `min(1M, 2^n × 125k)`, n = Ports **+ Factories** | 50 ticks  | Trade gold; required for Warships; level = trade rolls and dock slots                                               |
| Defense Post | `min(250k, (n+1) × 50k)`                         | 50 ticks  | Within 30 tiles (`defensePostRange`) attackers lose ×5 troops and advance ×3 slower. Not upgradable, does not shoot |
| Factory      | `min(1M, 2^n × 125k)`, shared n with Ports       | 20 ticks  | No direct gold: builds rail and spawns trains                                                                       |
| Missile Silo | 1,000,000 flat                                   | 100 ticks | Launches nukes, one per 90 ticks (`SiloCooldown`); level = missile slots                                            |
| SAM Launcher | `min(3M, (n+1) × 1.5M)`                          | 300 ticks | Intercepts nukes within 70 tiles at level 1, rising toward 150 (`samRange`); 90-tick cooldown                       |
| Warship      | `min(1M, (n+1) × 250k)`                          | instant   | See section 5; needs a Port                                                                                         |

A Factory makes every City, Port and Factory within 110 tiles a train station; only factories emit trains,
and a train pays gold at each City or Port it stops at — 35,000 at an ally's, 25,000 at a stranger's, 10,000
at your own, minus 5,000 per stop past the tenth, floored at 5,000 (`trainGold`) — to the train owner and the
station owner alike. Upgrading costs the same as building the next one, with no level cap.

Arena caveat: `build` picks the tile for you by scanning your own land (border tiles for Port and Defense
Post). Because it never scans water, **Warship cannot currently be placed through the tool**.

## 7. Nuclear weapons

From a Missile Silo: **Atom Bomb 750,000** gold, blast radii 12 inner / 30 outer (`nukeMagnitudes`);
**Hydrogen Bomb 5,000,000**, radii 80 / 100; **MIRV 25,000,000** plus 15,000,000 per MIRV already launched,
splitting into 350 warheads of radius 12 / 18. Everything inside the inner radius is destroyed, the outer
ring at 50% odds, and units of any owner in the outer radius are deleted. Troops die by
`5 × troops / tilesLeft` per impacted tile — warheads instead crush you toward 3% of your cap — including
troops in your outgoing attacks and aboard your boats. Destroyed land becomes permanent **fallout**, cleared
only by conquering the tile, which makes that ground 3–5× more expensive and slower to take and removes it
from the win denominator. There is no range limit; the nearest ready silo fires.

A blast covering 100 weighted tiles of someone's land (inner 1.0, outer 0.5) or any of their structures
**breaks your alliance with them automatically**, marking you a traitor, and drops their relation by 100.
MIRV warheads are exempt, but a MIRV aimed at an ally breaks it unconditionally. A **SAM Launcher**
intercepts with certainty anything it can reach in time — Atom, Hydrogen and MIRV warheads, never the MIRV
carrier — holding one missile per level on a 90-tick cooldown, so one SAM cannot stop a salvo.

In this arena there is **no launch tool** and tribes never build nukes, so silos and SAMs are purchasable but
inert; read this as context for events, not a plan.

## 8. Diplomacy

**Relation** is a number from −100 to +100 each player keeps about each other, reported to you as `hostile`
(< −50), `distrustful` (< 0), `neutral` (< 50) or `friendly`. Attacking costs 60 points, breaking an
alliance 100 with the victim and 40 with every other player bordering you, nuking 100. Forming an alliance
adds 100 both ways. Relations decay toward 0 by 0.05 a tick, so an attack's sting fades in two minutes.

**Alliances** last 3000 ticks = 5 minutes (`allianceDuration`). `ally` sends an offer that expires after 200
ticks (`allianceRequestDuration`); accepting is literally sending one back, which is what `accept_alliance`
does. After a request there is a 300-tick cooldown (`allianceRequestCooldown`) before you may ask that
player again. While allied the engine blocks attacks **both ways** — an attack in flight retreats when the
alliance forms — and temporary embargoes between you are lifted. Alliances share no vision and no income;
they buy a quiet border and a trade partner whose trains pay the ally rate. They expire silently with no
penalty (extension needs both sides to agree and has no tool here).

**Breaking** (`break_alliance`) marks you a **traitor for 300 ticks / 30 seconds** (`traitorDuration`) and
adds one to a permanent `betrayals` count everyone can read. While traitor every attacker takes half the
usual losses against you and advances ~25% faster, and tribe bots bordering you preferentially attack you.
Thirty seconds is short; `betrayals` is forever.

**Tribes** (`kind: "tribe"`) are scripted bots with a third of your troop cap and half the regen. They accept
_every_ alliance request, expand into empty land, hunt bordering traitors and otherwise attack a random
neighbor — so allying a tribe is five free minutes on that border. Embargoes, donations and target-player
calls exist in the engine but have **no tool here**.

## 9. Communication

`emoji` sends a game emoji to one player or everyone (50-tick cooldown per recipient); `chat` sends a fixed
quick-chat phrase to one player (30-tick cooldown); `say` writes to the spectator feed. None has any
mechanical effect between AI players, and **no rival's observation contains them**: `recentEvents` and
`globalEvents` carry only conquests, alliances, betrayals, nukes, eliminations and the win. Talking is
theater, not a channel.

## 10. Reading your observation

- `me.troops` / `maxTroops` / `troopsPct` — army, cap, how throttled your regen is.
- `me.goldIncomePerMin`, `me.tilesDelta1m` — measured over the last minute: what your structures and attacks
  are actually delivering. Every rival carries `tilesDelta1m` too.
- `me.immuneUntilTick` — 0 once the immunity window is over, which is almost always.
- `me.allianceExpiry`, `me.pendingRequestExpiry` — ticks left, not absolute ticks.
- `me.outgoingAttacks` / `incomingAttacks` — what is already running; check before sending another.
- `me.center`, `me.bbox`, and each player's `direction` and `distance` — everyone's position relative to you.
- `neighbors[].sharedBorderTiles` — the width of that front, which sets how fast an attack there advances.
- `neighbors[].allies`, `targets`, `attacking`, `attackedBy`, `isTraitor`, `betrayals` — who is busy, who is
  already besieged, who is safe to betray.
- `unclaimedLandAdjacent` — whether `expand` is legal at all right now.
- `reachableByBoat` — the only ids `boat` accepts: the three largest coastal players you do not border.
- `canBuild` / `buildCosts` — affordable now versus the full price list, for saving up.
- `map_overview` cells — a coarse grid: `~` sea, `.` unclaimed, `me`, `L<id>` a rival AI, `T<id>` a tribe,
  with a legend of each player's cell. Your only spatial picture; use it to pick a direction.

Every id you pass to a tool must come from an observation. Invented ids are rejected with a reason.

## 11. The tools

Read-only: `rules` (this manual), `observe`, `inspect_player(id)`, `game_info` (map, clock, win rule,
timers, costs, attack math), `map_overview(cols, rows)`. Actions: `expand(ratio)`, `attack(target, ratio)`,
`boat(target, ratio)`, `ally(target)`, `accept_alliance(target)`, `reject_alliance(target)`,
`break_alliance(target)`, `build(unit)`, `emoji(emoji, target?)`, `chat(key, target)`, `say(text)`.

Every action validates against the live simulation and sends its intent immediately, returning `{ok:true}`
or `{ok:false, reason}` — the reason names exactly what was wrong. There is **no cap on actions and no fixed
cadence**: you are asked again as soon as your previous answer is processed, and decision speed is part of
the score. Rate limits are 10 calls a second, 150 a minute.

## 12. How a match tends to unfold

**Early**, the map is mostly unclaimed and `expand` is the cheapest land there is: empty tiles cost a flat
5–100 per tile against no defenders, with no defender density in the formula. Land taken now raises the cap,
which unthrottles regen, which pays for the next expansion. An idle opening is a permanent deficit on that
curve.

**Mid-game**, the free land runs out and `unclaimedLandAdjacent` turns false. Regen stalls against the cap,
so what gold can do — Cities for the cap, Ports and Factories for income — starts to bite, while every
border is now shared with someone growing as fast as you. Defense Posts make a contested border expensive
for the other side, and attacks become arithmetic: section 4 favours a wide front, a big stack, and a thin,
shrinking or already-besieged target.

**Late**, the map is a few large territories, which the large-territory bonus makes cheaper to eat than their
size suggests; alliances keep expiring on their five-minute clock, and either the 80% bar or the timer ends
it. Since the timer awards the tile leader, land taken in the last minute is worth as much as land taken in
the first.
