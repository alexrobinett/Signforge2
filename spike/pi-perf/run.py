#!/usr/bin/env python3
"""Drive the kiosk Chromium over the DevTools protocol and collect frame pacing.

Runs on the Pi. Usage: run.py [label] [variant ...]
"""
import json
import subprocess
import sys
import time
import urllib.request

import websocket  # python3-websocket

CDP = "http://127.0.0.1:9222"
BASE = "http://127.0.0.1:8080/index.html"
SECONDS = 20


def get(path):
    return json.load(urllib.request.urlopen(CDP + path, timeout=5))


class Session:
    def __init__(self, url):
        self.ws = websocket.create_connection(url, timeout=30, suppress_origin=True)
        self.n = 0

    def call(self, method, **params):
        self.n += 1
        self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.n:
                return msg.get("result", msg)

    def evaluate(self, expr):
        r = self.call("Runtime.evaluate", expression=expr, returnByValue=True)
        return r.get("result", {}).get("value")


def cpu_times():
    with open("/proc/stat") as f:
        v = [int(x) for x in f.readline().split()[1:]]
    return sum(v), v[3] + v[4]


def vcgencmd(*args):
    return subprocess.run(["vcgencmd", *args], capture_output=True, text=True).stdout.strip()


def run_variant(page, variant, sandbox=True):
    query = variant if "=" in variant else f"variant={variant}"
    url = f"{BASE}?{query}&seconds={SECONDS}" + ("" if sandbox else "&sandbox=0")
    if variant.startswith("/"):
        url = "http://127.0.0.1:8080" + variant + f"&seconds={SECONDS}"
    page.call("Page.navigate", url=url)
    time.sleep(3)
    total0, idle0 = cpu_times()
    temps = []
    deadline = time.time() + SECONDS + 30
    result = None
    while time.time() < deadline:
        temps.append(float(vcgencmd("measure_temp").split("=")[1].split("'")[0]))
        raw = page.evaluate("JSON.stringify(window.__result || null)")
        if raw and raw != "null":
            result = json.loads(raw)
            break
        time.sleep(2)
    total1, idle1 = cpu_times()
    busy = 100 * (1 - (idle1 - idle0) / max(1, total1 - total0))
    return {
        "result": result,
        "cpuBusyPct": round(busy, 1),
        "tempMaxC": max(temps),
        "throttled": vcgencmd("get_throttled"),
    }


def main():
    label = sys.argv[1] if len(sys.argv) > 1 else "run"
    variants = sys.argv[2:] or ["compositor", "filter", "layout"]
    version = get("/json/version")
    page_target = next(t for t in get("/json") if t["type"] == "page" and t["url"].startswith("http://127.0.0.1:8080/") and "/template/" not in t["url"])
    page = Session(page_target["webSocketDebuggerUrl"])
    page.call("Page.enable")

    out = {"label": label, "browser": version.get("Browser"), "runs": {}}
    try:
        browser = Session(version["webSocketDebuggerUrl"])
        gpu = browser.call("SystemInfo.getInfo").get("gpu", {})
        out["gpu"] = {
            "devices": gpu.get("devices"),
            "features": gpu.get("featureStatus"),
            "workarounds": gpu.get("driverBugWorkarounds"),
        }
    except Exception as e:  # noqa: BLE001
        out["gpu"] = {"error": str(e)}

    for v in variants:
        sandbox = True
        name = v
        if v.endswith(":nosandbox"):
            name, sandbox = v.split(":")[0], False
        out["runs"][v] = run_variant(page, name, sandbox)
        r = out["runs"][v]; t = (r["result"] or {}).get("template") or {}
        extra = {k: (r["result"] or {}).get(k) for k in ("readyMs", "error", "animations", "stateMachines") if (r["result"] or {}).get(k)}
        if v.startswith("/"): print("  ", extra)
        print(f"{v:42s} fps={t.get('fps')} dropped={t.get('droppedPct')}% p99={t.get('p99Ms')}ms max={t.get('maxMs')}ms "
              f"cpu={r['cpuBusyPct']}% temp={r['tempMaxC']}C {r['throttled']}", flush=True)

    path = f"/home/alex/spike-results/{label}.json"
    subprocess.run(["mkdir", "-p", "/home/alex/spike-results"], check=True)
    with open(path, "w") as f:
        json.dump(out, f, indent=2)
    print("saved", path)


if __name__ == "__main__":
    main()
