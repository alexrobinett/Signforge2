/**
 * The check Worker under `wrangler dev`, with the runner in its container: what a push meets.
 * Each fixture is refused with its problem, every base template passes, and the container cannot
 * reach the network. Run with `pnpm test:container` (Docker); it prints the check's cost per push.
 */
import { buildTemplate } from '@signforge/cli/template';
import { parseTemplateRuntimeReport, type TemplateManifest, type TemplateRuntimeReport } from '@signforge/contract';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

const root = new URL('../../../templates/', import.meta.url).pathname;
const baseDirs = readdirSync(root).filter((d) => existsSync(`${root}${d}/template.json`));
const costs: { what: string; startMs: number; checkMs: number; pushMs: number }[] = [];

async function check(what: string, manifest: TemplateManifest, html: string): Promise<TemplateRuntimeReport> {
  const started = Date.now();
  const res = await fetch(inject('checkUrl'), { method: 'POST', body: JSON.stringify({ manifest, html }) });
  expect(res.status).toBe(200);
  const parsed = parseTemplateRuntimeReport(await res.json());
  if (!parsed.ok) throw new Error(parsed.problems.join('; '));
  costs.push({ what, ...parsed.value.cost, pushMs: Date.now() - started });
  return parsed.value;
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

describe('the check Worker, with its container', () => {
  it('starts the container for the first check and reuses it for the next', async () => {
    const first = await check('first (cold)', inMode('ok'), hostile.html);
    const second = await check('second (warm)', inMode('ok'), hostile.html);
    expect([first.ok, second.ok]).toEqual([true, true]);
    expect(first.cost.startMs).toBeGreaterThan(0);
    expect(second.cost.startMs).toBe(0);
    expect(first.runner.browser).toMatch(/^Chromium \d+/);
  });

  const refused: [string, string][] = [
    ['fetch', 'requested https://example.com/leak (blocked)'],
    ['navigate-top', 'tried to navigate the page around it (blocked)'],
    ['no-ready', 'did not report ready within 2000 ms'],
    ['throw', 'failed to prepare: prepare blew up'],
  ];
  for (const [mode, problem] of refused) {
    it(`refuses the fixture that does this: ${mode}`, async () => {
      const report = await check(mode, inMode(mode), hostile.html);
      expect(report.ok).toBe(false);
      expect(report.problems).toEqual([problem]);
    });
  }

  for (const dir of baseDirs) {
    it(`passes the base template ${dir}`, async () => {
      const built = await buildTemplate(`${root}${dir}`);
      const report = await check(dir, built.manifest, built.html);
      expect(report.problems).toEqual([]);
    });
  }
});

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
/** The running check container's name. */
function checkContainer(): string {
  const name = docker(['ps', '--format', '{{.Names}}'])
    .split('\n')
    .find((n) => n.includes('TemplateCheckContainer') && !n.endsWith('-proxy'));
  if (!name) throw new Error('no check container is running');
  return name;
}

describe('the container', () => {
  /** Run `node -e <code>` in the running check container. */
  const inContainer = (code: string) => docker(['exec', checkContainer(), 'node', '-e', code]);

  it('cannot reach an outside host: the request fails without an answer', () => {
    const out = inContainer(
      "fetch('https://example.com/', { signal: AbortSignal.timeout(5000) }).then((r) => console.log('answered', r.status), (e) => console.log('failed', e.cause?.code ?? e.message))",
    );
    expect(out).toMatch(/^failed /);
  });

  it("reports so through the runner's own probe, which every check depends on", () => {
    const health = JSON.parse(inContainer("fetch('http://127.0.0.1:8080/health').then((r) => r.text()).then(console.log)"));
    expect(health.network).toMatchObject({ closed: true, detail: expect.stringContaining('could not be reached') });
  });

  it('is started afresh for the next check after it stopped (the runner exits when its browser dies)', async () => {
    docker(['kill', checkContainer()]);
    const report = await check('after a stop', inMode('ok'), hostile.html);
    expect(report.ok).toBe(true);
    expect(report.cost.startMs).toBeGreaterThan(0);
  });
});
