# The Pi player

What runs on a Raspberry Pi 4 player, and how to set one up. The test rig is a Pi 400 (Pi 4 class, 4 GB) on Raspberry Pi OS Lite 64-bit (Trixie) with Chromium 156, at 1080p 60 Hz. Budgets and every measurement are in [`spike/pi-perf/RESULTS.md`](../../spike/pi-perf/RESULTS.md).

## Services

| Unit | What it does |
| --- | --- |
| `signforge-kiosk` | cage (Wayland kiosk compositor) running `kiosk.sh`: forces 1080p 60 Hz, then Chromium in kiosk mode on the URL in `~/signforge/kiosk.env` |
| `signforge-player-web` | `player_web.py`: serves `~/signforge/www` on 127.0.0.1:8090, standing in for the CDN: a link to the player build in use, `players/<version>/` (below), followed on each request, every reply `no-store` so Chromium keeps no build in its cache |
| `signforge-supervisor` | `supervisor.py`: display power and the screen's credential, on 127.0.0.1:8091. It restarts `signforge-kiosk` when the player has not beaten `POST /alive` for 30 s, allowed by the polkit rule `signforge-supervisor.rules` for that unit only. While the panel is on it reads the output's mode once a minute and sets it back to 1080p 60 Hz when a hotplug or an input switch has brought the panel's own back, but not every minute for a panel that refuses it (see below) |
| `signforge-datad`, `signforge-soak` | development stand-ins: a feed writer and a soak logger (`~/signforge/soak.csv`) |
| `signforge-bootprobe` | measurement only, never enabled by a deploy: records kernel start to first spot (`bench.py boot`) |

