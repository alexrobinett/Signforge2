// What a publish changed, in words (#370, review of #455): kind by kind, each name in its own <bdi>.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PublishChanges } from '../src/components/publishes/changes';
import type { PublishView } from '../src/lib/publishes';

type Changes = NonNullable<PublishView['changes']>;
const group = (kind: Changes[number]['kind'], names: string[], extra: Partial<Changes[number]> = {}) => ({
  kind,
  removed: false,
  count: names.length,
  names,
  omitted: 0,
  ...extra,
});
const html = (changes: Changes) => renderToStaticMarkup(createElement(PublishChanges, { id: 'c', changes }));
const words = (changes: Changes) => html(changes).replace(/<[^>]+>/g, '');

describe('what a publish changed, in words', () => {
  it('names its spots and playlists, the playlists it scheduled and those it took off the schedule', () => {
    expect(words([group('spot', ['Lunch special'])])).toBe('Spot Lunch special');
    expect(
      words([
        group('spot', ['Opening', 'Lunch special']),
        group('playlist', ['Lunch loop']),
        group('schedule_entry', ['Lunch loop']),
        group('schedule_entry', ['Storm notice'], { removed: true }),
      ]),
    ).toBe('Spots Opening and Lunch special; playlist Lunch loop; the schedule for Lunch loop; took Storm notice off the schedule');
  });
  it('shows three names at most, and counts the rest, the ones not kept too', () => {
    expect(words([group('spot', ['A', 'B', 'C', 'D', 'E'])])).toBe('Spots A, B, C and 2 more');
    expect(words([group('spot', ['A', 'B'], { count: 3000, omitted: 2998 })])).toBe('Spots A, B and 2,998 more');
  });
  it('puts each name in its own <bdi>, in a line that breaks a long one', () => {
    const out = html([group('spot', ['شاشة', 'Q'.repeat(100)])]);
    expect(out.match(/<bdi>/g)).toHaveLength(2);
    expect(out).toContain('wrap-anywhere');
  });
  it('says so when it changed no draft and only compiled the screens again', () => {
    expect(words([])).toBe('No draft changed: the screens were compiled again');
  });
});
