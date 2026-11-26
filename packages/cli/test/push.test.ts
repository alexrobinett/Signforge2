/**
 * What `sf build` writes, `sf push` can push (review of #585): the server checks a pushed manifest's id against the hash
 * of the manifest as the contract parses it (`readManifest` in apps/api src/admin), which leaves out keys the contract
 * does not declare. So a `template.json` or `brand.json` with a key of the author's own must build to that same
 * manifest, or the push is refused as "id is not the hash of the manifest".
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifestIdInput, parseManifest } from '@signforge/contract';
import { afterAll, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../../..');
const project = mkdtempSync(join(tmpdir(), 'sf-push-'));
const out = join(project, 'out');
// Beside the fixture, so the template's imports resolve through this package's node_modules.
const templates = mkdtempSync(join(import.meta.dirname, '.templates-'));
afterAll(() => {
  rmSync(project, { recursive: true, force: true });
  rmSync(templates, { recursive: true, force: true });
});

const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));

describe('a project whose template.json and brand.json carry keys of their own', () => {
  it('builds a manifest whose id is the hash of what the server parses, so the push passes its check', () => {
    cpSync(join(import.meta.dirname, 'fixtures/qr'), join(templates, 'qr'), { recursive: true });
    const authored = JSON.parse(readFileSync(join(templates, 'qr', 'template.json'), 'utf8'));
    json(join(templates, 'qr', 'template.json'), { ...authored, author: 'A. Author' });
    json(join(project, 'screen.json'), { id: 'push-screen', name: 'Push', timezone: 'Europe/London', orientation: 'landscape' });
    json(join(project, 'schedule.json'), { defaultPlaylist: 'all', entries: [] });
    json(join(project, 'brand.json'), {
      colors: { primary: '#1d4ed8', accent: '#f97316', background: '#0b1020', surface: '#18213a', text: '#f8fafc', muted: '#a5b4cb', extra: '#000000' },
      shape: 'soft',
      fonts: {},
    });
    mkdirSync(join(project, 'playlists'));
    json(join(project, 'playlists', 'all.json'), { name: 'All', items: ['qr'] });
    mkdirSync(join(project, 'spots'));
    json(join(project, 'spots', 'qr.json'), { name: 'QR', kind: 'template', template: 'qr', data: { link: 'https://example.com/' } });

    execFileSync(join(root, 'node_modules/.bin/tsx'), ['packages/cli/src/sf.ts', 'build', project, '--out', out, '--templates', templates], {
      cwd: root,
      stdio: 'pipe',
    });
    const sent: { id: string } = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    const parsed = parseManifest(sent);
    if (!parsed.ok) throw new Error(parsed.problems.join('; '));
    expect(createHash('sha256').update(manifestIdInput(parsed.value)).digest('hex')).toBe(sent.id);
    expect(parsed.value).toEqual(sent);
  }, 120_000);
});
