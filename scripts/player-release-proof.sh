#!/bin/sh
# The player release workflow's pack and sign, run on this machine with the contract's test-only key (#628), and the
# result checked by every reader a screen has: the contract's WebCrypto check, Python `cryptography` as the supervisor
# loads it, and the supervisor's own `read_manifest` and `extract`. No secret, no Cloudflare: it uploads and registers
# nothing, and prints the SQL the workflow would register with.
#
#   sh scripts/player-release-proof.sh [updater.py]
#
# `updater.py` is the supervisor's (device/pi/updater.py by default). It needs uv, for Python `cryptography`.
set -eu
cd "$(dirname "$0")/.."
updater=${1:-device/pi/updater.py}
[ -f "$updater" ] || { echo "no supervisor updater at $updater" >&2; exit 1; }
vector=packages/contract/test/player-release
out=$(mktemp -d)
release="pnpm exec tsx packages/cli/src/player-release.ts"
version=1

SF_PLAYER_RELEASE=$version pnpm build:player >/dev/null
$release pack dist/player "$out" --version $version
PLAYER_RELEASE_KEY=$(cat $vector/test-only.key.pem) $release sign "$out"
$release verify "$out" $vector/test-only.pub.pem
echo "WebCrypto: the signature verifies"

uv run --quiet --no-project --with cryptography python -I - "$out" $vector/test-only.pub.pem "$updater" <<'EOF'
import base64, hashlib, importlib.util, os, sys
from cryptography.hazmat.primitives.serialization import load_pem_public_key

out, pub, updater_path = sys.argv[1:]
text = open(os.path.join(out, "manifest.json"), "rb").read().decode("utf-8")
signature = open(os.path.join(out, "signature")).read()
load_pem_public_key(open(pub, "rb").read()).verify(base64.b64decode(signature, validate=True), text.encode("utf-8"))
print("Python cryptography: the signature verifies")

spec = importlib.util.spec_from_file_location("updater", updater_path)
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)
m = updater.read_manifest(text)
tarball = os.path.join(out, "release.tar.gz")
data = open(tarball, "rb").read()
assert hashlib.sha256(data).hexdigest() == m["sha256"] and len(data) == m["size"], "the tarball is not the one signed"
dest = os.path.join(out, "players", str(m["version"]))
updater.extract(tarball, dest, {f["path"]: f["sha256"] for f in m["files"]})
print(f"supervisor: read_manifest and extract accept release {m['version']}, {len(m['files'])} files, {m['size']} bytes")
EOF

$release register-sql "$out" | cut -c1-160
echo "release in $out"
