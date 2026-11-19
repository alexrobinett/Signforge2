# The runtime check's runner: Node, Playwright's headless Chromium shell and the bundled runner
# (dist/runner.mjs, `pnpm build`, which wrangler runs first). It starts with no network
# (`enableInternet: false` in src/worker/index.ts); everything below is fetched at build time.
# Cloudflare runs linux/amd64 (wrangler builds for it). Chromium does not run under Rosetta, so on
# an Apple Silicon Mac `wrangler dev --env arm64` builds the native image instead (wrangler.jsonc).
ARG RUNNER_PLATFORM=linux/amd64
FROM --platform=${RUNNER_PLATFORM} node:24-trixie-slim
WORKDIR /runner
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# dist/package.json names playwright-core at the version the tests ran (build.ts writes it).
COPY dist/package.json ./
RUN npm install --no-package-lock --no-fund --no-audit \
  && npx playwright-core install --with-deps --only-shell chromium \
  && rm -rf /var/lib/apt/lists/* /root/.npm
COPY dist/runner.mjs ./
USER node
EXPOSE 8080
CMD ["node", "runner.mjs"]
