#!/bin/sh
# Claude Code Stop hook: an agent is not done while `pnpm lint` or `pnpm typecheck` fails.
# Exit 2 sends the failure back to the agent to fix. Turbo caches typecheck per package, so a run
# with nothing changed takes a few seconds. After three blocks in a row in one session it lets the
# agent stop, so a failure it cannot fix (another branch's, a broken install) reaches a person.
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
session=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).session_id||"none")}catch{console.log("none")}})')
count_file="${TMPDIR:-/tmp}/signforge-stop-checks-$session"

if out=$(pnpm --silent lint 2>&1 && pnpm --silent typecheck --output-logs=errors-only 2>&1); then
  rm -f "$count_file"
  exit 0
fi

count=$(($(cat "$count_file" 2>/dev/null || echo 0) + 1))
if [ "$count" -gt 3 ]; then
  rm -f "$count_file"
  echo "pnpm lint or pnpm typecheck still fails after three tries; stopping anyway. Say so in the report." >&2
  exit 0
fi
echo "$count" > "$count_file"
printf '%s\n\n%s\n' "pnpm lint or pnpm typecheck fails. Fix it before you finish (try $count of 3):" "$(printf '%s\n' "$out" | tail -60)" >&2
exit 2
