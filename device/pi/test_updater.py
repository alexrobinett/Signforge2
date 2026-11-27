"""The player update channel on the device (#628), against a fake API, a test release key and injected clocks: no
network, no Pi, no wall clock.

Run from the repo root: python3 -m unittest discover -s device/pi -p 'test_*.py'
"""
import base64, hashlib, io, json, os, sys, tarfile, tempfile, unittest
from unittest import mock

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

sys.path.insert(0, os.path.dirname(__file__))
import updater

KEY = Ed25519PrivateKey.generate()
PUBLIC = KEY.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)
OTHER = Ed25519PrivateKey.generate()
# The wall clock, and the monotonic one, which starts from an arbitrary point as it does on a Pi.
T0 = 1_795_000_000
M0 = 5_000
FILES = {"index.html": b"<!doctype html><title>SignForge</title>", "assets/index-abc.js": b"console.log('player')", "sw.js": b"// sw"}
VECTOR = os.path.join(os.path.dirname(__file__), "..", "..", "packages", "contract", "test", "player-release", "vector.json")


def sha(b):
    return hashlib.sha256(b).hexdigest()


def file(name, data):
    return name, data


def member(name, kind, linkname=""):
    """A tar member that is not a regular file: `kind` a tarfile type (SYMTYPE, LNKTYPE, CHRTYPE, FIFOTYPE, DIRTYPE)."""
    info = tarfile.TarInfo(name)
    info.type = kind
    info.linkname = linkname
    return info


def tarball(entries):
    """A gzipped tar of `entries`: (name, bytes) for a regular file, or a TarInfo from `member` for anything else."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for e in entries:
            if isinstance(e, tarfile.TarInfo):
                tar.addfile(e)
            else:
                info = tarfile.TarInfo(e[0])
                info.size = len(e[1])
                tar.addfile(info, io.BytesIO(e[1]))
    return buf.getvalue()


def release(version, files=FILES, tar=None, schemas=(8, 9), key=KEY, override=None):
    """A release as CI would make it: its tarball, and the offer's release (the signed manifest text and signature). `override`: manifest fields to set."""
    tar = tar if tar is not None else tarball(list(files.items()))
    manifest = json.dumps({
        "format": 1,
        "minSupervisor": 1,
        "version": version,
        "sha256": sha(tar),
        "size": len(tar),
        "files": [{"path": p, "sha256": sha(b)} for p, b in files.items()],
        "manifestSchemas": list(schemas),
        "protocols": [1, 2],
        "createdAt": "2026-11-26T12:00:00.000Z",
        **(override or {}),
    })
    return tar, {"manifest": manifest, "signature": base64.b64encode(key.sign(manifest.encode())).decode()}


class Screen:
    """A screen's ~/signforge, a fake API and the updater's other hands, on clocks the test moves."""

    def __init__(self, channel="canary", panel_on=True, served=0, public=PUBLIC):
        self.home = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.home, "players", str(served)))
        os.symlink(f"players/{served}", os.path.join(self.home, "www"))
        self.now, self.mono, self.channel, self.panel, self.offer, self.tarballs, self.restarts, self.downloads = T0, M0, channel, panel_on, None, {}, 0, 0
        self.free, self.public, self.logged = 10**12, public, []
        self.u = self.make()

    def make(self):
        return updater.Updater(
            self.home, self.public, self.fetch, self.download, self.restart, lambda: self.panel, lambda: self.now, lambda: self.mono, lambda: 0.5,
            log=self.logged.append, disk_free=lambda: self.free,
        )

    def offering(self, rel, tar=None, manifest_schema=9):
        self.offer = {"manifestSchema": manifest_schema, "channel": self.channel, "release": rel}
        if tar is not None:
            self.tarballs[sha(tar)] = tar

    def fetch(self, path):
        assert path == "/player-release"
        return 200, json.dumps(self.offer or {"manifestSchema": 9, "channel": self.channel, "release": None}).encode()

    def download(self, path, dest, limit):
        self.downloads += 1
        body = self.tarballs[path.rsplit("/", 1)[1]]
        with open(dest, "wb") as f:
            f.write(body[: limit + 1])

    def restart(self):
        self.restarts += 1

    def served(self):
        return os.readlink(os.path.join(self.home, "www"))

    def players(self):
        return sorted(n for n in os.listdir(os.path.join(self.home, "players")) if n != "state.json")

    def tick(self, seconds):
        self.now += seconds
        self.mono += seconds


