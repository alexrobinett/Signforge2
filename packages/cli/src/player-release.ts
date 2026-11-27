#!/usr/bin/env tsx
/**
 * The player release workflow's build steps (#628), which need no secret: the job that runs them holds none, and the
 * job that signs, uploads and registers runs none of this repository's code (`.github/workflows/player-release.yml`).
 *
 *   player-release.ts pack <dist-dir> <out-dir> --version <n>
 *       <out>/release.tar.gz, the tarball as the contract states it, and <out>/manifest.json, the exact text to sign
 *   player-release.ts verify <out-dir> <public-key.pem>
 *       checks <out>/signature (base64) with WebCrypto, as the contract's test does (scripts/player-release-proof.sh)
 *
 * The tar is the same bytes for the same build: ustar, entries in path order with each directory before its first
 * file, mtime 0, no owner. The gzip around it has mtime 0 and no OS, but its deflate stream is zlib's, which may differ
 * between zlib builds: the same build packed on two machines may differ in its gzip bytes, never in what it unpacks to.
 */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  MAX_RELEASE_BYTES,
  MAX_RELEASE_FILES,
  MAX_RELEASE_PATH_LENGTH,
  parsePlayerReleaseManifest,
  PLAYER_RELEASE_FORMAT,
  RELEASE_PATH_SEGMENT,
  RESERVED_RELEASE_PATH,
  THIS_PLAYER,
  type PlayerPlays,
  type PlayerReleaseManifest,
} from '@signforge/contract';

/**
 * The supervisor level this player needs (`minSupervisor`). Supervisors are updated by hand, so raise it in the change
 * that makes the player depend on something a newer supervisor does.
 */
const MIN_SUPERVISOR = 1;

export interface ReleaseFile {
  path: string;
  bytes: Uint8Array;
}

const BLOCK = 512;
/** GNU tar's default: the archive is padded to a whole record of 20 blocks, as the contract's test vector is. */
const RECORD = 20 * BLOCK;

/** One ustar header: a path split at a `/` into prefix and name when it is past the name field's 100 bytes. */
function header(path: string, type: '0' | '5', size: number): Uint8Array {
  const h = new Uint8Array(BLOCK);
  const put = (at: number, text: string) => h.set(new TextEncoder().encode(text), at);
  const octal = (n: number, width: number) => `${n.toString(8).padStart(width - 1, '0')}\0`;
  let name = path;
  let prefix = '';
  if (name.length > 100) {
    const cut = path.lastIndexOf('/', 155);
    if (cut < 1 || path.length - cut - 1 > 100) throw new Error(`${path} is too long for a ustar header`);
    prefix = path.slice(0, cut);
    name = path.slice(cut + 1);
  }
  put(0, name);
  put(100, octal(type === '5' ? 0o755 : 0o644, 8));
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  put(124, octal(size, 12));
  put(136, octal(0, 12));
  put(148, ' '.repeat(8));
  put(156, type);
  put(257, 'ustar\0');
  put(263, '00');
  put(345, prefix);
  const sum = h.reduce((a, b) => a + b, 0);
  put(148, `${sum.toString(8).padStart(6, '0')}\0 `);
  return h;
}

/**
 * The release tarball of these files, in this order: `./`, then each file as `./<path>`, each directory it is in
 * coming just before the first file in it.
 */
