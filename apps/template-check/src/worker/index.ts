/**
 * The check Worker: `POST /check` with `{ manifest, html }` answers the runner's
 * TemplateRuntimeReport. One Durable Object holds one container; the runner inside checks one
 * template at a time, so pushes queue there. Started with no Internet access, it can reach nothing
 * but this object: the bundle comes in with the request and the report goes back as the answer.
 */
import { DurableObject } from 'cloudflare:workers';

const PORT = 8080;
/** Chromium's first launch in a fresh container is the slow part of a start. */
const START_TIMEOUT_MS = 60_000;
/** Kept running between checks, so a batch of pushes (an agent's tries, a seed) starts it once. */
const IDLE_MS = 5 * 60_000;
/** Two 1080p renders of a heavy template must not lose the 2 s ready limit to a starved CPU. */
const INSTANCE = 'standard-2';

export class TemplateCheckContainer extends DurableObject<Env> {
  private starting?: Promise<number>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    // A restarted object starts without the timeout (the Containers docs, setInactivityTimeout).
    if (container?.running) void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(IDLE_MS));
  }

  /** Start the runner unless it runs; resolves with how long the start took, 0 when it was running. */
  private ensureRunning(container: Container): Promise<number> {
    if (container.running && !this.starting) return Promise.resolve(0);
    this.starting ??= (async () => {
      const image = container.images.runner;
      if (!image) throw new Error('no runner image: wrangler.jsonc names it in containers[].images');
      const started = Date.now();
      container.start({ image, instance: INSTANCE, enableInternet: false, env: { RUNNER_IMAGE: image } });
      await container.setInactivityTimeout(IDLE_MS);
      // start() returns before the runner listens, and the runner listens once its browser is up.
      while (Date.now() - started < START_TIMEOUT_MS) {
        try {
          if ((await container.getTcpPort(PORT).fetch('http://runner/health')).ok) return Date.now() - started;
        } catch {
          // Not listening yet.
        }
        await scheduler.wait(250);
      }
      throw new Error(`the template check runner did not start within ${START_TIMEOUT_MS} ms`);
    })().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  override async fetch(request: Request): Promise<Response> {
    const container = this.ctx.container;
    if (!container) throw new Error('TemplateCheckContainer has no container configured');
    const startMs = await this.ensureRunning(container);
    return container.getTcpPort(PORT).fetch(`http://runner/check?startMs=${startMs}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: request.body,
    });
  }
}

export default {
  fetch(request, env) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/check') return Response.json({ error: 'POST /check' }, { status: 404 });
    return env.TEMPLATE_CHECK.getByName('runner').fetch(request);
  },
} satisfies ExportedHandler<Env>;
