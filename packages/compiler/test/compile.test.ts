import { describe, expect, it } from 'vitest';
import { validateManifest } from '@signforge/player-core';
import { compileScreen } from '../src/index';
import { opts, org, promo } from './fixtures';

describe('compileScreen', () => {
  it('produces a playable manifest whose id depends on content, not on when it was compiled', async () => {
    const first = await compileScreen(org(), opts('2026-11-17T12:00:00.000Z'));
    const later = await compileScreen(org(), opts('2026-11-18T09:30:00.000Z'));
    expect(first.problems).toEqual([]);
    expect(validateManifest(first.manifest)).toEqual([]);
    expect(first.manifest!.id).toMatch(/^[0-9a-f]{64}$/);
    expect(later.manifest!.id).toBe(first.manifest!.id);
    expect(later.manifest!.generatedAt).toBe('2026-11-18T09:30:00.000Z');

    const edited = org();
    edited.spots[0]!.name = 'Deal of the week';
    expect((await compileScreen(edited, opts())).manifest!.id).not.toBe(first.manifest!.id);
  });

  it('fills in every field the spot leaves out, including inside list rows, and never ships image fields as data', async () => {
    const input = org();
    const deal = input.spots[0] as Extract<(typeof input.spots)[number], { kind: 'template' }>;
    deal.data = { title: 'Two for $4', items: [{ name: 'Latte' }, { hot: true }] };
    const { manifest } = await compileScreen(input, opts());
    expect(manifest!.spots.deal).toMatchObject({
      data: { title: 'Two for $4', price: 2, items: [{ name: 'Latte', hot: false }, { name: 'Item', hot: true }] },
    });
    expect(manifest!.spots.deal).not.toHaveProperty('data.photo');
  });

  it('reports what is wrong with each spot, by spot, and publishes nothing', async () => {
    const input = org();
    input.spots.push(
      { id: 'too-long', name: 'Too long', kind: 'template', template: 'base/promo@1.0.0', data: {}, assets: { photo: 'b'.repeat(64) }, durationMs: 90_000 },
      { id: 'bad-data', name: 'Bad data', kind: 'template', template: 'base/promo@1.0.0', data: { price: 'free' }, assets: { photo: 'b'.repeat(64) }, durationMs: 8000 },
      { id: 'orphan', name: 'Orphan', kind: 'template', template: 'base/gone@2.0.0', data: {}, assets: {}, durationMs: 8000 },
    );
    input.playlists[0]!.items.push({ spot: 'too-long' }, { spot: 'bad-data' }, { spot: 'orphan' });
    const result = await compileScreen(input, opts());
    expect(result.manifest).toBeUndefined();
    expect(result.problems).toEqual([
      "spot too-long: duration 90000 ms is outside the template's range 4000 to 60000",
      'spot bad-data: field "price" must be a number',
      'spot orphan: template base/gone@2.0.0 is not available',
    ]);
  });

  it("keeps only the schedule entries that target this screen, its groups or the whole org", async () => {
    const input = org();
    const e = (id: string, target: 'org' | 'group' | 'screen', targetId?: string) => ({ id, playlist: 'all-day', priority: 1, target, targetId });
    input.schedule = [e('everyone', 'org'), e('front-desk', 'group', 'front'), e('kitchen', 'group', 'kitchen'), e('mine', 'screen', 'counter'), e('lobby', 'screen', 'lobby')];
    const { manifest } = await compileScreen(input, opts());
    expect(manifest!.schedule).toEqual([
      { id: 'everyone', playlist: 'all-day', priority: 1, target: 'org' },
      { id: 'front-desk', playlist: 'all-day', priority: 1, target: 'group' },
      { id: 'mine', playlist: 'all-day', priority: 1, target: 'screen' },
    ]);
  });

  it("carries only what this screen's schedule can reach", async () => {
    const input = org();
    input.templates['base/menu@1.0.0'] = { manifest: { ...promo, id: 'menu' }, html: 'd'.repeat(64) };
    input.files['d'.repeat(64)] = { size: 500, type: 'text/html' };
    input.dataSources = [{ id: 'weather', refreshS: 300 }, { id: 'news', refreshS: 300 }];
    const deal = input.spots[0] as Extract<(typeof input.spots)[number], { kind: 'template' }>;
    deal.bindings = { title: { source: 'weather', path: 'current.summary' } };

    const lean = (await compileScreen(input, opts())).manifest!;
    expect(Object.keys(lean.playlists)).toEqual(['all-day']);
    expect(Object.keys(lean.spots)).toEqual(['deal']);
    expect(Object.keys(lean.templates)).toEqual(['base/promo@1.0.0']);
    expect(Object.keys(lean.files).sort()).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
    expect(Object.keys(lean.dataSources)).toEqual(['weather']);

    // A group takeover makes the back room playlist reachable, and with it the still photo.
    input.schedule = [{ id: 'evenings', playlist: 'back-room', priority: 5, target: 'group', targetId: 'front', from: '18:00', to: '22:00' }];
    const full = (await compileScreen(input, opts())).manifest!;
    expect(Object.keys(full.playlists).sort()).toEqual(['all-day', 'back-room']);
    expect(Object.keys(full.spots).sort()).toEqual(['deal', 'still']);
    expect(Object.keys(full.files)).toContain('c'.repeat(64));
  });

  it('reports broken spots even when no schedule reaches them yet, alongside any manifest problem', async () => {
    const input = org();
    input.spots.push({ id: 'draft', name: 'Draft', kind: 'template', template: 'base/promo@1.0.0', data: {}, assets: { photo: 'b'.repeat(64) }, durationMs: 1000 });
    input.defaultPlaylist = 'missing';
    expect((await compileScreen(input, opts())).problems).toEqual([
      "spot draft: duration 1000 ms is outside the template's range 4000 to 60000",
      'manifest: defaultPlaylist does not exist',
    ]);
  });

  it('reports schedule entries it cannot place instead of dropping them', async () => {
    const input = org();
    input.schedule = [
      { id: 'typo', playlist: 'all-day', priority: 1, target: 'screens' as never, targetId: 'counter' },
      { id: 'nobody', playlist: 'all-day', priority: 1, target: 'group' },
    ];
    expect((await compileScreen(input, opts())).problems).toEqual([
      'schedule entry typo: target must be org, group or screen',
      'schedule entry nobody: a group entry needs a targetId',
    ]);
  });
});
