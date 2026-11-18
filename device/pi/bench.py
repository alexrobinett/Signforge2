#!/usr/bin/env python3
"""Measure the player on the Pi the same way every time, for tuning (spike/pi-perf/RESULTS.md, "Linux tuning").

  bench.py playlist <label> <content-dir> <secs> <runs>   alternate cut and fade 600 over the whole playlist
  bench.py restart <label> <n>                            restart the kiosk n times: launch, first prepare, first spot
  bench.py boot <label>                                   from early boot: kernel start to first spot (signforge-bootprobe.service)

Prints one JSON object per run (prefixed "RUN") and a summary line. Run long ones with
`nohup python3 -u bench.py ... > out.txt &`: an ssh session that drops takes buffered output with it.

playlist: each run clears the HTTP cache and bypasses the service worker (or it measures an old
player), loads `index.html?content=./<content-dir>`, waits 10 s, zeroes the frame counters and
measures <secs>. Frames are split by phase as isolate.py does; prepares are every `__sf.prepares`
entry since the load. A sampler records temperature, ARM clock and throttling every 5 s.

restart: the kiosk must already be on the URL to measure (kiosk.env). Times are from just before
`systemctl restart signforge-kiosk`: Chromium's navigation start (`performance.timeOrigin`), the
first spot's start (`__sf.log[0]`), and the first and second prepares.
"""
import calendar, json, os, statistics, subprocess, sys, threading, time, urllib.request
import websocket


def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout.strip()