**The output's mode during play (#511).** `kiosk.sh` sets 1920x1080 at 60 Hz before Chromium starts, retrying until `wlr-randr` reads it back (#509), since a Pi 4 at 4K drops 14 to 23% of frames. During play the supervisor reads the mode every 60 s with two `wlr-randr` calls (the output's name, then its modes), only while the panel is on (it is off by design otherwise, and setting a mode would turn it back on), and sets it back the same way when it is not `1920x1080@60` (Hz rounded, so 59.94 counts as 60). Each reset is a journal line, `output at 3840x2160@60, not 1920x1080@60: set back`. A panel that refuses it is set 3 times in a row (`MODE_TRIES`), each a line `… set back, still 3840x2160@60`, the third ending `stuck at 3840x2160@60, next try in 60 min`, and from then on once an hour (`MODE_RETRY_S`): 24 lines a day, not 1,440 (#558). `GET /display` reports the last reading, the stuck mode included, and how often a set took since the supervisor started (`"output": {"mode", "resets"}`); the player sends it in its heartbeat, and `get_screen` and `list_screens` show it as `heartbeat.displayOutput`. A Pi that keeps going back to 4K shows a count that keeps rising; one stuck shows its own mode, its count still. A check that fails unexpectedly is a journal line `mode check failed (1 in a row): …`, and the reading is dropped until the next good one, so none looks current; one that goes on failing is logged once an hour, not every minute, and `mode check works again, after N that failed` when it does (review of #560); the player watch logs and goes on the same way. The watch's tests run on a development machine against a faked `wlr-randr`: `python3 -m unittest discover -s device/pi -p 'test_*.py'`, which CI runs on every change (`deploy-pi.sh` leaves them out).

**Player updates (#628).** The supervisor pulls player builds itself (`updater.py`), so a player that breaks cannot stop its own fix from arriving.
- **Layout:** `~/signforge/www` is a link to `players/<version>/`. The content the player is sent is `~/signforge/content`, which each version links to as its `content/`, so a release never carries or replaces it. A build `deploy-pi.sh` copies is `players/0`; its first run moves the content out of the old `www/`.
- **Polling:** about every 15 minutes, with jitter, the supervisor asks the API its credential is bound to (`GET <api>/player-release`) for its screen's channel's release.
- **Checks before writing anything:**
  - the manifest's text verifies against `~/signforge/player-release.pub`, the Ed25519 key CI signs with (the contract's test vector, `packages/contract/test/player-release/`, is checked the same way);
  - it is the contract's manifest, within its bounds (64 MiB, 1000 files), in format 1, and asks for no newer supervisor than this one (`SUPERVISOR_LEVEL`);
  - the version is above the floor, and not one rolled back before. The floor is the highest of the version served, the highest that passed its gate here, and `player-release.floor`, which `deploy-pi.sh` copies from `device/pi/` and only ever raises, so a freshly imaged Pi is not offered a release older than the newest when it was set up;
  - the release plays the manifest schema the server compiles.
- **When it installs:** a canary at once; a stable screen while its panel is off, or an hour after the release was first offered, at a random minute of the hour after.
- **Installing:** with room on the disk, it downloads the tarball, no more than its signed size and within 15 minutes, from the bound API only (no redirect is followed), and checks its sha256. It extracts it as the contract states a release tarball: only regular files and directories at release paths, each listed file once with its hash, every one present, each directory a parent of one, nothing under the reserved `content/`; anything else and nothing is kept. Files and directories are synced to disk before the version's directory is renamed into place. An install that fails waits 15 minutes before that release is downloaded again, doubling each time, at most a day; after 6 tries, about 8 hours, it is marked bad as `other` and reported, as a rollback is.
- **Switching:** the gate is saved, synced, before the switch; a supervisor that died between the two finishes the switch at start, or clears the gate if the version is gone. It renames a new `www` link over the old one, which is atomic, and restarts the kiosk, with the hung-kiosk watchdog disarmed until the new player beats. `kiosk.sh` clears Chromium's HTTP cache before it starts it, so no cached build hides the switch.
- **Health gate:** the new player must beat `/alive` with its release number (`SF_PLAYER_RELEASE` at build) within 5 minutes, and with no gap over 30 s for 10 minutes after its first beat. The gate runs on the monotonic clock, as the Pi has no real-time clock, and starts its window again when the supervisor restarts with it open. Otherwise the link goes back, if the version before is still there, and the kiosk restarts; the version is never installed again, and the `/alive` reply names it, so the player reports it on its syncs (`failedRelease`). When an older build went on beating after the switch, the new one never ran: it goes back unmarked and is retried later, counted as a failed install. A rollback records the release bad before it switches back, so a supervisor that dies part way finishes the rollback at start, and never switches to that release again, even over a hand deploy. A reason the player does not know is reported as `other`.
- **Housekeeping:** the version in use and the one before stay; older ones go.
- **Without the key**, `python3-cryptography`, or with anything else the update channel needs failing at start, the supervisor runs as before and the player is updated only by a deploy.
- **Tests:** `test_updater.py`, against a fake API, a test key and fixed clocks, with the contract's test vector; `test_player_web.py` for the headers.

None of them waits for the network. The player is offline-first and plays its cached manifest without one, and the supervisor listens only on 127.0.0.1.

## Setting up a Pi

1. Flash Raspberry Pi OS Lite 64-bit with Raspberry Pi Imager (user, Wi-Fi and ssh set there) and boot it once.
2. Install the packages: `sudo apt install cage chromium wlr-randr python3-websocket`.
3. From a checkout: `pnpm build && PI=<user>@<host> sh scripts/deploy-pi.sh`. It copies the player, these scripts and the units, and enables and starts the services. Put the kiosk URL in `~/signforge/kiosk.env` (the cloud demo's is `kiosk.env.cloud`).
4. On the Pi: `sh ~/signforge/tune.sh`, then `sudo systemctl reboot`. It is idempotent, and `sh tune.sh --undo` reverts it. Each setting has a comment saying what it does and what it measured:
   - CPU governor `performance` instead of `ondemand`, through a udev rule. Frames dropped during a 600 ms fade halved, for about 2 C.
   - `systemd-user-sessions.service` no longer waits for `network.target`. logind holds every login session, the kiosk's included, until that unit has run.
   - cloud-init off after the first boot (`cloud-init=disabled` in `cmdline.txt`).
   - A quiet kernel console, and none on the serial port (`quiet`, no `console=serial0`). The first spot after boot comes 0.8 to 0.9 s sooner. A serial cable shows nothing until it is undone.

   Together with the unit ordering, the first spot after boot comes 22 to 23 s after the kernel starts, against 37 to 46 s before.

   `sh tune.sh --overclock` also runs the ARM at 2.0 GHz instead of 1.8 (`arm_freq=2000`, `over_voltage=6`). Prepares come 5 to 8% sooner for 3.4 C more; frames dropped while the next spot loads and boot time do not change. It is not the default: it was measured on one Pi 400, so check temperature (`vcgencmd measure_temp`, `get_throttled`) on a bare Pi 4 in its enclosure before leaving it on. Do not overclock the GPU: `v3d_freq=750` hung the display driver.

Left as Raspberry Pi OS ships them, each for a measured reason given in RESULTS.md: `hdmi_enable_4kp60=1` (it also runs the GPU at 550 MHz rather than 500), the 512 MB CMA pool, zram swap, the persistent journal and the apt and man-db timers.

## Measuring

- `isolate.py <secs> <transition> <spots>`: one spot or a few, frames split by phase. The transition is `cut`, `crossfade` or `fade` (500 ms), `fade<ms>`, or `<ms>` for a crossfade that long; anything else is refused with the usage text. A spot asked for that never played (an id the manifest lacks) is listed as NOT PLAYED. Each spot starts cold (HTTP cache and the player origin's storage cleared), and its prepares while measured are printed after its numbers. `SF_PLAYER=<page url>` measures another build served beside the deployed one, for comparing builds on one Pi (the feed-image bench, `packages/cli/bench/feed-images/`, serves its own).
- `bench.sh <label> [runs] [restarts]` drives `bench.py`. It runs the whole stress playlist (alternating cut and fade 600, 290 s each, on a freshly started Chromium) and then kiosk restarts (launch, first prepare, first spot). Results go to `bench-<label>.txt`.
- `bench.py boot`, run by `signforge-bootprobe.service` from early boot, stamps `/proc/uptime`. The wall clock can't be used: the Pi has no real-time clock, so it jumps when NTP first syncs, often after Chromium has started.
- Pitfalls:
  - Copy the player with `rsync --checksum`.
  - A build measured beside the deployed one goes under the version served, `~/signforge/players/<version>/<dir>/` (reached at `/<dir>/`), and goes with it at the next deploy or update.
  - Clear the HTTP cache and bypass the service worker before measuring a new build (`bench.py` does both).
  - Stop `signforge-soak` while measuring, because it zeroes the frame counters every minute.
- One user at a time: `sh pi-lock.sh take|status|release`. The N100 test rig takes the same lock: `SF_PI=signforge-n100 sh pi-lock.sh …`. How to use it is in [`device/n100/README.md`](../n100/README.md).
