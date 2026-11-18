import { createHash } from 'node:crypto';
import type { TemplateManifest } from '@signforge/contract';
import type { CompileInput } from '../src/index';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export const opts = (now = '2026-11-17T12:00:00.000Z') => ({ hash, now: new Date(now) });

export const promo: TemplateManifest = {
  id: 'promo',
  version: '1.0.0',
  name: 'Promo',
  fields: {
    title: { type: 'text', label: 'Title', default: 'Hello', maxLength: 40 },
    price: { type: 'number', label: 'Price', default: 2 },
    photo: { type: 'image', label: 'Photo' },
    items: {
      type: 'list',
      label: 'Items',
      default: [],
      item: { name: { type: 'text', label: 'Name', default: 'Item' }, hot: { type: 'boolean', label: 'Hot', default: false } },
    },
  },
  duration: { defaultMs: 8000, minMs: 4000, maxMs: 60000 },
  orientations: ['landscape'],
  uses: [],
  background: '#000',
  protocol: 1,
};

const sha = (c: string) => c.repeat(64);

/** A small org: one screen in group "front", two playlists, a takeover for another group. */
export function org(): CompileInput {
  return {
    screen: { id: 'counter', name: 'Counter', timezone: 'America/New_York', orientation: 'landscape' },
    groups: ['front'],
    templates: { 'base/promo@1.0.0': { manifest: promo, html: sha('a') } },
    files: {
      [sha('a')]: { size: 1000, type: 'text/html' },
      [sha('b')]: { size: 2000, type: 'image/jpeg' },
      [sha('c')]: { size: 3000, type: 'image/jpeg' },
    },
    spots: [
      {
        id: 'deal',
        name: 'Deal',
        kind: 'template',
        template: 'base/promo@1.0.0',
        data: { title: 'Two for $4' },
        assets: { photo: sha('b') },
        durationMs: 8000,
      },
      { id: 'still', name: 'Still', kind: 'image', file: sha('c'), fit: 'cover', durationMs: 5000 },
    ],
    playlists: [
      { id: 'all-day', name: 'All day', transition: { type: 'fade', ms: 600 }, items: [{ spot: 'deal' }] },
      { id: 'back-room', name: 'Back room', transition: { type: 'cut' }, items: [{ spot: 'still' }] },
    ],
    dataSources: [],
    schedule: [],
    defaultPlaylist: 'all-day',
  };
}
