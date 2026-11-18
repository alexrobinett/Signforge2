#!/bin/sh
# The standard tuning measurement on the Pi (spike/pi-perf/RESULTS.md, "Linux tuning"):
#
#   sh bench.sh <label> [playlist runs, default 6] [kiosk restarts, default 5]
#
# Needs the stress content at ~/signforge/www/stress (`sf build examples/stress`, then rsync with
# --checksum) and ~/signforge/kiosk.env.stress: kiosk.env.cloud with
# KIOSK_URL=http://127.0.0.1:8090/index.html?debug=1&poll=600&content=./stress
# Writes bench-<label>.txt. Run it with nohup; it leaves the kiosk on kiosk.env.cloud.
cd ~/signforge
L=$1; R=${2:-6}; N=${3:-5}
# The soak logger zeroes the frame counters every minute.
sudo systemctl stop signforge-soak
# Every configuration starts on a freshly started Chromium: prepares get slower the longer it runs
# (median 247-265 ms after two hours against 230-240 ms fresh, same settings).
sudo systemctl restart signforge-kiosk; sleep 40
{ echo "START $L $(date -Is) gov=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor) $(vcgencmd measure_temp)"
  [ "$R" -gt 0 ] && python3 -u bench.py playlist "$L" stress 290 "$R"
  if [ "$N" -gt 0 ]; then cp kiosk.env.stress kiosk.env; python3 -u bench.py restart "$L" "$N"; fi
  cp kiosk.env.cloud kiosk.env; sudo systemctl restart signforge-kiosk
  echo "END $L $(date -Is) $(vcgencmd measure_temp) $(vcgencmd get_throttled)"; } > "bench-$L.txt" 2>&1
sudo systemctl start signforge-soak
