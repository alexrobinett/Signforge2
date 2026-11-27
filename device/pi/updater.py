"""The player update channel on the device (#628): the supervisor pulls a signed player build and switches to it.

About every POLL_S, with jitter, it asks the API its credential is bound to for its screen's channel's release
(`GET <api>/player-release`, the contract's `PlayerReleaseOffer`). Before it writes anything it checks that:
  - the manifest's text verifies against the release key it ships with (`player-release.pub`, Ed25519);
  - the manifest is the contract's, in a format it knows, and asks for no newer supervisor than this (SUPERVISOR_LEVEL);
  - the version is above its floor, and not one it rolled back before (`bad`). The floor is the highest of the version
    it runs, the highest that ever passed its gate here, and the one deployed with the key (`player-release.floor`), so
    a freshly imaged screen is not offered a release older than the newest when it was set up;
  - the release plays the manifest schema the server compiles.
A canary installs at once; a stable screen while its panel is off, or else once the release has been offered for an
hour, at a random minute in the hour after, so a fleet does not restart at once. An install that fails waits before
the same release is downloaded again, doubling each time (RETRY_S, at most RETRY_MAX_S); after RETRY_TRIES it is
marked bad as `other` and reported, as a release rolled back is.

Installing: with room on the disk, it downloads the tarball (`GET <api>/player-release/<sha256>`) into players/, no
more than its size, and checks its sha256 and size. It extracts it into players/.<version>.tmp/ as the contract states
a tarball: only regular files and directories at release paths, each file listed in the manifest once and matching its
hash, every listed file present, each directory a parent of a listed one; anything else and nothing is kept. Every
file and directory is synced to disk before players/.<version>.tmp/ is renamed to players/<version>/, with a `content`
link to ~/signforge/content, the content the player is sent, which no release carries (`content` is reserved).

Switching: player-web serves ~/signforge/www, a link to players/<version>/, with no-store (player_web.py), and the
kiosk clears Chromium's HTTP cache as it starts (kiosk.sh), so a switch is never hidden by an old build kept in a cache.
The gate is written to state.json, synced, before the switch: a crash between the two is finished or undone at the
next start. A new link is made beside www and renamed over it, which is atomic, and the kiosk restarted. The new
player must beat `/alive` with its release number within GATE_FIRST_S, and go on beating, no gap over BEAT_GAP_S,
until GATE_HOLD_S after its first beat. The gate runs on the monotonic clock, since a Pi has no real-time clock and
its wall clock jumps when NTP first syncs; a supervisor that starts with a gate open starts its window again.

If the new player does not beat in time, the link goes back to the version before, if it is still there, and the
kiosk restarts. The version is marked bad, never installed again, and the `/alive` reply names it (`failedRelease`)
until a newer one passes, so the player reports it on its syncs. When an older build went on beating after the
switch, the new one never ran: that is not its fault, so it goes back without being marked, and waits to retry as a
failed install does, until RETRY_TRIES. A rollback records the release bad before it switches back, so a crash between
the two finishes the rollback at the next start rather than serving the failed release again. A version that passes leaves the one before it as the way back; older ones are deleted.

State that must outlive a restart is in players/state.json. Everything outside is injected, the clocks included, so
the tests run on fixed ones.
"""
import base64, hashlib, json, os, re, shutil, tarfile, zlib

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import load_pem_public_key

