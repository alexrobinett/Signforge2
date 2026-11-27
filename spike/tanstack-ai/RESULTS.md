# TanStack AI spike: results (#346)

**Recommendation for #349: go, with four conditions.** Fix these in #349 itself:

1. Export a streaming guarded fetch from `apps/api/src/data/fetch.ts`, and give it to every model call as `wrapFetch`.
2. Rebuild the outgoing headers from an allow-list in that wrapper.
3. Settle the model-id limit below. Without an answer, an org on a dated or new model id stops working.
4. Pin every `@tanstack/ai*` package exactly, and move them together.

The rest of the provider rewrite fits the existing `Model` seam. The spike found two problems for #350 and #351, but neither blocks #349:

- Earlier cards are lost after an approval pause.
- A recorded approval can be replayed.

Both are described below.

Everything here was run in workerd with the API Worker's compatibility date and flags, against a scripted model (`src/stub-model.ts`). No key was given, so no real provider was called. Anything that only a live provider can show is marked as not proven.

## Versions

| Package | Version | Pulled in by |
| --- | --- | --- |
| `@tanstack/ai` | 1.8.0 | |
| `@tanstack/ai-anthropic` | 1.2.1 | |
| `@tanstack/ai-openai` (`/compatible`) | 1.2.0 | |
| `@tanstack/ai-client` | 1.2.1 | |
| `zustand` | 5.1.0 | |
| `react`, `react-dom` | 19.3.1 | |
| `@anthropic-ai/sdk` | 0.135.0 | `@tanstack/ai-anthropic` (apps/api has 1.6.0) |
| `openai` | 7.62.0 | `@tanstack/openai-base` |
| `@tanstack/ai-utils`, `@tanstack/openai-base`, `@tanstack/ai-event-client` | 1.1.0 | |
| `@tanstack/store` | 0.11.2 | `@tanstack/ai-client` |
| `@ag-ui/core` | 1.0.0 | `@tanstack/ai` |

`@tanstack/ai` went from 1.7.0 to 1.8.0 in one day (2026-11-19 to 11-20), and `ai-anthropic` and `ai-client` both peer on `@tanstack/ai ^1.7.0`. They must move together, in one group.

## What was built

- **`src/worker.ts`:** `POST /api/chat` runs one drawer turn on `chat({ tools, outputSchema: answerCard, stream: true })` and answers with `toServerSentEventsResponse`.
  - The body is AG-UI's `RunAgentInput`, parsed with `chatParamsFromRequest`.
  - `?provider=compatible` switches to `openaiCompatible`.
- **`POST /api/fill`:** `chat({ outputSchema, stream: false })` with a flyer's text and a fixture PNG.
- **`src/tools.ts`:** the registry tools `list_screens` and `list_playlists`.
  - Each is wrapped as it stands, with its registry name, description and zod input. It runs only through `dispatch()`, as a viewer via cms-agent.
  - The model reads the result fenced as `<data>`. The card gets the object as `resultMetadata`, which the model never sees.
- **`restart_screens`:** a spike-only dummy tool with `needsApproval: true`. It only counts its runs.
- **`src/guarded-fetch.ts`:** the `wrapFetch` (see below).
- **`src/page/`:** a page that drives `ChatClient` from a Zustand store. It renders text parts, tool-call parts, the approval buttons, and the card in the `AnswerCard` shape.
- **`test/turn.test.ts`:** 14 workerd tests.
- **`scripts/size.mjs`:** the bundle sizes.

To run it:

- `pnpm --filter @signforge/spike-tanstack-ai test`
- or `pnpm --filter @signforge/spike-tanstack-ai dev`, and open the page. The org is empty there: the tests seed it with packages/db's test seed, which the Worker never imports.

The `MODEL_STUB=on` setting in `wrangler.jsonc` keeps it off the network.

## The questions in "Done when"

### It runs under `wrangler` on the API Worker runtime: yes

It runs under the same `compatibility_date` (2026-11-01) and `nodejs_compat` as `apps/api`. It was checked three ways:

- The workerd tests pass.
- `wrangler dev` answers `curl` with the full SSE turn:
  - `RUN_STARTED`;
  - two `TOOL_CALL_*` and two `TOOL_CALL_RESULT`;
  - `structured-output.start`;
  - three `TEXT_MESSAGE_CONTENT`;
  - `structured-output.complete`;
  - `RUN_FINISHED`.
- The page, driven in headless Chromium against `wrangler dev`, rendered both tool calls and the card. It then paused on `restart_screens`, showed Approve, and after Approve showed the call as complete. There were no page errors.

CPU per turn was not measured; #349's "Done when" asks for it.

### `wrapFetch` can enforce the fetch guards, and the key stays out of `process.env` and the client: yes, with work in #349

