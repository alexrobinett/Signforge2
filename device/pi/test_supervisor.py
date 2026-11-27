"""The supervisor's output mode watch (#511, #558) and its player watch, against a faked wlr-randr and systemctl and
the monotonic time passed in: no Pi, no clock.

Run from the repo root: python3 -m unittest discover -s device/pi -p 'test_*.py'
"""
import contextlib, io, json, os, sys, tempfile, threading, unittest
from unittest import mock

# The supervisor makes its token under ~/signforge as it loads: a home of its own for the tests.
HOME = tempfile.mkdtemp()
os.makedirs(os.path.join(HOME, "signforge"))
with mock.patch.dict(os.environ, {"HOME": HOME}):
    sys.path.insert(0, os.path.dirname(__file__))
    import supervisor


class Panel:
    """wlr-randr on one output: `takes` says whether a set of the mode sticks."""

    def __init__(self, mode, takes=True):
        self.mode, self.takes, self.sets = mode, takes, 0

    def run(self, *cmd, timeout=10):
        if cmd == ("wlr-randr",):
            if self.mode is None:
                return 0, 'HDMI-A-1 "Panel"\n  Enabled: yes\n  Modes:\n'
            w, rest = self.mode.split("x")
            h, hz = rest.split("@")
            return 0, f'HDMI-A-1 "Panel"\n  Enabled: yes\n  Modes:\n    {w}x{h} px, {hz}.000000 Hz (preferred, current)\n'
        if cmd[:3] == ("wlr-randr", "--output", "HDMI-A-1") and cmd[3] == "--mode":
            self.sets += 1
            if self.takes:
                self.mode = cmd[4]
            return 0, ""
        raise AssertionError(f"unexpected command {cmd}")


class Stop(BaseException):
    """Ends a watch loop from its sleep: not an Exception, so the loop's catch-all lets it through."""


