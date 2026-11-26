"""The supervisor's output mode watch (#511, #558), against a faked wlr-randr: no Pi, no clock.

Run from the repo root: python3 -m unittest discover -s device/pi -p 'test_*.py'
"""
import contextlib, io, os, sys, tempfile, unittest
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
            mock.patch.dict(supervisor.mode_watch, {"resets": 0, "failed": 0, "next_try": 0.0}),
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


if __name__ == "__main__":
    unittest.main()
