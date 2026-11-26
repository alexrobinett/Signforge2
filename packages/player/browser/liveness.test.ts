/** The supervisor restarts a hung kiosk when the player's beat stops (device/pi/supervisor.py). */
import { describe, expect, it } from 'vitest';
import { useHarness } from './harness';

const h = useHarness();

describe('the liveness beat', () => {
  it('posts /alive to the supervisor with its token, every few seconds', async () => {
    const p = await h.openPlayer((server) => server.publish(h.content([{ id: 'a', durationMs: 800 }])));
    const beats = () => p.server.requestsTo(/^\/supervisor\/alive$/);
    await expect.poll(() => beats().length, { timeout: 13_000, interval: 200 }).toBeGreaterThanOrEqual(2);
    expect(beats().map((r) => r.status)).toEqual(beats().map(() => 200));
    const [first, second] = beats();
    expect(second!.at - first!.at).toBeGreaterThan(4000);
  });

  it("says this build's version on each beat, and carries a release the supervisor rolled back on its next sync (#628)", async () => {
    const p = await h.openPlayer(
      (server) => {
        server.publish(h.content([{ id: 'a', durationMs: 800 }]));
        server.supervisorAlive = { failedRelease: { version: 42, reason: 'not-alive' } };
        // A sync a second, so one comes after the first beat.
        server.nextSyncS = 1;
        // Content on another origin is the API: the player syncs.
      },
      (server) => ({ content: `${server.localUrl}/content` }),
    );
    await expect.poll(() => p.server.beatVersions.length, { timeout: 13_000, interval: 200 }).toBeGreaterThanOrEqual(1);
    await expect.poll(() => p.server.syncs.at(-1)?.failedRelease, { timeout: 13_000, interval: 200 }).toEqual({ version: 42, reason: 'not-alive' });
    expect(p.server.beatVersions[0]).toBe(p.server.syncs.at(-1)!.player.version);
  });

  it('reports a reason it does not know as other, so its syncs carry no failure the server would refuse (#628)', async () => {
    const p = await h.openPlayer(
      (server) => {
        server.publish(h.content([{ id: 'a', durationMs: 800 }]));
        // A reason a newer supervisor may give, which this build's contract does not know.
        server.supervisorAlive = { failedRelease: { version: 42, reason: 'crashed' } };
        server.nextSyncS = 1;
      },
      (server) => ({ content: `${server.localUrl}/content` }),
    );
    await expect.poll(() => p.server.beatVersions.length, { timeout: 13_000, interval: 200 }).toBeGreaterThanOrEqual(1);
    await expect.poll(() => p.server.syncs.at(-1)?.failedRelease, { timeout: 13_000, interval: 200 }).toEqual({ version: 42, reason: 'other' });
  });
});
