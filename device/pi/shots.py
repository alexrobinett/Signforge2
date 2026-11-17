#!/usr/bin/env python3
"""Screenshot spots one at a time, a few seconds in.   Usage: shots.py <seconds-in> <spot> [<spot> ...]
Writes /tmp/shot-<spot>.png. Returns the page to normal playback afterwards."""
import base64, json, sys, time, urllib.request
import websocket
import os as _os
_tf = _os.path.expanduser("~/signforge/supervisor.token")
# Keep the supervisor token in every URL the tools load, so display power keeps working after a test.
TOKEN = f"supervisorToken={open(_tf).read().strip()}&" if _os.path.exists(_tf) else ""
page = next(t for t in json.load(urllib.request.urlopen("http://127.0.0.1:9222/json")) if t["type"] == "page" and ":8090/" in t["url"])
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=30, suppress_origin=True)
n = 0
def call(m, **p):
    global n
    n += 1
    ws.send(json.dumps({"id": n, "method": m, "params": p}))
    while True:
        r = json.loads(ws.recv())
        if r.get("id") == n:
            return r.get("result", {})
wait = float(sys.argv[1])
for spot in sys.argv[2:]:
    call("Page.navigate", url=f"http://127.0.0.1:8090/index.html?{TOKEN}poll=600&spots={spot}")
    time.sleep(2 + wait)
    open(f"/tmp/shot-{spot}.png", "wb").write(base64.b64decode(call("Page.captureScreenshot", format="png")["data"]))
call("Page.navigate", url=f"http://127.0.0.1:8090/index.html?{TOKEN}debug=1&poll=10")