POLL_S = 900
GATE_FIRST_S = 300
GATE_HOLD_S = 600
# The longest gap between the new player's beats while the gate is open: the supervisor's own STALE_S. An older
# build's beat later than this after the switch means the switch did not take.
BEAT_GAP_S = 30
# A stable screen whose panel is never off installs this long after a release was first offered, plus a random minute
# of the hour after.
OFFERED_WAIT_S = 3600
# A release whose install failed waits this long before it is downloaded again, doubling each time, at most a day.
RETRY_S = POLL_S
RETRY_MAX_S = 86_400
# Tries before a release that keeps failing is marked bad (`other`) and reported: waits of 15, 30, 60, 120 and 240
# minutes, about 8 hours, outlast a night's network or storage fault, and bound a canary's downloads and kiosk restarts
# for one release to 6, where trying for good cost 144 downloads in 3 days with nothing reported.
RETRY_TRIES = 6
# The contract's bounds (packages/contract, player releases): past any, nothing is written.
RELEASE_FORMAT = 1
MAX_RELEASE_MANIFEST_BYTES = 1_048_576
MAX_RELEASE_FILES = 1000
MAX_RELEASE_BYTES = 64 * 1_048_576
MAX_RELEASE_PATH_LENGTH = 1024
RELEASE_PATH_SEGMENT = re.compile(r"^[A-Za-z0-9._-]{1,255}\Z")
RELEASE_SIGNATURE = re.compile(r"^[A-Za-z0-9+/]{86}==\Z")
RESERVED_RELEASE_PATH = "content"
# This supervisor's level: a release whose `minSupervisor` is higher needs a supervisor deployed by hand first.
SUPERVISOR_LEVEL = 1
# Room left on the disk after an install's tarball and files.
DISK_MARGIN_BYTES = 100 * 1024 * 1024
CHANNELS = ("canary", "stable")
SHA256 = re.compile(r"^[0-9a-f]{64}\Z")
LEFTOVER = re.compile(r"^\.[0-9]+\.(tar\.gz|tmp)\Z")


class Refused(Exception):
    """A release the screen will not install, with why; nothing is written for it."""


def is_count(v, least=0):
    return isinstance(v, int) and not isinstance(v, bool) and v >= least


def is_release_path(p):
    """A path inside the tarball as the contract allows it: relative, `/`-separated RELEASE_PATH_SEGMENTs, never `.` or `..`."""
    return isinstance(p, str) and len(p) <= MAX_RELEASE_PATH_LENGTH and all(RELEASE_PATH_SEGMENT.match(s) and s not in (".", "..") for s in p.split("/"))


def read_offer(raw):
    """The API's reply as the contract's `PlayerReleaseOffer`, or Refused."""
    try:
        o = json.loads(raw)
    except ValueError:
        raise Refused("the offer is not JSON")
    if not isinstance(o, dict) or not is_count(o.get("manifestSchema"), 1) or o.get("channel") not in CHANNELS:
        raise Refused("the offer needs a manifestSchema and a channel")
    r = o.get("release")
    if r is not None and not (
        isinstance(r, dict)
        and isinstance(r.get("manifest"), str)
        and len(r["manifest"].encode("utf-8")) <= MAX_RELEASE_MANIFEST_BYTES
        and isinstance(r.get("signature"), str)
        and RELEASE_SIGNATURE.match(r["signature"])
    ):
        raise Refused("the offer's release needs its manifest text, at most a MiB, and an Ed25519 signature")
    return o


