/**
 * The supervisor restarts a hung kiosk when the player's beat stops (device/pi/supervisor.py). The page's clock stands
 * still and moves only as a test steps it, so no beat or sync depends on how fast this machine is.
 */
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import type { FixtureServer } from './fixture-server';
import { useHarness } from './harness';

const h = useHarness();
/** Any instant: the beat does not read the time. */
const NOW = Date.parse('2100-01-01T12:00:00.000Z');
/** The player's beat interval (ALIVE_MS in src/main.ts). */
const ALIVE_MS = 5000;

async function openPaused(setup: (server: FixtureServer) => void, query?: (server: FixtureServer) => Record<string, string>) {
  return h.openPlayer(setup, query ?? {}, { clockAt: new Date(NOW), before: (page: Page) => page.clock.pauseAt(NOW) });
}

/** Step the paused page clock a second at a time, at most `limitS` seconds of it, until `done`. */
async function stepUntil(page: Page, done: () => boolean, limitS: number) {
  for (let s = 0; s < limitS && !done(); s++) {
    await page.clock.runFor(1000);
    // Let what the step sent reach the fixture server: real time bounds only how soon the check sees it.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(done()).toBe(true);
}

describe('the liveness beat', () => {
  it('posts /alive to the supervisor with its token, every few seconds', async () => {
    const p = await openPaused((server) => server.publish(h.content([{ id: 'a', durationMs: 800 }])));
    const beats = () => p.server.requestsTo(/^\/supervisor\/alive$/);
    // Three intervals of the page's time, and no more: exactly three beats, whatever this machine's speed.
    for (let n = 1; n <= 3; n++) {
      await p.page.clock.runFor(ALIVE_MS);
      await expect.poll(() => beats().length, { timeout: 10_000, interval: 50 }).toBeGreaterThanOrEqual(n);
    }
    expect(beats().length).toBe(3);
    expect(beats().map((r) => r.status)).toEqual([200, 200, 200]);
  });

  it("says this build's version on each beat, and carries a release the supervisor rolled back on its next sync (#628)", async () => {
    const p = await openPaused(
      (server) => {
        server.publish(h.content([{ id: 'a', durationMs: 800 }]));
        server.supervisorAlive = { failedRelease: { version: 42, reason: 'not-alive' } };
        // A sync a second, so one comes after the first beat.
        server.nextSyncS = 1;
      },
      // Content on another origin is the API: the player syncs.
      (server) => ({ content: `${server.localUrl}/content` }),
    );
    const reported = () => p.server.syncs.at(-1)?.failedRelease?.reason === 'not-alive';
    await stepUntil(p.page, reported, 60);
    expect(p.server.syncs.at(-1)?.failedRelease).toEqual({ version: 42, reason: 'not-alive' });
    expect(p.server.beatVersions[0]).toBe(p.server.syncs.at(-1)!.player.version);
  });

  it('reports a reason it does not know as other, so its syncs carry no failure the server would refuse (#628)', async () => {
    const p = await openPaused(
      (server) => {
        server.publish(h.content([{ id: 'a', durationMs: 800 }]));
        // A reason a newer supervisor may give, which this build's contract does not know.
        server.supervisorAlive = { failedRelease: { version: 42, reason: 'crashed' } };
        server.nextSyncS = 1;
      },
      (server) => ({ content: `${server.localUrl}/content` }),
    );
    await stepUntil(p.page, () => p.server.syncs.at(-1)?.failedRelease !== undefined, 60);
    expect(p.server.syncs.at(-1)?.failedRelease).toEqual({ version: 42, reason: 'other' });
  });
});