`chat({ wrapFetch })` reaches every model call, for Anthropic and `openaiCompatible` alike. The spike's wrapper ignores the adapter's own fetch and sends each request itself, through the same checks as `guardedKeyedJson`:

- `feedUrlProblem` on the URL;
- every resolved address public;
- the provider's own origin only;
- no redirect followed, since the request carries the key;
- one `AbortSignal.timeout` per call.

Tests cover the guards: another origin, a private address, a redirect, a missed deadline, and `http:` are all refused.

**Not as hoped:** `apps/api` has no guarded fetch that returns a streaming `Response`. `guardedKeyedJson` reads the whole JSON, and `checkedUrl`, `isPrivate` and `dohResolver` are private to `apps/api`, which a spike may not import from (`turbo boundaries`). The spike carries a marked copy of the address checks and a small DNS-over-HTTPS resolver of its own; the stub model never uses that resolver. #349 must export one primitive (say, `guardedStream`) from `data/fetch.ts` and use it: condition 1 above.

**The key:** it is opened per call (from a Worker secret here; from the vault in `apps/api`) and passed to the adapter explicitly. The guarded fetch then sets it on the request again. The adapters still read `process.env`, which `nodejs_compat` fills with the Worker's vars and secrets:

- **`ai-anthropic`** merges in `ANTHROPIC_CUSTOM_HEADERS` on every request. It reads `ANTHROPIC_BASE_URL` when no `baseURL` is given. It reads `ANTHROPIC_LOG` and `ANTHROPIC_OPEN_TELEMETRY` to decide whether to load the real `@anthropic-ai/sdk`, which reads more of `process.env`.
- **`openai-base`** reads `OPENAI_CUSTOM_HEADERS`, `OPENAI_LOG`, and `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` unless they are given as `null`.

The spike neutralises all of these:

- It always passes `baseURL`, `logLevel: 'off'`, `openTelemetry: false`, `maxRetries: 0`, and `organization` and `project` as `null`.
- The wrapper rebuilds the headers from an allow-list (`accept`, `content-type`, `anthropic-version`, `anthropic-beta`, plus the key).

A test sets `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` and `ANTHROPIC_CUSTOM_HEADERS` (with a second key) in `process.env`. Every request still goes to `api.anthropic.com`, with only the given key and only allowed headers.

**The client:** `scripts/size.mjs` builds the page bundle and checks it. It contains no `sk-ant-`, no `x-api-key`, no `api.anthropic.com` and no `@tanstack/ai-anthropic`. The page imports only `@tanstack/ai-client` and the zod card schema.

### `dispatch()` is still the only writer: yes

- **Only registry tools, through `dispatch()`:** the turn's tools are the two registry tools, wrapped so that `dispatch()` is the only way they run, plus the spike's dummy tool, which writes nothing.
- **The request can't add tools:** tools declared in the request body (AG-UI `tools`) are never offered. `chat()` gets only the server's list, and `mergeAgentTools` is never called. A test sends a declared `publish`; every model request still lists only the three server tools.
- **Nothing is written:** every D1 table's row count is the same before and after a full turn.
- **#350 should drop `restart_screens`:** it is the spike's dummy and is not part of any real turn.

### `chat({ tools, outputSchema })` refuses a reply that is only free text: yes

- **Prose:** a final turn that is only prose ends the run in `RUN_ERROR` with `code: 'structured-output-parse-failed'`, and no card.
- **JSON in the wrong shape:** JSON that is not the card's shape (a lone `{ text }`) ends in `structured-output-validation-failed`. The schema makes `groups` and `steps` required, so a text-only card can't pass.
- **`stream: false`:** the same prose makes `await chat(...)` reject.

There is no silent fallback in either mode. The package's own skill doc says the streaming path does not validate against the schema; in 1.8.0 it does.

**One catch:** the prose reaches the client as `TEXT_MESSAGE_CONTENT` before the refusal. `ChatClient` holds it in the `structured-output` part's `raw` until the part turns to `status: 'error'`. The drawer must render only a complete card, never `raw`.

### Worker bundle delta vs the current Anthropic SDK

These were measured with esbuild as wrangler bundles a Worker (esm, workerd conditions, minified):

| Bundle | Minified | Gzipped |
| --- | --- | --- |
| Today: `@anthropic-ai/sdk` 1.6.0 client + one call | 414 KiB | 97 KiB |
| `@tanstack/ai` + `ai-anthropic` | 717 KiB | 188 KiB |
| … + `openaiCompatible` | 1,218 KiB | 303 KiB |
| The spike Worker (with `packages/db` and the registry) | 2,375 KiB | 605 KiB |
| The page (React, Zustand, `@tanstack/ai-client`) | 864 KiB | 214 KiB |

The adapters don't drop the vendor SDKs:

- `ai-anthropic` bundles 215 files of `@anthropic-ai/sdk` 0.135 (its error classes, and the full SDK behind a dynamic import).
- `openaiCompatible` bundles 236 files of `openai` 7.62.

Today's endpoint adapter is plain `fetch`. Today's API Worker is 6,462 KiB, or 1,207 KiB gzipped (`wrangler deploy --dry-run --env dev`). Replacing the SDK adds about **+91 KiB gzipped** for Anthropic, or about **+206 KiB** with `openaiCompatible`. That's about 1.4 MiB gzipped in all, well inside Workers' limit.

### On Anthropic, `partial` stays empty until `final`: no, it fills as the JSON streams

That's with this release, given streamed deltas.

In `ai-anthropic` 1.2.1, every model it knows is in `ANTHROPIC_COMBINED_TOOLS_AND_SCHEMA_MODELS`. So the card's schema goes into the same streaming Messages call as the tools (`output_config.format`), and each JSON delta becomes a `TEXT_MESSAGE_CONTENT`.

In the test, the stub streams the card in three pieces. The page's `structured-output` part has a `partial` with `text` and no `steps` before it completes.

The issue's caveat (one event at the end) is the separate-finalization path. It is used only for models outside that list, which this release can't use at all (see the model-id limit below).

**Not proven:** whether Anthropic's API itself sends `output_config` JSON in several deltas. No key was given.

### `needsApproval` pauses a dangerous tool and resumes after a click, without running it first: yes

**What works:**

- The model's call to `restart_screens` ends the run with `RUN_FINISHED`, `outcome: interrupt`. The tool hasn't run: its count is 0.
- Approve resumes the run, runs the tool once, and the card arrives.
- Deny never runs it.

**What the client and server need:**

- **The client answers generic interrupts.** It doesn't declare the server's tools, so their approvals arrive as generic AG-UI interrupts. The client answers them with `resolveInterrupt({ approved })`. `resolveInterrupts(true)` ignores them.
- **The server forwards `parentRunId`.** It must pass `parentRunId` from the request, or the resume fails (`InterruptResumeValidationError`).

**What stays ours, for #351:**

- **Approvals can be replayed.** Nothing on the server remembers an approval. A test sends the recorded approving request again with a new `runId`, and the tool runs a second time. The one-use token and the hash binding of #269 are still ours to build.
- **Edited arguments.** The default approval response schema accepts `editedArgs`, so the client can approve different arguments from the ones shown. #351 must refuse edited arguments, or bind them in its token.

## The added question: can the drawer drive `ChatClient` in a Zustand slice? Yes

`src/page/store.ts`:

- holds a `ChatClient` (no `useChat`);
- copies `client.getSnapshot()` into the store on each `subscribeSnapshot` call;
- exposes `ask`, `decide` and `dispose` as actions.

The page reads the store with `useStore` selectors and uses no `useState` or `useEffect`. It works in workerd and in a real browser.

Two details for #350:

- **The card arrives untyped.** `ChatClient`'s snapshot doesn't carry the `outputSchema` type (only `useChat` threads it through), so the page parses each card with zod. That's cheap, and it's the edge anyway.
- **Server rendering shows the first state.** Zustand renders a store's initial state on the server, which the CMS already lives with.

## Found on the way: for #350 and #351, not #349

1. **Earlier cards are lost after a pause.** An interrupt's `MESSAGES_SNAPSHOT` replaces the client's messages with the server's. Every earlier turn's `structured-output` part comes back as a text part holding its raw JSON, so the page shows a JSON blob where the cards were.
   - A test pins this behaviour.
   - #350 must keep cards by message id in its slice, or upstream must fix it, before the approval flow ships.
2. **The model's id must be one the adapter's release knows.** `createAnthropicChat` and `AnthropicTextAdapter` accept only `ANTHROPIC_MODELS`, at the type level; there's no `as` outside the allow-list.
   - Today an org can choose any exact id from its provider's list.
   - #349 must either limit the model picker to the adapter's ids (a visible change) or add one allow-listed cast with its reason.
   - The spike refuses unknown ids (tested).
3. **`chat()` won't take a union of adapters.** Each provider branch calls `chat()` with its own adapter type (`withModel` in `src/worker.ts`).
4. **History is still the client's.** `chatParamsFromRequest` passes the browser's messages to the model, assistant turns and tool results included. TanStack doesn't fence them; #335's rule (earlier turns as data, or rebuilt on the server) still applies in #350.
5. **Defaults to set explicitly in #349:**
   - **`retry`:** off by default.
   - **The adapter's `maxRetries`:** 2 by default; set it to 0.
   - **`repairToolInput`:** on by default. It repairs a tool input that fails its check, and `dispatch()` checks the input again anyway. Consider `false`.
   - **`agentLoopStrategy`:** `maxIterations(5)` by default; set it to the drawer's budget.
   - **`threadId`:** required by every `chat()` call.
