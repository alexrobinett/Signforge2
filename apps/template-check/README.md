# Template check

The runtime check of uploaded templates (#40): a Worker, `signforge-template-check`, that gives each org its own container with no Internet access, in which a Node runner renders the template in headless Chromium in the player's own frame and policy. What it refuses and records is in [docs/architecture.md](../../docs/architecture.md#runtime-check); the API calls it through its `TEMPLATE_CHECK` service binding for every org template version (`register_template_version`), at `POST /check/org/<orgId>`, with the org from the caller's scope.

```
src/runner/check.ts    the render, what it refuses, and the start-up canary (Playwright)
src/runner/server.ts   the runner's HTTP API in the container: GET /health, POST /check; probes and queue
src/worker/index.ts    the Worker, the per-org Durable Object that starts its container, and CheckSlots
build.ts               `pnpm build`: dist/runner.mjs and dist/package.json (the Playwright the tests ran)
Dockerfile             Node, Playwright's Chromium shell, the two files above
```

Instances: `org:<orgId>` for an org's templates, `base` for the platform's (`POST /check/base`). At most `MAX_CONTAINERS` (a var, 10) run at once; past that a new instance's check is answered 503 with `retry-after`, and the API refuses the push as `unavailable`.

## Tests

- `pnpm test`: the runner in Node with Playwright's Chromium. Every template in `templates/` must pass, the hostile fixture (`test/fixtures/hostile`, one `mode` per thing it tries) must be refused with each problem, the runner refuses checks while its network probe answers or its queue is full, and the image installs the Playwright the tests ran. CI runs it.
- `pnpm test:container`: the Worker under `wrangler dev` with its containers (Docker must run), with `MAX_CONTAINERS` 3. The fixtures, through `org/org-a`, and the base templates, through `base`; two orgs in two containers; a fourth instance refused; in each container, a request to an outside host, its probe and canary; a restart after a kill; and the check's cost per push. Not in CI.

## Locally

`pnpm dev` runs the Worker and its containers. On an Apple Silicon Mac use `pnpm dev --env arm64`: Wrangler builds linux/amd64 images, and Chromium cannot run under Rosetta (it is killed for memory), so that environment builds the native image. Run it beside the API's `pnpm dev`, whose `TEMPLATE_CHECK` binding finds it; without it, registering an org template is refused as `unavailable` (base templates do not need it). If Wrangler cannot find Docker, set `DOCKER_HOST` (for Colima, `unix://$HOME/.colima/default/docker.sock`).

## Deploy

Containers must be enabled on the account (Workers Paid). From this folder, with Docker running: `pnpm exec wrangler deploy`. It bundles the runner, builds the linux/amd64 image, pushes it to the account's registry and uploads the Worker. Then deploy the API (`--env demo` or `--env prod`), whose binding names this Worker and whose `TEMPLATE_CHECK_LIMIT` rate limit is new. Each org's first check after a deploy, or after 2 idle minutes, starts its container.
