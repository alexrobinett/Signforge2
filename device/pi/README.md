# The Pi player

What runs on a Raspberry Pi 4 player, and how to set one up. The test rig is a Pi 400 (Pi 4 class, 4 GB) on Raspberry Pi OS Lite 64-bit (Trixie) with Chromium 156, at 1080p 60 Hz. Budgets and every measurement are in [`spike/pi-perf/RESULTS.md`](../../spike/pi-perf/RESULTS.md).

## Services

| Unit | What it does |
| --- | --- |
| `signforge-kiosk` | cage (Wayland kiosk compositor) running `kiosk.sh`: forces 1080p 60 Hz, then Chromium in kiosk mode on the URL in `~/signforge/kiosk.env` |
| `signforge-player-web` | serves `~/signforge/www` (the player build) on 127.0.0.1:8090, standing in for the CDN |
| `signforge-supervisor` | `supervisor.py`: display power and the screen's credential, on 127.0.0.1:8091. It restarts `signforge-kiosk` when the player has not beaten `POST /alive` for 30 s, allowed by the polkit rule `signforge-supervisor.rules` for that unit only. While the panel is on it reads the output's mode once a minute and sets it back to 1080p 60 Hz when a hotplug or an input switch has brought the panel's own back (see below) |
| `signforge-datad`, `signforge-soak` | development stand-ins: a feed writer and a soak logger (`~/signforge/soak.csv`) |
| `signforge-bootprobe` | measurement only, never enabled by a deploy: records kernel start to first spot (`bench.py boot`) |

**The output's mode during play (#511).** `kiosk.sh` sets 1920x1080 at 60 Hz before Chromium starts, retrying until `wlr-randr` reads it back (#509), since a Pi 4 at 4K drops 14 to 23% of frames. During play the supervisor reads the mode every 60 s with one `wlr-randr` call, only while the panel is on (it is off by design otherwise, and setting a mode would turn it back on), and sets it back the same way when it is not `1920x1080@60` (Hz rounded, so 59.94 counts as 60). Each reset is a journal line, `output at 3840x2160@60, not 1920x1080@60: set back, now 1920x1080@60`. `GET /display` reports the last reading and the number of resets since the supervisor started (`"output": {"mode", "resets"}`); the player sends it in its heartbeat, and `get_screen` and `list_screens` show it as `heartbeat.displayOutput`. A Pi that keeps going back to 4K shows a count that keeps rising.

None of them waits for the network. The player is offline-first and plays its cached manifest without one, and the supervisor listens only on 127.0.0.1.

## Setting up a Pi

1. Flash Raspberry Pi OS Lite 64-bit with Raspberry Pi Imager (user, Wi-Fi and ssh set there) and boot it once.
2. Install the packages: `sudo apt install cage chromium wlr-randr python3-websocket`.
3. From a checkout: `pnpm build && PI=<user>@<host> sh scripts/deploy-pi.sh`. It copies the player, these scripts and the units, and enables and starts the services. Put the kiosk URL in `~/signforge/kiosk.env` (the cloud demo's is `kiosk.env.cloud`).
4. On the Pi: `sh ~/signforge/tune.sh`, then `sudo systemctl reboot`. It is idempotent, and `sh tune.sh --undo` reverts it. Each setting has a comment saying what it does and what it measured:
   - CPU governor `performance` instead of `ondemand`, through a udev rule. Frames dropped during a 600 ms fade halved, for about 2 C.
   - `systemd-user-sessions.service` no longer waits for `network.target`. logind holds every login session, the kiosk's included, until that unit has run.
   - cloud-init off after the first boot (`cloud-init=disabled` in `cmdline.txt`).

   Together with the unit ordering, the first spot after boot comes 21 to 22 s after the kernel starts, against 37 to 46 s before.

Left as Raspberry Pi OS ships them, each for a measured reason given in RESULTS.md: `hdmi_enable_4kp60=1` (it also runs the GPU at 550 MHz rather than 500), the 512 MB CMA pool, zram swap, the persistent journal and the apt and man-db timers.

## Measuring

- `isolate.py <secs> <transition> <spots>`: one spot or a few, frames split by phase. The transition is `cut`, `crossfade` or `fade` (500 ms), `fade<ms>`, or `<ms>` for a crossfade that long; anything else is refused with the usage text. A spot asked for that never played (an id the manifest lacks) is listed as NOT PLAYED. Each spot starts cold (HTTP cache and the player origin's storage cleared), and its prepares while measured are printed after its numbers. `SF_PLAYER=<page url>` measures another build served beside the deployed one, for comparing builds on one Pi (the feed-image bench, `packages/cli/bench/feed-images/`, serves its own).
- `bench.sh <label> [runs] [restarts]` drives `bench.py`. It runs the whole stress playlist (alternating cut and fade 600, 290 s each, on a freshly started Chromium) and then kiosk restarts (launch, first prepare, first spot). Results go to `bench-<label>.txt`.
- `bench.py boot`, run by `signforge-bootprobe.service` from early boot, stamps `/proc/uptime`. The wall clock can't be used: the Pi has no real-time clock, so it jumps when NTP first syncs, often after Chromium has started.
- Pitfalls:
  - Copy the player with `rsync --checksum`.
  - Clear the HTTP cache and bypass the service worker before measuring a new build (`bench.py` does both).
  - Stop `signforge-soak` while measuring, because it zeroes the frame counters every minute.
- One user at a time: `sh pi-lock.sh take|status|release`. The N100 test rig (Proxmox `pve`, LXC 105, a virtual 4K60 display) takes the same lock: `SF_PI=signforge-n100 sh pi-lock.sh …`; whoever holds it restarts its kiosk when done.
