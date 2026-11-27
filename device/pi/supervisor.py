#!/usr/bin/env python3
"""Device supervisor: the part of the Pi the browser cannot reach. It powers the panel, holds
the screen's credential and restarts a hung kiosk.

The player decides *when* (it owns the schedule, display hours included, and works offline);
the supervisor only does *how*, over a local HTTP API:

  POST /display/on    signal on at 1080p60, then wake the TV and select this input over CEC
  POST /display/off   put the TV in standby over CEC, then turn the video signal off
  GET  /display       last state, which methods worked, and the output's mode (see below)
  GET  /credential    the screen's API credential and the API it is for, for the player's own origin (see below)
  POST /credential    {"credential": "sfd_...", "api": "https://<api>/v1/device"}: store what pairing gave the player
  DELETE /credential  forget it: the server revoked it
  POST /alive         the player's beat, every 5 s, with its version and release (see below); answers with a release rolled back (updater.py)

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

The player's own watchdog runs in the renderer it watches, so a wedged renderer would leave a
frozen panel. The player beats POST /alive with the token instead; with no beat for STALE_S the
supervisor restarts the kiosk unit (allowed by signforge-supervisor.rules, a polkit rule for that
one unit and verb). Only a beat arms the check, and a restart disarms it until the next beat, so a
player that never beats (an older build, a kiosk URL without the player) is never restarted in a loop. A restart
that fails is tried again RESTART_RETRY_S later, at most RESTART_TRIES times in all, then not until the next beat.

The output's mode (#511). kiosk.sh sets 1920x1080 at 60 Hz before the browser starts (a Pi 4 cannot
animate at 4K), but a panel can bring its own mode back during play: a hotplug, an input switch. So
every MODE_CHECK_S while the panel is on, the supervisor reads the mode (two wlr-randr calls, the
output's name and its modes, which wake nothing), and when it is not MODE sets it back as kiosk.sh
does and logs it. GET /display reports the last reading and how often a set took ("output": {"mode",
"resets"}); the player sends it in its heartbeat, so the screen's tools show it. A panel that refuses
MODE is set MODE_TRIES times in a row, then once every MODE_RETRY_S, its own mode reported meanwhile
(#558); a reading other than the one it is stuck at, or none (the panel unplugged), ends the wait, so a panel
plugged back in is set at its next check. A check that fails unexpectedly is logged (then once an hour while it goes on) and the
reading dropped, so none looks current. Not read while the panel is off: the signal is off by design
then, and setting a mode would turn it on.
"""
import hmac, ipaddress, json, os, random, re, secrets, subprocess, threading, time
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8091
MODE = "1920x1080@60"
CEC_DEV = "/dev/cec0"  # HDMI 0, the port next to the power socket
PLAYER_ORIGINS = set(os.environ.get("SF_PLAYER_ORIGINS", "http://127.0.0.1:8090").split())
TOKEN_FILE = os.path.expanduser("~/signforge/supervisor.token")
KIOSK_UNIT = "signforge-kiosk.service"
# Six missed beats: a page reload, or a busy moment in a slow prepare, is not a hang.
STALE_S = 30
CREDENTIAL_FILE = os.path.expanduser("~/signforge/device.credential")
MODE_CHECK_S = 60
# Sets in a row that leave the panel off MODE before the supervisor stops setting it every check: a panel that
# refuses it would otherwise be set and logged every minute, 1,440 times a day (#558).
MODE_TRIES = 3
# Then it tries once this often: an input switched back may take MODE again.
MODE_RETRY_S = 3600
# A kiosk restart that fails is tried again this much later, this many times in all (review of #560).
RESTART_RETRY_S = 30
RESTART_TRIES = 3
# wlr-randr's line for the mode in use: "    1920x1080 px, 60.000000 Hz (preferred, current)".
MODE_LINE = re.compile(r"^\s+(\d+)x(\d+) px, ([\d.]+) Hz \([^)]*\bcurrent\b")


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


def output_mode(randr):
    """The current mode in wlr-randr's listing as `<w>x<h>@<Hz>` (Hz rounded, as `--mode` takes it), or None for an output that is off or has none."""
    if re.search(r"^\s+Enabled: no$", randr, re.M):
        return None
    m = next(filter(None, map(MODE_LINE.match, randr.splitlines())), None)
    return f"{m[1]}x{m[2]}@{round(float(m[3]))}" if m else None


def read_mode():
    """The output's name and current mode, or None while there is no compositor or the output is off."""
    out = wayland()
    if not out:
        return None
    rc, randr = run("wlr-randr")
    mode = output_mode(randr) if rc == 0 else None
    return (out, mode) if mode else None


