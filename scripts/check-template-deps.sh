#!/bin/sh
# The cli's and the API's tests build every template, and the runtime check's tests play every
# template, so each lists every templates/* package as a devDependency: else a change to that
# template skips them (docs/ci.md). Each template's own browser tests are its package's `test`
# task, on the shared harness, so a change to one template reruns only its own.
# Usage: sh scripts/check-template-deps.sh
set -eu
node -e '
const { readdirSync, readFileSync } = require("node:fs");
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const templates = readdirSync("templates").map((d) => ({ dir: `templates/${d}`, pkg: read(`templates/${d}/package.json`) }));
let ok = true;
for (const pkg of ["apps/api", "packages/cli", "apps/template-check"]) {
  const deps = read(`${pkg}/package.json`).devDependencies ?? {};
  const missing = templates.filter((t) => !(t.pkg.name in deps)).map((t) => t.pkg.name);
  if (missing.length) {
    ok = false;
    console.log(`${pkg}/package.json is missing devDependencies: ${missing.join(", ")}. Add each as "workspace:*".`);
  }
}
for (const { dir, pkg } of templates)
  if (!pkg.scripts?.test || !pkg.devDependencies?.["@signforge/template-test"]) {
    ok = false;
    console.log(`${dir} has no browser tests of its own: give it a "test" script and test/browser.test.ts on @signforge/template-test.`);
  }
if (!ok) console.log("See docs/ci.md, What affected means.");
process.exit(ok ? 0 : 1);
'
