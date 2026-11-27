// The drawer's change summary (#268): a line per change, a link to check in full, and reach worked
// out by the schedule's own targeting, never the model's word. The audit's cases: a spot's headline,
// look and QR link; breakfast weekdays 6-11 on the drive-thrus.
import type { FieldDef } from '@signforge/contract';
import { describe, expect, it } from 'vitest';
import type { ProposedCall } from '@signforge/api/agent-chat';
import { type DraftContext, type DraftSummary, summarize as summarizeOrNot } from '../src/lib/draft-summary';
import { scheduleEntry as entry } from './schedule-entry';

const FIELDS: Record<string, FieldDef> = {
  headline: { type: 'text', label: 'Headline' },
  look: { type: 'select', label: 'Look', options: ['day', 'night'], default: 'day' },
  qrUrl: { type: 'url', label: 'QR code link', default: '' },
};

const screen = (id: string, name: string) => ({ id, name, timezone: 'UTC' });
const CONTEXT: DraftContext = {
  screens: [screen('scr_lobby', 'Lobby'), screen('scr_dt1', 'Drive-thru 1'), screen('scr_dt2', 'Drive-thru 2')],
  groups: [{ id: 'grp_dt', name: 'Drive-thrus', screenIds: ['scr_dt1', 'scr_dt2'] }],
  // The drive-thrus play the drive-thru playlist; the lobby the default.
  entries: [entry('sch_dt', { playlistId: 'pls_dt', target: 'group', groupId: 'grp_dt', priority: 5 })],
  playlists: [
    { id: 'pls_main', name: 'Main', spotIds: ['spt_other'], isDefault: true },
    { id: 'pls_dt', name: 'Drive-thru', spotIds: ['spt_promo'], isDefault: false },
    { id: 'pls_breakfast', name: 'Breakfast', spotIds: [], isDefault: false },
  ],
  spots: [{ id: 'spt_promo', name: 'Promo' }],
  fieldsOf: (id) => (id === 'tpv_card' ? FIELDS : undefined),
  // A Monday at noon.
  at: new Date('2026-11-23T12:00:00Z'),
};

/** A summary the card shows, failing the test where it says why it cannot. */
const summarize = (call: ProposedCall, context: DraftContext): DraftSummary => {
  const s = summarizeOrNot(call, context);
  if ('problem' in s) throw new Error(s.problem);
  return s;
};

describe('summarize', () => {
  it("says a spot's changes, before → after, its QR link in full and marked to check, and the screens its playlists reach", () => {
    const s = summarize(
      {
        token: 'tok',
        tool: 'save_spot',
        input: { spotId: 'spt_promo', data: { headline: 'Hot breakfast, fast', look: 'night', qrUrl: 'https://order.example/menu?from=screen' }, ifVersion: 3 },
        target: { kind: 'spot', id: 'spt_promo' },
        before: {
          id: 'spt_promo',
          name: 'Promo',
          durationMs: 8000,
          templateVersionId: 'tpv_card',
          data: { headline: 'Breakfast served', look: 'day' },
          version: 3,
        },
      },
      CONTEXT,
    );
    expect(s).toEqual({
      title: 'Spot Promo',
      lines: [
        { label: 'Headline', before: 'Breakfast served', after: 'Hot breakfast, fast', check: false },
        { label: 'Look', before: 'day', after: 'night', check: false },
        { label: 'QR code link', before: '(empty)', after: 'https://order.example/menu?from=screen', check: true },
      ],
      reach: 'Reaches 2 screens at the next publish',
    });
  });

  it('says where a new entry wins: breakfast weekdays 6-11 on the drive-thrus, above their entry', () => {
    const s = summarize(
      {
        token: 'tok',
        tool: 'save_schedule_entry',
        input: {
          playlistId: 'pls_breakfast',
          target: 'group',
          groupId: 'grp_dt',
          days: [1, 2, 3, 4, 5],
          from: '06:00',
          to: '11:00',
          priority: 6,
          idempotencyKey: 'k',
        },
        target: null,
        before: null,
      },
      CONTEXT,
    );
    expect(s.lines.map((l) => l.after)).toEqual(['Breakfast', 'Group Drive-thrus', expect.stringContaining('06:00'), '6']);
    expect(s.lines.at(-1)?.label).toBe('Priority');
    expect(s.reach).toBe('Wins on 2 of 2 screens at the next publish');
    // Below the drive-thru entry's priority, it would not play there.
    const lower = summarize(
      {
        token: 'tok',
        tool: 'save_schedule_entry',
        input: { playlistId: 'pls_breakfast', target: 'group', groupId: 'grp_dt', priority: 1 },
        target: null,
        before: null,
      },
      CONTEXT,
    );
    expect(lower.reach).toBe('Wins on 0 of 2 screens at the next publish');
  });

  it('says a screen rename reaches that screen, and the default playlist every screen', () => {
    expect(
      summarize(
        {
          token: 'tok',
          tool: 'update_screen',
          input: { screenId: 'scr_dt1', name: 'DT 1' },
          target: { kind: 'screen', id: 'scr_dt1' },
          before: { id: 'scr_dt1', name: 'Drive-thru 1' },
        },
        CONTEXT,
      ),
    ).toEqual({
      title: 'Screen Drive-thru 1',
      lines: [{ label: 'Name', before: 'Drive-thru 1', after: 'DT 1', check: false }],
      reach: 'This screen',
    });
    expect(
      summarize(
        {
          token: 'tok',
          tool: 'save_playlist',
          input: { playlistId: 'pls_main', name: 'Everyday' },
          target: { kind: 'playlist', id: 'pls_main' },
          before: { id: 'pls_main', name: 'Main', spotIds: [] },
        },
        CONTEXT,
      ).reach,
    ).toBe('Reaches 3 screens at the next publish');
  });
  const promo = (templateVersionId: string, data: Record<string, unknown>): ProposedCall => ({
    token: 'tok',
    tool: 'save_spot',
    input: { spotId: 'spt_promo', data, ifVersion: 3 },
    target: { kind: 'spot', id: 'spt_promo' },
    before: { id: 'spt_promo', name: 'Promo', durationMs: 8000, templateVersionId, data: { headline: 'Breakfast served', legacy: 'old' }, version: 3 },
  });

  it("lists every data key the template's fields do not name, added, changed or dropped, marked to check", () => {
    const s = summarize(promo('tpv_card', { headline: 'Breakfast served', tracking: 'https://evil.example' }), CONTEXT);
    expect(s.lines).toEqual([
      { label: '"legacy", which no field of the template names', before: 'old', after: '(empty)', check: true },
      { label: '"tracking", which no field of the template names', before: '(empty)', after: 'https://evil.example', check: true },
    ]);
  });

  it("says why it cannot show a spot's data on a template version it has not read, rather than showing less", () => {
    expect(summarizeOrNot(promo('tpv_unknown', { headline: 'Hot breakfast, fast' }), CONTEXT)).toEqual({ problem: expect.stringMatching(/could not be read/) });
    // A change of name alone needs no fields.
    expect(summarizeOrNot({ ...promo('tpv_unknown', {}), input: { spotId: 'spt_promo', name: 'Morning', ifVersion: 3 } }, CONTEXT)).toMatchObject({
      lines: [{ label: 'Name', before: 'Promo', after: 'Morning' }],
    });
  });
});