# The mode watch's own counts: sets that took, failed sets in a row, the monotonic time before which none is tried,
# and the mode it is stuck at while it waits.
mode_watch = {"resets": 0, "failed": 0, "next_try": 0.0, "stuck_at": None}
# Checks that failed in a row, and the monotonic time before which another failure is not logged (review of #560).
mode_errors = {"count": 0, "next_log": 0.0}


def check_mode(now):
    """One check of the output's mode, at `now` on the monotonic clock: set back to MODE, unless it is stuck (#558)."""
    with lock:
        if not state["on"]:
            return
        found = read_mode()
        if not found:
            # Unplugged, or its input switched away: whatever comes back is set at once (review of #560).
            mode_watch.update(failed=0, next_try=0.0, stuck_at=None)
            return
        out, mode = found
        if mode == MODE or mode_watch["stuck_at"] not in (None, mode):
            # Back at MODE, or stuck and now at another mode (a hotplug, an input switch): no wait.
            mode_watch.update(failed=0, next_try=0.0, stuck_at=None)
        if mode != MODE and now >= mode_watch["next_try"]:
            rc, msg = run("wlr-randr", "--output", out, "--mode", MODE)
            after = read_mode()
            was, mode = mode, after[1] if after else mode
            why = "" if rc == 0 else " (" + msg.strip()[:120] + ")"
            if mode == MODE:
                mode_watch.update(resets=mode_watch["resets"] + 1, failed=0, next_try=0.0)
                print(f"output at {was}, not {MODE}: set back{why}", flush=True)
            else:
                mode_watch["failed"] += 1
                stuck = mode_watch["failed"] >= MODE_TRIES
                if stuck:
                    mode_watch.update(next_try=now + MODE_RETRY_S, stuck_at=mode)
                then = f"; stuck at {mode}, next try in {MODE_RETRY_S // 60} min" if stuck else ""
                print(f"output at {was}, not {MODE}: set back, still {mode}{why}{then}", flush=True)
        state["output"] = {"mode": mode, "resets": mode_watch["resets"]}


def watch_mode():
    while True:
        time.sleep(MODE_CHECK_S)
        now = time.monotonic()
        try:
            check_mode(now)
        except Exception as e:
            # The reading dropped, so the screen shows none rather than one that looks current (#558). Logged at the
            # first failure, then once every MODE_RETRY_S while they go on, not every minute (review of #560).
            with lock:
                state.pop("output", None)
            mode_errors["count"] += 1
            if now >= mode_errors["next_log"]:
                mode_errors["next_log"] = now + MODE_RETRY_S
                print(f"mode check failed ({mode_errors['count']} in a row): {e!r}", flush=True)
            continue
        if mode_errors["count"]:
            print(f"mode check works again, after {mode_errors['count']} that failed", flush=True)
            mode_errors.update(count=0, next_log=0.0)


# time.monotonic() of the player's last beat; None until a beat after a start or a restart.
last_beat = None


# Restarts that failed in a row, and the monotonic time the next is tried; None while none is due (review of #560).
restarts = {"failed": 0, "retry_at": None}


def check_player(now):
    """One check of the player's beat, at `now` on the monotonic clock: restart the kiosk when it has gone quiet."""
    global last_beat
    stale = last_beat is not None and now - last_beat > STALE_S
    retry = restarts["retry_at"] is not None and now >= restarts["retry_at"]
    if not (stale or retry):
        return
    last_beat = None
    restarts["retry_at"] = None
    rc, out = run("systemctl", "restart", "--no-block", KIOSK_UNIT)
    if rc == 0:
        restarts["failed"] = 0
        print(f"no beat from the player for {STALE_S} s: kiosk restart queued", flush=True)
        return
    restarts["failed"] += 1
    again = restarts["failed"] < RESTART_TRIES
    then = f"next try in {RESTART_RETRY_S} s" if again else "no more tries until the player beats"
    print(f"no beat from the player for {STALE_S} s: kiosk restart failed ({restarts['failed']} of {RESTART_TRIES}): {out.strip()[:120]}; {then}", flush=True)
    if again:
        restarts["retry_at"] = now + RESTART_RETRY_S
    else:
        restarts["failed"] = 0


def watch_player():
    while True:
        time.sleep(5)
        # A failure is logged and the watch goes on: a thread that ends leaves no watchdog (#558).
        try:
            check_player(time.monotonic())
            # A poll holding the lock may be downloading: the gate waits for the next check, the watchdog does not.
            if updates and update_lock.acquire(blocking=False):
                try:
                    updates.check_gate()
                finally:
                    update_lock.release()
        except Exception as e:
            print(f"player check failed: {e!r}", flush=True)


