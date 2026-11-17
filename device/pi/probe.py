#!/usr/bin/env python3
"""Read the running player's state over DevTools. Needs the kiosk started with remote debugging.

  probe.py                 print window.__sf
  probe.py --shot out.png  also save a screenshot
  probe.py --reset         zero the frame counters
  probe.py --eval "<js>"   evaluate an expression in the player page
"""
import base64, json, sys, urllib.request
import websocket

page = next(t for t in json.load(urllib.request.urlopen("http://127.0.0.1:9222/json"))
            if t["type"] == "page" and ":8090/" in t["url"])
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=30, suppress_origin=True)
n = 0
def call(method, **params):
    global n
    n += 1
    ws.send(json.dumps({"id": n, "method": method, "params": params}))
    while True:
        m = json.loads(ws.recv())
        if m.get("id") == n:
            return m.get("result", {})
def evaluate(expr):
    return call("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True).get("result", {}).get("value")

args = sys.argv[1:]
if "--reset" in args:
    evaluate("__sf.frames = {count: 0, dropped: 0, maxMs: 0}; __sf.byPhase = {}; __sf.stalls.length = 0; 1")
if "--eval" in args:
    print(evaluate(args[args.index("--eval") + 1]))
if "--shot" in args:
    open(args[args.index("--shot") + 1], "wb").write(base64.b64decode(call("Page.captureScreenshot", format="png")["data"]))
s = json.loads(evaluate("JSON.stringify({...__sf, log: __sf.log.slice(-6), stalls: __sf.stalls.slice(-40)})"))
f = s["frames"]
s["frames"]["droppedPct"] = round(100 * f["dropped"] / max(1, f["count"] + f["dropped"]), 2)
print(json.dumps(s, indent=1))
