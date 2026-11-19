/**
 * The check Worker: `POST /check/org/<orgId>` (or `/check/base`) with `{ manifest, html }` answers
 * the runner's TemplateRuntimeReport. Each org has its own Durable Object, `org:<orgId>`, holding its
 * own container, so one org's template never shares a browser with another org's bundles or
 * reports; base templates have `base`. The runner in a container checks one template at a time, so
 * an org's pushes queue there and only there. Started with no Internet access, a container reaches
 * nothing but its object: the bundle comes in with the request and the report goes back.
 *
 * At most MAX_CONTAINERS run at once (CheckSlots). Past that a new org's check is refused with a
 * 503 to retry, never sent to another org's container.
 */
import { isId } from '@signforge/contract';
import { DurableObject } from 'cloudflare:workers';

const PORT = 8080;
/** Chromium's first launch in a fresh container is the slow part of a start. */
const START_TIMEOUT_MS = 60_000;
/**
 * Kept running between checks, so an author's or an agent's fix-and-push loop starts it once. Every
 * org's container idles this long after its last check, so it is short: a cold start costs about 2 s.
 */
const IDLE_MS = 2 * 60_000;
/** A slot outlives its container's idle time by the longest a check can wait and run. */
const SLOT_MS = IDLE_MS + START_TIMEOUT_MS + 60_000;
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

/**
 * Which containers may run: one slot per instance name, held until SLOT_MS after its last check.
 * One object for the whole Worker, so the count is exact.
 */
export class CheckSlots extends DurableObject<Env> {
  /** Hold or renew `name`'s slot; false when MAX_CONTAINERS other instances hold one. */
  async claim(name: string): Promise<boolean> {
    const now = Date.now();
    const slots = (await this.ctx.storage.get<Record<string, number>>('slots')) ?? {};
    for (const [held, until] of Object.entries(slots)) if (until <= now) delete slots[held];
    if (!(name in slots) && Object.keys(slots).length >= Number(this.env.MAX_CONTAINERS)) return false;
    slots[name] = now + SLOT_MS;
    await this.ctx.storage.put('slots', slots);
    return true;
  }
}

/** The instance for a path: `org:<id>` for an org's templates, `base` for the platform's. */
function instanceFor(pathname: string): string | undefined {
  if (pathname === '/check/base') return 'base';
  const org = /^\/check\/org\/([^/]+)$/.exec(pathname)?.[1];
  return org !== undefined && isId(org) ? `org:${org}` : undefined;
}

export default {
  async fetch(request, env) {
    const name = request.method === 'POST' ? instanceFor(new URL(request.url).pathname) : undefined;
    if (!name) return Response.json({ error: 'POST /check/org/<orgId> or /check/base' }, { status: 404 });
    if (!(await env.CHECK_SLOTS.getByName('slots').claim(name))) {
      return Response.json(
        { error: `${env.MAX_CONTAINERS} orgs are checking templates already; try again in a minute` },
        { status: 503, headers: { 'retry-after': '60' } },
      );
    }
    const res = await env.TEMPLATE_CHECK.getByName(name).fetch(request);
    // Which instance answered, for the API's logs and the isolation test; the runner adds its boot id.
    const answer = new Response(res.body, res);
    answer.headers.set('x-check-instance', name);
    return answer;
  },
} satisfies ExportedHandler<Env>;
