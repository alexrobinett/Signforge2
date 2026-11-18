#!/bin/sh
# Linux-side tuning of a Pi 4 player. Run once on a provisioned Pi (Raspberry Pi OS Lite 64-bit,
# Trixie), as the kiosk user with sudo, after scripts/deploy-pi.sh has installed the units:
#
#   sh tune.sh           apply (idempotent), then reboot
#   sh tune.sh --undo    put every setting back to the Raspberry Pi OS default, then reboot
#
# Each change below was kept because it measured better beyond run-to-run noise on the Pi 400,
# 1080p 60 Hz; the numbers are in spike/pi-perf/RESULTS.md, "Linux tuning". Changes tried and
# rejected are listed there too, with why.
set -eu
undo=false; [ "${1:-}" = "--undo" ] && undo=true

# 1. CPU governor: performance. Raspberry Pi OS sets ondemand from a udev rule in
#    raspberrypi-sys-mods (60-ondemand-governor.rules); a rule of the same name in /etc/udev/rules.d
#    replaces it (udev(7)). The kernel's cpufreq.default_governor= is overridden by that rule, so it
#    is not used. ondemand is at a low clock when a fade or a prepare starts after a quiet stretch of
#    play: performance halved the frames dropped during a 600 ms fade (2.4-3.0% to 1.2-1.3%) for
#    about 2 C more (max 57 C, never throttled).
rule=/etc/udev/rules.d/60-ondemand-governor.rules
if $undo; then
  sudo rm -f "$rule"
else
  printf '%s\n' "# SignForge (device/pi/tune.sh): performance, not ondemand. Replaces raspberrypi-sys-mods' rule of the same name." \
    'KERNEL=="cpu*", SUBSYSTEM=="cpu", ATTR{cpufreq/scaling_governor}="performance"' | sudo tee "$rule" > /dev/null
fi

# 2. Let the kiosk's login session start without waiting for the network. logind orders every
#    non-system user's session after systemd-user-sessions.service, which upstream orders after
#    network.target, and on Trixie NetworkManager takes 7 to 8 s to reach that (it rewrites its
#    netplan files and reloads systemd four times at boot). The player plays its cached manifest
#    offline, so nothing on the screen needs the network first. The kiosk and supervisor units
#    no longer wait for network-online.target either (see their files). Together: first spot
#    after boot at 23.2-24.1 s from kernel start instead of 37 to 46 s.
unit=/etc/systemd/system/systemd-user-sessions.service
if $undo; then
  sudo rm -f "$unit"
else
  sed 's/^After=\(.*\) network\.target\(.*\)$/# SignForge (device\/pi\/tune.sh): not after network.target; the kiosk session waits for this unit.\nAfter=\1\2/' \
    /usr/lib/systemd/system/systemd-user-sessions.service | sudo tee "$unit" > /dev/null
fi

# 3. cloud-init off after the first boot. Raspberry Pi OS runs it on every boot (it applies the
#    Imager settings in /boot/firmware/user-data and network-config once, on the first), and it sat
#    on the path to sysinit.target for about 2.5 s. Off by the documented kernel parameter rather
#    than /etc/cloud/cloud-init.disabled, so it can be undone by editing cmdline.txt on the boot
#    partition from any computer. Wi-Fi is NetworkManager's own profile by then (/etc/netplan/90-NM-*),
#    so it does not depend on cloud-init. First spot after boot 21.3-21.9 s instead of 23.2-24.1 s.
#    Edits to user-data or network-config on the boot partition no longer take effect while it is off.
boot=/boot/firmware
[ -f "$boot/cmdline.txt.pre-tune" ] || sudo cp "$boot/cmdline.txt" "$boot/cmdline.txt.pre-tune"
if $undo; then
  sudo sed -i 's/ cloud-init=disabled//' "$boot/cmdline.txt"
elif ! grep -q 'cloud-init=disabled' "$boot/cmdline.txt"; then
  sudo sed -i '1s/$/ cloud-init=disabled/' "$boot/cmdline.txt"  # cmdline.txt is one line
fi

sudo systemctl daemon-reload
echo "tuned$($undo && echo ' (undone)'); reboot to apply: sudo systemctl reboot"