class Installs(unittest.TestCase):
    def test_a_canary_installs_a_signed_release_at_once_and_opens_the_gate(self):
        s = Screen()
        tar, rel = release(42)
        s.offering(rel, tar)
        self.assertEqual(s.u.poll(), "installed 42")
        self.assertEqual(s.served(), "players/42")
        self.assertEqual(s.restarts, 1)
        for path, body in FILES.items():
            with open(os.path.join(s.home, "players", "42", path), "rb") as f:
                self.assertEqual(f.read(), body)
        # The content the player is sent is beside the releases, which never carry it.
        self.assertEqual(os.readlink(os.path.join(s.home, "players", "42", "content")), "../../content")
        self.assertTrue(os.path.isdir(os.path.join(s.home, "www", "content")))
        self.assertEqual(s.players(), ["0", "42"])
        # Nothing else is asked for while its gate is open.
        self.assertEqual(s.u.poll(), "gate open")

    def test_it_installs_the_contract_s_test_vector_the_tarball_its_signed_manifest_names(self):
        with open(VECTOR) as f:
            vector = json.load(f)
        pem = b"-----BEGIN PUBLIC KEY-----\n" + vector["publicKey"].encode() + b"\n-----END PUBLIC KEY-----\n"
        s = Screen(public=pem)
        tar = base64.b64decode(vector["tarball"])
        s.offering({"manifest": vector["manifest"], "signature": vector["signature"]}, tar)
        self.assertEqual(s.u.poll(), "installed 1")
        for f in json.loads(vector["manifest"])["files"]:
            with open(os.path.join(s.home, "players", "1", f["path"]), "rb") as got:
                self.assertEqual(sha(got.read()), f["sha256"])
        # Another byte after the text it signed: refused.
        s = Screen(public=pem)
        s.offering({"manifest": vector["manifest"] + " ", "signature": vector["signature"]}, tar)
        self.assertEqual(s.u.poll(), "refused: the signature does not verify")

    def test_nothing_is_written_for_a_release_that_does_not_verify_is_not_newer_or_does_not_play_the_schema(self):
        cases = {
            "a signature by another key": release(42, key=OTHER),
            "a version not above the one running": release(5),
            "a schema the server does not compile": release(42, schemas=(7, 8)),
        }
        for why, (tar, rel) in cases.items():
            with self.subTest(why):
                s = Screen(served=5)
                s.offering(rel, tar)
                self.assertTrue(s.u.poll().startswith("refused"), why)
                self.assertEqual((s.downloads, s.restarts, s.served(), s.players()), (0, 0, "players/5", ["5"]))

    def test_a_release_below_the_floor_it_was_deployed_with_or_one_that_passed_here_is_refused(self):
        s = Screen()
        with open(os.path.join(s.home, "player-release.floor"), "w") as f:
            f.write("40\n")
        for v in (39, 40):
            tar, rel = release(v)
            s.offering(rel, tar)
            self.assertEqual(s.u.poll(), "refused: version %d is not above this screen's floor (40)" % v)
        self.assertEqual((s.downloads, s.served()), (0, "players/0"))

    def test_a_manifest_the_contract_refuses_is_refused_before_anything_is_written(self):
        cases = {
            "another format": ({"format": 2}, "refused: the manifest is not in release format 1"),
            "a newer supervisor": ({"minSupervisor": 2}, "refused: version 42 needs supervisor 2; this is 1"),
            "more files than a release may hold": ({"files": [{"path": f"f{i}", "sha256": "a" * 64} for i in range(1001)]}, None),
            "a path outside the contract's segments": ({"files": [{"path": "a b.js", "sha256": "a" * 64}]}, None),
            "a path too long": ({"files": [{"path": "/".join(["a" * 200] * 6), "sha256": "a" * 64}]}, None),
            "a file that is also a directory": (
                {"files": [{"path": "a", "sha256": "a" * 64}, {"path": "a/b", "sha256": "a" * 64}]},
                "refused: the manifest lists a file that is also a directory of 'a/b'",
            ),
            "a file under the reserved content/": ({"files": [{"path": "content/x.json", "sha256": "a" * 64}]}, "refused: the manifest lists 'content/x.json', under the reserved content/"),
            "a sha256 with a newline after it": ({"sha256": "a" * 64 + "\n"}, None),
            "a tarball over 64 MiB": ({"size": 64 * 1_048_576 + 1}, None),
            "no createdAt": ({"createdAt": None}, None),
        }
        for why, (fields, said) in cases.items():
            with self.subTest(why):
                s = Screen()
                tar, rel = release(42, override=fields)
                s.offering(rel, tar)
                self.assertEqual(s.u.poll(), said or "refused: the manifest is not a release manifest")
                self.assertEqual(s.downloads, 0)

    def test_an_offer_with_a_malformed_signature_or_an_oversized_manifest_is_refused(self):
        tar, rel = release(42)
        for why, bad in {"a short signature": {**rel, "signature": rel["signature"][:-4]}, "a manifest over a MiB": {**rel, "manifest": " " * 1_048_577}}.items():
            with self.subTest(why):
                s = Screen()
                s.offering(bad, tar)
                self.assertTrue(s.u.poll().startswith("refused: the offer's release"))

    def test_a_manifest_text_changed_after_signing_does_not_verify(self):
        s = Screen()
        tar, rel = release(42)
        rel["manifest"] = rel["manifest"].replace('"version": 42', '"version": 43')
        s.offering(rel, tar)
        self.assertEqual(s.u.poll(), "refused: the signature does not verify")

    def test_a_tarball_that_is_not_the_one_signed_is_not_kept(self):
        s = Screen()
        tar, rel = release(42)
        s.offering(rel)
        s.tarballs[sha(tar)] = tar[:-1] + bytes([tar[-1] ^ 1])
        self.assertEqual(s.u.poll(), "refused: the tarball is not the one signed")
        self.assertEqual((s.restarts, s.served(), s.players()), (0, "players/0", ["0"]))

    def test_a_hostile_tarball_writes_nothing_outside_and_installs_nothing_and_says_why(self):
        rest = list(FILES.items())[1:]
        hostile = {
            "a path up and out": ([file("../outside.js", b"x")], "a path outside it: '../outside.js'"),
            "an absolute path": ([file("/tmp/outside.js", b"x")], "a path outside it: '/tmp/outside.js'"),
            "a symbolic link": ([member("index.html", tarfile.SYMTYPE, "/etc/passwd"), *rest], "something other than a file or a directory: 'index.html'"),
            "a hard link": ([member("index.html", tarfile.LNKTYPE, "sw.js"), *rest], "something other than a file or a directory: 'index.html'"),
            "a device": ([member("index.html", tarfile.CHRTYPE), *rest], "something other than a file or a directory: 'index.html'"),
            "a FIFO": ([member("index.html", tarfile.FIFOTYPE), *rest], "something other than a file or a directory: 'index.html'"),
            "a directory no listed file is in": ([member("extra", tarfile.DIRTYPE), *FILES.items()], "a directory no listed file is in: 'extra'"),
            "a directory under the reserved content/": ([member("content", tarfile.DIRTYPE), *FILES.items()], "a directory no listed file is in: 'content'"),
            "a file the manifest does not list": ([*FILES.items(), file("extra.js", b"x")], "a file the manifest does not list once: 'extra.js'"),
            "a listed file twice": ([*FILES.items(), file("sw.js", b"// sw")], "a file the manifest does not list once: 'sw.js'"),
            "a listed file with other bytes": ([file("index.html", b"<script>evil()</script>"), *rest], "index.html is not the file signed"),
            "a listed file missing": (rest, "lacks 1 file(s) the manifest lists, such as 'index.html'"),
            "a directory named twice": ([member("assets", tarfile.DIRTYPE), member("assets/", tarfile.DIRTYPE), *FILES.items()], "names a directory twice: 'assets'"),
            "./ twice": ([member("./", tarfile.DIRTYPE), member(".", tarfile.DIRTYPE), *FILES.items()], "names a directory twice: '.'"),
        }
        for why, (entries, said) in hostile.items():
            with self.subTest(why):
                s = Screen()
                tar = tarball(entries)
                _, rel = release(42, files=FILES, tar=tar)
                s.offering(rel, tar)
                self.assertIn(said, s.u.poll())
                self.assertEqual((s.restarts, s.served(), s.players()), (0, "players/0", ["0"]))
                self.assertFalse(os.path.exists(os.path.join(s.home, "outside.js")))
                self.assertFalse(os.path.exists("/tmp/outside.js"))

    def test_files_that_add_up_to_more_than_a_release_and_too_many_members_are_refused(self):
        s = Screen()
        tar, rel = release(42, files={"big.js": b"x" * 4096})
        s.offering(rel, tar)
        with mock.patch.object(updater, "MAX_RELEASE_BYTES", 4095):
            self.assertEqual(s.u.poll(), "refused: the tarball's files add up to more than a release may")
        self.assertEqual(s.players(), ["0"])
        # Three files, one directory they are in, and `./`: five members at most, as the manifest allows.
        s = Screen()
        tar = tarball([member("./", tarfile.DIRTYPE), member("assets", tarfile.DIRTYPE), *FILES.items(), file("x", b"")])
        _, rel = release(42, tar=tar)
        s.offering(rel, tar)
        self.assertEqual(s.u.poll(), "refused: the tarball holds more than 5 members")
        s = Screen()
        tar = tarball([member("./", tarfile.DIRTYPE), member("assets", tarfile.DIRTYPE), *FILES.items()])
        _, rel = release(42, tar=tar)
        s.offering(rel, tar)
        self.assertEqual(s.u.poll(), "installed 42")

    def test_a_signed_tarball_that_is_not_a_gzipped_tar_is_refused_and_waits_to_retry(self):
        for why, body in {"not gzip": b"plain bytes, not a tarball", "gzip, not a tar": __import__("gzip").compress(b"x" * 600)}.items():
            with self.subTest(why):
                s = Screen()
                _, rel = release(42, tar=body)
                s.offering(rel, body)
                self.assertTrue(s.u.poll().startswith("refused: the tarball is not a gzipped tar"))
                self.assertEqual((s.u.poll(), s.players()), ("release 42 waits to retry", ["0"]))

    def test_with_no_room_on_the_disk_nothing_is_downloaded(self):
        s = Screen()
        tar, rel = release(42)
        s.offering(rel, tar)
        s.free = updater.DISK_MARGIN_BYTES
        self.assertEqual(s.u.poll(), "refused: not enough room on the disk")
        self.assertEqual(s.downloads, 0)

    def test_a_failed_install_is_not_downloaded_again_until_its_wait_which_doubles(self):
        s = Screen()
        tar, rel = release(42)
        s.offering(rel)
        s.tarballs[sha(tar)] = b"not it"
        self.assertEqual(s.u.poll(), "refused: the tarball is not the one signed")
        self.assertEqual(s.u.poll(), "release 42 waits to retry")
        s.tick(updater.RETRY_S)
        self.assertEqual(s.u.poll(), "refused: the tarball is not the one signed")
        s.tick(updater.RETRY_S)
        # The wait held across a restart of the supervisor, and doubled.
        s.u = s.make()
        self.assertEqual(s.u.poll(), "release 42 waits to retry")
        s.tick(updater.RETRY_S)
        s.tarballs[sha(tar)] = tar
        self.assertEqual(s.u.poll(), "installed 42")
        self.assertEqual(s.downloads, 3)

    def test_a_release_that_keeps_failing_is_marked_bad_as_other_and_reported(self):
        s = Screen()
        tar, rel = release(42)
        s.offering(rel)
        s.tarballs[sha(tar)] = b"not it"
        waits = []
        for _ in range(updater.RETRY_TRIES):
            self.assertEqual(s.u.poll(), "refused: the tarball is not the one signed")
            retry = s.u.state["retry"]
            if retry:
                waits.append(next(iter(retry.values()))["at"] - s.now)
                s.now = next(iter(retry.values()))["at"]
        self.assertEqual([w // 60 for w in waits], [15, 30, 60, 120, 240])
        self.assertEqual(s.u.alive_reply(), {"failedRelease": {"version": 42, "reason": "other"}})
        self.assertEqual(s.u.poll(), "refused: version 42 was rolled back before")
        self.assertEqual(s.downloads, updater.RETRY_TRIES)

    def test_at_start_it_clears_what_an_install_left_and_reads_past_a_state_file_that_is_not_one(self):
        s = Screen()
        players = os.path.join(s.home, "players")
        os.makedirs(os.path.join(players, ".42.tmp", "assets"))
        open(os.path.join(players, ".42.tar.gz"), "w").close()
        with open(os.path.join(players, "state.json"), "w") as f:
            f.write("null")
        s.u = s.make()
        self.assertEqual(s.players(), ["0"])
        self.assertEqual(s.u.alive_reply(), {})


class Timing(unittest.TestCase):
    def test_a_stable_screen_installs_while_its_panel_is_off(self):
        s = Screen(channel="stable", panel_on=False)
        tar, rel = release(42)
        s.offering(rel, tar)
        self.assertEqual(s.u.poll(), "installed 42")

    def test_a_stable_screen_whose_panel_stays_on_installs_an_hour_after_the_offer_at_a_random_minute(self):
        s = Screen(channel="stable", panel_on=True)
        tar, rel = release(42)
        s.offering(rel, tar)
        # rand() is 0.5: the 30th minute of the hour after the first hour.
        at = T0 + updater.OFFERED_WAIT_S + 30 * 60
        self.assertEqual(s.u.poll(), "release 42 waits for the panel to be off")
        s.now = at - 1
        # The wait holds across a restart of the supervisor.
        s.u = s.make()
        self.assertEqual(s.u.poll(), "release 42 waits for the panel to be off")
        s.now = at
        self.assertEqual(s.u.poll(), "installed 42")


class HealthGate(unittest.TestCase):
    def installed(self, served=7):
        s = Screen(served=served)
        tar, rel = release(42)
        s.offering(rel, tar)
        self.assertEqual(s.u.poll(), "installed 42")
        return s

    def beat(self, s, seconds, every=5, release=42):
        for _ in range(seconds // every):
            s.tick(every)
            s.u.beat(release)
            outcome = s.u.check_gate()
            if outcome:
                return outcome
        return None

    def test_a_player_that_beats_with_its_release_for_ten_minutes_passes_and_the_oldest_version_goes(self):
        s = self.installed()
        os.makedirs(os.path.join(s.home, "players", "3"))
        s.tick(60)
        self.assertEqual(self.beat(s, updater.GATE_HOLD_S + 5), "passed")
        self.assertEqual(s.served(), "players/42")
        # The one in use and the way back.
        self.assertEqual(s.players(), ["42", "7"])
        self.assertEqual(s.u.alive_reply(), {})
        # What passed is a floor: a hand deploy of an older build (players/0) is not offered anything at or below it.
        os.replace(os.path.join(s.home, "www"), os.path.join(s.home, "www.old"))
        os.symlink("players/0", os.path.join(s.home, "www"))
        tar, rel = release(41)
        s.offering(rel, tar)
        self.assertEqual(s.u.poll(), "refused: version 41 is not above this screen's floor (42)")

    def test_a_player_that_never_beats_with_its_release_is_rolled_back_marked_bad_and_reported(self):
        s = self.installed()
        # The old build's beats while the kiosk restarts, and a build's with no release, are not the new one's.
        self.beat(s, 20, release=7)
        self.beat(s, 10, release=None)
        s.mono = M0 + updater.GATE_FIRST_S + 1
        self.assertEqual(s.u.check_gate(), "rolled back: not-alive")
        self.assertEqual((s.served(), s.restarts, s.players()), ("players/7", 2, ["7"]))
        self.assertEqual(s.u.alive_reply(), {"failedRelease": {"version": 42, "reason": "not-alive"}})
        # Never again: the same release offered after a restart of the supervisor is refused.
        s.u = s.make()
        self.assertEqual(s.u.poll(), "refused: version 42 was rolled back before")
        self.assertEqual(s.u.alive_reply(), {"failedRelease": {"version": 42, "reason": "not-alive"}})

    def test_an_old_build_beating_on_after_the_switch_goes_back_without_marking_the_release(self):
        s = self.installed()
        # A cached build still running: its beats come long after the switch.
        self.assertIsNone(self.beat(s, updater.GATE_FIRST_S - 5, release=7))
        s.tick(10)
        self.assertEqual(s.u.check_gate(), "rolled back: not switched")
        self.assertEqual(s.served(), "players/7")
        self.assertEqual(s.u.alive_reply(), {})
        # Offered again once its wait is over, not refused as bad.
        self.assertEqual(s.u.poll(), "release 42 waits to retry")
        s.tick(updater.RETRY_S)
        self.assertEqual(s.u.poll(), "installed 42")
        # A second round: the install keeps the count, so the wait doubles rather than starting again.
        self.assertIsNone(self.beat(s, updater.GATE_FIRST_S - 5, release=7))
        s.tick(10)
        self.assertEqual(s.u.check_gate(), "rolled back: not switched")
        s.tick(updater.RETRY_S)
        self.assertEqual(s.u.poll(), "release 42 waits to retry")
        s.tick(updater.RETRY_S)
        self.assertEqual(s.u.poll(), "installed 42")
        # And a pass clears it.
        self.assertEqual(self.beat(s, updater.GATE_HOLD_S + 5), "passed")
        self.assertEqual(s.u.state["retry"], {})

    def test_a_player_that_stops_beating_before_the_gate_closes_is_rolled_back(self):
        s = self.installed()
        self.assertIsNone(self.beat(s, 120))
        s.tick(updater.BEAT_GAP_S + 1)
        self.assertEqual(s.u.check_gate(), "rolled back: stopped")
        self.assertEqual(s.served(), "players/7")

    def test_the_gate_runs_on_the_monotonic_clock_not_the_wall_s_jumps(self):
        s = self.installed()
        # NTP's first sync moves the wall clock a day; the gate does not see it.
        s.now += 86_400
        self.assertIsNone(s.u.check_gate())
        s.now -= 2 * 86_400
        self.assertIsNone(self.beat(s, 60))

    def test_a_newer_release_that_passes_ends_the_report(self):
        s = self.installed()
        s.tick(updater.GATE_FIRST_S + 1)
        s.u.check_gate()
        tar, rel = release(43)
        s.offering(rel, tar)
        self.assertEqual(s.u.poll(), "installed 43")
        self.assertEqual(s.u.alive_reply(), {"failedRelease": {"version": 42, "reason": "not-alive"}})
        self.assertEqual(self.beat(s, updater.GATE_HOLD_S + 5, release=43), "passed")
        self.assertEqual(s.u.alive_reply(), {})

    def test_a_supervisor_that_starts_with_a_gate_open_starts_its_window_again(self):
        s = self.installed()
        # The process that opened it is gone, and its monotonic times with it: a reboot starts the clock afresh.
        s.mono = 10
        s.u = s.make()
        s.tick(updater.GATE_FIRST_S - 1)
        self.assertIsNone(s.u.check_gate())
        s.tick(2)
        self.assertEqual(s.u.check_gate(), "rolled back: not-alive")

    def test_a_crash_between_the_gate_and_the_switch_is_finished_at_start(self):
        s = self.installed()
        # As if the supervisor died after saving the gate, before the link moved.
        os.replace(os.path.join(s.home, "www"), os.path.join(s.home, "www.gone"))
        os.symlink("players/7", os.path.join(s.home, "www"))
        s.u = s.make()
        self.assertEqual((s.served(), s.restarts), ("players/42", 2))
        self.assertEqual(self.beat(s, updater.GATE_HOLD_S + 5), "passed")

    def test_a_gate_whose_release_is_gone_and_not_served_is_cleared_at_start(self):
        s = self.installed()
        os.replace(os.path.join(s.home, "www"), os.path.join(s.home, "www.gone"))
        os.symlink("players/7", os.path.join(s.home, "www"))
        import shutil

        shutil.rmtree(os.path.join(s.home, "players", "42"))
        s.u = s.make()
        self.assertEqual((s.served(), s.u.state["gate"], s.restarts), ("players/7", None, 1))

    def test_a_crash_inside_a_rollback_finishes_it_at_start(self):
        s = self.installed()
        s.tick(updater.GATE_FIRST_S + 1)
        # The record is saved; the supervisor dies before the link moves back.
        with mock.patch.object(s.u, "switch", side_effect=SystemExit):
            with self.assertRaises(SystemExit):
                s.u.check_gate()
        self.assertEqual(s.served(), "players/42")
        s.u = s.make()
        self.assertEqual((s.served(), s.u.state["gate"], s.players()), ("players/7", None, ["7"]))
        self.assertEqual(s.u.alive_reply(), {"failedRelease": {"version": 42, "reason": "not-alive"}})

    def test_a_hand_deploy_over_a_rolled_back_release_is_not_undone_at_start(self):
        s = self.installed()
        s.tick(updater.GATE_FIRST_S + 1)
        with mock.patch.object(s.u, "switch", side_effect=SystemExit):
            with self.assertRaises(SystemExit):
                s.u.check_gate()
        # deploy-pi.sh, before the supervisor starts again.
        os.makedirs(os.path.join(s.home, "players", "0"))
        os.replace(os.path.join(s.home, "www"), os.path.join(s.home, "www.gone"))
        os.symlink("players/0", os.path.join(s.home, "www"))
        s.u = s.make()
        self.assertEqual((s.served(), s.u.state["gate"]), ("players/0", None))

    def test_with_the_version_before_gone_a_failed_release_stays_served_and_is_marked(self):
        s = self.installed()
        import shutil

        shutil.rmtree(os.path.join(s.home, "players", "7"))
        s.tick(updater.GATE_FIRST_S + 1)
        self.assertEqual(s.u.check_gate(), "rolled back: not-alive")
        self.assertEqual((s.served(), s.restarts), ("players/42", 1))
        self.assertEqual(s.u.alive_reply(), {"failedRelease": {"version": 42, "reason": "not-alive"}})

    def test_a_full_disk_does_not_stop_a_rollback(self):
        s = self.installed()
        s.tick(updater.GATE_FIRST_S + 1)
        with mock.patch.object(s.u, "save", side_effect=OSError(28, "No space left on device")):
            self.assertEqual(s.u.check_gate(), "rolled back: not-alive")
        self.assertEqual(s.served(), "players/7")
        self.assertTrue(any("not saved" in line for line in s.logged))


if __name__ == "__main__":
    unittest.main()
