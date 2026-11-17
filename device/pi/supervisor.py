#!/usr/bin/env python3
"""Device supervisor: the part of the Pi the browser cannot reach. For now it powers the panel.

The player decides *when* (it owns the schedule, display hours included, and works offline);
the supervisor only does *how*, over a local HTTP API:

  POST /display/on    signal on at 1080p60, then wake the TV and select this input over CEC
  POST /display/off   put the TV in standby over CEC, then turn the video signal off
  GET  /display       last state and which methods worked

Two methods, because panels differ:
  CEC     TVs and commercial displays. Ignored by most monitors.
  signal  turning the HDMI output off. A monitor goes to standby on no signal, and so do many TVs.
Both run every time; whichever the panel honours does the work.

Listens on 127.0.0.1 only, and acts only on requests that carry the device's secret token
(~/signforge/supervisor.token, created on first run and passed to the player in the kiosk URL).
A plain POST from any page would otherwise reach it without a CORS preflight: the token header
forces one, the preflight is granted only to the player's origin, and a request whose Host is not
this address (DNS rebinding) is refused.
"""
import hmac, json, os, secrets, subprocess, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8091
MODE = "1920x1080@60"
CEC_DEV = "/dev/cec0"  # HDMI 0, the port next to the power socket
PLAYER_ORIGINS = set(os.environ.get("SF_PLAYER_ORIGINS", "http://127.0.0.1:8090").split())
TOKEN_FILE = os.path.expanduser("~/signforge/supervisor.token")


def load_token():
    if not os.path.exists(TOKEN_FILE):
        fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(secrets.token_urlsafe(24))
    with open(TOKEN_FILE) as f:
        return f.read().strip()


TOKEN = load_token()
lock = threading.Lock()
state = {"on": True, "cec": "unknown", "signal": "unknown"}

env = dict(os.environ)
env.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")


def run(*cmd, timeout=10):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
        return p.returncode, p.stdout + p.stderr
    except Exception as e:
        return 1, str(e)


def wayland():
    """The compositor's socket and its single output, or None if the kiosk is not running."""
    rd = env["XDG_RUNTIME_DIR"]
    sockets = sorted(f for f in os.listdir(rd) if f.startswith("wayland-") and not f.endswith(".lock")) if os.path.isdir(rd) else []
    if not sockets:
        return None
    env["WAYLAND_DISPLAY"] = sockets[0]
    rc, out = run("wlr-randr")
    return out.split()[0] if rc == 0 and out else None


def signal(on):
    out = wayland()
    if not out:
        return "no compositor"
    args = ["--on", "--mode", MODE] if on else ["--off"]
    rc, msg = run("wlr-randr", "--output", out, *args)
    return "ok" if rc == 0 else msg.strip()[:120]


def cec(*args):
    rc, out = run("cec-ctl", "-d", CEC_DEV, *args)
    return rc == 0 and "Not Acknowledged" not in out and "Error" not in out


def cec_power(on):
    if not os.path.exists(CEC_DEV):
        return "no cec device"
    cec("--playback", "--osd-name", "SignForge")
    if on:
        acked = cec("--to", "0", "--image-view-on")
        # Become the active source so the TV switches to this input.
        rc, out = run("cec-ctl", "-d", CEC_DEV)
        phys = next((l.split(":")[1].strip() for l in out.splitlines() if "Physical Address" in l), "")
        if phys and phys != "f.f.f.f":
            cec("--to", "15", "--active-source", f"phys-addr={phys}")
    else:
        acked = cec("--to", "0", "--standby")
    return "ok" if acked else "not acknowledged (the panel has no CEC, or it is turned off in its settings)"


def set_display(on):
    with lock:
        if on:
            state["signal"] = signal(True)  # the TV needs a signal to switch to
            state["cec"] = cec_power(True)
        else:
            state["cec"] = cec_power(False)
            state["signal"] = signal(False)
        state["on"] = on
        print(f"display {'on' if on else 'off'}: signal {state['signal']}, cec {state['cec']}", flush=True)
        return dict(state)


class Handler(BaseHTTPRequestHandler):
    def origin_ok(self):
        return self.headers.get("Origin") in PLAYER_ORIGINS

    def host_ok(self):
        return self.headers.get("Host") in (f"127.0.0.1:{PORT}", f"localhost:{PORT}")

    def authorised(self):
        return self.host_ok() and hmac.compare_digest(self.headers.get("x-sf-token", ""), TOKEN)

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        if self.origin_ok():
            self.send_header("access-control-allow-origin", self.headers["Origin"])
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        # The preflight the token header triggers, including Chromium's private network check for
        # a player served from the internet. Granted to the player's origin only.
        if not (self.origin_ok() and self.host_ok()):
            self.send_response(403)
            self.end_headers()
            return
        self.send_response(204)
        self.send_header("access-control-allow-origin", self.headers["Origin"])
        self.send_header("access-control-allow-methods", "GET, POST")
        self.send_header("access-control-allow-headers", "x-sf-token")
        self.send_header("access-control-allow-private-network", "true")
        self.end_headers()

    def do_GET(self):
        if not self.authorised():
            return self.reply(403, {"error": "forbidden"})
        self.reply(200, state) if self.path == "/display" else self.reply(404, {"error": "not found"})

    def do_POST(self):
        if not self.authorised():
            return self.reply(403, {"error": "forbidden"})
        if self.path in ("/display/on", "/display/off"):
            self.reply(200, set_display(self.path.endswith("/on")))
        else:
            self.reply(404, {"error": "not found"})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
