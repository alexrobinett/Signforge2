/**
 * Takeovers (M3-19): a takeover cuts in as soon as a screen has it, and ends on time with no new data
 * and the network down. Every spot is an hour long, so only a cut can move a screen on within a test.
 * The page runs on Playwright's clock from a fixed instant; a takeover's end is reached by jumping
 * that clock, never by waiting on the machine's.
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { type FieldDef, type ScheduleEntry, type TemplateManifest, templateKey } from '@signforge/contract';
import { buildTemplate } from '@signforge/cli/template';
import { beforeAll, describe, expect, it } from 'vitest';
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

let alert: { html: string; manifest: TemplateManifest };
beforeAll(async () => {
  alert = await buildTemplate(resolve(import.meta.dirname, '../../../templates/alert'));
}, 60_000);

/** The loop plays spot a; the takeover plays spot t, the shipped Alert template (#200) with its defaults. */
function alertContent(takeover: Pick<ScheduleEntry, 'startsAt' | 'endsAt'>) {
  const html = Buffer.from(alert.html);
  const sha = createHash('sha256').update(html).digest('hex');
  const key = templateKey(alert.manifest);
  const data = Object.fromEntries(Object.entries(alert.manifest.fields as Record<string, FieldDef>).flatMap(([k, f]) => ('default' in f ? [[k, f.default]] : [])));
  const c = h.content([{ id: 'a', durationMs: HOUR }], {
    edit: (m) => {
      m.files[sha] = { size: html.byteLength, type: 'text/html' };
      m.templates[key] = { manifest: alert.manifest, html: sha };
      m.spots.t = { id: 't', name: 'Evacuate', kind: 'template', template: key, durationMs: HOUR, data, assets: {} };
      m.playlists.takeover = { id: 'takeover', name: 'Alert', transition: { type: 'cut' }, items: [{ spot: 't' }] };
      m.schedule = [{ id: 'tk', playlist: 'takeover', priority: 100, target: 'org', ...takeover }];
    },
  });
  c.blobs.set(sha, html);
  return c;
}

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

  it('the Alert template plays as a takeover: it cuts in at once, and ends on time offline', async () => {
    const p = await h.openPlayer((s) => s.publish(content()), {}, { clockAt: new Date(T0) });
    await p.until((s) => played(s).includes('a'));

    p.server.publish(alertContent({ startsAt: iso(T0 - HOUR), endsAt: iso(T0 + 30 * MINUTE) }));
    await p.until((s) => played(s).includes('t'));
    p.server.intercept(/./, { status: 503 });

    await p.page.clock.fastForward(31 * MINUTE);
    const s = await p.until((s) => played(s).filter((x) => x === 'a').length === 2);
    expect(played(s)).toEqual(['a', 't', 'a']);
  });

  // Owner decision (#200): an alert is better shown on a doubtful clock than missed. A screen back
  // from a power cut reads a clock years behind until its first sync; the build time is the least
  // the real time can be, and this takeover has not ended by then.
  it('an Alert takeover plays on a clock the screen does not trust; another takeover does not', async () => {
    const behind = { clockAt: new Date('2020-01-01T00:00:00Z') };
    const bounds = { startsAt: iso(T0 - HOUR), endsAt: iso(T0 + 2 * HOUR) };
    const p = await h.openPlayer((s) => s.publish(alertContent(bounds)), {}, behind);
    const s = await p.until((s) => played(s).includes('t'));
    expect(s.clock.trusted).toBe(false);
    expect(played(s)).toEqual(['t']);

    const q = await h.openPlayer((s) => s.publish(content(bounds)), {}, behind);
    expect(played(await q.until((s) => played(s).length > 0))).toEqual(['a']);
  });
});

