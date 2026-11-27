/**
 * The check Worker: `POST /check/org/<orgId>` (or `/check/base`) with `{ manifest, html }` answers
 * the runner's TemplateRuntimeReport. Each org has its own Durable Object, `org:<orgId>`, holding its
 * own container, so one org's template never shares a browser with another org's bundles or
 * reports; base templates have `base`. The runner in a container checks one template at a time, so
 * an org's pushes queue there and only there. Started with no Internet access, a container reaches
 * nothing but its object: the bundle comes in with the request and the report goes back.
 *
 * At most MAX_CONTAINERS run at once (CheckSlots). Past that a new org's check is refused with a
 * 503 to retry, never sent to another org's container. A slot is held for the check at SLOT_MS, and
 * once the check has finished or failed, let go with its container: at once when the container is
 * not running, else when it will stop on its own, IDLE_MS on (SLOT_MS stays as the net for a Worker
 * that dies mid-check).
 */
import { isId } from '@signforge/contract';
import { DurableObject } from 'cloudflare:workers';
import { claimSlot, type Ledger, settleSlot } from './slots';

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

  /** Whether the container is up: what the slot is for. */
  running(): boolean {
    return !!this.ctx.container?.running;
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
 * Which containers may run, by the ledger in ./slots.ts: a slot per instance name, held for a check
 * at SLOT_MS and, once it is done, only as long as its container lives (`settle`). One object for
 * the whole Worker, so the count is exact.
 */
export class CheckSlots extends DurableObject<Env> {
  private async ledger(): Promise<Ledger> {
    const [until, busy] = await Promise.all([this.ctx.storage.get<Record<string, number>>('slots'), this.ctx.storage.get<Record<string, number>>('busy')]);
    return { until: until ?? {}, busy: busy ?? {} };
  }

  /** Hold or renew `name`'s slot; false when MAX_CONTAINERS other instances hold one. */
  async claim(name: string): Promise<boolean> {
    const ledger = await this.ledger();
    const held = claimSlot(ledger, name, Date.now(), Number(this.env.MAX_CONTAINERS), SLOT_MS);
    await this.ctx.storage.put({ slots: ledger.until, busy: ledger.busy });
    return held;
  }

  /**
   * `name`'s check is over, finished or failed. A container that is not running holds no slot. One
   * that is stops after IDLE_MS without a check, and holds it until then: a new org's container
   * must not start beside it past MAX_CONTAINERS.
   */
  async settle(name: string, running: boolean): Promise<void> {
    const ledger = await this.ledger();
    settleSlot(ledger, name, running, Date.now(), IDLE_MS);
    await this.ctx.storage.put({ slots: ledger.until, busy: ledger.busy });
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
    const checker = env.TEMPLATE_CHECK.getByName(name);
    let res: Response;
    let body: ArrayBuffer;
    try {
      res = await checker.fetch(request);
      // Read here, so the check is over when its slot is settled.
      body = await res.arrayBuffer();
    } finally {
      await env.CHECK_SLOTS.getByName('slots').settle(name, await checker.running());
    }
    // Which instance answered, for the API's logs and the isolation test; the runner adds its boot id.
    const answer = new Response(body, res);
    answer.headers.set('x-check-instance', name);
    return answer;
  },
} satisfies ExportedHandler<Env>;
