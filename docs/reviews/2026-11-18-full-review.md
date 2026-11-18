# Full review, 2026-11-18 (master @ 5c08bb8)

Two fresh reviews of the whole repository, same brief: Opus and GPT Astra, neither with any history in the project. Their reports are kept beside this one (`2026-11-18-opus.md`, `2026-11-18-astra.md`) with file:line evidence; this is the combined picture.

## Verdicts

- **Opus:** no way across orgs; nearly all of the 17 November findings fixed in code and covered by browser tests. What is left sits in the gaps between finished parts, not in the security boundaries.
- **Astra:** the backend boundaries are stronger than before (membership checked per request, grants intersected with roles, writes and audit atomic). Two high findings in the device path; the remaining reliability problems appear when two events coincide: a clock reset while offline, a retry after a re-image, a publish during another edit.

## High (Astra; checked)

| # | Finding | Fix |
| --- | --- | --- |
| H1 | **The player sends its device credential to whatever API its URL names.** `?content=` on the player URL picks the API, and the bearer goes to any cross-origin content base. A paired browser opened with another `content=` hands the long-lived credential to that host. The supervisor's origin check cannot see it. Matters most for browser test screens (M3-41). | Provision the device API base outside the URL (supervisor or build), refuse to attach the credential to any other origin. |
| H2 | **Revocation can leave an open socket alive.** The revoke commits, then a best-effort call closes the socket; if that call fails, the socket keeps receiving commands, and retrying the revoke exits early. | Make socket closure a durable, retried consequence of revocation; test a failed first delivery. |

## Where both agree

| # | Finding | Opus | Astra |
| --- | --- | --- | --- |
| B1 | **A screen's version moves when it reports a manifest**, so an open screen editor gets a spurious "changed since you opened it" after every publish. Astra adds: the dashboard prefers the socket's report over a newer HTTP one, so a screen can show "updating" after it has updated. | F1 | R18 |
| B2 | **Brand fonts and logos are not pinned** while a spot prepares, so cleanup can delete them when the kit changes mid-prepare. | F5 | R08 |
| B3 | **The README's Pi numbers predate the wrapper frame and brand fonts.** Current: first prepare after a kiosk restart 547–998 ms (budget 500), worst frames 83–417 ms (budget 50), news 1.4–1.6 s under video with kit fonts. | F3 | R17 |
| B4 | **The generated isolation test only swaps ids that are in each tool's example**, so optional or branch-only ids are never tried. | F8 | R15 |
| B5 | **Publishing in production is still `/admin` + `sf push`** with one deploy-wide token; the draft publish path is only called from tests. | F2 | (status A4) |

## Medium, one reviewer

- **Master typecheck is red** (Astra R13): #15's new e2e test and #7's `signInAs` crossed. Fixed in #23.
- **Offline cold boot with closed hours powers the panel off** on an untrusted clock, and a saved sleep override can outlive its expiry (Astra R04).
- **Play counts can double after a re-image** when retries from the old and new epochs interleave (Astra R05).
- **A failed content fetch turns an acknowledged heartbeat into a failed sync**, so affected screens write every 30 s: about 86M writes a month at 1,000 screens, over the plan's 50M (Astra R06).
- **Last known good can be a browser error page** (a URL spot's `load` fires on failed navigation) or a video that never played (Astra R07).
- **Concurrent publishes can rewind a newer draft or published copy**: promotion is not guarded by the draft's revision (Astra R09).
- **CMS retries can create twice**: the command menu makes a new idempotency key per submit, and image upload never sends its key (Astra R10).
- **The Screens page shows stale status** while left open, and a naive poll would scan every screen and fetch manifests (Astra R11).
- **The display-hours editor drops all but the first window of a dated exception** on edit (Astra R12).
- **Template paging breaks on non-Latin names** (`btoa` on the cursor) (Astra R14).
- **Nothing restarts a hung browser**; the architecture says the supervisor does (Opus F4).
- **Private blob responses are cached for a year** in the browser, so a cache hit skips the membership check after sign-out or an org switch on a shared browser (Astra R03).

## Low

Device-supplied strings without size limits (F7); a screen can only fetch files of its desired and previous manifests, not an older last-good (F6); membership changes are outside the audit log (F9); browser tests that assert "nothing happened" by sleeping (F10); new templates must be added to two dependency lists by hand (F11, check it in CI); no automated accessibility pass (F12); no retention for idempotency keys and audit rows (F13); docs now wrong (F14); command-form errors not announced (R16).

## Milestone 4 and scale (Opus A1, Astra next steps)

No per-agent rate limits or write budgets; publish compiles every screen in one request; the runtime template check that agent-written templates depend on is not built.

## Recommended order

1. **Device trust (H1, H2).** Before any more screens are paired, and before the browser test screen (#19) merges.
2. **Green master and the cheap correctness fixes:** #23 (typecheck), B1, B2, R14, R12, R10.
3. **Sync and offline correctness:** R04, R05, R06, R07, with regression tests for each.
4. **The real publish path** (M3-16 to M3-18, in progress) with R09's guard, then delete `/admin`'s publish routes (B5).
5. **Fleet status** on Query polling over a light status projection with SQL paging (R11), and the supervisor liveness check (F4).
6. **Pi budgets and docs:** README numbers (B3), first prepare after restart, M3-45; the docs drift (F14).
7. **Before Milestone 4:** agent rate limits, the runtime template check, retention (F13), membership audit (F9).
