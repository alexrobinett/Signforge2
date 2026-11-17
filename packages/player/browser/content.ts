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
export interface ContentOptions {
  transition?: Transition;
  /** Manifest schema. Schema 1 keys templates without their owner. Default `MANIFEST_SCHEMA`. */
  schema?: number;
  /** Appended to the template as a comment, so the template file (and its hash) differs from other content's. */
  variant?: string;
}

export function buildContent(templateHtml: string, spots: FixtureSpot[], { transition = { type: 'cut' }, schema = MANIFEST_SCHEMA, variant }: ContentOptions = {}): Content {
  const html = Buffer.from(variant ? `${templateHtml}<!-- ${variant} -->` : templateHtml);
  const key = schema === 1 ? 'fixture@1.0.0' : TEMPLATE_KEY;
  const htmlSha = sha256(html);
  const spotMap: Record<string, Spot> = {};
  for (const s of spots) {
    spotMap[s.id] = {
      id: s.id,
      name: s.id,
      kind: 'template',
      template: key,
      durationMs: s.durationMs ?? 1000,
      data: { label: s.label ?? s.id, mode: s.mode ?? 'ok' },
      assets: {},
    };
  }
  const body: Omit<ScreenManifest, 'id'> = {
    schema,
    generatedAt: new Date().toISOString(),
    screen: { id: 'test-screen', name: 'Test screen', timezone: 'UTC', orientation: 'landscape' },
    files: { [htmlSha]: { size: html.byteLength, type: 'text/html' } },
    templates: { [key]: { manifest: templateManifest, html: htmlSha } },
    spots: spotMap,
    playlists: { main: { id: 'main', name: 'Main', transition, items: spots.map((s) => ({ spot: s.id })) } },
    dataSources: {},
    schedule: [],
    defaultPlaylist: 'main',
  };
  const manifest: ScreenManifest = { ...body, id: sha256(manifestIdInput(body)) };
  return { manifest, blobs: new Map([[htmlSha, html]]) };
}
