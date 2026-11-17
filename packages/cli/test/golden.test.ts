/**
 * `sf build` on the example projects must keep producing exactly the manifests saved in
 * `golden/` (apart from when they were generated). This is what keeps the local publisher and
 * the server's compiler from drifting. After a deliberate change to the output, regenerate the
 * goldens and say why in the commit.
 *
 * Built template bundles are compared by key, not by bytes or size: their hash follows the minifier, which
 * renames variables whenever the SDK or contract code it bundles changes. The template build is
 * checked by its own budget and lint, not here. Everything that depends on a bundle's hash (the
 * manifest id, and the bundle's entry in `files`) is normalised the same way.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../../..');
const out = mkdtempSync(join(tmpdir(), 'sf-golden-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

type Manifest = { id?: string; templates: Record<string, { html: string }>; files: Record<string, unknown> };

/** Replace each template bundle's hash with a name derived from its key, and drop the id. */
function normalise(m: Manifest): Manifest {
  const names = new Map(Object.entries(m.templates).map(([key, t]) => [t.html, `<bundle ${key}>`]));
  // A bundle's size changes with any template edit, which is not compiler behaviour either.
  const files = Object.fromEntries(Object.entries(m.files).filter(([sha]) => !names.has(sha)));
  const json = JSON.stringify({ ...m, files, id: undefined }).replace(/[0-9a-f]{64}/g, (sha) => names.get(sha) ?? sha);
  return JSON.parse(json) as Manifest;
}

function build(project: string): Manifest {
  const dir = join(out, project);
  execFileSync(join(root, 'node_modules/.bin/tsx'), ['packages/cli/src/sf.ts', 'build', `examples/${project}`, '--out', dir], { cwd: root, stdio: 'pipe' });
  const { generatedAt: _at, ...manifest } = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  return normalise(manifest as unknown as Manifest);
}
const golden = (project: string) => normalise(JSON.parse(readFileSync(join(import.meta.dirname, 'golden', `${project}.json`), 'utf8')) as Manifest);

describe('sf build', () => {
  it('builds the demo project exactly as before', () => {
    expect(build('demo')).toEqual(golden('demo'));
  }, 60_000);

  // The stress project's photos and videos are generated (scripts/stress-media.sh), not committed.
  // Without them the test skips, and says so in the test name and on stderr, so a green run
  // never hides that the stress golden went unchecked.
  const stressMedia = existsSync(join(root, 'examples/stress/media/pan-1080p30.mp4'));
  if (!stressMedia) {
    process.stderr.write('\n*** golden.test.ts: SKIPPING the stress golden: examples/stress/media is missing. Run `sh scripts/stress-media.sh` to check it. ***\n\n');
  }
  const stressName = stressMedia ? 'builds the stress project exactly as before' : 'builds the stress project exactly as before (SKIPPED: no stress media, run scripts/stress-media.sh)';
  it.skipIf(!stressMedia)(stressName, () => {
    expect(build('stress')).toEqual(golden('stress'));
  }, 120_000);
});
