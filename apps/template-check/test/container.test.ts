/**
 * The check Worker under `wrangler dev`, with the runners in their containers: what a push meets.
 * Each org's checks run in its own container (`org:<id>`), base templates in `base`; each fixture is
 * refused with its problem, every base template passes, no container can reach the network, and
 * past MAX_CONTAINERS (3 here, test/wrangler-dev.ts) a new org is refused to retry. Run with
 * `pnpm test:container` (Docker); it prints the check's cost per push.
 */
import { buildTemplate } from '@signforge/template-build';
import { parseTemplateRuntimeReport, type TemplateManifest, type TemplateRuntimeReport } from '@signforge/contract';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

const root = new URL('../../../templates/', import.meta.url).pathname;
const baseDirs = readdirSync(root).filter((d) => existsSync(`${root}${d}/template.json`));
const costs: { what: string; startMs: number; checkMs: number; pushMs: number }[] = [];

/** `org/<id>` or `base`, as the API names the container. */
const post = (owner: string, manifest: TemplateManifest, html: string) =>
  fetch(`${inject('checkUrl')}/${owner}`, { method: 'POST', body: JSON.stringify({ manifest, html }) });

async function check(what: string, owner: string, manifest: TemplateManifest, html: string) {
  const started = Date.now();
  const res = await post(owner, manifest, html);
  expect(res.status).toBe(200);
  const parsed = parseTemplateRuntimeReport(await res.json());
  if (!parsed.ok) throw new Error(parsed.problems.join('; '));
  costs.push({ what: `${owner}: ${what}`, ...parsed.value.cost, pushMs: Date.now() - started });
  const report: TemplateRuntimeReport = parsed.value;
  return { report, instance: res.headers.get('x-check-instance'), boot: res.headers.get('x-runner-boot') };
}

let hostile: { manifest: TemplateManifest; html: string };
beforeAll(async () => {
  hostile = await buildTemplate(new URL('fixtures/hostile', import.meta.url).pathname);
});
afterAll(() => console.table(costs));

const inMode = (mode: string): TemplateManifest => {
  const fields = structuredClone(hostile.manifest.fields);
  if (fields.mode?.type === 'select') fields.mode.default = mode;
  return { ...hostile.manifest, fields };
};

describe("an org's checks", () => {
  it('start its container for the first check and reuse it for the next', async () => {
    const first = await check('first (cold)', 'org/org-a', inMode('ok'), hostile.html);
    const second = await check('second (warm)', 'org/org-a', inMode('ok'), hostile.html);
    expect([first.report.ok, second.report.ok]).toEqual([true, true]);
    expect(first.report.cost.startMs).toBeGreaterThan(0);
    expect(second.report.cost.startMs).toBe(0);
    expect(second.boot).toBe(first.boot);
    expect(first.report.runner.browser).toMatch(/^Chromium \d+/);
  });

  const refused: [string, string][] = [
    ['fetch', 'requested https://example.com/leak (blocked)'],
    ['navigate-top', 'tried to navigate the page around it (blocked)'],
    ['no-ready', 'did not report ready within 2000 ms'],
    ['throw', 'failed to prepare: prepare blew up'],
    ['spin-on-play', 'froze after play: did not draw a second of frames within 3000 ms'],
  ];
  for (const [mode, problem] of refused) {
    it(`refuse the fixture that does this: ${mode}`, async () => {
      const { report } = await check(mode, 'org/org-a', inMode(mode), hostile.html);
      expect(report.ok).toBe(false);
      expect(report.problems).toEqual([problem]);
    });
  }
});

describe('the base templates', () => {
  for (const dir of baseDirs) {
    it(`pass, in the base container: ${dir}`, async () => {
      const built = await buildTemplate(`${root}${dir}`);
      const { report, instance } = await check(dir, 'base', built.manifest, built.html);
      expect(report.problems).toEqual([]);
      expect(instance).toBe('base');
    });
  }
});

describe('containers', () => {
  it("are one per org: another org's check runs in another container", async () => {
    const a = await check('isolation', 'org/org-a', inMode('ok'), hostile.html);
    const b = await check('isolation (cold)', 'org/org-b', inMode('ok'), hostile.html);
    expect([a.instance, b.instance]).toEqual(['org:org-a', 'org:org-b']);
    expect(a.boot).toBeTruthy();
    expect(b.boot).not.toBe(a.boot);
    expect(b.report.cost.startMs).toBeGreaterThan(0);
  });

  it('are at most MAX_CONTAINERS: a further org is refused to retry, not sent to a running one', async () => {
    const res = await post('org/org-c', inMode('ok'), hostile.html);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('60');
    expect((await res.json()).error).toMatch(/^3 orgs are checking templates already; try again/);
  });
});

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
/** The running check containers' names. */
const checkContainers = () =>
  docker(['ps', '--format', '{{.Names}}'])
    .split('\n')
    .filter((n) => n.includes('TemplateCheckContainer') && !n.endsWith('-proxy'));
const inContainer = (name: string, code: string) => docker(['exec', name, 'node', '-e', code]);

describe('each container', () => {
  it('cannot reach an outside host: the request fails without an answer', () => {
    expect(checkContainers()).toHaveLength(3);
    for (const name of checkContainers()) {
      const out = inContainer(
        name,
        "fetch('https://example.com/', { signal: AbortSignal.timeout(5000) }).then((r) => console.log('answered', r.status), (e) => console.log('failed', e.cause?.code ?? e.message))",
      );
      expect(out).toMatch(/^failed /);
    }
  });

  it('proved at start that its network is closed and that it sees a blocked request', () => {
    for (const name of checkContainers()) {
      const health = JSON.parse(inContainer(name, "fetch('http://127.0.0.1:8080/health').then((r) => r.text()).then(console.log)"));
      expect(health.network).toMatchObject({ closed: true, detail: expect.stringContaining('could not be reached') });
      expect(health.canary).toMatchObject({ ok: true });
    }
  });

  it('is started afresh for the next check after it stopped (the runner exits when its browser dies)', async () => {
    for (const name of checkContainers()) docker(['kill', name]);
    const { report } = await check('after a stop', 'org/org-a', inMode('ok'), hostile.html);
    expect(report.ok).toBe(true);
    expect(report.cost.startMs).toBeGreaterThan(0);
  });
});