def read_manifest(text):
    """A signed manifest's text as the contract's `PlayerReleaseManifest`, or Refused."""
    try:
        m = json.loads(text)
    except ValueError:
        raise Refused("the manifest is not JSON")
    if not isinstance(m, dict) or m.get("format") != RELEASE_FORMAT:
        raise Refused(f"the manifest is not in release format {RELEASE_FORMAT}")
    ok = (
        is_count(m.get("minSupervisor"), 1)
        and is_count(m.get("version"), 1)
        and isinstance(m.get("sha256"), str)
        and SHA256.match(m["sha256"])
        and is_count(m.get("size"), 1)
        and m["size"] <= MAX_RELEASE_BYTES
        and isinstance(m.get("files"), list)
        and len(m["files"]) <= MAX_RELEASE_FILES
        and all(isinstance(f, dict) and is_release_path(f.get("path")) and isinstance(f.get("sha256"), str) and SHA256.match(f["sha256"]) for f in m["files"])
        and all(isinstance(m.get(k), list) and all(is_count(v, 1) for v in m[k]) for k in ("manifestSchemas", "protocols"))
        and isinstance(m.get("createdAt"), str)
    )
    if not ok:
        raise Refused("the manifest is not a release manifest")
    paths = {f["path"] for f in m["files"]}
    if len(paths) != len(m["files"]):
        raise Refused("the manifest lists a path twice")
    for p in paths:
        parts = p.split("/")
        if parts[0] == RESERVED_RELEASE_PATH:
            raise Refused(f"the manifest lists {p!r}, under the reserved {RESERVED_RELEASE_PATH}/")
        if any("/".join(parts[:i]) in paths for i in range(1, len(parts))):
            raise Refused(f"the manifest lists a file that is also a directory of {p!r}")
    if m["minSupervisor"] > SUPERVISOR_LEVEL:
        raise Refused(f"version {m['version']} needs supervisor {m['minSupervisor']}; this is {SUPERVISOR_LEVEL}")
    return m


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class Updater:
    """
    `home`: ~/signforge. `public_key`: the release key's PEM. `fetch(path)`: the API's reply to a GET under the bound base,
    as (status, bytes). `download(path, dest, limit)`: write that GET's body to `dest`, at most `limit` bytes, raising past it.
    `restart()`: restart the kiosk. `panel_on()`: whether the panel is on. `clock()`: wall time in seconds, for waits that
    outlive a restart. `mono()`: the monotonic clock in seconds, for the gate. `rand()`: in [0, 1).
    """

    def __init__(self, home, public_key, fetch, download, restart, panel_on, clock, mono, rand, log=print, disk_free=None):
        self.home, self.fetch, self.download, self.restart, self.panel_on, self.clock, self.mono, self.rand, self.log = (
            home, fetch, download, restart, panel_on, clock, mono, rand, log
        )
        self.key = load_pem_public_key(public_key)
        if not isinstance(self.key, Ed25519PublicKey):
            raise ValueError("the release key is not Ed25519")
        self.players = os.path.join(home, "players")
        os.makedirs(self.players, exist_ok=True)
        os.makedirs(os.path.join(home, "content"), exist_ok=True)
        self.disk_free = disk_free or (lambda: shutil.disk_usage(self.players).free)
        self.state_file = os.path.join(self.players, "state.json")
        self.state = {"bad": [], "failed": None, "offered": None, "gate": None, "passed": 0, "retry": {}}
        try:
            with open(self.state_file) as f:
                saved = json.load(f)
            if isinstance(saved, dict):
                self.state.update(saved)
        except (OSError, ValueError):
            pass
        # An install that stopped part way leaves these; none is in use.
        for name in os.listdir(self.players):
            if LEFTOVER.match(name):
                path = os.path.join(self.players, name)
                shutil.rmtree(path, ignore_errors=True) if os.path.isdir(path) else os.remove(path)
        self.resume_gate()

    def resume_gate(self):
        """A gate open at start: its monotonic times are another process's, so its window starts again. A crash between
        writing the gate and switching left the version before served: the switch is finished, or the gate cleared when
        the new version's files are gone."""
        gate = self.state["gate"]
        if not gate:
            return
        target = f"players/{gate['version']}"
        if gate["version"] in self.state["bad"]:
            # A rollback that stopped part way: finished, and never switched to the release again.
            previous = gate["previous"]
            if self.served() == target and previous and os.path.isdir(os.path.join(self.home, previous)):
                self.switch(previous)
                shutil.rmtree(os.path.join(self.home, target), ignore_errors=True)
            self.state["gate"] = None
            self.try_save()
            return
        if self.served() != target:
            if self.served() != gate["previous"] or not os.path.isdir(os.path.join(self.home, target)):
                self.state["gate"] = None
                self.save()
                return
            self.switch(target)
        gate.update(started=self.mono(), first=None, last=None, old=None)

    # -------------------------------------------------------------------------------------------- what runs now

    def served(self):
        """Where player-web's link points, `players/<version>`, or None before there is one."""
        try:
            return os.readlink(os.path.join(self.home, "www"))
        except OSError:
            return None

    def installed(self):
        """The version player-web serves; 0 for none, or a build deployed by hand (`players/0`)."""
        name = os.path.basename(self.served() or "")
        return int(name) if name.isdigit() else 0

    def floor(self):
        """The highest version this screen will not install at or below: what it runs, what passed here, what it was deployed with."""
        try:
            with open(os.path.join(self.home, "player-release.floor")) as f:
                deployed = int(f.read().strip() or 0)
        except (OSError, ValueError):
            deployed = 0
        return max(self.installed(), self.state["passed"], deployed)

    def save(self):
        """Write state.json and sync it, the file and its directory, so it outlives a power cut."""
        tmp = self.state_file + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.state, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.state_file)
        fsync_dir(self.players)

    def try_save(self):
        """save(), when what it records matters less than going on: a full disk still rolls back."""
        try:
            self.save()
        except OSError as e:
            self.log(f"player update state not saved: {e}")

    # ----------------------------------------------------------------------------------------------------- poll

    def poll(self):
        """One poll: the offer, checked, and installed when it is due. Returns what it did, for the log and the tests."""
        if self.state["gate"]:
            return "gate open"
        status, raw = self.fetch("/player-release")
        if status != 200:
            return f"offer: HTTP {status}"
        try:
            offer = read_offer(raw)
            if offer["release"] is None:
                return "no release"
            m = self.verified(offer)
        except Refused as e:
            self.log(f"player release refused: {e}")
            return f"refused: {e}"
        v = m["version"]
        now = self.clock()
        retry = self.state["retry"].get(f"{v}:{m['sha256']}")
        if retry and now < retry["at"]:
            return f"release {v} waits to retry"
        if offer["channel"] == "stable" and self.panel_on():
            offered = self.state["offered"]
            if not offered or offered["version"] != v:
                offered = self.state["offered"] = {"version": v, "at": now + OFFERED_WAIT_S + int(self.rand() * 60) * 60}
                self.save()
            if now < offered["at"]:
                return f"release {v} waits for the panel to be off"
        try:
            self.install(m)
        except (Refused, OSError) as e:
            self.retry_later(v, m["sha256"])
            self.log(f"player release {v} not installed: {e}")
            return f"refused: {e}"
        return f"installed {v}"

    def retry_later(self, version, sha256):
        """Hold this release back before it is downloaded again, for longer each time it fails; other releases' holds go.
        At RETRY_TRIES it is marked bad, as `other`, and the `/alive` reply reports it."""
        key = f"{version}:{sha256}"
        tries = self.state["retry"].get(key, {}).get("tries", 0) + 1
        if tries >= RETRY_TRIES:
            self.state.update(bad=sorted(set(self.state["bad"]) | {version}), failed={"version": version, "reason": "other"}, retry={})
            self.log(f"player release {version} failed {tries} times: marked bad")
        else:
            self.state["retry"] = {key: {"tries": tries, "at": self.clock() + min(RETRY_S * 2 ** (tries - 1), RETRY_MAX_S)}}
        self.try_save()

    def verified(self, offer):
        """The offered manifest, once its signature, version and schema are right; else Refused. Writes nothing."""
        text = offer["release"]["manifest"]
        try:
            self.key.verify(base64.b64decode(offer["release"]["signature"], validate=True), text.encode("utf-8"))
        except (InvalidSignature, ValueError):
            raise Refused("the signature does not verify")
        m = read_manifest(text)
        v = m["version"]
        if v <= self.floor():
            raise Refused(f"version {v} is not above this screen's floor ({self.floor()})")
        if v in self.state["bad"]:
            raise Refused(f"version {v} was rolled back before")
        if offer["manifestSchema"] not in m["manifestSchemas"]:
            raise Refused(f"version {v} does not play manifest schema {offer['manifestSchema']}")
        return m

    # -------------------------------------------------------------------------------------------------- install

    def install(self, m):
        v, size = m["version"], m["size"]
        if self.disk_free() < 2 * size + DISK_MARGIN_BYTES:
            raise Refused("not enough room on the disk")
        tarball = os.path.join(self.players, f".{v}.tar.gz")
        work = os.path.join(self.players, f".{v}.tmp")
        final = os.path.join(self.players, str(v))
        try:
            self.download(f"/player-release/{m['sha256']}", tarball, size)
            with open(tarball, "rb") as f:
                digest, got = hashlib.sha256(), 0
                for chunk in iter(lambda: f.read(1 << 16), b""):
                    digest.update(chunk)
                    got += len(chunk)
            if got != size or digest.hexdigest() != m["sha256"]:
                raise Refused("the tarball is not the one signed")
            shutil.rmtree(work, ignore_errors=True)
            extract(tarball, work, {f["path"]: f["sha256"] for f in m["files"]})
            os.symlink("../../content", os.path.join(work, RESERVED_RELEASE_PATH))
            fsync_dir(work)
            shutil.rmtree(final, ignore_errors=True)
            os.rename(work, final)
            fsync_dir(self.players)
        except BaseException:
            shutil.rmtree(work, ignore_errors=True)
            raise
        finally:
            if os.path.exists(tarball):
                os.remove(tarball)
        # The gate before the switch: a crash between them is finished or undone at the next start (resume_gate).
        self.state.update(
            gate={"version": v, "sha256": m["sha256"], "previous": self.served(), "started": self.mono(), "first": None, "last": None, "old": None},
            offered=None,
        )
        self.save()
        self.switch(f"players/{v}")
        self.log(f"player {v} installed: waiting for its beat")

    def switch(self, target):
        """Point player-web's link at `target` (`players/<version>`), atomically, and restart the kiosk."""
        link = os.path.join(self.home, "www")
        tmp = link + ".new"
        if os.path.lexists(tmp):
            os.remove(tmp)
        os.symlink(target, tmp)
        os.replace(tmp, link)
        fsync_dir(self.home)
        self.restart()

    # ---------------------------------------------------------------------------------------------- health gate

    def beat(self, release):
        """The player's `/alive`, with the release it says it is (None for a build with none): the gate counts the new
        one's, and notes an older build still beating once the switch had time to take."""
        gate = self.state["gate"]
        if not gate:
            return
        now = self.mono()
        if release == gate["version"]:
            if gate["first"] is None:
                gate["first"] = now
            gate["last"] = now
        elif now - gate["started"] > BEAT_GAP_S:
            gate["old"] = now

    def check_gate(self):
        """Close the gate: passed once the new player has beaten for GATE_HOLD_S; rolled back once it has not beaten in time."""
        gate = self.state["gate"]
        if not gate:
            return None
        now = self.mono()
        if gate["first"] is None:
            if now - gate["started"] <= GATE_FIRST_S:
                return None
            # An older build beat on after the switch: the new one never ran, so it is not marked bad.
            return self.roll_back(None if gate["old"] is not None else "not-alive")
        if now - gate["last"] > BEAT_GAP_S:
            return self.roll_back("stopped")
        if now - gate["first"] >= GATE_HOLD_S:
            v = gate["version"]
            self.state.update(gate=None, failed=None, retry={}, passed=max(self.state["passed"], v))
            self.save()
            self.keep(f"players/{v}", gate["previous"])
            self.log(f"player {v} passed its health gate")
            return "passed"
        return None

    def roll_back(self, reason):
        """Back to what served before, when it is still there. A failed release is recorded bad first, the gate still
        open, so a crash before the switch finishes the rollback at start (resume_gate); a save that fails, on a full disk,
        does not stop it. `reason` None: the new version never ran, so it waits to retry, unmarked."""
        gate = self.state["gate"]
        v, previous = gate["version"], gate["previous"]
        if reason:
            self.state["bad"] = sorted(set(self.state["bad"]) | {v})
            self.state["failed"] = {"version": v, "reason": reason}
            self.try_save()
        if previous and os.path.isdir(os.path.join(self.home, previous)):
            self.switch(previous)
            shutil.rmtree(os.path.join(self.players, str(v)), ignore_errors=True)
            self.log(f"player {v} rolled back to {previous}: {reason or 'not switched'}")
        else:
            # Nothing else to serve: the new version stays.
            self.log(f"player {v} failed its gate ({reason or 'not switched'}), and there is no version before it to go back to")
        self.state["gate"] = None
        if reason:
            self.try_save()
        else:
            self.retry_later(v, gate["sha256"])
        return f"rolled back: {reason or 'not switched'}"

    def keep(self, *targets):
        """Delete every installed version but these (`players/<version>`): the one in use and the way back."""
        names = {os.path.basename(t) for t in targets if t}
        for name in os.listdir(self.players):
            if name.isdigit() and name not in names:
                shutil.rmtree(os.path.join(self.players, name), ignore_errors=True)

    def alive_reply(self):
        """The `/alive` reply: the release last rolled back, until a newer one passes."""
        return {"failedRelease": self.state["failed"]} if self.state["failed"] else {}


