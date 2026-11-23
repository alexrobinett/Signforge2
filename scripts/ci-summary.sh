#!/bin/sh
# CI's timing summary (docs/ci.md), as Markdown for $GITHUB_STEP_SUMMARY: this job's steps so far
# with their times, then every Turbo task that ran, slowest first, and whether the cache had it.
# Needs GH_TOKEN with actions: read, and the run summary `turbo run --summarize` writes.
set -eu
now=$(date -u +%s)
jobs=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/attempts/$GITHUB_RUN_ATTEMPT/jobs")
started=$(printf '%s' "$jobs" | jq -r --arg job "$GITHUB_JOB" '.jobs[] | select(.name == $job) | .started_at | fromdateiso8601')

# TURBO_SCM_BASE: the plan's base, empty when the run covers every package. NIGHTLY_SKIPPED: the plan
# ran no task, as on a nightly run on the commit the last green nightly passed on.
if [ "${NIGHTLY_SKIPPED:-}" = true ]; then
  echo "## CI: skipped, same commit as the last green nightly"
elif [ -n "${TURBO_SCM_BASE:-}" ]; then
  echo "## CI: affected packages only, against ${TURBO_SCM_BASE}"
else
  echo "## CI: every package"
fi
echo
echo "$((now - started)) s from job start to this summary (post-job steps not counted)."
echo
echo "| Step | Time | Result |"
echo "| --- | ---: | --- |"
printf '%s' "$jobs" | jq -r --arg job "$GITHUB_JOB" '
  .jobs[] | select(.name == $job) | .steps[]
  | select(.completed_at != null and .conclusion != "skipped")
  | "| \(.name) | \((.completed_at | fromdateiso8601) - (.started_at | fromdateiso8601)) s | \(.conclusion) |"'

run=$(ls -t .turbo/runs/*.json 2>/dev/null | head -n 1)
[ -n "$run" ] || exit 0
echo
jq -r '
  [.tasks[] | select(.command != "<NONEXISTENT>" and .execution != null)] as $t
  | "Turbo ran \($t | length) tasks, \([$t[] | select(.cache.status == "HIT")] | length) from the cache.",
    "",
    "| Task | Time | Cache |",
    "| --- | ---: | --- |",
    ($t | sort_by(.execution.startTime - .execution.endTime)[]
      | "| \(.taskId) | \((.execution.endTime - .execution.startTime) / 100 | round / 10) s | \(.cache.status) |")' "$run"
