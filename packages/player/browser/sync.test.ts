import { describe, expect, it } from 'vitest';
import { useHarness } from './harness';

const h = useHarness();
const BLOBS = /^\/content\/blobs\//;
const MANIFEST = /^\/content\/manifest\.json$/;

describe('content sync', () => {
  it('abandons a stalled download after the stall timeout, and recovers', async () => {
    const content = h.content([{ id: 'a' }]);
    let release = () => {};
    // The player's stall timeout is 30 s; `?stall=1` makes it 1 s so the test is quick.
    const p = await h.openPlayer((s) => {
      s.publish(content);
      release = s.intercept(BLOBS, 'stall');
    }, { stall: '1' });

    await expect.poll(() => p.server.requestsTo(BLOBS).find((r) => r.abortedAt), { timeout: 10_000 }).toBeTruthy();
    const stalled = p.server.requestsTo(BLOBS).find((r) => r.abortedAt)!;
    const waited = stalled.abortedAt! - stalled.at;
    expect(waited).toBeGreaterThanOrEqual(900);
    expect(waited).toBeLessThan(5000);
    await expect.poll(() => p.page.locator('#status').textContent()).toContain('download stalled');
    expect((await p.state()).manifestId).toBe('');

    release();
    const s = await p.until((s) => s.log.length >= 1);
    expect(s.manifestId).toBe(content.manifest.id);
  });

  it('changes nothing when a manifest poll answers 304', async () => {
    const content = h.content([
      { id: 'a', durationMs: 600 },
      { id: 'b', durationMs: 600 },
    ]);
    const p = await h.openPlayer((s) => s.publish(content));
    const before = await p.until((s) => s.log.length >= 1);
    const blobRequests = p.server.requestsTo(BLOBS).length;
    const notModified = () => p.server.requestsTo(MANIFEST).filter((r) => r.status === 304 && r.ifNoneMatch === `"${content.manifest.id}"`).length;
    const seen = notModified();

    await expect.poll(notModified, { timeout: 10_000 }).toBeGreaterThanOrEqual(seen + 3);
    const after = await p.state();
    expect(after.manifestId).toBe(before.manifestId);
    expect(after.online).toBe(true);
    expect(after.lastError).toBe('');
    expect(after.played).toBeGreaterThan(before.played);
    expect(p.server.requestsTo(BLOBS).length).toBe(blobRequests);
    expect(p.console.filter((l) => l.includes('[sf] manifest')).length).toBe(1);
  });

  it('adopts a newly published manifest at the next poll', async () => {
    const first = h.content([{ id: 'a', durationMs: 600 }]);
    const p = await h.openPlayer((s) => s.publish(first));
    await p.until((s) => s.manifestId === first.manifest.id && s.log.length >= 1);

    const second = h.content([{ id: 'b', durationMs: 600 }]);
    p.server.publish(second);
    const s = await p.until((s) => s.log.at(-1)?.spot === 'b');
    expect(s.manifestId).toBe(second.manifest.id);
    expect(s.log.at(-1)!.manifest).toBe(second.manifest.id);
  });
});
