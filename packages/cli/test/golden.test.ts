/**
 * `sf build` on the example projects must keep producing exactly the manifests saved in
 * `golden/` (apart from when they were generated). This is what keeps the local publisher and
 * the server's compiler from drifting. After a deliberate change to the output, regenerate the
 * goldens and say why in the commit.
 *
 * Built template bundles are compared by key, not by bytes or size: their hash follows the minifier, which
 * renames variables whenever the SDK or contract code it bundles changes. The template build is
 * checked by its own budget and lint, not here. The bundle's entry in `files` is normalised the
 * same way.
 *
 * The id is compared too. A golden's stored id must be the hash of its own body, so a test can
 * compare a server-compiled manifest with the golden directly (packages/tools publishing.test.ts),
 * and the build's id, with the golden's bundle hashes put in for its own, must be the golden's.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifestIdInput, type ScreenManifest } from '@signforge/contract';
import { afterAll, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../../..');
const out = mkdtempSync(join(tmpdir(), 'sf-golden-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

type Manifest = { id?: string; templates: Record<string, { html: string }>; files: Record<string, { size: number; type: string }> };

const idOf = (m: Manifest) =>
  createHash('sha256')
    .update(manifestIdInput(m as unknown as ScreenManifest))
    .digest('hex');

/** `built` with `golden`'s bundle hash and size for each template it shares, and its id recomputed. */
function withBundlesOf(built: Manifest, golden: Manifest): Manifest {
  let json = JSON.stringify(built);
  const files = { ...built.files };
  for (const [key, t] of Object.entries(built.templates)) {
    const g = golden.templates[key]?.html;
    if (!g || g === t.html) continue;
    delete files[t.html];
    if (golden.files[g]) files[g] = golden.files[g]!;
    json = json.replaceAll(t.html, g);
  }
  const m = { ...(JSON.parse(json) as Manifest), files };
  return { ...m, id: idOf(m) };
}

/** Build a project and check its id against the golden's; returns both, normalised, to compare bodies. */
function check(project: string): { built: Manifest; expected: Manifest } {
  const built = buildRaw(project);
  const stored = storedGolden(project);
  expect(stored.id, `golden/${project}.json: its id is not the hash of its body; regenerate it`).toBe(idOf(stored));
  expect(built.id, 'the build: id is not the hash of its body').toBe(idOf(built));
  expect(withBundlesOf(built, stored).id, 'the build, with the golden bundles, has another id than the golden').toBe(stored.id);
  return { built: normalise(built), expected: normalise(stored) };
}

/** Replace each template bundle's hash with a name derived from its key, and drop the id. */
function normalise(m: Manifest): Manifest {
  const names = new Map(Object.entries(m.templates).map(([key, t]) => [t.html, `<bundle ${key}>`]));
  // A bundle's size changes with any template edit, which is not compiler behaviour either.
  const files = Object.fromEntries(Object.entries(m.files).filter(([sha]) => !names.has(sha)));
  const json = JSON.stringify({ ...m, files, id: undefined }).replace(/[0-9a-f]{64}/g, (sha) => names.get(sha) ?? sha);
  return JSON.parse(json) as Manifest;
}

function buildRaw(project: string): Manifest {
  const dir = join(out, project);
  execFileSync(join(root, 'node_modules/.bin/tsx'), ['packages/cli/src/sf.ts', 'build', `examples/${project}`, '--out', dir], { cwd: root, stdio: 'pipe' });
  const { generatedAt: _at, ...manifest } = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  return manifest as unknown as Manifest;
}
const storedGolden = (project: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'golden', `${project}.json`), 'utf8')) as Manifest;

describe('sf build', () => {
  it('builds the demo project exactly as before', () => {
    const { built, expected } = check('demo');
    expect(built).toEqual(expected);
  }, 60_000);

  // The stress project's photos and videos are generated (scripts/stress-media.sh), not committed.
  // Without them the test skips, and says so in the test name and on stderr, so a green run
  // never hides that the stress golden went unchecked.
  const stressMedia = existsSync(join(root, 'examples/stress/media/pan-1080p30.mp4'));
  if (!stressMedia) {
    process.stderr.write(
      '\n*** golden.test.ts: SKIPPING the stress golden: examples/stress/media is missing. Run `sh scripts/stress-media.sh` to check it. ***\n\n',
    );
  }
  const stressName = stressMedia
    ? 'builds the stress project exactly as before'
    : 'builds the stress project exactly as before (SKIPPED: no stress media, run scripts/stress-media.sh)';
  it.skipIf(!stressMedia)(
    stressName,
    () => {
      const { built, expected } = check('stress');
      expect(built).toEqual(expected);
    },
    120_000,
  );
});
