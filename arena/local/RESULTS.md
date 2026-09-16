# Local seat results (one seat vs scripted nations, World Compact, 120 tribes, 20 min, $0)

| run | seat | prompt | nations | result | peak tiles | rounds (median gap) | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| aUjFaMR5aP | Qwen3.6-35B-A3B-4bit untuned | full manual (`localfull/`) | 6 Medium | dead at 16:11 | 20,332 at 7:30 | 184 (3.2 s) | 0 alliances; 45 builds (Defense Posts mostly), 36 attacks into two nations at 0.15–0.5 every ~30 s, 7 boats, 6 move_warship; 28 drops |
| aqV4m6RyUK | Qwen3-30B-A3B-2507-4bit + LoRA v1 (5k iters, val loss 0.14) | short prompt (`local/`) | 6 Medium | dead at 1:02 | 1,534 | 36 (1 s) | 4 s rounds, no narration; but fired `attack(6, 0.8)` + `boat(x, 0.8)` every round from the first tick: the data had 5 % idle rounds, the model learned "act every round" and emptied its army in a minute. v2 trains on every empty 50-tick window (~50 % idle). |
