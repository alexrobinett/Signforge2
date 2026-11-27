import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { manifestText, releaseFiles, tarball, verifyManifest } from '../src/player-release';

const VECTOR = join(import.meta.dirname, '../../contract/test/player-release');
const vector: { publicKey: string; manifest: string; signature: string; tarball: string } = JSON.parse(await readFile(join(VECTOR, 'vector.json'), 'utf8'));
const testPub = await readFile(join(VECTOR, 'test-only.pub.pem'), 'utf8');
const vectorManifest = JSON.parse(vector.manifest);

/** The vector's two files, in the vector manifest's order, with the bytes its tarball holds. */
const vectorFiles = [
  { path: 'index.html', bytes: new TextEncoder().encode('<!doctype html><title>SignForge test release</title><script src="assets/index-abc.js"></script>\n') },
  { path: 'assets/index-abc.js', bytes: new TextEncoder().encode("console.log('test release');\n") },
];

describe('the release packer (#628)', () => {
  it("packs the contract's test vector's tar byte for byte, and describes its tarball as its manifest does", () => {
    const vectorTarball = Buffer.from(vector.tarball, 'base64');
    const tar = tarball(vectorFiles);
    // The tar inside is the same bytes. The deflate stream around it is zlib's and may differ between zlib builds
    // (Linux's packs 269 bytes where the vector's has 267), so only the gzip header is compared, not the whole file.
    expect(Buffer.compare(gunzipSync(tar), gunzipSync(vectorTarball))).toBe(0);
    expect(Buffer.from(tar.subarray(0, 10))).toEqual(vectorTarball.subarray(0, 10));
    // Given the vector's own tarball, the manifest is the vector's text exactly, so its signature holds.
    const text = manifestText(vectorFiles, vectorTarball, 1, vectorManifest.createdAt, { manifestSchemas: [8, 9], protocols: [1, 2] });
    expect(text).toBe(vector.manifest);
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
