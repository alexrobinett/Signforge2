#!/bin/sh
# "The contract leads" (AGENTS.md): a commit that changes packages/contract changes nothing else,
# apart from the lockfile and generated files. Checks every non-merge commit in <base>..HEAD.
# Usage: sh scripts/check-contract-commits.sh <base>   (CI passes the PR's base, or the push's before)
set -eu
base=${1:-origin/master}
# Commits from before this check that it would refuse. Never add to this list.
# 0828ce9 (M3-31): set allowImportingTsExtensions in tsconfig.base.json for the contract's .ts imports.
known="0828ce959e058578e37896155a1657670a044c6a"
status=0
for c in $(git rev-list --no-merges "$base..HEAD"); do
  case " $known " in *" $c "*) continue ;; esac
  files=$(git diff-tree --no-commit-id --name-only -r "$c")
  printf '%s\n' "$files" | grep -q '^packages/contract/' || continue
  others=$(printf '%s\n' "$files" | grep -v -e '^packages/contract/' -e '^pnpm-lock\.yaml$' -e '\.gen\.ts$' -e 'worker-configuration\.d\.ts$' || true)
  if [ -n "$others" ]; then
    echo "$(git log -1 --format='%h %s' "$c")"
    echo "  changes packages/contract and also:"
    printf '%s\n' "$others" | sed 's/^/    /'
    status=1
  fi
done
[ "$status" -eq 0 ] || echo "Put the contract change in a commit of its own, before the code that uses it (AGENTS.md)."
exit "$status"
