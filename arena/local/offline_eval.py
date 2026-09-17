#!/usr/bin/env python3
"""Offline check: does the model served on :9300 reproduce the human labels on
held-out examples? N act + N hold examples; prints the (label, prediction)
confusion, calls per example, mean ratio and the tool mix. This is what caught
the never-loaded adapter (16 Sep): a served model that never holds, or whose
ratios sit outside 0.05-0.6, is not the trained one.
Also reports "grounded" calls: ones the observation says are possible (target is
a neighbour, unit affordable, id mine, ...) — the arena refuses the rest.
Usage: offline_eval.py <temperature> [N=30] [valid.jsonl=data/valid.jsonl] [top_p=1]"""
import json, sys, random, urllib.request, collections, os
T = float(sys.argv[1]); N = int(sys.argv[2]) if len(sys.argv) > 2 else 30
VALID = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "data/valid.jsonl")
TOP_P = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0

def grounded(call, o):
    """Would the arena accept this call given observation o? (mirrors arena/observe.ts guards, roughly)"""
    me = o["me"]; name = call["function"]["name"]; a = call["function"]["arguments"]; a = json.loads(a) if isinstance(a, str) else a
    ids = lambda key: {d["id"] for d in o.get(key, [])}
    neigh = ids("neighbors"); visible = neigh | ids("reachableByBoat") | ids("leaderboard") | set(me.get("allies", []))
    t = a.get("target")
    if name == "attack": return t in neigh and t not in me.get("allies", [])
    if name == "boat": return t in visible and t not in me.get("allies", [])
    if name == "expand": return me.get("freeLandAtBorder", 0) > 0
    if name == "build": return a.get("unit") in {c["unit"] for c in o.get("canBuild", [])}
    if name == "upgrade": return a.get("id") in {u["id"] for u in me.get("units", [])}
    if name == "move_warship": return a.get("id") in {u["id"] for u in me.get("units", []) if u.get("type") == "Warship"}
    if name == "nuke": return t in visible and me.get("structures", {}).get("Missile Silo", 0) > 0
    if name == "retreat": return not a or t in {x["to"] for x in me.get("outgoingAttacks", [])}
    if name == "recall_boats": return me.get("boatsInFlight", 0) > 0
    if name == "ally": return t in visible and t not in me.get("allies", [])
    if name == "accept_alliance" or name == "reject_alliance": return t in set(me.get("pendingAllianceRequestsFrom", []))
    if name in ("extend_alliance", "break_alliance", "donate"): return t in set(me.get("allies", []))
    if name in ("embargo", "chat"): return t in visible
    if name == "emoji": return t is None or t in visible
    return False
random.seed(7)
acts, holds = [], []
for line in open(VALID):
    ex = json.loads(line)
    (acts if ex["messages"][-1].get("tool_calls") else holds).append(ex)
random.shuffle(acts); random.shuffle(holds)
sample = acts[:N] + holds[:N]
def ask(ex):
    body = {"model": "default_model", "messages": ex["messages"][:2], "tools": ex["tools"], "tool_choice": "auto",
            "max_tokens": 600, "temperature": T, "top_p": TOP_P}
    req = urllib.request.Request("http://localhost:9300/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
    m = json.load(urllib.request.urlopen(req, timeout=300))["choices"][0]["message"]
    return m.get("tool_calls") or []
conf = collections.Counter(); ratios_p, ratios_l, calls_p, calls_l = [], [], [], []
g_p = [0, 0]; g_l = [0, 0]
names_p, names_l = collections.Counter(), collections.Counter()
for ex in sample:
    lab = ex["messages"][-1].get("tool_calls") or []
    pred = ask(ex)
    obs = json.loads(ex["messages"][1]["content"])
    for c in lab: g_l[0] += grounded(c, obs); g_l[1] += 1
    for c in pred: g_p[0] += grounded(c, obs); g_p[1] += 1
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
print(f"T={T} top_p={TOP_P} n={len(sample)}  (label,pred):", dict(conf))
print(f" grounded calls: pred {g_p[0]}/{g_p[1]}  label {g_l[0]}/{g_l[1]}")
print(" calls/example label", mean(calls_l), "pred", mean(calls_p))
print(" ratio label mean", mean(ratios_l), "pred mean", mean(ratios_p), "pred>0.6:", sum(r > 0.6 for r in ratios_p), "/", len(ratios_p))
print(" names label", dict(names_l)); print(" names pred ", dict(names_p))
