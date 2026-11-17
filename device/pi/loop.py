#!/usr/bin/env python3
"""Measure one full playlist loop, spot by spot. Prints frame stats per spot and every stall
(a frame over 50 ms) with what the player was doing at the time. Saves a screenshot of each
spot to /tmp/shot-<spot>.png.   Usage: loop.py [max-seconds]
"""
import base64, json, sys, time, urllib.request
import websocket

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
    return call("Runtime.evaluate", expression=x, returnByValue=True).get("result", {}).get("value")

TAKE = ("(() => { const s = {spot: __sf.spot, f: __sf.frames, st: __sf.stalls.slice(), age: Date.now() - Date.parse(__sf.log.at(-1).startedAt),"
        " sk: __sf.skipped, err: __sf.lastError}; return JSON.stringify(s); })()")
RESET = "__sf.frames = {count: 0, dropped: 0, maxMs: 0}; __sf.stalls.length = 0; 1"
VQ = ("(() => { const v = [...document.querySelectorAll('video')].find(v => !v.paused); if (!v) return null;"
      " const q = v.getVideoPlaybackQuality(); return {decoded: q.totalVideoFrames, dropped: q.droppedVideoFrames}; })()")

limit = float(sys.argv[1]) if len(sys.argv) > 1 else 150
# Start cleanly at a spot boundary.
first = json.loads(ev(TAKE))["spot"]
while json.loads(ev(TAKE))["spot"] == first:
    time.sleep(0.1)
ev(RESET)
rows, cur, shot, vq, start = [], json.loads(ev(TAKE))["spot"], False, None, time.time()
total = {"count": 0, "dropped": 0}
while time.time() - start < limit:
    s = json.loads(ev(TAKE))
    q = ev(VQ)
    if q:
        vq = q
    if s["spot"] != cur:
        rows.append((cur, prev, vq))
        total["count"] += prev["f"]["count"]; total["dropped"] += prev["f"]["dropped"]
        ev(RESET)
        cur, shot, vq = s["spot"], False, None
        if cur == rows[0][0]:
            break
        continue
    if not shot and s["age"] > 4000:
        open(f"/tmp/shot-{cur}.png", "wb").write(base64.b64decode(call("Page.captureScreenshot", format="png")["data"]))
        shot = True
    prev = s
    time.sleep(0.25)

print(f"{'spot':20s} {'frames':>6s} {'drop%':>6s} {'worst':>6s}  stalls (ms@phase, loading next)")
for spot, s, vq in rows:
    f = s["f"]
    pct = 100 * f["dropped"] / max(1, f["count"] + f["dropped"])
    st = ", ".join(f"{x['ms']}ms at {x['atMs'] / 1000:.1f}s {x['phase']}{'/' + x['next'] if x['next'] else ''}" for x in s["st"][:5])
    v = f"  video decoded {vq['decoded']} dropped {vq['dropped']}" if vq else ""
    print(f"{spot:20s} {f['count']:6d} {pct:6.2f} {f['maxMs']:6d}  {st}{v}")
print(f"LOOP total dropped {100 * total['dropped'] / max(1, total['count'] + total['dropped']):.2f}% | skipped {s['sk']} | last error: {s['err'] or 'none'}")
