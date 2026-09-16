#!/usr/bin/env python3
"""Offline check: does the model served on :9300 reproduce the human labels on
held-out examples? N act + N hold examples; prints the (label, prediction)
confusion, calls per example, mean ratio and the tool mix. This is what caught
the never-loaded adapter (16 Sep): a served model that never holds, or whose
ratios sit outside 0.05-0.6, is not the trained one.
Usage: offline_eval.py <temperature> [N=30] [valid.jsonl=data/valid.jsonl]"""
import json, sys, random, urllib.request, collections, os
T = float(sys.argv[1]); N = int(sys.argv[2]) if len(sys.argv) > 2 else 30
VALID = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "data/valid.jsonl")
random.seed(7)
acts, holds = [], []
for line in open(VALID):
    ex = json.loads(line)
    (acts if ex["messages"][-1].get("tool_calls") else holds).append(ex)
random.shuffle(acts); random.shuffle(holds)
sample = acts[:N] + holds[:N]
def ask(ex):
    body = {"model": "default_model", "messages": ex["messages"][:2], "tools": ex["tools"], "tool_choice": "auto",
            "max_tokens": 600, "temperature": T}
    req = urllib.request.Request("http://localhost:9300/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
    m = json.load(urllib.request.urlopen(req, timeout=300))["choices"][0]["message"]
    return m.get("tool_calls") or []
conf = collections.Counter(); ratios_p, ratios_l, calls_p, calls_l = [], [], [], []
names_p, names_l = collections.Counter(), collections.Counter()
for ex in sample:
    lab = ex["messages"][-1].get("tool_calls") or []
    pred = ask(ex)
    conf[("act" if lab else "hold", "act" if pred else "hold")] += 1
    calls_l.append(len(lab)); calls_p.append(len(pred))
    for c in lab:
        names_l[c["function"]["name"]] += 1
        r = c["function"]["arguments"].get("ratio")
        if r is not None: ratios_l.append(float(r))
    for c in pred:
        a = c["function"]["arguments"]; a = json.loads(a) if isinstance(a, str) else a
        names_p[c["function"]["name"]] += 1
        r = a.get("ratio")
        if r is not None: ratios_p.append(float(r))
mean = lambda xs: round(sum(xs) / len(xs), 2) if xs else None
print(f"T={T} n={len(sample)}  (label,pred):", dict(conf))
print(" calls/example label", mean(calls_l), "pred", mean(calls_p))
print(" ratio label mean", mean(ratios_l), "pred mean", mean(ratios_p), "pred>0.6:", sum(r > 0.6 for r in ratios_p), "/", len(ratios_p))
print(" names label", dict(names_l)); print(" names pred ", dict(names_p))
