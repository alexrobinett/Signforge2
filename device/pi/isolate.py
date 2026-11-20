#!/usr/bin/env python3
"""Play each spot on its own and report dropped frames by phase.

  isolate.py <secs> <transition> <spec> [<spec> ...]
  secs:       how long to measure each spec, in seconds (after 10 s to settle)
  transition: the player's ?transition=: cut, crossfade, fade (both 500 ms), fade<ms>,
              or <ms> for a crossfade that long; ms is a whole number from 1 to 10000
  spec:       a spot id, or several joined with '+' to play as a mini playlist,
              optionally followed by extra player options: "a+b&prep=hidden".
              The player drops spot ids its manifest lacks (all of them: it plays the schedule),
              so a spot asked for that never played is listed after the numbers as NOT PLAYED.
"""
import json, re, sys, time, urllib.request
import websocket


def usage(problem):
    sys.exit(f"isolate.py: {problem}\n{__doc__}")


if len(sys.argv) < 4:
    usage("expected <secs> <transition> and at least one <spec>")
secs, transition, specs = sys.argv[1], sys.argv[2], sys.argv[3:]
if not re.fullmatch(r"\d*\.?\d+", secs) or float(secs) == 0:
    usage(f"<secs> must be a number of seconds above 0, not {secs!r}")
secs = float(secs)
# The same grammar the player parses (packages/player/src/transition-override.ts), which refuses anything else.
named = re.fullmatch(r"cut|crossfade|fade|fade(\d+)|(\d+)", transition)
ms = named and (named[1] or named[2])
if not named or ms and not 1 <= int(ms) <= 10_000:
    usage(f"<transition> must be cut, crossfade, fade, fade<ms> or <ms>, not {transition!r}")
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
    call("Page.navigate", url=f"http://127.0.0.1:8090/index.html?debug=1&poll=600&transition={transition}&spots={spots.replace('+', ',')}&{extra}")
    time.sleep(10)
    ev("__sf.frames = {count: 0, dropped: 0, maxMs: 0}; __sf.byPhase = {}; __sf.stalls.length = 0; 1")
    time.sleep(secs)
    s = json.loads(ev("JSON.stringify({f: __sf.frames, p: __sf.byPhase, st: __sf.stalls, sk: __sf.skipped, log: __sf.log})"))
    ph = {k: f"{pct(v):6.2f}" for k, v in s["p"].items()}
    # Overall from the phase totals: the soak logger resets __sf.frames every minute.
    tot = {"count": sum(v["count"] for v in s["p"].values()), "dropped": sum(v["dropped"] for v in s["p"].values())}
    big = ", ".join(f"{x['ms']}@{x['phase']}" for x in s["st"] if x["ms"] >= 150)
    played = {x["spot"] for x in s["log"] if x["playlist"] == "__test"}
    unplayed = [x for x in spots.split("+") if x not in played]
    print(f"{spec[:38]:38s} {pct(tot):6.2f} {ph.get('play', '     -'):>6s} {ph.get('prepare', '     -'):>6s} {ph.get('transition', '     -'):>6s} {s['f']['maxMs']:6d}  {big}"
          f"{'  SKIPPED ' + str(s['sk']) if s['sk'] else ''}{'  NOT PLAYED ' + ','.join(unplayed) if unplayed else ''}")
