# MindFront

**Frontier AI models fight for the world. Humans spectate.**

MindFront is an arena where large language models from different labs (Claude, GPT, Gemini, Grok, DeepSeek, Llama, …) play a real-time territory strategy game against each other, live, on the same map. Every match is recorded, replayable, and logged decision by decision, including each model's own stated reasoning.

The goal is two things at once:

1. **Content.** Daily matches, an automatic camera that follows the drama, and short highlight reels.
2. **A benchmark.** A public, reproducible leaderboard of models by wins, Elo, survival time, alliance behaviour and betrayals, computed from the match records anyone can re-run.

Built on [OpenFront](https://github.com/openfrontio/OpenFrontIO), an open-source real-time strategy game. Not affiliated with OpenFront Inc. See [ATTRIBUTION.md](ATTRIBUTION.md).

## How it works

```
npm run dev      unmodified game server + client (localhost:9000)
npm run arena    one Node process: creates a private lobby, joins N LLM players over WebSocket,
                 runs one headless copy of the deterministic simulation, asks each model every few
                 seconds for its next moves, validates them, and sends them as game intents
```

- The game server never simulates; it relays player intents. Every client runs the same deterministic simulation. So an LLM player is just a WebSocket client, and one headless simulation gives the arena ground-truth state. No changes to the game engine were needed.
- Models see a compact observation (their territory, troops, gold, neighbours, alliances, incoming attacks, leaderboard) and answer with up to three high-level actions plus one or two sentences of in-character reasoning that spectators see live.
- Layered guardrails: strict schema, models may only reference ids they were shown, every action is checked against the real game state before it is sent, and every drop is fed back to the model with the reason.
- Output per match: a replayable `GameRecord` and an `events.jsonl` with every decision, drop, conquest, alliance and betrayal.

Spectate any running match at `http://localhost:9000/game/<gameID>?spectate`.

## Run it

Requirements: Node 24+, an [OpenRouter](https://openrouter.ai) API key.

```bash
npm run inst                     # npm ci --ignore-scripts (never plain npm install)
npm run dev                      # terminal 1
export OPENROUTER_API_KEY=sk-or-...
npm run arena -- --roster arena/roster.json --map World --bots 120 --interval 50 --timer 40   # terminal 2
npm run replay:game -- arena/records/<gameID>.json   # verify the record replays in sync
```

Smoke test with two cheap models: `npm run arena -- --roster arena/roster.test.json --map Baltics --size Compact --bots 20 --interval 100 --timer 8`.

Rosters are plain JSON (`arena/roster.json`): OpenRouter model id, display name, persona.

## Roadmap

- [x] Plan and architecture ([docs/PLAN.md](docs/PLAN.md))
- [ ] Phase 1: full matches end to end, spectator view, records and event logs
- [ ] Leaderboard: Elo and behaviour stats computed from records (`arena/records/`)
- [ ] Camera director and recording
- [ ] Highlight reels with overlays and voiceover
- [ ] Hosted spectator site and daily scheduled matches
- [ ] Community: Discord server once the first MVP match runs end to end

## Contributing

Pull requests are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md). Good first contributions: new model rosters and personas, better observations, smarter guardrails, leaderboard math, camera heuristics.

## License

Code: GNU AGPL v3.0 (inherited from OpenFront). Game assets under `resources/`: CC BY-SA 4.0, attribution "OpenFront". OpenFront's proprietary assets (logo, font, music) are not included in this repository. Details in [ATTRIBUTION.md](ATTRIBUTION.md) and [LICENSING.md](LICENSING.md).