# --------------------------------------------------------------------------------------------- player updates (#628)

RELEASE_KEY_FILE = os.path.expanduser("~/signforge/player-release.pub")
# The most an offer's reply may be: a manifest of a MiB, every character of it escaped in JSON, and the rest.
OFFER_READ_BYTES = 6 * 1_048_576 + 4096
# The longest a tarball's download may take, past each read's own timeout: a trickle cannot hold the update lock for long.
DOWNLOAD_DEADLINE_S = 900


class NoRedirect(HTTPRedirectHandler):
    """Refuse every redirect: the credential goes to the API it is bound to and nowhere else."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


api_opener = build_opener(NoRedirect)


def api_request(path):
    """A GET under the API base the credential is bound to, with the credential, and nowhere else."""
    held = load_credential()
    if not held or not held[1]:
        raise OSError("no credential bound to an API")
    return Request(held[1] + path, headers={"authorization": f"Bearer {held[0]}"})


def api_get(path):
    try:
        with api_opener.open(api_request(path), timeout=30) as r:
            return r.status, r.read(OFFER_READ_BYTES)
    except HTTPError as e:
        e.close()
        return e.code, b""


def api_download(path, dest, limit):
    """Write the GET's body to `dest`, refusing past `limit` bytes: no more than the signed size is written."""
    deadline = time.monotonic() + DOWNLOAD_DEADLINE_S
    with api_opener.open(api_request(path), timeout=60) as r, open(dest, "wb") as f:
        got = 0
        # read1: what has arrived, at most 64 KiB, so a trickle returns at once and meets the deadline.
        for chunk in iter(lambda: r.read1(1 << 16), b""):
            got += len(chunk)
            if got > limit:
                raise updater.Refused("the tarball is larger than the one signed")
            if time.monotonic() > deadline:
                raise updater.Refused(f"the download took more than {DOWNLOAD_DEADLINE_S} s")
            f.write(chunk)


def kiosk_restart():
    global last_beat
    # Disarmed until the restarted player beats: its start is not a hang. The update's gate watches it meanwhile.
    last_beat = None
    rc, out = run("systemctl", "restart", "--no-block", KIOSK_UNIT)
    if rc != 0:
        print(f"kiosk restart for a player update failed: {out.strip()[:120]}", flush=True)


def load_updater():
    """The update channel, or None without the release key, the library that checks it, or anything else it needs: then
    the player is updated by hand, and display power and the watchdog run as before."""
    global updater
    try:
        with open(RELEASE_KEY_FILE, "rb") as f:
            key = f.read()
        import updater

        return updater.Updater(
            os.path.expanduser("~/signforge"), key, api_get, api_download, kiosk_restart, lambda: state["on"], time.time, time.monotonic, random.random
        )
    except Exception as e:
        print(f"player updates off: {e!r}", flush=True)
        return None


updates = None
# Held through a poll, which may be a download: the display's lock stays free for /display, and a beat that finds it
# held skips the gate, which is never open while a release downloads.
update_lock = threading.Lock()


def watch_updates():
    while True:
        # About every POLL_S, with jitter, so a fleet's screens do not ask at once.
        time.sleep(updater.POLL_S * (0.8 + 0.4 * random.random()))
        try:
            with update_lock:
                done = updates.poll()
            print(f"player update: {done}", flush=True)
        except Exception as e:
            print(f"player update failed: {e!r}", flush=True)


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
        global last_beat
        if not self.authorised():
            return self.reply(403, {"error": "forbidden"})
        if self.path == "/alive":
            last_beat = time.monotonic()
            restarts.update(failed=0, retry_at=None)
            # A player before #628, or a build not made by the release workflow, sends no release: its beat still counts
            # for the watchdog, and for no release's gate.
            try:
                length = int(self.headers.get("content-length") or 0)
                release = json.loads(self.rfile.read(min(length, 1024)) or b"{}").get("release")
            except (ValueError, AttributeError):
                release = None
            if not updates:
                return self.reply(200, {})
            # The beat waits for no poll: one that finds the lock held is not counted, and the gate is never open
            # while a release downloads. The report is read without it.
            if update_lock.acquire(blocking=False):
                try:
                    updates.beat(release if isinstance(release, int) and not isinstance(release, bool) and release >= 1 else None)
                finally:
                    update_lock.release()
            self.reply(200, updates.alive_reply())
        elif self.path in ("/display/on", "/display/off"):
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
    updates = load_updater()
    threading.Thread(target=watch_player, daemon=True).start()
    threading.Thread(target=watch_mode, daemon=True).start()
    if updates:
        threading.Thread(target=watch_updates, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
