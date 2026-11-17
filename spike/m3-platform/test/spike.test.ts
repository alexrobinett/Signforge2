import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { runAuthFlow } from '../src/auth-flow';
import { probeForeignKeys } from '../src/fk';
import { expandCalendar, SAMPLE_ICS } from '../src/ical';
import { readMp4Header } from '../src/mp4';
import { FIXTURES } from './fixtures';

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  for (const [key, b64] of Object.entries(FIXTURES)) {
    await env.MEDIA.put(key, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  }
});

describe('ical.js in workerd', () => {
  it('expands a weekly RRULE with an EXDATE and a moved instance', () => {
    const out = expandCalendar(SAMPLE_ICS, new Date('2026-11-20T00:00:00Z'));
    expect(out.map((o) => `${o.start} ${o.summary}`)).toEqual([
      '2026-11-26T14:00:00.000Z Standup',
      // 3 Dec is cancelled by EXDATE.
      '2026-12-10T19:00:00.000Z Standup (moved)',
      '2026-12-17T14:00:00.000Z Standup',
    ]);
  });
});

describe('mp4box in workerd over R2 range reads', () => {
  it('reads a faststart file in one range read and accepts it', async () => {
    const r = await readMp4Header(env.MEDIA, 'ok-faststart.mp4', 4096);
    expect(r).toMatchObject({ ok: true, codec: 'avc1.64002a', profile: 100, level: 42, width: 320, height: 180, fps: 30 });
    expect(r.reads).toHaveLength(1);
  });

  it('skips the mdat to reach a moov at the end', async () => {
    const r = await readMp4Header(env.MEDIA, 'moov-at-end.mp4', 1024);
    expect(r).toMatchObject({ ok: true, profile: 77, fps: 30 });
    // The first read sees ftyp and the mdat header; the next jumps past the mdat.
    expect(r.reads[1]!.offset).toBeGreaterThan(8000);
  });

  it('rejects 10-bit High 10 at 60 fps', async () => {
    const r = await readMp4Header(env.MEDIA, 'bad-10bit-60fps.mp4', 4096);
    expect(r.ok).toBe(false);
    expect(r.reasons.join('; ')).toMatch(/profile 110.*60 fps/);
  });
});

describe('D1 foreign keys (local workerd)', () => {
  it('enforces composite foreign keys with no PRAGMA', async () => {
    const r = await probeForeignKeys(env.DB);
    expect(r.results.map((x) => x.accepted)).toEqual([true, false, false, false, false]);
    expect(r.batchGoodRowKept).toBe(false);
  });
});

describe('Better Auth organization flow on D1 (local workerd)', () => {
  it('signs in, creates an org, invites and accepts without transactions', async () => {
    const r = await runAuthFlow(env, 'https://spike.test');
    expect(r.steps).toContain('editor may publish: true');
    expect(r.ok).toBe(true);
  });
});

describe('router', () => {
  it('answers 404 elsewhere', async () => {
    expect((await exports.default.fetch('https://spike.test/nope')).status).toBe(404);
  });
});
