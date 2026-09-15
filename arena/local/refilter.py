#!/usr/bin/env python3
"""Re-stamp a built dataset with the current arena/local/tools.json and drop
examples too long for the training cap (a truncated label trains on nothing
and turns the loss NaN). Usage: refilter.py data/ [max_chars=12000]"""
import json, sys, os
d = sys.argv[1]; max_chars = int(sys.argv[2]) if len(sys.argv) > 2 else 12000
tools = json.load(open(os.path.join(os.path.dirname(__file__), "tools.json")))
for name in ("train.jsonl", "valid.jsonl"):
    src = os.path.join(d, name); tmp = src + ".tmp"; kept = total = 0
    with open(src) as f, open(tmp, "w") as out:
        for line in f:
            total += 1
            e = json.loads(line); e["tools"] = tools
            s = json.dumps(e, separators=(",", ":"))
            if len(s) > max_chars: continue
            out.write(s + "\n"); kept += 1
    os.replace(tmp, src); print(f"{name}: kept {kept}/{total}")
