// Video tools: a multipart upload to R2, and the server's check of what landed, over range reads.
// The clips are media-check's, made by ffmpeg. Parts are uploaded through the R2 binding here; the
// browser's presigned PUTs to the S3 API are in test/e2e/upload.test.ts.
import { scoped } from '@signforge/db';
import { claimFileForSweep, seedOrg, type SeededOrg, tombstoneFile } from '@signforge/db/testing';
import { EXPORT_ADVICE } from '@signforge/media-check';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { dispatch, orgBlobKey, r2Presigner, registry, uploadKey, type Caller } from '../src';
import { racing } from './calls';
import { memberOf } from './member';

// These tests upload, complete and re-hash multi-megabyte videos in workerd: several seconds each
// on a CI runner, past vitest's 5 s default.
vi.setConfig({ testTimeout: 30_000 });

let o: SeededOrg;
let owner: Caller;

const call = async <T = any>(name: string, input: unknown): Promise<T> => {
  const r = await dispatch(registry, name, input, owner);
  if (!r.ok) throw new Error(`${name}: ${r.error}: ${r.message}`);
  return r.output as T;
};
const run = (name: string, input: unknown) => dispatch(registry, name, input, owner);
const tombstone = (sha: string, at: number) => tombstoneFile(env.DB, o.orgId, sha, at);

const clips: Record<string, string> = JSON.parse(env.VIDEO_CLIPS);
const clip = (name: string) => Uint8Array.from(atob(clips[name]!), (c) => c.charCodeAt(0));
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (b: Uint8Array) => hex(await crypto.subtle.digest('SHA-256', b));

/** The clip followed by a top-level `free` box, so it spans more than one part. Players skip it. */
function padded(bytes: Uint8Array, extra: number): Uint8Array {
  const out = new Uint8Array(bytes.length + extra);
  out.set(bytes);
  new DataView(out.buffer).setUint32(bytes.length, extra);
  out.set([0x66, 0x72, 0x65, 0x65], bytes.length + 4);
  return out;
}

interface Created {
  asset: { id: string; status: string };
  upload: { uploadId: string; partBytes: number; parts: { partNumber: number; url: string; size: number }[] } | null;
}

/** Create the upload and PUT its parts as the browser would, through the binding. */
async function upload(name: string, bytes: Uint8Array, claim: { sha256?: string } = {}) {
  const sha = claim.sha256 ?? (await sha256(bytes));
  const created = await call<Created>('start_upload', { kind: 'video', name, sha256: sha, type: 'video/mp4', size: bytes.length });
  const parts: { partNumber: number; etag: string }[] = [];
  if (created.upload) {
    const mp = env.BLOBS.resumeMultipartUpload(uploadKey(o.orgId, created.asset.id, sha), created.upload.uploadId);
    for (const p of created.upload.parts) {
      const start = (p.partNumber - 1) * created.upload.partBytes;
      parts.push(await mp.uploadPart(p.partNumber, bytes.slice(start, start + p.size)));
    }
  }
  return { created, sha, parts, uploadId: created.upload?.uploadId };
}

beforeAll(async () => {
  o = await seedOrg(env.DB, 'videos-org');
  owner = memberOf(scoped(env.DB, o.orgId), 'owner', {
    uploads: r2Presigner({
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      bucket: 'signforge-test',
      accessKeyId: 'AKID',
      secretAccessKey: 'secret',
      now: () => Date.UTC(2026, 10, 18, 12),
    }),
  });
});

