/**
 * `sf build` on the example projects must keep producing exactly the manifests saved in
 * `golden/` (apart from when they were generated). This is what keeps the local publisher and
 * the server's compiler from drifting. After a deliberate change to the output, regenerate the
 * goldens and say why in the commit.
 *
 * Built template bundles are compared by key, not by bytes or size: their hash follows the minifier, which
 * renames variables whenever the SDK or contract code it bundles changes. The template build is
 * checked by its own budget and lint, and its bytes by templates.test.ts, not here. The bundle's entry in `files` is normalised the
 * same way.
 *
 * The id is compared too. A golden's stored id must be the hash of its own body, so a test can
 * compare a server-compiled manifest with the golden directly (packages/tools publishing.test.ts),
 * and the build's id, with the golden's bundle hashes put in for its own, must be the golden's.
 *
 * Images `sf build` scales (sharp, so libvips) differ by a few bytes between macOS and Linux, so
 * a derived file, one that is not a byte-for-byte copy of a file in the project, is compared by
 * where the manifest uses it, like a bundle, and an image's sample by the image it samples. The
 * sources themselves keep their hashes.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifestIdInput, type ScreenManifest } from '@signforge/contract';
import { afterAll, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../../..');
const out = mkdtempSync(join(tmpdir(), 'sf-golden-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

type Manifest = {
  id?: string;
  spots?: unknown;
  templates: Record<string, { html: string }>;
  files: Record<string, { size: number; type: string; sample?: string }>;
};

const idOf = (m: Manifest) =>
  createHash('sha256')
    .update(manifestIdInput(m as unknown as ScreenManifest))
    .digest('hex');

/** The sha256 of every file under a project: what a manifest may carry unchanged. */
function sourceShas(project: string): Set<string> {
  const dir = join(root, 'examples', project);
  const shas = new Set<string>();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile())
      shas.add(
        createHash('sha256')
          .update(readFileSync(join(entry.parentPath, entry.name)))
          .digest('hex'),
      );
  }
  return shas;
}

/** A stable name for each bundle and derived file: the template key, where the spots first use it, or the image it samples. */
function stableNames(m: Manifest, sources: Set<string>): Map<string, string> {
  const names = new Map(Object.entries(m.templates).map(([key, t]) => [t.html, `<bundle ${key}>`]));
  const visit = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (m.files[value] && !names.has(value) && !sources.has(value)) names.set(value, `<derived ${path}>`);
    } else if (Array.isArray(value)) value.forEach((v, i) => visit(v, `${path}[${i}]`));
    else if (value && typeof value === 'object') {
      for (const key of Object.keys(value).sort()) visit((value as Record<string, unknown>)[key], `${path}.${key}`);
    }
  };
  visit(m.spots, 'spots');
  for (const [sha, f] of Object.entries(m.files)) if (f.sample) names.set(f.sample, `<sample of ${names.get(sha) ?? sha}>`);
  return names;
}

/** `built` with `golden`'s hash and size for each bundle and derived file they share by name, and its id recomputed. */
function withFilesOf(built: Manifest, golden: Manifest, sources: Set<string>): Manifest {
  const goldenByName = new Map([...stableNames(golden, sources)].map(([sha, name]) => [name, sha]));
  let json = JSON.stringify(built);
  const files = { ...built.files };
  for (const [sha, name] of stableNames(built, sources)) {
    const g = goldenByName.get(name);
    if (!g || g === sha) continue;
    delete files[sha];
    if (golden.files[g]) files[g] = golden.files[g]!;
    json = json.replaceAll(sha, g);
  }
  const m = { ...(JSON.parse(json) as Manifest), files };
  return { ...m, id: idOf(m) };
}

/** Build a project and check its id against the golden's; returns both, normalised, to compare bodies. */
function check(project: string): { built: Manifest; expected: Manifest } {
  const built = buildRaw(project);
  const stored = storedGolden(project);
  const sources = sourceShas(project);
  expect(stored.id, `golden/${project}.json: its id is not the hash of its body; regenerate it`).toBe(idOf(stored));
  expect(built.id, 'the build: id is not the hash of its body').toBe(idOf(built));
  expect(withFilesOf(built, stored, sources).id, 'the build, with the golden bundles and derived files, has another id than the golden').toBe(stored.id);
  return { built: normalise(built, sources), expected: normalise(stored, sources) };
}

/** Replace each bundle's and derived file's hash with its stable name, drop their sizes, and drop the id. */
function normalise(m: Manifest, sources: Set<string>): Manifest {
  const names = stableNames(m, sources);
  // A bundle's size changes with any template edit, and a scaled image's with the platform's libvips.
  const files = Object.fromEntries(Object.entries(m.files).map(([sha, f]) => [sha, names.has(sha) ? { type: f.type } : f]));
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

/** Why examples/stress/media is not the set listed in examples/stress/media.sha256, if it is not. */
function stressMediaMismatch(): string | undefined {
  const dir = join(root, 'examples/stress');
  for (const line of readFileSync(join(dir, 'media.sha256'), 'utf8').trim().split('\n')) {
    const [sha, name] = line.split(/ +/);
    const file = join(dir, 'media', name!);
    if (!existsSync(file)) return `examples/stress/media/${name} is missing`;
    if (createHash('sha256').update(readFileSync(file)).digest('hex') !== sha) return `examples/stress/media/${name} is not the canonical file`;
  }
  return undefined;
}

describe('sf build', () => {
  it('builds the demo project exactly as before', () => {
    const { built, expected } = check('demo');
    expect(built).toEqual(expected);
  }, 60_000);

  // The stress project's photos and video are not in git: scripts/stress-media.sh fetches the
  // canonical set, which the golden was built from. Without exactly that set the stress golden
  // cannot be checked. In CI that fails; elsewhere the test skips, and says so in the test name and
  // on stderr, so a green run never hides that the stress golden went unchecked.
  const stressMediaProblem = stressMediaMismatch();
  const skipStress = stressMediaProblem !== undefined && !process.env.CI;
  if (skipStress) {
    process.stderr.write(`\n*** golden.test.ts: SKIPPING the stress golden: ${stressMediaProblem}. Run \`sh scripts/stress-media.sh\` to check it. ***\n\n`);
  }
  const stressName = skipStress
    ? 'builds the stress project exactly as before (SKIPPED: not the canonical stress media, run scripts/stress-media.sh)'
    : 'builds the stress project exactly as before';
  it.skipIf(skipStress)(
    stressName,
    () => {
      expect(stressMediaProblem, 'run `sh scripts/stress-media.sh`').toBeUndefined();
      const { built, expected } = check('stress');
      expect(built).toEqual(expected);
    },
    120_000,
  );
});