class ModeWatch(unittest.TestCase):
    def setUp(self):
        runtime = tempfile.mkdtemp()
        open(os.path.join(runtime, "wayland-0"), "w").close()
        self.patches = [
            mock.patch.dict(supervisor.env, {"XDG_RUNTIME_DIR": runtime}),
            mock.patch.dict(supervisor.state, {"on": True}),
            mock.patch.dict(supervisor.mode_watch, {"resets": 0, "failed": 0, "next_try": 0.0, "stuck_at": None}),
            mock.patch.dict(supervisor.restarts, {"failed": 0, "retry_at": None}),
            mock.patch.dict(supervisor.mode_errors, {"count": 0, "next_log": 0.0}),
        ]
        for p in self.patches:
            p.start()
        supervisor.state.pop("output", None)
        self.log = io.StringIO()
        self.addCleanup(lambda: [p.stop() for p in self.patches])

    def check(self, panel, now):
        with mock.patch.object(supervisor, "run", panel.run), contextlib.redirect_stdout(self.log):
            supervisor.check_mode(now)
        return supervisor.state.get("output")

    def test_sets_a_panel_back_and_counts_the_set_that_took(self):
        panel = Panel("3840x2160@60")
        self.assertEqual(self.check(panel, 0), {"mode": "1920x1080@60", "resets": 1})
        self.assertEqual(self.check(panel, 60), {"mode": "1920x1080@60", "resets": 1})
        self.assertEqual(panel.sets, 1)
        self.assertIn("output at 3840x2160@60, not 1920x1080@60: set back", self.log.getvalue())

    def test_backs_off_from_a_panel_that_refuses_the_mode_and_reports_its_own(self):
        panel = Panel("3840x2160@30", takes=False)
        for minute in range(supervisor.MODE_TRIES):
            self.assertEqual(self.check(panel, minute * 60), {"mode": "3840x2160@30", "resets": 0})
        self.assertEqual(panel.sets, supervisor.MODE_TRIES)
        self.assertIn("stuck at 3840x2160@30, next try in 60 min", self.log.getvalue())
        # An hour of checks: read and reported, never set.
        last = (supervisor.MODE_TRIES - 1) * 60
        for minute in range(1, 60):
            self.assertEqual(self.check(panel, last + minute * 60), {"mode": "3840x2160@30", "resets": 0})
        self.assertEqual(panel.sets, supervisor.MODE_TRIES)
        # Then once more; a panel switched back that now takes it is set back and counted.
        panel.takes = True
        self.assertEqual(self.check(panel, last + supervisor.MODE_RETRY_S), {"mode": "1920x1080@60", "resets": 1})
        self.assertEqual(panel.sets, supervisor.MODE_TRIES + 1)
        self.assertEqual(supervisor.mode_watch["failed"], 0)

    def stuck(self, panel):
        """`panel` refused the mode MODE_TRIES times, a minute apart: the watch waits an hour. The last check's time."""
        for minute in range(supervisor.MODE_TRIES):
            self.check(panel, minute * 60)
        self.assertEqual(supervisor.mode_watch["stuck_at"], panel.mode)
        return (supervisor.MODE_TRIES - 1) * 60

    def test_a_panel_back_at_another_mode_is_set_at_once_not_after_the_hour(self):
        panel = Panel("3840x2160@30", takes=False)
        last = self.stuck(panel)
        # A hotplug brings it back at 4K 60 Hz, and now it takes the mode: set at the next check (review of #560).
        panel.mode, panel.takes = "3840x2160@60", True
        self.assertEqual(self.check(panel, last + 60), {"mode": "1920x1080@60", "resets": 1})
        self.assertEqual(panel.sets, supervisor.MODE_TRIES + 1)

    def test_a_panel_unplugged_and_plugged_back_at_its_own_mode_is_set_at_once(self):
        panel = Panel("3840x2160@30", takes=False)
        last = self.stuck(panel)
        panel.mode = None
        self.check(panel, last + 60)
        self.assertEqual(panel.sets, supervisor.MODE_TRIES)
        panel.mode, panel.takes = "3840x2160@30", True
        self.assertEqual(self.check(panel, last + 120), {"mode": "1920x1080@60", "resets": 1})

    def test_the_same_mode_still_waits_out_the_hour(self):
        panel = Panel("3840x2160@30", takes=False)
        last = self.stuck(panel)
        self.check(panel, last + 60)
        self.assertEqual(panel.sets, supervisor.MODE_TRIES)

    def test_drops_the_reading_goes_on_and_logs_a_lasting_failure_once_an_hour(self):
        supervisor.state["output"] = {"mode": "1920x1080@60", "resets": 0}
        panel = Panel("1920x1080@60")
        # Each check a minute apart on the monotonic clock: 61 that fail, then one that works.
        minutes = iter(range(0, 63 * 60, 60))
        checks = iter([*["fail"] * 61, "works", "stop"])
        broken_now = {"on": True}

        def sleep(_):
            step = next(checks)
            if step == "stop":
                raise Stop()
            broken_now["on"] = step == "fail"

        def run(*cmd, timeout=10):
            if broken_now["on"]:
                raise RuntimeError("wlr-randr went away")
            return panel.run(*cmd, timeout=timeout)

        with (
            mock.patch.object(supervisor, "run", run),
            mock.patch.object(supervisor.time, "sleep", sleep),
            mock.patch.object(supervisor.time, "monotonic", lambda: next(minutes)),
            contextlib.redirect_stdout(self.log),
        ):
            with self.assertRaises(Stop):
                supervisor.watch_mode()
        lines = self.log.getvalue().splitlines()
        # The first failure, the one an hour later (the 61st), and the check that worked again.
        self.assertEqual(
            lines,
            [
                "mode check failed (1 in a row): RuntimeError('wlr-randr went away')",
                "mode check failed (61 in a row): RuntimeError('wlr-randr went away')",
                "mode check works again, after 61 that failed",
            ],
        )
        self.assertEqual(supervisor.state["output"], {"mode": "1920x1080@60", "resets": 0})

    def test_the_player_watch_logs_a_failure_and_goes_on(self):
        sleeps = iter([None, None, Stop()])

        def sleep(_):
            step = next(sleeps)
            if step:
                raise step

        def broken(*cmd, timeout=10):
            raise RuntimeError("systemctl went away")

        with (
            mock.patch.object(supervisor, "last_beat", -10_000.0),
            mock.patch.object(supervisor, "run", broken),
            mock.patch.object(supervisor.time, "sleep", sleep),
            contextlib.redirect_stdout(self.log),
        ):
            with self.assertRaises(Stop):
                supervisor.watch_player()
        self.assertEqual(self.log.getvalue().count("player check failed: RuntimeError('systemctl went away')"), 1)