def extract(tarball, dest, files):
    """Extract `tarball` into `dest` as the contract states a release tarball, each file and directory synced to disk."""
    parents = {"/".join(p.split("/")[:i]) for p in files for i in range(1, p.count("/") + 1)}
    # Every member is a listed file, a directory one is in, or `./`, each once.
    most = len(files) + len(parents) + 1
    os.makedirs(dest)
    seen, dirs, total, members = set(), set(), 0, 0
    try:
        with tarfile.open(tarball, "r:gz") as tar:
            for member in tar:
                members += 1
                if members > most:
                    raise Refused(f"the tarball holds more than {most} members")
                name = member.name[2:] if member.name.startswith("./") else member.name
                name = name.rstrip("/") if member.isdir() else name
                if member.isdir() and name in ("", "."):
                    name = ""
                elif not is_release_path(name):
                    raise Refused(f"the tarball holds a path outside it: {member.name!r}")
                if member.isdir():
                    if name and name not in parents:
                        raise Refused(f"the tarball holds a directory no listed file is in: {name!r}")
                    if name in dirs:
                        raise Refused(f"the tarball names a directory twice: {member.name!r}")
                    dirs.add(name)
                    os.makedirs(os.path.join(dest, name), exist_ok=True)
                    continue
                if not member.isreg():
                    raise Refused(f"the tarball holds something other than a file or a directory: {member.name!r}")
                if name not in files or name in seen:
                    raise Refused(f"the tarball holds a file the manifest does not list once: {name!r}")
                seen.add(name)
                path = os.path.join(dest, name)
                os.makedirs(os.path.dirname(path), exist_ok=True)
                src = tar.extractfile(member)
                digest = hashlib.sha256()
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
                with os.fdopen(fd, "wb") as out:
                    # Counted as written, not as the header says: a header cannot make a file larger than a release.
                    for chunk in iter(lambda: src.read(1 << 16), b""):
                        total += len(chunk)
                        if total > MAX_RELEASE_BYTES:
                            raise Refused("the tarball's files add up to more than a release may")
                        digest.update(chunk)
                        out.write(chunk)
                    out.flush()
                    os.fsync(out.fileno())
                if digest.hexdigest() != files[name]:
                    raise Refused(f"{name} is not the file signed")
    except (tarfile.TarError, EOFError, zlib.error) as e:
        raise Refused(f"the tarball is not a gzipped tar: {e}")
    missing = set(files) - seen
    if missing:
        raise Refused(f"the tarball lacks {len(missing)} file(s) the manifest lists, such as {sorted(missing)[0]!r}")
    for root, subdirs, _ in os.walk(dest):
        for d in subdirs:
            fsync_dir(os.path.join(root, d))
