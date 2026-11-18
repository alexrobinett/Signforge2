#!/usr/bin/env python3
"""Device supervisor: the part of the Pi the browser cannot reach. It powers the panel and holds
the screen's credential.

The player decides *when* (it owns the schedule, display hours included, and works offline);
the supervisor only does *how*, over a local HTTP API:

  POST /display/on    signal on at 1080p60, then wake the TV and select this input over CEC
  POST /display/off   put the TV in standby over CEC, then turn the video signal off
  GET  /display       last state and which methods worked
  GET  /credential    the screen's API credential and the API it is for, for the player's own origin (see below)
  POST /credential    {"credential": "sfd_...", "api": "https://<api>/v1/device"}: store what pairing gave the player
  DELETE /credential  forget it: the server revoked it

Two methods, because panels differ:
  CEC     TVs and commercial displays. Ignored by most monitors.
  signal  turning the HDMI output off. A monitor goes to standby on no signal, and so do many TVs.
Both run every time; whichever the panel honours does the work.

Listens on 127.0.0.1 only, and acts only on requests that carry the device's secret token
(~/signforge/supervisor.token, created on first run). The player collects it from GET /token, which
answers only the player's own origin: browsers always send Origin on a cross-origin request and a
page cannot forge it, so a template (origin "null") or a web page cannot obtain it. Keeping it out
of the kiosk URL matters because a template frame can read its parent's URL.
A plain POST from any page would otherwise reach it without a CORS preflight: the token header
forces one, the preflight is granted only to the player's origin, and a request whose Host is not
this address (DNS rebinding) is refused.

The screen's API credential (`sfd_<screen>.<secret>`) lives in ~/signforge/device.credential, mode
0600, with the device API base it was paired with on the second line. Pairing (M3-08) writes both:
the player pairs with the API and hands them here with POST /credential, and deletes them with
DELETE /credential when the server refuses the credential. Both need the token, like the display
routes. They can still be installed by hand. GET /credential hands them to the player under the
same rule as /token: the player's origin, this Host, never in a URL. The file is read on each
request, so a new credential needs no restart; 404 while there is none.

The API base is what keeps the credential at home: the kiosk URL names the API the player talks to,
so the player sends the credential only to the API it is bound to (`"api": null` for a file with no
second line, which the player does not use). It must be https, or http to this LAN or this machine
for a development API, with no user, query or fragment.
"""
import hmac, ipaddress, json, os, re, secrets, subprocess, threading
from urllib.parse import urlsplit
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8091
MODE = "1920x1080@60"
CEC_DEV = "/dev/cec0"  # HDMI 0, the port next to the power socket
PLAYER_ORIGINS = set(os.environ.get("SF_PLAYER_ORIGINS", "http://127.0.0.1:8090").split())
TOKEN_FILE = os.path.expanduser("~/signforge/supervisor.token")
CREDENTIAL_FILE = os.path.expanduser("~/signforge/device.credential")


def load_token():
    if not os.path.exists(TOKEN_FILE):
        fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(secrets.token_urlsafe(24))
    with open(TOKEN_FILE) as f:
        return f.read().strip()


TOKEN = load_token()


def load_credential():
    """The screen's credential and its API base (None without one), or None. Tightens the file to 0600 if it was left readable."""
    try:
        st = os.stat(CREDENTIAL_FILE)
        if st.st_mode & 0o077:
            os.chmod(CREDENTIAL_FILE, 0o600)
        with open(CREDENTIAL_FILE) as f:
            lines = f.read().split()
    except OSError:
        return None
    return (lines[0], device_api(lines[1]) if len(lines) > 1 else None) if lines else None
CREDENTIAL = re.compile(r"^sfd_[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{43}$")
API_BASE = re.compile(r"^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~-]+)*$")


def device_api(api):
    """`api` if it is a device API base the credential may be bound to, else None."""
    if not isinstance(api, str) or not API_BASE.match(api):
        return None
    host = urlsplit(api).hostname
    if api.startswith("http://"):
        try:
            if host != "localhost" and not ipaddress.ip_address(host).is_private:
                return None
        except ValueError:
            return None
    return api


def store_credential(cred, api):
    """Write the credential and its API base atomically, 0600 from the start."""
    tmp = CREDENTIAL_FILE + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(f"{cred}\n{api}\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, CREDENTIAL_FILE)


def delete_credential():
    try:
        os.remove(CREDENTIAL_FILE)
    except FileNotFoundError:
        pass


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
        self.send_header("cache-control", "no-store")
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
        self.send_header("access-control-allow-methods", "GET, POST, DELETE")
        self.send_header("access-control-allow-headers", "x-sf-token, content-type")
        self.send_header("access-control-allow-private-network", "true")
        self.end_headers()

    def do_GET(self):
        if self.path == "/token":
            if not (self.origin_ok() and self.host_ok()):
                return self.reply(403, {"error": "forbidden"})
            return self.reply(200, {"token": TOKEN})
        if self.path == "/credential":
            if not (self.origin_ok() and self.host_ok()):
                return self.reply(403, {"error": "forbidden"})
            held = load_credential()
            return self.reply(200, {"credential": held[0], "api": held[1]}) if held else self.reply(404, {"error": "no credential"})
        if not self.authorised():
            return self.reply(403, {"error": "forbidden"})
        self.reply(200, state) if self.path == "/display" else self.reply(404, {"error": "not found"})

    def do_POST(self):
        if not self.authorised():
            return self.reply(403, {"error": "forbidden"})
        if self.path in ("/display/on", "/display/off"):
            self.reply(200, set_display(self.path.endswith("/on")))
        elif self.path == "/credential":
            try:
                length = int(self.headers.get("content-length") or 0)
                body = json.loads(self.rfile.read(min(length, 4096)) or b"{}")
                cred, api = body.get("credential"), device_api(body.get("api"))
            except (ValueError, AttributeError):
                cred = api = None
            if not isinstance(cred, str) or not CREDENTIAL.match(cred) or not api:
                return self.reply(400, {"error": "send {\"credential\": \"sfd_<screen>.<secret>\", \"api\": \"https://<api>/v1/device\"}"})
            store_credential(cred, api)
            print("credential stored", flush=True)
            self.reply(200, {})
        else:
            self.reply(404, {"error": "not found"})

    def do_DELETE(self):
        if not self.authorised():
            return self.reply(403, {"error": "forbidden"})
        if self.path != "/credential":
            return self.reply(404, {"error": "not found"})
        delete_credential()
        print("credential deleted", flush=True)
        self.reply(200, {})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