class PlayerWatch(unittest.TestCase):
    """A kiosk restart that fails, tried again a bounded number of times (review of #560), at times passed in."""

    def setUp(self):
        self.patches = [mock.patch.dict(supervisor.restarts, {"failed": 0, "retry_at": None}), mock.patch.object(supervisor, "last_beat", 0.0)]
        for p in self.patches:
            p.start()
        self.addCleanup(lambda: [p.stop() for p in self.patches])
        self.log = io.StringIO()

    def check(self, answers, now):
        """One check at `now`, systemctl answering the next of `answers`: the restarts it asked for."""
        asked = []

        def run(*cmd, timeout=10):
            asked.append(cmd)
            return answers.pop(0)

        with mock.patch.object(supervisor, "run", run), contextlib.redirect_stdout(self.log):
            supervisor.check_player(now)
        return len(asked)

    def test_retries_a_failed_restart_before_the_next_beat_until_it_takes(self):
        stale = supervisor.STALE_S + 1
        answers = [(1, "Failed to restart: busy"), (0, "")]
        self.assertEqual(self.check(answers, stale), 1)
        self.assertEqual(self.check(answers, stale + supervisor.RESTART_RETRY_S - 1), 0)
        self.assertEqual(self.check(answers, stale + supervisor.RESTART_RETRY_S), 1)
        self.assertEqual(self.check(answers, stale + 10 * supervisor.RESTART_RETRY_S), 0)
        self.assertIn(f"kiosk restart failed (1 of {supervisor.RESTART_TRIES}): Failed to restart: busy; next try in", self.log.getvalue())
        self.assertIn("kiosk restart queued", self.log.getvalue())

    def test_stops_after_restart_tries_until_the_player_beats(self):
        answers = [(1, "denied")] * (supervisor.RESTART_TRIES + 1)
        at = supervisor.STALE_S + 1
        tries = 0
        for _ in range(supervisor.RESTART_TRIES + 2):
            tries += self.check(answers, at)
            at += supervisor.RESTART_RETRY_S
        self.assertEqual(tries, supervisor.RESTART_TRIES)
        self.assertIn("no more tries until the player beats", self.log.getvalue())

class Alive(unittest.TestCase):
    """POST /alive through the supervisor's own server, on a free port: the beat's release reaches the update channel (#628)."""

    class Updates:
        def __init__(self):
            self.beats = []

        def beat(self, release):
            self.beats.append(release)

        def alive_reply(self):
            return {"failedRelease": {"version": 42, "reason": "stopped"}}

    def setUp(self):
        self.server = supervisor.ThreadingHTTPServer(("127.0.0.1", 0), supervisor.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.shutdown)

    def alive(self, body):
        import http.client

        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        headers = {"Host": f"127.0.0.1:{supervisor.PORT}", "x-sf-token": supervisor.TOKEN}
        conn.request("POST", "/alive", body=body, headers=headers)
        res = conn.getresponse()
        return res.status, json.loads(res.read())

    def test_passes_the_beat_s_release_and_answers_with_the_release_rolled_back(self):
        updates = self.Updates()
        with mock.patch.object(supervisor, "updates", updates):
            self.assertEqual(self.alive(json.dumps({"version": "0.1.0+abc", "release": 42})), (200, {"failedRelease": {"version": 42, "reason": "stopped"}}))
            # A player before #628 beats with no body, and a hand-built one with no release: still beats, for no release's gate.
            self.assertEqual(self.alive(None), (200, {"failedRelease": {"version": 42, "reason": "stopped"}}))
            self.assertEqual(self.alive(json.dumps({"version": "0.1.0+abc"})), (200, {"failedRelease": {"version": 42, "reason": "stopped"}}))
            self.assertEqual(self.alive(json.dumps({"version": "0.1.0+abc", "release": "42"})), (200, {"failedRelease": {"version": 42, "reason": "stopped"}}))
        # A beat with no release, or one not a whole number, reaches the gate as None: an older build, still beating.
        self.assertEqual(updates.beats, [42, None, None, None])

    def test_answers_nothing_more_without_the_update_channel(self):
        with mock.patch.object(supervisor, "updates", None):
            self.assertEqual(self.alive(json.dumps({"version": "0.1.0+abc", "release": 42})), (200, {}))