export function tarball(files: readonly ReleaseFile[]): Uint8Array {
  const parts: Uint8Array[] = [header('./', '5', 0)];
  const made = new Set<string>();
  for (const f of files) {
    const segments = f.path.split('/');
    for (let i = 1; i < segments.length; i++) {
      const dir = segments.slice(0, i).join('/');
      if (!made.has(dir)) parts.push(header(`./${dir}/`, '5', 0));
      made.add(dir);
    }
    parts.push(header(`./${f.path}`, '0', f.bytes.byteLength), f.bytes, new Uint8Array((BLOCK - (f.bytes.byteLength % BLOCK)) % BLOCK));
  }
  const length = parts.reduce((n, p) => n + p.byteLength, 0) + 2 * BLOCK;
  const tar = new Uint8Array(Math.ceil(length / RECORD) * RECORD);
  let at = 0;
  for (const p of parts) {
    tar.set(p, at);
    at += p.byteLength;
  }
  const gz = gzipSync(tar, { level: 6 });
  // The gzip header's OS byte, which zlib sets to the machine it ran on: "unknown", as the contract's test vector has it.
  gz[9] = 0xff;
  return gz;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The manifest text to sign, its fields in the contract's order, refused if the contract would not read it. */
export function manifestText(files: readonly ReleaseFile[], tar: Uint8Array, version: number, createdAt: string, plays: PlayerPlays = THIS_PLAYER): string {
  const manifest: PlayerReleaseManifest = {
    format: PLAYER_RELEASE_FORMAT,
    minSupervisor: MIN_SUPERVISOR,
    version,
    sha256: sha256(tar),
    size: tar.byteLength,
    files: files.map((f) => ({ path: f.path, sha256: sha256(f.bytes) })),
    manifestSchemas: plays.manifestSchemas,
    protocols: plays.protocols,
    createdAt,
  };
  const read = parsePlayerReleaseManifest(manifest);
  if (!read.ok) throw new Error(`not a release manifest: ${read.problems.join('; ')}`);
  return JSON.stringify(manifest);
}

/**
 * Every file under `dir`, each directory's names in code point order, each path one the contract allows. Anything else in the build,
 * a link, a path the supervisor would refuse or more than a release may hold, stops the pack: here, not on a screen.
 */
export async function releaseFiles(dir: string): Promise<ReleaseFile[]> {
  const files: ReleaseFile[] = [];
  let total = 0;
  const walk = async (rel: string) => {
    for (const name of (await readdir(join(dir, rel))).toSorted()) {
      const path = rel ? `${rel}/${name}` : name;
      const stat = await lstat(join(dir, path));
      if (!RELEASE_PATH_SEGMENT.test(name)) throw new Error(`${path}: not a name a release may hold`);
      if (!rel && name === RESERVED_RELEASE_PATH) throw new Error(`${path}: ${RESERVED_RELEASE_PATH}/ is reserved for the screen's content`);
      if (path.length > MAX_RELEASE_PATH_LENGTH) throw new Error(`${path}: longer than ${MAX_RELEASE_PATH_LENGTH}`);
      if (stat.isDirectory()) await walk(path);
      else if (stat.isFile()) {
        total += stat.size;
        files.push({ path, bytes: await readFile(join(dir, path)) });
      } else throw new Error(`${path}: a release holds only files and directories`);
    }
  };
  await walk('');
  if (!files.length) throw new Error(`${dir} holds no files`);
  if (files.length > MAX_RELEASE_FILES) throw new Error(`${files.length} files: a release holds at most ${MAX_RELEASE_FILES}`);
  if (total > MAX_RELEASE_BYTES) throw new Error(`${total} bytes: a release holds at most ${MAX_RELEASE_BYTES}`);
  return files;
}

/** The contract's check of a release signature, by WebCrypto, against a PEM SPKI public key. */
export async function verifyManifest(text: string, signature: string, publicKeyPem: string): Promise<boolean> {
  const der = Buffer.from(publicKeyPem.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, ''), 'base64');
  const key = await crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, Buffer.from(signature, 'base64'), new TextEncoder().encode(text));
}

/** A release version from the command line: the workflow's run number. */
function versionOf(text: string | undefined): number {
  const n = Number(text);
  if (!text || !/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(n)) throw new Error(`not a release version: ${text}`);
  return n;
}

async function main([command, ...args]: string[]) {
  const at = (dir: string | undefined, file: string) => {
    if (!dir) throw new Error(`${command}: give the release directory`);
    return join(dir, file);
  };
  switch (command) {
    case 'pack': {
      const [dist, out, flag, version] = args;
      if (!dist || flag !== '--version') throw new Error('pack <dist-dir> <out-dir> --version <n>');
      const files = await releaseFiles(dist);
      const tar = tarball(files);
      await writeFile(at(out, 'release.tar.gz'), tar);
      await writeFile(at(out, 'manifest.json'), manifestText(files, tar, versionOf(version), new Date().toISOString()));
      return;
    }
    case 'verify': {
      const [dir, pub] = args;
      if (!pub) throw new Error('verify <out-dir> <public-key.pem>');
      const ok = await verifyManifest(
        await readFile(at(dir, 'manifest.json'), 'utf8'),
        await readFile(at(dir, 'signature'), 'utf8'),
        await readFile(pub, 'utf8'),
      );
      if (!ok) throw new Error(`the signature does not verify against ${pub}`);
      return;
    }
    default:
      throw new Error(`unknown command ${command}: pack or verify`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