class Page:
    def __init__(self, timeout=60):
        end = time.time() + timeout
        while True:
            try:
                page = next(t for t in json.load(urllib.request.urlopen("http://127.0.0.1:9222/json", timeout=2))
                            if t["type"] == "page" and ":8090/" in t["url"])
                self.ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=30, suppress_origin=True)
                break
            except Exception:
                if time.time() > end:
                    raise
                time.sleep(0.1)
        self.n = 0

    def call(self, method, **p):
        self.n += 1
        self.ws.send(json.dumps({"id": self.n, "method": method, "params": p}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get("id") == self.n:
                return m.get("result", {})

    def ev(self, x):
        return self.call("Runtime.evaluate", expression=x, returnByValue=True).get("result", {}).get("value")


class Sampler(threading.Thread):
    """Temperature, ARM clock and throttling every 5 s while a run lasts."""
    def __init__(self):
        super().__init__(daemon=True)
        self.temps, self.clocks, self.throttled, self.stop = [], [], set(), False

    def run(self):
        while not self.stop:
            self.temps.append(float(sh("vcgencmd measure_temp").split("=")[1].split("'")[0]))
            self.clocks.append(int(sh("vcgencmd measure_clock arm").split("=")[1]) // 1_000_000)
            self.throttled.add(sh("vcgencmd get_throttled").split("=")[1])
            time.sleep(5)

    def summary(self):
        return {"tempMax": max(self.temps), "tempMean": round(statistics.mean(self.temps), 1),
                "armMhzMean": round(statistics.mean(self.clocks)), "throttled": sorted(self.throttled)}


def pct(d, c):
    return round(100 * d / max(1, d + c), 2)


def playlist(label, content, secs, runs):
    out = []
    for i in range(runs):
        transition = "cut" if i % 2 == 0 else "fade600"
        p = Page()
        p.call("Network.enable"); p.call("Network.clearBrowserCache"); p.call("Network.setBypassServiceWorker", bypass=True)
        p.call("Page.navigate", url=f"http://127.0.0.1:8090/index.html?debug=1&hud=0&poll=600&transition={transition}&content=./{content}")
        time.sleep(10)
        p.ev("__sf.frames = {count: 0, dropped: 0, maxMs: 0}; __sf.byPhase = {}; __sf.stalls.length = 0; 1")
        s = Sampler(); s.start()
        time.sleep(secs)
        s.stop = True
        d = json.loads(p.ev("JSON.stringify({f: __sf.frames, b: __sf.byPhase, st: __sf.stalls, p: __sf.prepares, sk: __sf.skipped,"
                            " js: [...document.scripts].map(s => s.src.split('/').pop())})"))
        p.ws.close()
        b = d["b"]
        tot = {"count": sum(v["count"] for v in b.values()), "dropped": sum(v["dropped"] for v in b.values())}
        ms = [x["ms"] for x in d["p"]]
        by = {}
        for x in d["p"]:
            by.setdefault(x["spot"], []).append(x["ms"])
        r = {"label": label, "run": i + 1, "transition": transition, "player": d["js"],
             "overall": pct(tot["dropped"], tot["count"]),
             **{f"{ph}Pct": pct(v["dropped"], v["count"]) for ph, v in b.items()},
             "loadDropped": b.get("prepare", {}).get("dropped", 0), "transDropped": b.get("transition", {}).get("dropped", 0),
             "worst": d["f"]["maxMs"], "stalls150": sum(x["ms"] >= 150 for x in d["st"]),
             "stalls100": [f"{x['ms']}@{x['phase']}:{x['spot']}>{x['next']}" for x in d["st"] if x["ms"] >= 100],
             "prepares": len(ms), "over500": sum(m > 500 for m in ms), "prepMedian": statistics.median(ms) if ms else None,
             "prepMax": max(ms) if ms else None, "videoPan": by.get("video-pan", []), "skipped": d["sk"], **s.summary()}
        print("RUN", json.dumps(r), flush=True)
        out.append(r)
    for t in ("cut", "fade600"):
        rs = [r for r in out if r["transition"] == t]
        if rs:
            print(f"SUMMARY {label} {t}: overall {[r['overall'] for r in rs]} load {[r.get('preparePct') for r in rs]} "
                  f"trans {[r.get('transitionPct') for r in rs]} worst {[r['worst'] for r in rs]} over500 {[r['over500'] for r in rs]} "
                  f"median {[r['prepMedian'] for r in rs]} videoPan {[r['videoPan'] for r in rs]} tempMax {max(r['tempMax'] for r in rs)}", flush=True)


FIRST = ("JSON.stringify({origin: performance.timeOrigin, log: __sf.log.slice(0, 2), p: __sf.prepares.slice(0, 3),"
         " off: __sf.clock.offsetMs, sk: __sf.skipped, err: __sf.lastError})")


def iso_ms(iso):
    """Epoch ms of the player's ISO time (UTC, ms precision)."""
    return calendar.timegm(time.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S")) * 1000 + int(iso[20:23])


def wait_first(p, end):
    while time.time() < end:
        try:
            d = json.loads(p.ev(FIRST) or "null")
            if d and len(d["p"]) >= 2 and d["log"]:
                return d
        except Exception:
            pass
        time.sleep(0.2)
    return None


def restart(label, n):
    out = []
    for i in range(n):
        time.sleep(20)
        t0 = time.time() * 1000
        sh("sudo systemctl restart signforge-kiosk")
        p = Page(timeout=60)
        d = wait_first(p, time.time() + 60)
        p.ws.close()
        if not d:
            print("RUN", json.dumps({"label": label, "run": i + 1, "error": "no first spot within 60 s"}), flush=True)
            continue
        first = iso_ms(d["log"][0]["startedAt"]) - d["off"]
        r = {"label": label, "run": i + 1, "launchMs": round(d["origin"] - t0), "firstSpotMs": round(first - t0),
             "firstSpot": d["log"][0]["spot"], "prepares": d["p"], "skipped": d["sk"], "err": d["err"]}
        print("RUN", json.dumps(r), flush=True)
        out.append(r)
    if out:
        f = [r["prepares"][0]["ms"] for r in out]
        print(f"SUMMARY {label}: launch {[r['launchMs'] for r in out]} firstSpot {[r['firstSpotMs'] for r in out]} "
              f"firstPrepare {f} (median {statistics.median(f)}) second {[r['prepares'][1]['ms'] for r in out]}", flush=True)


def uptime():
    return float(open("/proc/uptime").read().split()[0])


def boot(label):
    """Run from early boot (signforge-bootprobe.service). Stamps /proc/uptime, which never steps: the Pi has
    no real-time clock, so its wall clock jumps when NTP first syncs, often after Chromium has started."""
    marks, p = {"probeStart": uptime()}, None
    while uptime() < 300 and "firstSpot" not in marks:
        try:
            if p is None:
                urllib.request.urlopen("http://127.0.0.1:9222/json/version", timeout=1)
                marks.setdefault("devtools", uptime())
                p = Page(timeout=1)
                marks.setdefault("page", uptime())
            d = json.loads(p.ev("window.__sf ? JSON.stringify({n: __sf.prepares.length, l: __sf.log.length,"
                                " spot: __sf.log[0] && __sf.log[0].spot, p: __sf.prepares.slice(0, 2), nav: performance.now()}) : 'null'") or "null")
            if d:
                marks.setdefault("navigation", round(uptime() - d["nav"] / 1000, 2))
                if d["n"]:
                    marks.setdefault("firstPrepareDone", uptime())
                if d["l"]:
                    marks["firstSpot"] = uptime()
                    marks["spot"], marks["prepares"] = d["spot"], d["p"]
        except Exception:
            p = None
        time.sleep(0.1)
    marks = {k: round(v, 2) if isinstance(v, float) else v for k, v in marks.items()}
    marks.update(label=label, systemd=sh("systemd-analyze | head -1"),
                 kiosk=sh("systemctl show -p ExecMainStartTimestampMonotonic signforge-kiosk").split("=")[1])
    marks["kiosk"] = round(int(marks["kiosk"]) / 1e6, 2)
    with open(os.path.expanduser("~/signforge/bootprobe.jsonl"), "a") as fh:
        fh.write(json.dumps(marks) + "\n")
    print("RUN", json.dumps(marks), flush=True)


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "playlist":
        playlist(sys.argv[2], sys.argv[3], float(sys.argv[4]), int(sys.argv[5]))
    elif cmd == "restart":
        restart(sys.argv[2], int(sys.argv[3]))
    elif cmd == "boot":
        boot(sys.argv[2])
