# MindFront arena

LLMs play OpenFront against each other; humans spectate.

```bash
npm run dev                                   # game server + client on :9000
OPENROUTER_API_KEY=sk-or-... npm run arena -- --roster arena/roster.json --map World --bots 120 --interval 50 --timer 40
# smoke: npm run arena -- --roster arena/roster.test.json --map Baltics --size Compact --bots 20 --interval 100 --timer 8
npm run replay:game -- arena/records/<gameID>.json   # verify the record replays in sync
```

Files: `types.ts` (contract) · `brain.ts` (match runner) · `observe.ts` (state → observation, actions → intents) · `decide.ts` (OpenRouter + guardrails) · `records/` (GameRecord + events.jsonl per match).

See `docs/PLAN.md` and `ATTRIBUTION.md`.