describe('start_upload, a video', () => {
  it('creates a pending video asset and a signed UploadPart URL per 16 MiB part', async () => {
    const bytes = padded(clip('high.mp4'), 40 * 1024 * 1024);
    const created = await call<Created>('start_upload', { kind: 'video', name: 'Promo', sha256: await sha256(bytes), type: 'video/mp4', size: bytes.length });
    expect(created.asset).toMatchObject({ status: 'pending', renditions: [] });
    const up = created.upload!;
    expect(up.partBytes).toBe(16 * 1024 * 1024);
    expect(up.parts.map((p) => p.size)).toEqual([up.partBytes, up.partBytes, bytes.length - 2 * up.partBytes]);
    const url = new URL(up.parts[1]!.url);
    expect(url.pathname).toBe(`/signforge-test/${uploadKey(o.orgId, created.asset.id, await sha256(bytes))}`);
    expect(url.searchParams.get('partNumber')).toBe('2');
    expect(url.searchParams.get('uploadId')).toBe(up.uploadId);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
  });

  it('refuses a file over the size cap before anything is stored', async () => {
    const r = await run('start_upload', { kind: 'video', name: 'Huge', sha256: 'a'.repeat(64), type: 'video/mp4', size: 500_000_001 });
    expect(r).toMatchObject({ ok: false, error: 'invalid_input', details: [{ path: 'size', message: 'a video may be at most 500 MB' }] });
  });

  it('refuses a file the storage sweep has claimed for deletion (#235)', async () => {
    const sha = 'c'.repeat(64);
    const at = Date.UTC(2026, 4, 1, 9);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at);
    try {
      await claimFileForSweep(env.DB, o.orgId, sha, at + 60_000);
      expect(await run('start_upload', { kind: 'video', name: 'Claimed', sha256: sha, type: 'video/mp4', size: 1000 })).toMatchObject({
        ok: false,
        error: 'conflict',
        message: expect.stringContaining('storage clean-up'),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses a held file only if the sweep has not deleted it, and its finish clears an older tombstone (review of #434, 3, 4)', async () => {
    const at = Date.UTC(2026, 4, 1, 9);
    vi.useFakeTimers({ toFake: ['Date'], now: at });
    try {
      const bytes = clip('high.mp4');
      const sha = await sha256(bytes);
      await env.BLOBS.put(orgBlobKey(o.orgId, sha), bytes);
      const input = (name: string) => ({ kind: 'video', name, sha256: sha, type: 'video/mp4', size: bytes.length });
      // Held: no upload. The sweep deletes it between the read and the commit: refused.
      const raced = racing(owner, () => tombstone(sha, at));
      expect(await dispatch(registry, 'start_upload', input('Raced'), raced)).toMatchObject({ ok: false, error: 'conflict' });
      // Deleted, though a copy is back: uploaded again all the same.
      const again = await call<Created>('start_upload', input('Again'));
      expect(again.upload).not.toBeNull();
      // Finished from the copy now held, read after the tombstone was stamped: verified, and the tombstone goes.
      await tombstone(sha, at - 1);
      expect((await call('finalize_upload', { assetId: again.asset.id })).asset.status).toBe('verified');
      expect(await scoped(env.DB, o.orgId).storage.deleted([sha], at)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('finalize_upload, a video', () => {
  it('completes a two-part upload, checks the header, re-hashes and stores it under its hash', async () => {
    const bytes = padded(clip('high.mp4'), 20 * 1024 * 1024);
    const { created, sha, parts, uploadId } = await upload('Two parts', bytes);
    expect(parts).toHaveLength(2);
    const done = await call('finalize_upload', { assetId: created.asset.id, uploadId, parts });
    expect(done).toMatchObject({
      changed: true,
      asset: { kind: 'video', status: 'verified', width: 320, height: 180, durationMs: 1000, sha256: sha, size: bytes.length },
    });
    const stored = await env.BLOBS.get(orgBlobKey(o.orgId, sha));
    expect(await sha256(new Uint8Array(await stored!.arrayBuffer()))).toBe(sha);
    expect(await env.BLOBS.head(uploadKey(o.orgId, created.asset.id, sha))).toBeNull();
    // Again: nothing changes.
    expect(await call('finalize_upload', { assetId: created.asset.id })).toMatchObject({ changed: false });
  });

  it('reads a moov at the end of the file', async () => {
    const { created, parts, uploadId } = await upload('Moov last', clip('main-moov-at-end.mp4'));
    expect(await call('finalize_upload', { assetId: created.asset.id, uploadId, parts })).toMatchObject({ asset: { status: 'verified' } });
  });

  it('rejects a 60 fps video, deletes it, and says how to export one that passes', async () => {
    const { created, sha, parts, uploadId } = await upload('Too fast', clip('fps60.mp4'));
    const r = await run('finalize_upload', { assetId: created.asset.id, uploadId, parts });
    expect(r).toMatchObject({ ok: false, error: 'invalid_input', details: [{ path: 'fps', message: '60 fps is above 30' }] });
    expect(r.ok ? '' : r.message).toBe(`the video was rejected and deleted: 60 fps is above 30. ${EXPORT_ADVICE}`);
    expect(await env.BLOBS.head(uploadKey(o.orgId, created.asset.id, sha))).toBeNull();
    expect(await env.BLOBS.head(orgBlobKey(o.orgId, sha))).toBeNull();
    expect(await call('get_asset', { assetId: created.asset.id })).toMatchObject({ asset: { status: 'rejected' } });
    // Found under the tool it replaced, as a finish that passed is (review of #516).
    const { entries } = await call('list_audit_log', { action: 'finalize_video_upload' });
    expect(entries.map((e: { target: { id: string } }) => e.target.id)).toContain(created.asset.id);
  });

  it('rejects bytes that do not hash to the claimed SHA-256', async () => {
    const claimed = 'b'.repeat(64);
    const { created, parts, uploadId } = await upload('Forged', clip('high.mp4'), { sha256: claimed });
    const r = await run('finalize_upload', { assetId: created.asset.id, uploadId, parts });
    expect(r).toMatchObject({ ok: false, details: [{ path: 'sha256' }] });
    expect(await env.BLOBS.head(orgBlobKey(o.orgId, claimed))).toBeNull();
  });

  it('refuses parts R2 cannot complete without changing anything, then completes on a retry', async () => {
    const bytes = padded(clip('high.mp4'), 21 * 1024 * 1024);
    const { created, parts, uploadId } = await upload('Retry', bytes);
    const tries = [parts.slice(1), [parts[0]!, { ...parts[1]!, etag: '"not-it"' }]];
    for (const tried of tries) {
      const r = await run('finalize_upload', { assetId: created.asset.id, uploadId, parts: tried });
      expect(r).toMatchObject({ ok: false, error: 'invalid_input', details: [{ path: 'parts' }] });
    }
    expect(await call('get_asset', { assetId: created.asset.id })).toMatchObject({ asset: { status: 'pending' } });
    expect(await call('finalize_upload', { assetId: created.asset.id, uploadId, parts })).toMatchObject({ asset: { status: 'verified' } });
  });

  it('refuses a file not uploaded yet without changing anything', async () => {
    const bytes = clip('fps60.mp4').slice();
    bytes[bytes.length - 1]! ^= 1;
    const created = await call<Created>('start_upload', { kind: 'video', name: 'Not yet', sha256: await sha256(bytes), type: 'video/mp4', size: bytes.length });
    expect(await run('finalize_upload', { assetId: created.asset.id })).toMatchObject({ ok: false, error: 'invalid_input', message: 'not uploaded yet' });
    expect(await call('get_asset', { assetId: created.asset.id })).toMatchObject({ asset: { status: 'pending' } });
  });

  it('needs no upload for a file the org already holds, and checks it from there', async () => {
    const bytes = padded(clip('high.mp4'), 20 * 1024 * 1024);
    const sha = await sha256(bytes);
    // The two-part test above stored these bytes.
    expect(await env.BLOBS.head(orgBlobKey(o.orgId, sha))).not.toBeNull();
    const created = await call<Created>('start_upload', { kind: 'video', name: 'Again', sha256: sha, type: 'video/mp4', size: bytes.length });
    expect(created.upload).toBeNull();
    expect(await call('finalize_upload', { assetId: created.asset.id })).toMatchObject({ asset: { status: 'verified', width: 320 } });
  });

  it("renews no video's upload: a video's upload is started again (#345)", async () => {
    const { created } = await upload('Wrong tool', clip('main-moov-at-end.mp4'));
    expect(await run('start_upload', { kind: 'image', assetId: created.asset.id })).toMatchObject({ ok: false, error: 'conflict' });
  });

  it('deletes a pending video with its upload', async () => {
    const { created, sha, parts, uploadId } = await upload('Abandoned', padded(clip('high.mp4'), 64));
    await env.BLOBS.resumeMultipartUpload(uploadKey(o.orgId, created.asset.id, sha), uploadId!).complete(parts);
    await call('delete', { type: 'asset', id: created.asset.id });
    expect(await env.BLOBS.head(uploadKey(o.orgId, created.asset.id, sha))).toBeNull();
  });
});
