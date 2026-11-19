#!/bin/sh
# The API's tests build every template, and the player's browser tests and the runtime check's tests
# play every template, so each lists every templates/* package as a devDependency: else a change to
# that template skips them (docs/ci.md).
# Usage: sh scripts/check-template-deps.sh
set -eu
node -e '
const { readdirSync, readFileSync } = require("node:fs");
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const templates = readdirSync("templates").map((d) => read(`templates/${d}/package.json`).name);
let ok = true;
for (const pkg of ["apps/api", "packages/player", "apps/template-check"]) {
  const deps = read(`${pkg}/package.json`).devDependencies ?? {};
  const missing = templates.filter((t) => !(t in deps));
  if (missing.length) {
    ok = false;
    console.log(`${pkg}/package.json is missing devDependencies: ${missing.join(", ")}`);
  }
}
if (!ok) console.log("Add each as \"workspace:*\" (docs/ci.md).");
process.exit(ok ? 0 : 1);
'
