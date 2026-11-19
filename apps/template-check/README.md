# Template check

The runtime check of uploaded templates (#40): a Worker, `signforge-template-check`, whose Durable Object starts a container with no Internet access, in which a Node runner renders the template in headless Chromium in the player's own frame and policy. What it refuses and records is in [docs/architecture.md](../../docs/architecture.md#runtime-check); the API calls it through its `TEMPLATE_CHECK` service binding for every org template version (`register_template_version`).

```
src/runner/check.ts    the render and what it refuses (Playwright)
src/runner/server.ts   the runner's HTTP API in the container: GET /health, POST /check
src/worker/index.ts    the Worker and the Durable Object that starts the container
Dockerfile             Node, Playwright's Chromium shell, dist/runner.mjs (`pnpm build`)
```

## Tests

- `pnpm test`: the runner in Node with Playwright's Chromium. Every template in `templates/` must pass, and the hostile fixture (`test/fixtures/hostile`, one `mode` per thing it tries) must be refused with each problem. CI runs it.
- `pnpm test:container`: the Worker under `wrangler dev` with its container (Docker must run). The fixtures and base templates through `POST /check`, a request from inside the container to an outside host, and the check's cost per push. Not in CI.

## Locally

`pnpm dev` runs the Worker and its container. On an Apple Silicon Mac use `pnpm dev --env arm64`: Wrangler builds linux/amd64 images, and Chromium cannot run under Rosetta (it is killed for memory), so that environment builds the native image. Run it beside the API's `pnpm dev`, whose `TEMPLATE_CHECK` binding finds it; without it, registering an org template fails (base templates do not need it). If Wrangler cannot find Docker, set `DOCKER_HOST` (for Colima, `unix://$HOME/.colima/default/docker.sock`).

## Deploy

Containers must be enabled on the account (Workers Paid). From this folder, with Docker running: `pnpm exec wrangler deploy`. It bundles the runner, builds the linux/amd64 image, pushes it to the account's registry and uploads the Worker. Then deploy the API (`--env demo` or `--env prod`), whose binding names this Worker. The first check after a deploy starts a container.
