#!/usr/bin/env python3
"""Count frames the compositor actually presented (light trace: viz only) next to the page's
rAF counter, over the same window.   Usage: presented.py [secs] [url-query]
"""
import json, sys, time, urllib.request
from collections import Counter
import websocket

SECS = float(sys.argv[1]) if len(sys.argv) > 1 else 40
QUERY = sys.argv[2] if len(sys.argv) > 2 else ""
ver = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json/version"))
page = next(t for t in json.load(urllib.request.urlopen("http://127.0.0.1:9222/json")) if t["type"] == "page" and ":8090/" in t["url"])
b = websocket.create_connection(ver["webSocketDebuggerUrl"], timeout=120, suppress_origin=True)
p = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=30, suppress_origin=True)
n = {"i": 0}
def call(ws, method, **params):
    n["i"] += 1
    ws.send(json.dumps({"id": n["i"], "method": method, "params": params}))
    while True:
        m = json.loads(ws.recv())
        if m.get("id") == n["i"]:
            return m.get("result", m)
def ev(x):
    for _ in range(20):
        try:
            return call(p, "Runtime.evaluate", expression=x, returnByValue=True).get("result", {}).get("value")
        except Exception:
            time.sleep(0.5)
if QUERY:
    call(p, "Page.navigate", url=f"http://127.0.0.1:8090/index.html?debug=1&poll=600&{QUERY}")
    time.sleep(10)
ev("__sf.frames = {count: 0, dropped: 0, maxMs: 0}; __sf.byPhase = {}; __sf.stalls.length = 0; 1")
call(b, "Tracing.start", transferMode="ReturnAsStream", traceConfig={"includedCategories": ["viz", "benchmark"], "excludedCategories": ["*"]})
time.sleep(SECS)
raf = json.loads(ev("JSON.stringify(__sf.frames)"))
n["i"] += 1
b.send(json.dumps({"id": n["i"], "method": "Tracing.end"}))
stream = None
while not stream:
    m = json.loads(b.recv())
    if m.get("method") == "Tracing.tracingComplete":
        stream = m["params"]["stream"]
data = []
while True:
    r = call(b, "IO.read", handle=stream, size=4 << 20)
    data.append(r.get("data", ""))
    if r.get("eof"):
        break
ev_ = json.loads("".join(data))
ev_ = ev_["traceEvents"] if isinstance(ev_, dict) else ev_
names = Counter(e["name"] for e in ev_ if e.get("ph") in ("X", "B"))
swaps = sorted(e["ts"] for e in ev_ if e.get("name") == "Display::DrawAndSwap" and e.get("ph") in ("X", "B"))
if not swaps:
    print("no DrawAndSwap events; top names:", names.most_common(15))
    sys.exit()
iv = [(b2 - a) / 1000 for a, b2 in zip(swaps, swaps[1:])]
period = sorted(iv)[len(iv) // 2]
missed = sum(max(0, round(d / 16.667) - 1) for d in iv)
span = (swaps[-1] - swaps[0]) / 1e6
print(f"presented: {len(swaps)} frames in {span:.1f}s = {len(swaps) / span:.1f} fps, median interval {period:.1f} ms, "
      f"missed vsyncs {missed} ({100 * missed / (len(iv) + missed):.2f}%), worst gap {max(iv):.0f} ms, gaps>50ms {sum(d > 50 for d in iv)}")
print(f"page rAF:  {raf['count']} frames, dropped {raf['dropped']} ({100 * raf['dropped'] / max(1, raf['count'] + raf['dropped']):.2f}%), worst {raf['maxMs']} ms")
