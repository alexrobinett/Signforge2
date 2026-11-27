# The N100 test rig

A second test platform beside the Pi (#462, owner decision 2026-11-25). It is an Intel N100 running Proxmox, with the player in an LXC container that drives the N100's own display engine. **The Pi still sets the budgets.** Use the N100 for:
- high-end checks, such as 4K60;
- checks that run while the Pi is busy, during a soak for example;
- checking how a spot looks.

A number from the N100 is not evidence that something fits on a Pi. Its numbers next to the Pi's are in [`spike/pi-perf/RESULTS.md`](../../spike/pi-perf/RESULTS.md) ("The template set on the N100").

## What it is

| | |
| --- | --- |
| Host | Proxmox VE 9 on `pve` (`ssh pve`, root). It also runs Home Assistant, Plex, OMV and agent-devbox: leave them alone. |
| Player | LXC 105 `signforge-n100`, 192.168.1.75 (`ssh signforge-n100`, user `signforge`, passwordless sudo). Unprivileged, 4 cores, 2 GB, Debian 13, Chromium 156. `/dev/dri/card0` and `renderD128` are passed in, so it scans out on the iGPU itself: no VM and no passthrough. `onboot: 0`, so if it is down, run `pct start 105` on `pve`. |
| Display | No panel. `signforge-edid.service` on `pve` forces HDMI-A-1 on at boot with the EDID in `SF_EDID`: `/root/sf-2160p60.bin` (the default, which also offers 1920x1080 at 60 Hz) or `/root/sf-1080p60.bin`. `systemctl disable --now signforge-edid` turns it off. The mode is real DRM scan-out, so Chromium gets real vsync: 60.00 fps at 4K and at 1080p (`cadence.py`). |
| Kiosk | `signforge-kiosk.service`: cage and `kiosk.sh`, then Chromium on `KIOSK_URL` from `~/signforge/kiosk.env`, with CDP on 127.0.0.1:9222. The drop-in `/etc/systemd/system/signforge-kiosk.service.d/drm.conf` loads `~/signforge/kiosk-drm.env` (`WLR_BACKENDS=drm`, `LIBSEAT_BACKEND=noop`, `KIOSK_RESOLUTION=3840x2160@60Hz`) for real scan-out. Remove the drop-in and the kiosk runs headless. |
| Files | `signforge-player-web.service` (`player_web.py`, with no-store) serves `~/signforge/www` on 127.0.0.1:8090, as on the Pi. `www` is a link to `players/0`, the build deployed here, with `content/` linked to `~/signforge/content` (#628). |
| Supervisor | `signforge-supervisor.service` runs the Pi's `supervisor.py` with this rig's user, its Wayland runtime directory and `SF_MODE=3840x2160@60`, so the mode watch holds 4K60, not the Pi's 1080p. polkit (`signforge-supervisor.rules`) lets it restart the kiosk and nothing else. Player updates are off until a release key is deployed. |

No credential: the rig plays local content only. The supervisor powers the output as the content's display hours say, as a screen does: outside them, or on a closed day such as the demo's 2026-11-26, the player asks for the display off and the output goes dark (`wlr-randr --off`). A page whose content has no hours asks for it on again.

## Using it

1. Take the lock. The rig shares the Pi's lock script: `SF_PI=signforge-n100 sh device/pi/pi-lock.sh take "<you>" "<what for>" [minutes]`. Check it with `… status`, and run `… release "<you>"` when done.
2. Deploy: `pnpm build && sh scripts/deploy-n100.sh` copies the player, the content (`dist/content`), the supervisor and the measuring tools, installs the rig's supervisor and player-web units (`device/n100/`), and restarts the kiosk. The kiosk unit and `kiosk.sh` stay the rig's own. Running it again changes nothing. Add `--content-only` to copy the content alone, once the rig has the new layout.
3. Measure inside the container, as on the Pi: `isolate.py`, `bench.py` and `trace.py` from `device/pi`, plus `cadence.py` (the page's `requestAnimationFrame` cadence, `python3 cadence.py <seconds>`). Set `SF_PLAYER` to measure another build served beside the deployed one, under `~/signforge/players/0/<dir>/` (reached at `/<dir>/`); the deploy keeps directories named `m*`. To measure the demo outside its display hours, build a copy without them into such a directory.
4. Change the mode for a run without touching the EDID. Inside the container, run `XDG_RUNTIME_DIR=/tmp/signforge-runtime WAYLAND_DISPLAY=wayland-0 wlr-randr --output HDMI-A-1 --mode 1920x1080@60.000000Hz` (add `--transform 90` for portrait). Restarting the kiosk sets it back to 4K60.
5. If a run stops getting spots ready partway through, so that every load reports `not ready within 2000 ms` even after a fresh page load, the rig is at fault, not the build. It happened twice in the first batch (#462, RESULTS.md). Change the mode or restart the kiosk, then run it again.
6. Afterwards, restart the kiosk (`sudo systemctl restart signforge-kiosk`) so it runs 4K60 landscape on the deployed player, then release the lock.
