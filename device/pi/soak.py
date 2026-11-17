#!/usr/bin/env python3
"""Soak-test logger. Every INTERVAL seconds, sample the player and the system and append a row
to ~/signforge/soak.csv. Frame counters are reset after each sample, so each row covers one interval.
Stalls (frames over 50 ms) are appended to ~/signforge/soak-stalls.jsonl.
"""
import csv, json, os, subprocess, time, urllib.request
from datetime import datetime

import websocket

INTERVAL = 60
OUT = os.path.expanduser("~/signforge/soak.csv")
STALLS = os.path.expanduser("~/signforge/soak-stalls.jsonl")
FIELDS = ["time", "ok", "manifest", "online", "played", "skipped", "frames", "dropped", "dropped_pct", "worst_ms", "stalls",
          "heap_mb", "chromium_rss_mb", "chromium_procs", "mem_available_mb", "temp_c", "throttled", "kiosk_uptime_s",
          "weather_fetched", "last_error"]
EXPR = ("(() => { const s = {manifest: __sf.manifestId, online: __sf.online, played: __sf.played, skipped: __sf.skipped,"
        " frames: __sf.frames, stalls: __sf.stalls.slice(), heap: __sf.heapMb, data: __sf.data, err: __sf.lastError,"
        " up: Math.round(performance.now() / 1000)};"
        " __sf.frames = {count: 0, dropped: 0, maxMs: 0}; __sf.stalls.length = 0; return JSON.stringify(s); })()")

def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout.strip()

def player():
    page = next(t for t in json.load(urllib.request.urlopen("http://127.0.0.1:9222/json", timeout=5))
                if t["type"] == "page" and ":8090/" in t["url"])
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=20, suppress_origin=True)
    try:
        ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {"expression": EXPR, "returnByValue": True}}))
        while True:
            m = json.loads(ws.recv())
            if m.get("id") == 1:
                return json.loads(m["result"]["result"]["value"])
    finally:
        ws.close()

def sample():
    row = {k: "" for k in FIELDS}
    row["time"] = datetime.now().isoformat(timespec="seconds")
    rss = [int(x) for x in sh("ps -C chromium -o rss=").split()]
    row["chromium_rss_mb"] = round(sum(rss) / 1024)
    row["chromium_procs"] = len(rss)
    row["mem_available_mb"] = round(int(sh("awk '/MemAvailable/ {print $2}' /proc/meminfo") or 0) / 1024)
    row["temp_c"] = sh("vcgencmd measure_temp").replace("temp=", "").replace("'C", "")
    row["throttled"] = sh("vcgencmd get_throttled").replace("throttled=", "")
    try:
        s = player()
        f = s["frames"]
        row.update(ok=1, manifest=s["manifest"], online=int(s["online"]), played=s["played"], skipped=s["skipped"],
                   frames=f["count"], dropped=f["dropped"], worst_ms=f["maxMs"], stalls=len(s["stalls"]),
                   dropped_pct=round(100 * f["dropped"] / max(1, f["count"] + f["dropped"]), 2),
                   heap_mb=s["heap"], kiosk_uptime_s=s["up"], weather_fetched=s["data"].get("weather", ""), last_error=s["err"])
        if s["stalls"]:
            with open(STALLS, "a") as fh:
                for st in s["stalls"]:
                    fh.write(json.dumps({"time": row["time"], **st}) + "\n")
    except Exception as e:
        row.update(ok=0, last_error=f"probe failed: {e}")
    new = not os.path.exists(OUT)
    with open(OUT, "a", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS)
        if new:
            w.writeheader()
        w.writerow(row)

while True:
    sample()
    time.sleep(INTERVAL)
