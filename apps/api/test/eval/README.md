# Agent eval

A fixed set of agent tasks, run against SignForge's agent tools, so the tool consolidation (#345) can show it keeps agents succeeding while it shrinks what they read. Each consolidation PR runs it before and after. The bar: success no lower than the baseline in any arm, and tool calls per task at most 10% more.

## What it runs

- **Tasks** (`tasks.ts`): 25 tasks covering reads across the types, the common writes (spot, playlist, schedule), publishing, confirmation cards from the drawer, refusals and multi-step work. Each task names the role it runs as, the arms it runs in and a script: the calls a model that knows the tools makes.
- **The org** (`harness.ts`, `seed`): every run gets a new org, built the same way through the scoped repositories and the CMS's own tool route. It has four screens in two groups, three spots in three playlists (one is the default), a schedule entry, three templates, a publish, and one unpublished change.
- **Two arms:**
  - **/mcp**: the MCP SDK's own client (`@modelcontextprotocol/client`) with an OAuth token the member consented to, and a plain loop over Anthropic's Messages API. The system prompt holds the server's instructions, as a client such as Claude Code does.
  - **The drawer**: `POST /api/agent/chat` as the member. The org's model is the one under test. When a task says so, the confirmation card the turn stops at is pressed.
- **Checks** read the org after the run, or the tool results the model was sent. They never read the model's own words. A read check parses every successful result and merges what it shows of each record, across responses, then requires the fields the question asks for on the right records. So `get_screen` on each screen passes, and a list of states without names fails. A schedule check judges the whole schedule. It takes every entry, or every draft, for that playlist and group in the asked window. Each must have no end date and must not start after the run's day. Together their days must be exactly Monday to Friday, so a split Mon–Wed plus Thu–Fri passes and an extra weekend entry fails. The drawer only drafts, so a drawer write is checked against the drafts in its answer card.
- **Variants**: some tasks carry other scripts that CI runs: valid alternate paths that must pass, and incomplete ones that must fail.

## What it records

Every attempt gives a record, including one where the model failed or the harness threw. Each record has:

- **success**: the check passed and the run completed with no execution error. A read whose tools answered, followed by a model that failed, is a check pass but not a success.
- **checked**: whether the check passed.
- **why**: why the check failed.
- **errors**: the model's failures, the drawer's run errors, /mcp's protocol errors or its loop running out of turns, and the harness's own. The model's failures are `model_503` and other statuses, `model_unreachable`, `model_unreadable`, a reply cut off (`model_max_tokens`) or refused (`model_refusal`), and `model_timeout` once a live /mcp run's model calls pass 300 s.
- tool calls, refused calls, model calls, input and output tokens, and catalogue size.

All of it is measured from the model's side, so both arms count the same way:

- A tool call is one the model asked for. A card's pause counts once, and its press doesn't count again.
- A refused call is a tool result marked as an error, or a card refused to the member.
- Tokens are the provider's final usage for each call, with cache reads and writes included. A stream's `message_delta` counts when it has the input, and `message_start` otherwise.

Scripted runs freeze the tools' clock and the drawer's, and give the model call no deadline, so nothing depends on when or how fast they run. Live runs keep the real clock and the drawer's own deadline.

## Running it

In CI, `agent-eval.test.ts` runs every task with a scripted model, inside the normal API test run. Each script must pass its check with the refusals it expects, each variant must pass or fail as it says, and a model that does nothing must fail. Models that answer 503 or can't be reached must give recorded failures. This proves every seed, check and arm without a model.

A live run is done by hand and never in CI. It costs money:

```sh
cd apps/api
ANTHROPIC_API_KEY=… pnpm eval:agents                  # claude-haiku-5-5, 3 runs a task
EVAL_MODEL=claude-sonnet-5-5 ANTHROPIC_API_KEY=… pnpm eval:agents
EVAL_TASKS=write-schedule,card-publish EVAL_RUNS=1 ANTHROPIC_API_KEY=… pnpm eval:agents
EVAL_MODEL=scripted pnpm eval:agents                  # the whole pipeline, offline
```

- The key goes only into the test worker's bindings. The drawer seals it as the org's key, as Settings does.
- Results are written to `test/eval/out/<model>-<commit>.json` and `.md` (gitignored), and the table is printed. Success and checks count every attempt. Tool calls, refusals and tokens are means over the completed runs, those with no errors, with the count of completed runs beside them. Post the table on the PR.
- A full run is 41 task-arm pairs × 3 runs, about 7M input tokens. That is under $1 on Haiku 5.5 and about $15 on Sonnet 5.5, at list prices without caching.
- The default model is `claude-haiku-5-5`. It is the cheapest model, and the demo model is a fast model of its class. Run Sonnet 5.5 too when a change touches how the drawer's capable model chooses tools.

## The catalogue budget

`catalogue.test.ts` pins the catalogue's size per role. The budget is the `tools` array in the model's first request in each arm, counted as `{ tools }` JSON in o200k tokens, the tool audit's method. /mcp's `tools/list`, what a client receives before it builds the model's tools, is pinned apart as discovery. A PR that grows either fails there. A PR that shrinks one updates the pin in the same diff.

| Model-facing | Owner | Editor | Viewer |
|---|---|---|---|
| /mcp request | 45 tools · 16,886 tokens | 42 · 15,450 | 6 · 1,726 |
| Drawer request | 22 · 7,992 | 20 · 7,690 | 11 · 4,334 |
| /mcp `tools/list` (discovery) | 45 · 18,079 | 42 · 16,562 | 6 · 1,882 |

The /mcp request carries each tool's name, description and input schema, and leaves out the title and annotations. The drawer's request carries TanStack AI's own fields (`type`, `cache_control`). Since #345 PR 1, no input schema carries `$schema`, the id pattern or the safe-integer bounds, `ifVersion` and `idempotencyKey` have short texts, and the drawer offers only the cards a role can press. Since PR 2, agents read every type with `read` and learn a type with `describe`; each type's own read stays in the registry, unlisted. Since PR 3, `update_screen`, `screen_command` and `save_group` replace ten screen and group writes, and the drawer drafts a screen's name alone. Before PR 1 the pins were /mcp 25,388 / 23,667 / 6,472, drawer 13,548 / 13,429 / 13,429, and discovery 27,214 / 25,405 / 7,264; after PR 1, /mcp 21,312 / 19,783 / 5,532, drawer 12,122 / 11,715 / 8,221, and discovery 23,519 / 21,883 / 6,489; after PR 2, /mcp 17,444 / 16,008 / 1,726, drawer 8,211 / 7,909 / 4,384, and discovery 18,824 / 17,307 / 1,882.

## Adding a task

Add the task to `tasks.ts` with a script for each arm it runs in, and a check that reads the org or the tool results. Write half of any new tasks only after a PR's design is frozen, so the eval has tasks the design wasn't shaped around (#345, plan §8).
