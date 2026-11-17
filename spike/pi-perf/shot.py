#!/usr/bin/env python3
"""Navigate the kiosk to a path, wait, and save a screenshot. Usage: shot.py <path> <seconds> <out.png>"""
import base64, json, sys, time, urllib.request
import websocket
t = next(t for t in json.load(urllib.request.urlopen("http://127.0.0.1:9222/json"))
         if t["type"] == "page" and t["url"].startswith("http://127.0.0.1:8080/") and "/template/" not in t["url"])
ws = websocket.create_connection(t["webSocketDebuggerUrl"], timeout=30, suppress_origin=True)
def call(i, method, **params):
    ws.send(json.dumps({"id": i, "method": method, "params": params}))
    while True:
        m = json.loads(ws.recv())
        if m.get("id") == i:
            return m.get("result", {})
call(1, "Page.navigate", url="http://127.0.0.1:8080" + sys.argv[1])
time.sleep(float(sys.argv[2]))
open(sys.argv[3], "wb").write(base64.b64decode(call(2, "Page.captureScreenshot", format="png")["data"]))