class Updates(unittest.TestCase):
    """What the supervisor gives the update channel (#628): the API with no redirects, a start that cannot fail, the
    watchdog disarmed across an update's restart, and a gate check that waits for no download."""

    def test_follows_no_redirect_so_the_credential_reaches_only_its_api(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        elsewhere = []

        class Other(BaseHTTPRequestHandler):
            def do_GET(self):
                elsewhere.append(self.headers.get("authorization"))
                self.send_response(200)
                self.end_headers()

            def log_message(self, *_):
                pass

        other = ThreadingHTTPServer(("127.0.0.1", 0), Other)
        threading.Thread(target=other.serve_forever, daemon=True).start()
        self.addCleanup(other.shutdown)

        class Api(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(302)
                self.send_header("Location", f"http://127.0.0.1:{other.server_port}/stolen")
                self.end_headers()

            def log_message(self, *_):
                pass

        api = ThreadingHTTPServer(("127.0.0.1", 0), Api)
        threading.Thread(target=api.serve_forever, daemon=True).start()
        self.addCleanup(api.shutdown)
        held = ("sfd_secret", f"http://127.0.0.1:{api.server_port}/v1/device")
        with mock.patch.object(supervisor, "load_credential", return_value=held):
            self.assertEqual(supervisor.api_get("/player-release"), (302, b""))
        self.assertEqual(elsewhere, [])

    def download(self, chunks, clock):
        """api_download against a fake API answering with `chunks`, one per read, on `clock`, the monotonic time."""
        import updater

        class Body:
            def __init__(self):
                self.left = list(chunks)

            def read1(self, _n):
                return self.left.pop(0) if self.left else b""

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

        class Opener:
            def open(self, req, timeout):
                return Body()

        dest = os.path.join(tempfile.mkdtemp(), "t.tar.gz")
        held = ("sfd_secret", "https://api.test/v1/device")
        with (
            mock.patch.object(supervisor, "api_opener", Opener()),
            mock.patch.object(supervisor, "load_credential", return_value=held),
            mock.patch.object(supervisor, "updater", updater, create=True),
            mock.patch.object(supervisor.time, "monotonic", clock),
        ):
            supervisor.api_download("/player-release/abc", dest, 10)
        with open(dest, "rb") as f:
            return f.read()

    def test_a_download_writes_no_more_than_the_signed_size_and_stops_at_its_deadline(self):
        import updater

        self.assertEqual(self.download([b"12345", b"67890"], lambda: 0), b"1234567890")
        with self.assertRaisesRegex(updater.Refused, "larger than the one signed"):
            self.download([b"12345", b"678901"], lambda: 0)
        # A trickle: a byte a read, the clock past the deadline by the third.
        times = iter([0, 1, supervisor.DOWNLOAD_DEADLINE_S, supervisor.DOWNLOAD_DEADLINE_S + 1])
        with self.assertRaisesRegex(updater.Refused, "the download took more than"):
            self.download([b"1", b"2", b"3", b"4"], lambda: next(times))

    def test_starts_with_updates_off_and_names_the_key_it_lacks(self):
        missing = os.path.join(HOME, "signforge", "no-such.pub")
        with mock.patch.object(supervisor, "RELEASE_KEY_FILE", missing), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertIsNone(supervisor.load_updater())
        self.assertEqual(out.getvalue(), f"player updates off: no {missing}\n")

    def test_starts_with_updates_off_when_the_key_or_its_state_is_bad(self):
        key = os.path.join(HOME, "bad.pub")
        with open(key, "w") as f:
            f.write("not a key")
        with mock.patch.object(supervisor, "RELEASE_KEY_FILE", key), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertIsNone(supervisor.load_updater())
        self.assertIn("player updates off", out.getvalue())

    def test_an_update_s_kiosk_restart_disarms_the_watchdog_until_the_player_beats(self):
        with mock.patch.object(supervisor, "last_beat", 100.0), mock.patch.object(supervisor, "run", return_value=(0, "")) as run:
            supervisor.kiosk_restart()
            self.assertIsNone(supervisor.last_beat)
            # Long after, with no beat: the watchdog does not restart it again on its own.
            supervisor.check_player(10_000.0)
        self.assertEqual(run.call_count, 1)

    def test_the_gate_check_waits_for_no_poll_holding_the_lock(self):
        class Gate:
            checks = 0

            def check_gate(self):
                Gate.checks += 1

        gate = Gate()
        sleeps = iter([None, Stop()])

        def sleep(_):
            nxt = next(sleeps)
            if nxt:
                raise nxt

        with mock.patch.object(supervisor, "updates", gate), mock.patch.object(supervisor.time, "sleep", sleep), mock.patch.object(supervisor, "check_player"):
            with supervisor.update_lock, self.assertRaises(Stop):
                supervisor.watch_player()
        self.assertEqual(Gate.checks, 0)


if __name__ == "__main__":
    unittest.main()
