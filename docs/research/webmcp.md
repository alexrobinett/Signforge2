# WebMCP: should the CMS give browser agents its tools?

Research for M4-16 (#121), 2026-11-25. Every fact below was read on that day from the source linked beside it (listed again under Sources). The prototype ran on this day against a local dev stack only.

**Decision: not in Milestone 4. Move it to Milestone 5, as the owner's default says.** No stable Chrome ships WebMCP without a flag or an origin trial. No mainstream agent most of our members use can call page tools yet. The two pieces that matter most for us, confirmation and knowing who called, are still open in the spec. The smallest real version is small, though, and the prototype shows it works on our existing `/api/tools`, so it is cheap to build once the conditions at the end hold.

## What WebMCP is today

- **Who publishes it.** The W3C Web Machine Learning Community Group. Its status is "Draft Community Group Report", last updated 24 November 2026. That is a community group draft, not on the W3C standards track. The editors are from Microsoft (2) and Google (2) ([spec][spec], [spec source][bs]).
- **The API moved.** The spec now puts it on the document, `document.modelContext`, not `navigator.modelContext` (moved 2026-05-27, [#184][c184]). `provideContext()` and `clearContext()` were removed on 2026-03-05 ([#132][c132]). Guides that show `navigator.modelContext.provideContext()` are out of date.
- **The surface** ([spec IDL][spec-api]):
  - `registerTool(tool, { signal, exposedTo })`. A tool is `{ name, title, description, inputSchema, outputSchema, execute(input, { signal }), annotations }`. Aborting `signal` unregisters the tool.
  - `getTools({ fromOrigins })` and `executeTool(tool, input, { signal })` let a page, or an agent hosted in a page, list and call tools. The `Tool` interface was added on 2026-11-19 ([#348][c348]).
  - `waitForToolsUntil(promise)`, added on 2026-11-23 ([#373][c373]).
  - Events: `toolchange`, `toolactivated` (a tool's `execute` started) and `toolcancel`.
  - A declarative form API (`toolname` and `tooldescription` on a `<form>`) is "under active discussion and subject to change" ([Chrome: declarative API][cr-decl]).
- **Annotations** are four booleans, all false by default: `readOnlyHint`, `untrustedContentHint` (the output holds data the site does not trust), `consequentialHint` ("significant, real-world, or non-reversible", added 2026-09-03, [#217][c217]) and `debugging` ([spec IDL][spec-tool]). There is no `destructiveHint` or `idempotentHint` as in MCP. The spec says they are hints: "a malicious site can omit or misrepresent those hints" ([spec, baseline capabilities][spec-baseline]).
- **Confirmation is the page's job.** The spec has no API for a tool to ask the person. `requestUserInteraction()` and the `ModelContextClient` it lived on were removed on 2026-06-11 ([#205][c205]). "User prompting and elicitation" is listed as still being explored ([README, open questions][readme-open]). Chrome's secure-tools page still describes `requestUserInteraction()` as part of the draft (last updated 2026-09-01), so that page is behind the spec ([Chrome: secure tools][cr-secure]). `consequentialHint` lets an agent or browser "selectively enforce mandatory user confirmation prompts", but nothing makes them do it ([spec, mitigations][spec-consequential]). So a page that wants confirmation makes its `execute` wait for a click in its own UI. That confirmation is advisory: an agent that can also click in the page or run script in it (an extension with host permissions, DevTools) can press the button itself. Chrome says so: "Extensions with `host_permission` can drive the page with custom JavaScript even without WebMCP" ([Chrome: secure tools][cr-secure]).
- **Cross-origin.** By default a tool can be seen and called only by same-origin documents. A cross-origin frame needs three opt-ins: the embedder grants `allow="tools"` (Permissions Policy feature `tools`, default `'self'`), the provider lists the caller in `exposedTo`, and the consumer lists the provider in `fromOrigins`. `Permissions-Policy: tools=()` turns WebMCP off for a document and its frames before any script runs ([spec, same-origin policy][spec-sop], [spec, permissions policy mitigation][spec-pp]).

## Who ships it

| Browser or agent | Status on 2026-11-25 | Source |
| --- | --- | --- |
| Chrome | Dev trial from 146 behind `chrome://flags/#enable-webmcp-testing`. Origin trial 149 to 156, extended to 162 (filed 2026-09-28). Chrome Status says "Proposed", with no ship milestone. Chrome 162 is stable on 2027-02-02. | [Chrome Status][cs], [ChromiumDash 162][cd162], [Chrome docs][cr-docs] |
| Chrome stable on this Mac (158.0.8127.37) | `document.modelContext` is `undefined` by default, and present with the flag on. ChromiumDash lists 159.0.8154.34 as the newest Mac stable release (2026-11-24). | Probe below, [ChromiumDash][cd] |
| Edge | Origin trial from 150. | [implementation status][status] |
| Brave | Leo AI chat calls page tools by default from Brave 1.102.2, "expected on January 5, 2027". | [implementation status][status], [#383][c383] |
| ChatGPT Desktop | Listed as supporting WebMCP (since 2026-08-26). | [implementation status][status], [#258][c258] |
| Meta Ray-Ban Display | "Coming soon", off by default. | [implementation status][status] |
| Firefox | Mozilla's position: neutral (issue open). | [mozilla/standards-positions#1412][moz] |
| Safari | WebKit's position: oppose (concerns include privacy, security, meaningful user consent and venue). | [WebKit/standards-positions#670][webkit] |

**On by default in a stable browser: none today.** Brave 1.102.2 would be the first, in January, and only for Brave's own Leo.

**Which agents call page tools in Chrome:**

- **Gemini in Chrome.** Chrome's WebMCP docs do not say it calls page tools. They say the test extensions "are separate from Gemini in Chrome" ([Chrome docs][cr-docs]).
- **Extensions** can list and call tools through content scripts with `getTools()` and `executeTool()`. There is no `chrome.*` API for it. Google's test extensions (the Model Context Tool Inspector and an example agent) need a Gemini API key ([Chrome docs][cr-docs]).
- **Claude in Chrome** does not discover page tools. The feature request is open ([anthropics/claude-code#76809][claude-issue]), after an earlier one closed as stale ([#30645][claude-issue-old]).
- **Chrome DevTools MCP** has `list_webmcp_tools` and `execute_webmcp_tool` behind `--categoryExperimentalWebmcp` ([tool reference][devtools-mcp]). This is how the prototype drove the tools.

## Security guidance

- The spec assumes agents carry the person's identity: "When an agent visits a website, it carries the user's logged-in credentials and session state." Defending the agent against a hostile page is "primarily the responsibility of the agent's own security model" ([spec, baseline capabilities][spec-baseline]).
- Prompt injection can come through tool descriptions, inputs and outputs ([spec, prompt injection][spec-pi]). For sites, Chrome advises:
  - mark user-generated or external output with `untrustedContentHint`;
  - mark high-stakes tools with `consequentialHint`;
  - expose tools only to origins you trust;
  - keep descriptions short: about 500 characters per tool, 150 per parameter, and 1.5K of output.

  For agents, Chrome advises keeping a human in the loop, assuming every tool mutates unless marked read-only, spotlighting untrusted output, and limiting the origins a task touches ([Chrome: secure tools][cr-secure], [Chrome: agent security][cr-agents]).
- Neither page covers server-side authorization or rate limits. Those stay ours.

## Prototype

Run on 2026-11-25. Nothing from it is committed.

- **Browser.** Chrome 158 stable on this Mac, with a scratch profile and `enable-webmcp-testing` set the way `chrome://flags` sets it. With the flag off, `document.modelContext` was `undefined`. With it on, it had `registerTool`, `getTools`, `executeTool` and the three events. There was no `waitForToolsUntil` (added to the spec two days ago).
- **App.** The API (`wrangler dev`) and CMS (`vite dev`) ran on their own ports, with a scratch D1 and the base templates seeded. A fresh test account signed in and made one org and one web-page spot.
- **Adapter.** A script injected into the signed-in Spots page, about 50 lines, did four things:
  - fetched `GET /api/tools` with the tab-org header;
  - registered three tools from it, with their own descriptions and input schemas:
    - `list_spots`, with `readOnlyHint` from `!mutates`;
    - `update_spot`;
    - `publish`, with `consequentialHint` from scope `content:publish`;
  - made each `execute` call `POST /api/tools/:name` with the session cookie and the tab-org header;
  - added a top bar ("An agent in this browser is working as you", with Stop) and a `<dialog>` that `publish` waited on.
- **Agent.** Claude (Sonnet, through `claude -p`) with Chrome DevTools MCP 1.14.0 connected to that browser, allowed only `list_pages`, `select_page`, `list_webmcp_tools` and `execute_webmcp_tool`. It was asked to list spots, change the Spring menu's URL and publish that spot.

What happened:

- **Discovery worked.** The agent saw the three tools with our descriptions, schemas and annotations (`readOnly: true` on `list_spots`, `consequential: true` on `publish`).
- **The read and the draft write worked.** `list_spots` returned the spot. `update_spot` changed the URL, and the agent passed `ifVersion: 1` on its own.
- **Publish waited for the page.** The agent pinned the draft (`drafts: [{ kind: 'spot', id, version: 2 }]`). The call stayed open while the dialog was up (5 s) and returned once Publish was clicked. On a second run Cancel was clicked: the agent got the tool's error "The person declined", did not retry, nothing was published, and no publish row was audited. Chrome itself asked nothing: `consequentialHint` changed nothing in the browser.
- **The audit cannot tell the agent from the person.** Every row read `actor: { kind: 'user', clientId: 'cms' }`, the same as a click in the CMS. `/api/tools` has no way to know the call came through WebMCP.
- **Stop withdrew the tools.** Aborting the registration signal left `getTools()` empty.
- **`toolactivated` fired for each call**, which is enough to drive the bar and the outline of changed fields.
- **Not tested:** an origin trial token (it needs a registered origin), and any agent other than DevTools MCP.

## How it would sit on what we have

| Piece | How WebMCP would use it | Gap |
| --- | --- | --- |
| Registry and `dispatch` | Register the tools from `GET /api/tools` for the person's role. Each `execute` posts to `/api/tools/:name`. No new tool code: the prototype needed none. | After #345 (#478: one generic `read` plus `describe`) the list is shorter, which suits a browser agent's context. Register the same catalogue `/mcp` gets, less what the drawer never offers (below). |
| Actor `user`, client `webmcp` | The CMS would mark these calls, for example with a header the route reads to set `clientId: 'webmcp'`. | The mark is the page's claim. The agent holds the same session cookie and can call `/api/tools` directly, unmarked. This is the drawer's "via agent" problem before #269 signs a turn. |
| Audit | Rows read "…as the member, via browser agent" once the client is marked. | Only as honest as the mark. |
| Tab-org header | The adapter sends it like `callTool` does, so a tab switched to another org is refused with `org_changed`. The tools re-register on an org switch. | None. |
| `AGENT_LIMITS` | Count calls with client `webmcp` per session, with the same numbers (120 calls and 30 changes a minute, 2,000 changes a day). | Today the limiter counts only `actor.kind === 'agent'` by grant. It would need a key for a session. It holds back a runaway loop through the tools, not an agent that bypasses them. |
| "An agent is working as you" bar with Stop | `toolactivated` shows the bar. Stop aborts the registrations' signal. Shown working in the prototype. | Stop withdraws the tools, not the agent: an agent that also drives the page keeps going. |
| Publish confirmation in the page | `execute` waits for the person's click. Shown working, both ways. | Advisory only: an agent that can click or run script in the page can press it. The drawer's card is stronger: its one-use token is bound to a hash of the input, the member and the org. |
| Outline of changed fields | `toolactivated` and the tool's output say what changed. The editor already marks the fields a drawer save changed. | Fine for spots in an open editor. Changes to things not on screen need the drawer's change summary instead. |

**Compared with what a browser agent can already use:**

- **`/mcp`** gives any MCP agent the same tools through a grant the person consented to. The grant has its own scopes (publish is a separate scope), the actor is `agent`, limits are counted server-side by grant, and the grant can be revoked. WebMCP has none of that: the agent gets the person's whole role, from no consent step except being signed in.
- **The drawer** is our own agent, with our guardrails:
  - fenced inputs;
  - no tools that reach an address;
  - drafts that are proposals until Save;
  - publish behind a signed card;
  - turn and statement budgets.

**What WebMCP adds:**

- An agent the person already uses can act in the tab they are looking at, with no OAuth set-up.
- The person watches it work and can take over a field.
- It calls structured tools instead of clicking through the UI, which is more reliable and cheaper than screen-reading.

**What it risks:**

- **It acts with the person's full session and role.** An owner's browser agent can publish, revoke screens and save AI keys. An agent that drives the UI can already do that, but WebMCP makes it easy and invites it.
- **Content in the org can steer it.** That means spot text, feed headlines, a table's cells, screen and playlist names another member typed, and a fetched page. Tool outputs carrying such content need `untrustedContentHint`. The drawer's rule should apply here too: tools that make SignForge fetch from or send to an address (feeds, tables, connections, webhooks), and tools only people may call, are not registered.
- **Our audit and limits rest on a claim the page makes.**
- **The API is still moving,** with six interface changes since March (the ones linked above). Code written against it in M4 would need changes before it ships.

## Recommendation

**Move WebMCP to Milestone 5.** The owner's rule was to build in M4 only if a stable Chrome ships it unflagged, and that has not happened:

- Chrome is in an origin trial until 162 (stable 2027-02-02), and Chrome Status has no ship milestone.
- Chrome's own agent is not documented to call page tools.
- Safari opposes it.

Beyond the rule, the people who would use it mostly cannot: Claude in Chrome does not call page tools, and Brave's Leo arrives in January. Meanwhile `/mcp` and the drawer already give agents these tools with consent, scopes, server-side limits and signed confirmation.

| | Build now (M4) | Move to M5 (recommended) | Never |
| --- | --- | --- | --- |
| Who can use it | Flag users and Chrome origin-trial visitors. Brave Leo from January. | Whoever ships by then. | Nobody. Browser agents click the UI instead. |
| Cost | Small (below), plus changes as the spec moves. | The same small cost, once, on a settled API. | None. |
| Safety | Advisory confirmation, an unverified client mark, the full session. | The same, unless the spec gains browser-enforced confirmation or agent identity. | Agents still act with the session through the UI, unlabelled and unlimited. |
| Audit | "via browser agent" as a claim. | The same, or better with #269's signing. | Agents' clicks look like the person's. |

Why not "never": browser agents will act in the CMS anyway, by clicking. Structured tools with our bar, our confirmation and an audit mark are better than unlabelled clicks, once agents call them.

**The smallest real version** (an M-sized ticket):

1. The CMS app shell, in a browser with `document.modelContext` only, registers the tools from `GET /api/tools` for the tab's org. It re-registers on an org switch and withdraws them on Stop or sign-out.
2. **Leave out:**
   - publish, takeover, revoke, delete and the live-screen commands, until step 4;
   - every tool that reaches an address;
   - every tool only people may call (`people`).

   That is the drawer's list, from one shared definition.
3. **Annotations:**
   - `readOnlyHint` from `!mutates`;
   - `consequentialHint` on every tool held back in step 2;
   - `untrustedContentHint` on reads whose output carries org or third-party text.
4. `publish` with `drafts` pinned is the one consequential tool offered, behind an in-page dialog that shows the pinned drafts and their reach, as the drawer's card does.
5. Calls carry a `webmcp` client mark. The API records `clientId: 'webmcp'` and counts these calls per session against `AGENT_LIMITS`. The audit says "via browser agent".
6. The bar with Stop, and the outline of changed fields in an open editor.
7. `Permissions-Policy: tools=()` on every page outside the app shell (sign-in, the test screen and the stage), so nothing else can register tools.
8. An e2e test in Chrome with the flag, through DevTools MCP's `execute_webmcp_tool`, as in the prototype: a call is audited with client `webmcp`, and a publish waits for the page.

**What would change the answer:**

- **Build it sooner** if a stable Chrome ships WebMCP on by default, or Gemini in Chrome or Claude in Chrome calls page tools in stable. Members' agents could then use it, and the cost above is small.
- **Build it with publish in the model's reach** only if the spec gains a confirmation the browser enforces (the "user prompting and elicitation" work) or a way for a page to know which agent called. Until then, publish stays behind the page's own dialog.
- **Drop it** if Chrome ends the origin trial without shipping, as Safari's opposition suggests could happen. Agents then keep `/mcp`.

## Sources

All read 2026-11-25.

- [WebMCP, Draft Community Group Report][spec], and its source and history in [webmachinelearning/webmcp][repo] at `47e2b99` ([index.bs][bs], [README][readme-open], [implementation-status.md][status])
- Spec changes: [#132 remove provideContext][c132], [#184 move to Document][c184], [#205 remove ModelContextClient][c205], [#217 consequentialHint][c217], [#258 ChatGPT Desktop][c258], [#348 Tool interface][c348], [#373 waitForToolsUntil][c373], [#383 Brave Leo default][c383]
- [Chrome Status: WebMCP][cs] (its API record, `/api/v0/features/5117755740913664`)
- [ChromiumDash: current stable][cd] and [milestone 162][cd162]
- Chrome for Developers: [WebMCP][cr-docs] (updated 2026-10-07), [declarative API][cr-decl] (updated 2026-09-25), [secure WebMCP tools][cr-secure] (updated 2026-09-01), [agent security][cr-agents] (published 2026-06-09)
- [Chrome DevTools MCP tool reference][devtools-mcp]
- [Mozilla standards position][moz], [WebKit standards position][webkit]
- [anthropics/claude-code#76809][claude-issue], [#30645][claude-issue-old]

[spec]: https://webmachinelearning.github.io/webmcp/
[spec-api]: https://webmachinelearning.github.io/webmcp/#model-context-container
[spec-tool]: https://webmachinelearning.github.io/webmcp/#model-context-tool
[spec-baseline]: https://webmachinelearning.github.io/webmcp/#agent-baseline-capabilities
[spec-pi]: https://webmachinelearning.github.io/webmcp/#prompt-injection
[spec-sop]: https://webmachinelearning.github.io/webmcp/#interaction-with-same-origin-policy
[spec-pp]: https://webmachinelearning.github.io/webmcp/#mitigation-disable-permissions-policy
[spec-consequential]: https://webmachinelearning.github.io/webmcp/#mitigation-consequential-annotation
[repo]: https://github.com/webmachinelearning/webmcp
[bs]: https://github.com/webmachinelearning/webmcp/blob/main/index.bs
[readme-open]: https://github.com/webmachinelearning/webmcp/blob/main/README.md
[status]: https://github.com/webmachinelearning/webmcp/blob/main/implementation-status.md
[c132]: https://github.com/webmachinelearning/webmcp/commit/fe84c67
[c184]: https://github.com/webmachinelearning/webmcp/commit/c7b5c70
[c205]: https://github.com/webmachinelearning/webmcp/commit/067a1c9
[c217]: https://github.com/webmachinelearning/webmcp/commit/7b3f50f
[c258]: https://github.com/webmachinelearning/webmcp/commit/2ac94f5
[c348]: https://github.com/webmachinelearning/webmcp/commit/14b6d53
[c373]: https://github.com/webmachinelearning/webmcp/commit/47e2b99
[c383]: https://github.com/webmachinelearning/webmcp/commit/56b8e7a
[cs]: https://chromestatus.com/feature/5117755740913664
[cd]: https://chromiumdash.appspot.com/releases?platform=Mac
[cd162]: https://chromiumdash.appspot.com/schedule
[cr-docs]: https://developer.chrome.com/docs/ai/webmcp
[cr-decl]: https://developer.chrome.com/docs/ai/webmcp/declarative-api
[cr-secure]: https://developer.chrome.com/docs/ai/webmcp/secure-tools
[cr-agents]: https://developer.chrome.com/docs/agents/security
[devtools-mcp]: https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md
[moz]: https://github.com/mozilla/standards-positions/issues/1412
[webkit]: https://github.com/WebKit/standards-positions/issues/670
[claude-issue]: https://github.com/anthropics/claude-code/issues/76809
[claude-issue-old]: https://github.com/anthropics/claude-code/issues/30645
