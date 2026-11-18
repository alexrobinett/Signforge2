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
});
