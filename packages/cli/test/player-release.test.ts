import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { canaryReport, manifestText, releaseFiles, signManifest, tarball, verifyManifest } from '../src/player-release';

const VECTOR = join(import.meta.dirname, '../../contract/test/player-release');
const vector: { publicKey: string; manifest: string; signature: string; tarball: string } = JSON.parse(await readFile(join(VECTOR, 'vector.json'), 'utf8'));
const testKey = await readFile(join(VECTOR, 'test-only.key.pem'), 'utf8');
const testPub = await readFile(join(VECTOR, 'test-only.pub.pem'), 'utf8');
const vectorManifest = JSON.parse(vector.manifest);

/** The vector's two files, in the vector manifest's order, with the bytes its tarball holds. */
const vectorFiles = [
  { path: 'index.html', bytes: new TextEncoder().encode('<!doctype html><title>SignForge test release</title><script src="assets/index-abc.js"></script>\n') },
  { path: 'assets/index-abc.js', bytes: new TextEncoder().encode("console.log('test release');\n") },
];

describe('the release packer (#628)', () => {
  it("packs, describes and signs the contract's test vector byte for byte", () => {
    const tar = tarball(vectorFiles);
    expect(Buffer.from(tar).toString('base64')).toBe(vector.tarball);
    const text = manifestText(vectorFiles, tar, 1, vectorManifest.createdAt, { manifestSchemas: [8, 9], protocols: [1, 2] });
    expect(text).toBe(vector.manifest);
    // Ed25519 is deterministic: the test key signs the same text to the same signature.
    expect(signManifest(text, testKey)).toBe(vector.signature);
  });

  it("verifies as the contract's test does, and refuses a changed byte", async () => {
    expect(await verifyManifest(vector.manifest, vector.signature, testPub)).toBe(true);
    expect(await verifyManifest(vector.manifest.replace('"version":1', '"version":2'), vector.signature, testPub)).toBe(false);
  });

  it('reads a build: each directory in name order, files only, and a directory before the files in it', async () => {
    const dist = await mkdtemp(join(tmpdir(), 'sf-release-'));
    await mkdir(join(dist, 'assets'));
    await writeFile(join(dist, 'index.html'), 'page');
    await writeFile(join(dist, 'assets/b.js'), 'b');
    await writeFile(join(dist, 'assets/a.js'), 'a');
    await writeFile(join(dist, 'assets-map.txt'), 'map');
    const files = await releaseFiles(dist);
    expect(files.map((f) => f.path)).toEqual(['assets/a.js', 'assets/b.js', 'assets-map.txt', 'index.html']);
    const tar = gunzipSync(tarball(files));
    const names = Array.from({ length: 7 }, (_, i) => i).reduce<{ at: number; names: string[] }>(
      ({ at, names }) => {
        const size = Number.parseInt(tar.subarray(at + 124, at + 135).toString(), 8);
        return {
          at: at + 512 + Math.ceil(size / 512) * 512,
          names: [
            ...names,
            tar
              .subarray(at, at + 100)
              .toString()
              .replace(/\0.*$/s, ''),
          ],
        };
      },
      { at: 0, names: [] },
    ).names;
    expect(names).toEqual(['./', './assets/', './assets/a.js', './assets/b.js', './assets-map.txt', './index.html', '']);
    expect(Buffer.compare(tarball(files), tarball(await releaseFiles(dist)))).toBe(0);
  });

  it("stops at what the supervisor would refuse: a link, content/, a name outside the contract's", async () => {
    const make = async (build: (dir: string) => Promise<void>) => {
      const dir = await mkdtemp(join(tmpdir(), 'sf-release-'));
      await writeFile(join(dir, 'index.html'), 'page');
      await build(dir);
      return releaseFiles(dir);
    };
    await expect(make((d) => symlink('index.html', join(d, 'link.html')))).rejects.toThrow('link.html: a release holds only files and directories');
    await expect(make(async (d) => mkdir(join(d, 'content')))).rejects.toThrow('content: content/ is reserved');
    await expect(make((d) => writeFile(join(d, 'a b.js'), ''))).rejects.toThrow('a b.js: not a name a release may hold');
  });
});

describe('the canary report (#628)', () => {
  const HOUR = 3_600_000;
  it('says of each canary what it runs, for how long, what it rolled back and when it last synced', () => {
    const rows = [
      { id: 'scr_1', lastSeenAt: 10 * HOUR - 120_000, release: 7, releaseSince: 4 * HOUR, failedReleases: null },
      { id: 'scr_2', lastSeenAt: null, release: 6, releaseSince: null, failedReleases: '[{"version":7,"reason":"not-alive"}]' },
    ];
    expect(canaryReport(rows, 7, 10 * HOUR)).toBe(
      [
        'Canary screens, for release 7:\n',
        '| Screen | Runs release | For | Rolled back | Last sync |',
        '| --- | --- | --- | --- | --- |',
        '| scr_1 | **7** | 6 h |  | 2 min ago |',
        '| scr_2 | 6 |  | **rolled 7 back (not-alive)** | never |',
        '',
      ].join('\n'),
    );
    expect(canaryReport([], 7, 0)).toBe('No screen is on the canary channel: release 7 has run nowhere yet.\n');
  });
});
