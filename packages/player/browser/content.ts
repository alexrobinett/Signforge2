/**
 * Build a screen manifest and its files in memory, for the fixture server to serve. Every spot
 * uses the fixture template (`fixtures/template.ts`); its `mode` decides how the template behaves.
 */
import { createHash } from 'node:crypto';
import { MANIFEST_SCHEMA, PROTOCOL_VERSION, manifestIdInput, type ScreenManifest, type Spot, type TemplateManifest, type Transition } from '@signforge/contract';

export interface FixtureSpot {
  id: string;
  /** How the fixture template behaves for this spot. */
  mode?: 'ok' | 'throw' | 'hang';
  /** Shown by the template. Defaults to the id. */
  label?: string;
  durationMs?: number;
  /** A file of the spot's own, passed to the template as asset `file`. */
  asset?: Buffer;
  /**
   * Bind the label to data source `feed`. The player waits up to 3 s for a bound spot's feeds
   * before preparing it, so a feed that never answers holds the spot in that wait.
   */
  bound?: boolean;
}

export interface Content {
  manifest: ScreenManifest;
  /** Files by SHA-256. */
  blobs: Map<string, Buffer>;
}

export const TEMPLATE_KEY = 'base/fixture@1.0.0';
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

const templateManifest: TemplateManifest = {
  id: 'fixture',
  version: '1.0.0',
  name: 'Fixture',
  fields: { label: { type: 'text', label: 'Label' }, mode: { type: 'text', label: 'Mode' } },
  duration: { defaultMs: 1000, minMs: 100, maxMs: 60_000 },
  orientations: ['landscape', 'portrait'],
  uses: [],
  background: '#000',
  protocol: PROTOCOL_VERSION,
};

/**
 * One playlist (`main`, the default) of the given spots, in order. Change any spot's label to get
 * a manifest with a new id, as a publish would.
 */
export function buildContent(templateHtml: string, spots: FixtureSpot[], { transition = { type: 'cut' } as Transition } = {}): Content {
  const html = Buffer.from(templateHtml);
  const htmlSha = sha256(html);
  const spotMap: Record<string, Spot> = {};
  const blobs = new Map<string, Buffer>([[htmlSha, html]]);
  const files: ScreenManifest['files'] = { [htmlSha]: { size: html.byteLength, type: 'text/html' } };
  for (const s of spots) {
    spotMap[s.id] = {
      id: s.id,
      name: s.id,
      kind: 'template',
      template: TEMPLATE_KEY,
      durationMs: s.durationMs ?? 1000,
      data: { label: s.label ?? s.id, mode: s.mode ?? 'ok' },
      assets: {},
    };
    if (s.asset) {
      const sha = sha256(s.asset);
      blobs.set(sha, s.asset);
      files[sha] = { size: s.asset.byteLength, type: 'application/octet-stream' };
      (spotMap[s.id] as Extract<Spot, { kind: 'template' }>).assets.file = sha;
    }
    if (s.bound) (spotMap[s.id] as Extract<Spot, { kind: 'template' }>).bindings = { label: { source: 'feed', path: 'label' } };
  }
  const body: Omit<ScreenManifest, 'id'> = {
    schema: MANIFEST_SCHEMA,
    generatedAt: new Date().toISOString(),
    screen: { id: 'test-screen', name: 'Test screen', timezone: 'UTC', orientation: 'landscape' },
    files,
    templates: { [TEMPLATE_KEY]: { manifest: templateManifest, html: htmlSha } },
    spots: spotMap,
    playlists: { main: { id: 'main', name: 'Main', transition, items: spots.map((s) => ({ spot: s.id })) } },
    dataSources: spots.some((s) => s.bound) ? { feed: { id: 'feed', refreshS: 60 } } : {},
    schedule: [],
    defaultPlaylist: 'main',
  };
  const manifest: ScreenManifest = { ...body, id: sha256(manifestIdInput(body)) };
  return { manifest, blobs };
}
