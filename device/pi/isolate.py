#!/usr/bin/env python3
"""Play each spot on its own and report dropped frames by phase.

  isolate.py <secs> <transition> <spec> [<spec> ...]
  spec: a spot id, or several joined with '+' to play as a mini playlist,
        optionally followed by extra player options: "a+b&prep=hidden".
"""
import json, sys, time, urllib.request
import websocket
import os as _os
_tf = _os.path.expanduser("~/signforge/supervisor.token")
# Keep the supervisor token in every URL the tools load, so display power keeps working after a test.
TOKEN = f"supervisorToken={open(_tf).read().strip()}&" if _os.path.exists(_tf) else ""

secs, transition, specs = float(sys.argv[1]), sys.argv[2], sys.argv[3:]
page = next(t for t in json.load(urllib.request.urlopen("http://127.0.0.1:9222/json")) if t["type"] == "page" and ":8090/" in t["url"])
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=30, suppress_origin=True)
n = 0
def call(method, **p):
    global n
    n += 1
    ws.send(json.dumps({"id": n, "method": method, "params": p}))
    while True:
        m = json.loads(ws.recv())
        if m.get("id") == n:
            return m.get("result", {})
def ev(x):
    for _ in range(20):
        try:
            return call("Runtime.evaluate", expression=x, returnByValue=True).get("result", {}).get("value")
        except Exception:
            time.sleep(0.5)

def pct(c):
    return 100 * c["dropped"] / max(1, c["count"] + c["dropped"])

print(f"{'spots':38s} {'all%':>6s} {'play%':>6s} {'load%':>6s} {'trans%':>6s} {'worst':>6s}  big stalls")
for spec in specs:
    spots, _, extra = spec.partition('&')
    call("Page.navigate", url=f"http://127.0.0.1:8090/index.html?{TOKEN}debug=1&poll=600&transition={transition}&spots={spots.replace('+', ',')}&{extra}")
    time.sleep(10)
    ev("__sf.frames = {count: 0, dropped: 0, maxMs: 0}; __sf.byPhase = {}; __sf.stalls.length = 0; 1")
    time.sleep(secs)
    s = json.loads(ev("JSON.stringify({f: __sf.frames, p: __sf.byPhase, st: __sf.stalls, sk: __sf.skipped})"))
    ph = {k: f"{pct(v):6.2f}" for k, v in s["p"].items()}
    # Overall from the phase totals: the soak logger resets __sf.frames every minute.
    tot = {"count": sum(v["count"] for v in s["p"].values()), "dropped": sum(v["dropped"] for v in s["p"].values())}
    big = ", ".join(f"{x['ms']}@{x['phase']}" for x in s["st"] if x["ms"] >= 150)
    print(f"{spec[:38]:38s} {pct(tot):6.2f} {ph.get('play', '     -'):>6s} {ph.get('prepare', '     -'):>6s} {ph.get('transition', '     -'):>6s} {s['f']['maxMs']:6d}  {big}{'  SKIPPED ' + str(s['sk']) if s['sk'] else ''}")
