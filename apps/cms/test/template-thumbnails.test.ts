// The New spot dialog's thumbnails (scripts/template-thumbnails.ts) are drawn from each base
// template's current version: a new version fails here until they are drawn again.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import thumbnails from '../src/lib/template-thumbnails.json';

const root = new URL('../../../', import.meta.url);
const templates = Object.fromEntries(
  readdirSync(new URL('templates/', root)).map((d) => {
    const t: { id: string; version: string } = JSON.parse(readFileSync(new URL(`templates/${d}/template.json`, root), 'utf8'));
    return [t.id, t.version];
  }),
);

describe('template thumbnails', () => {
  it('are drawn from every base template at its current version (run scripts/template-thumbnails.ts)', () => {
    expect(thumbnails).toEqual(templates);
  });

  it('each has its image', () => {
    for (const id of Object.keys(thumbnails)) expect(existsSync(new URL(`apps/cms/public/template-thumbnails/${id}.webp`, root)), id).toBe(true);
  });
});
