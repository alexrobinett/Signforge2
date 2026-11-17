#!/usr/bin/env python3
"""Record a Chromium performance trace for N seconds and list the long events next to the
player's stalls.   Usage: trace.py [seconds]
"""
import json, sys, time, urllib.request
from collections import defaultdict
import websocket

SECS = float(sys.argv[1]) if len(sys.argv) > 1 else 30
ver = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json/version"))
page = next(t for t in json.load(urllib.request.urlopen("http://127.0.0.1:9222/json")) if t["type"] == "page" and ":8090/" in t["url"])
b = websocket.create_connection(ver["webSocketDebuggerUrl"], timeout=120, suppress_origin=True)
p = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=30, suppress_origin=True)
ids = {"n": 0}
def call(ws, method, **params):
    ids["n"] += 1
    ws.send(json.dumps({"id": ids["n"], "method": method, "params": params}))
    while True:
        m = json.loads(ws.recv())
        if m.get("id") == ids["n"]:
            return m.get("result", m)
        if m.get("method") == "Tracing.tracingComplete":
            return m["params"]
def ev(x):
    return call(p, "Runtime.evaluate", expression=x, returnByValue=True).get("result", {}).get("value")

ev("__sf.stalls.length = 0; 1")
t0 = time.time()
call(b, "Tracing.start", transferMode="ReturnAsStream", traceConfig={"includedCategories": [
    "toplevel", "devtools.timeline", "v8", "disabled-by-default-v8.gc", "blink.gc", "gpu", "viz", "cc", "media", "loading", "blink"]})
time.sleep(SECS)
ids["n"] += 1
b.send(json.dumps({"id": ids["n"], "method": "Tracing.end"}))
stream = None
while not stream:
    m = json.loads(b.recv())
    if m.get("method") == "Tracing.tracingComplete":
        stream = m["params"]["stream"]
chunks = []
while True:
    r = call(b, "IO.read", handle=stream, size=4 << 20)
    chunks.append(r.get("data", ""))
    if r.get("eof"):
        break
events = json.loads("".join(chunks))
events = events["traceEvents"] if isinstance(events, dict) else events
stalls = json.loads(ev("JSON.stringify(__sf.stalls)"))

names = {}
for e in events:
    if e.get("ph") == "M" and e.get("name") in ("thread_name", "process_name"):
        names[(e["pid"], e.get("tid") if e["name"] == "thread_name" else None)] = e["args"]["name"]
def where(e):
    return f"{names.get((e['pid'], None), e['pid'])}/{names.get((e['pid'], e['tid']), e['tid'])}"

long = [e for e in events if e.get("ph") == "X" and e.get("dur", 0) > 60_000]
agg = defaultdict(lambda: [0, 0.0])
for e in long:
    k = (e["name"], where(e))
    agg[k][0] += 1
    agg[k][1] = max(agg[k][1], e["dur"] / 1000)
print(f"trace: {len(events)} events, stalls seen by the player: {len(stalls)}")
for s in stalls:
    print("  stall", s)
print("\nlongest events (>60 ms): count, worst ms, name, process/thread")
for (name, w), (c, worst) in sorted(agg.items(), key=lambda kv: -kv[1][1])[:30]:
    print(f"  {c:3d} {worst:7.0f}  {name[:48]:48s} {w}")
