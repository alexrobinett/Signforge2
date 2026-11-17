#!/bin/bash
# Usage: flags.sh <label> "<chromium flags>"  -- restarts the kiosk with extra flags and runs the comparison set.
export XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0
label=$1; flags=$2
echo "CHROMIUM_EXTRA_FLAGS=$flags" > ~/spike/kiosk.env
sudo systemctl restart signforge-kiosk
for i in $(seq 1 40); do curl -sf localhost:9222/json/version >/dev/null && break; read -t 1 < /dev/zero; done
read -t 4 < /dev/zero
echo "== $label: $flags"
if ! curl -sf localhost:9222/json/version >/dev/null; then echo "kiosk did not start"; sudo journalctl -u signforge-kiosk -n 5 --no-pager | cut -c1-200; exit 0; fi
python3 - <<'PY'
import json, urllib.request, websocket
v = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json/version"))
ws = websocket.create_connection(v["webSocketDebuggerUrl"], timeout=20, suppress_origin=True)
ws.send(json.dumps({"id": 1, "method": "SystemInfo.getInfo"}))
while True:
    m = json.loads(ws.recv())
    if m.get("id") == 1: break
g = m["result"]["gpu"]; aux = g.get("auxAttributes", {})
print("GL:", aux.get("glRenderer"), "|", aux.get("glVersion"))
f = g.get("featureStatus", {})
print("features:", {k: f.get(k) for k in ("gpu_compositing", "rasterization", "vulkan", "video_decode", "direct_rendering_display_compositor")})
PY
wlr-randr --output HDMI-A-1 --mode 3840x2160@30; read -t 3 < /dev/zero
python3 ~/spike/run.py "flags-$label-4k30" compositor "variant=rich,willchange" | grep -v saved
wlr-randr --output HDMI-A-1 --mode 1920x1080@60; read -t 3 < /dev/zero
python3 ~/spike/run.py "flags-$label-1080p60" "variant=rich,willchange,backdrop" "variant=rich,willchange&particles=150" | grep -v saved
