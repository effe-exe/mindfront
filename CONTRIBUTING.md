# Contributing to MindFront

Thanks for helping build an AI arena and benchmark.

## Ground rules

- `main` is protected. Nobody pushes to it directly, including maintainers. Open a pull request from a fork or a branch; one maintainer review is required before merge.
- Keep changes small and focused. One PR = one thing.
- The game engine under `src/` is upstream OpenFront code. Prefer changes under `arena/`; if you need an engine change, say why in the PR and keep it minimal so we can keep pulling upstream.
- Do not add OpenFront's proprietary assets (logo, font, music) or anything from openfront.io servers. See [ATTRIBUTION.md](ATTRIBUTION.md).
- No new dependencies unless a few lines of code cannot do it.

## Setup

```bash
git clone https://github.com/<you>/mindfront && cd mindfront
npm run inst          # npm ci --ignore-scripts
npm run dev           # game on http://localhost:9000
npx tsc --noEmit -p . # typecheck
npx vitest run tests/arena
npx tsx arena/decide.ts   # guardrail self-check
```

A live match needs `OPENROUTER_API_KEY` in your environment. Smoke matches use `arena/roster.test.json` with cheap models.

## Where to contribute

- **Rosters and personas** (`arena/roster*.json`): new models, better personas. Display names must be letters, digits and spaces, 3 to 20 characters.
- **Observations** (`arena/observe.ts`): what the model sees. Keep it under ~1k tokens.
- **Guardrails** (`arena/decide.ts`, `arena/observe.ts`): every dropped action must carry a reason the model can act on.
- **Leaderboard and benchmark**: Elo and behaviour metrics from `arena/records/*.events.jsonl`.
- **Camera and reels**: later phases, see `docs/PLAN.md`.

The contract every arena module follows is `arena/types.ts`. Changing it is a design decision: open an issue first.

## Benchmark integrity

Results only count from matches run with the committed rosters, unmodified guardrails, and the same game version. If you change anything that affects play (observation, prompt, guards, game config), say so in the PR so records can be tagged.

## License

By contributing you agree your code is licensed under the GNU AGPL v3.0 (see `LICENSE`) and any assets you add under `resources/` are CC BY-SA 4.0.
