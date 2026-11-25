# Agent eval

A fixed set of agent tasks, run against SignForge's agent tools, so the tool consolidation (#345) can show it keeps agents succeeding while it shrinks what they read. Each consolidation PR runs it before and after. The bar: success no lower than the baseline in any arm, and tool calls per task at most 10% more.

## What it runs

- **Tasks** (`tasks.ts`): 23 tasks covering reads across the types, the common writes (spot, playlist, schedule), publishing, confirmation cards from the drawer, refusals and multi-step work. Each task names the role it runs as, the arms it runs in and a script: the calls a model that knows the tools makes.
- **The org** (`harness.ts`, `seed`): every run gets a new org, built the same way through the scoped repositories and the CMS's own tool route. It has four screens in two groups, three spots in three playlists (one is the default), a schedule entry, three templates, a publish, and one unpublished change.
- **Two arms:**
  - **/mcp**: the MCP SDK's own client (`@modelcontextprotocol/client`) with an OAuth token the member consented to, and a plain loop over Anthropic's Messages API. The system prompt holds the server's instructions, as a client such as Claude Code does.
  - **The drawer**: `POST /api/agent/chat` as the member. The org's model is the one under test. When a task says so, the confirmation card the turn stops at is pressed.
- **Checks** read the org after the run, or the tool results the model was sent. They never read the model's own words. The drawer only drafts, so a drawer write is checked against the drafts in its answer card.

## What it records

For each run: success (and why not), tool calls, refused calls, model calls, input and output tokens, catalogue size (tools, bytes, o200k tokens) and how the run ended badly, if it did. All of it is measured from the model's side, so both arms count the same way. A tool call is one the model asked for. A card's pause counts once, and its press doesn't count again.

## Running it

In CI, `agent-eval.test.ts` runs every task with a scripted model, inside the normal API test run. Each script must pass its check, and a model that does nothing must fail it. This proves every seed, check and arm without a model.

A live run is done by hand and never in CI. It costs money:

```sh
cd apps/api
ANTHROPIC_API_KEY=… pnpm eval:agents                  # claude-haiku-5-5, 3 runs a task
EVAL_MODEL=claude-sonnet-5-5 ANTHROPIC_API_KEY=… pnpm eval:agents
EVAL_TASKS=write-schedule,card-publish EVAL_RUNS=1 ANTHROPIC_API_KEY=… pnpm eval:agents
EVAL_MODEL=scripted pnpm eval:agents                  # the whole pipeline, offline
```

- The key goes only into the test worker's bindings. The drawer seals it as the org's key, as Settings does.
- Results are written to `test/eval/out/<model>-<commit>.json` and `.md` (gitignored), and the table is printed. Post the table on the PR.
- A full run is 38 task-arm pairs × 3 runs, about 7M input tokens. That is under $1 on Haiku 5.5 and about $15 on Sonnet 5.5, at list prices without caching.
- The default model is `claude-haiku-5-5`. It is the cheapest model, and the demo model is a fast model of its class. Run Sonnet 5.5 too when a change touches how the drawer's capable model chooses tools.

## The catalogue budget

`catalogue.test.ts` pins the catalogue's size per role for each arm. It measures what /mcp's `tools/list` returns and what the drawer sends its model, as `{ tools }` JSON in o200k tokens, the tool audit's method. A PR that grows the catalogue fails there. A PR that shrinks it updates the pin in the same diff.

| Surface | Owner | Editor | Viewer |
|---|---|---|---|
| /mcp | 83 tools · 27,214 tokens | 79 · 25,405 | 36 · 7,264 |
| Drawer | 52 · 13,105 | 51 · 12,995 | 51 · 12,995 |

/mcp matches the audit byte for byte. Its token count is 22 higher because `tools/list` orders each schema's keys differently. The drawer counts about 800 tokens below the audit's 13,908. The audit built the tools from `chat.ts`'s lists, but TanStack AI's Anthropic adapter drops `$schema` from every input schema before sending, and this counts what is sent.

## Adding a task

Add the task to `tasks.ts` with a script for each arm it runs in, and a check that reads the org or the tool results. Write half of any new tasks only after a PR's design is frozen, so the eval has tasks the design wasn't shaped around (#345, plan §8).
