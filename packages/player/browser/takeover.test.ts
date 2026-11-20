/**
 * Takeovers (M3-19): a takeover cuts in as soon as a screen has it, and ends on time with no new data
 * and the network down. Every spot is an hour long, so only a cut can move a screen on within a test.
 * The page runs on Playwright's clock from a fixed instant; a takeover's end is reached by jumping
 * that clock, never by waiting on the machine's.
 */
import type { ScheduleEntry } from '@signforge/contract';
import { describe, expect, it } from 'vitest';
import { useHarness } from './harness';

const h = useHarness();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The page's clock starts at the next whole minute: after the player's build time, so the screen trusts it. */
const T0 = Math.ceil(Date.now() / MINUTE) * MINUTE + MINUTE;
const iso = (ms: number) => new Date(ms).toISOString();

/** The loop plays spot a. With `takeover`, that entry plays spot t, from playlist "takeover". */
const content = (takeover?: Pick<ScheduleEntry, 'startsAt' | 'endsAt'>) =>
  h.content([{ id: 'a', durationMs: HOUR }, ...(takeover ? [{ id: 't', durationMs: HOUR }] : [])], {
    edit: (m) => {
      m.playlists.main!.items = [{ spot: 'a' }];
      if (!takeover) return;
      m.playlists.takeover = { id: 'takeover', name: 'Takeover', transition: { type: 'cut' }, items: [{ spot: 't' }] };
      m.schedule = [{ id: 'tk', playlist: 'takeover', priority: 100, target: 'org', ...takeover }];
    },
  });

const played = (s: { log: { spot: string }[] }) => s.log.map((l) => l.spot);

describe('takeovers', () => {
  it('a takeover published mid-spot ends the spot on screen at once, not at its end', async () => {
    const p = await h.openPlayer((s) => s.publish(content()), {}, { clockAt: new Date(T0) });
    await p.until((s) => played(s).includes('a'));

    p.server.publish(content({ startsAt: iso(T0 - HOUR), endsAt: iso(T0 + 2 * HOUR) }));
    const s = await p.until((s) => played(s).includes('t'));
    expect(played(s)).toEqual(['a', 't']);
  });

  it('a takeover ends mid-spot at its end, with no new data and the network down', async () => {
    const p = await h.openPlayer((s) => s.publish(content({ startsAt: iso(T0 - HOUR), endsAt: iso(T0 + 30 * MINUTE) })), {}, { clockAt: new Date(T0) });
    await p.until((s) => played(s).includes('t'));
    p.server.intercept(/./, { status: 503 });

    await p.page.clock.fastForward(31 * MINUTE);
    const s = await p.until((s) => played(s).includes('a'));
    expect(played(s)).toEqual(['t', 'a']);
  });

  it('a takeover published to start later cuts in at its start, with no new data', async () => {
    const p = await h.openPlayer((s) => s.publish(content({ startsAt: iso(T0 + 30 * MINUTE), endsAt: iso(T0 + 2 * HOUR) })), {}, { clockAt: new Date(T0) });
    await p.until((s) => played(s).includes('a'));

    await p.page.clock.fastForward(31 * MINUTE);
    const s = await p.until((s) => played(s).includes('t'));
    expect(played(s)).toEqual(['a', 't']);
  });
});
