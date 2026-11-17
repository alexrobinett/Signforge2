/**
 * Build a screen manifest and its files in memory, for the fixture server to serve. Every spot
 * uses the fixture template (`fixtures/template.ts`); its `mode` decides how the template behaves.
 */
import { createHash } from 'node:crypto';
import {
  MANIFEST_SCHEMA,
  MIN_REFRESH_S,
  PROTOCOL_VERSION,
  manifestIdInput,
  type Binding,
  type BrandColors,
  type BrandFont,
  type BrandShape,
  type DataSource,
  type ScreenManifest,
  type Spot,
  type TemplateManifest,
  type Transition,
} from '@signforge/contract';

export interface FixtureSpot {
  id: string;
  /** How the fixture template behaves for this spot. */
  mode?: 'ok' | 'throw' | 'hang';
  /** Shown by the template. Defaults to the id. */
  label?: string;
  durationMs?: number;
  /** Rows the template lists, as a news template would. Static, so the fallback when bound. */
  items?: { title: string }[];
  /** Fields that take their value from live data. Each source is added to the manifest. */
  bindings?: Record<string, Binding>;
  /** A file of the spot's own, passed to the template as asset `file`. */
  asset?: Buffer;
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
  fields: {
    label: { type: 'text', label: 'Label', maxLength: 40 },
    mode: { type: 'text', label: 'Mode' },
    items: { type: 'list', label: 'Items', maxItems: 3, default: [], item: { title: { type: 'text', label: 'Title' } } },
  },
  duration: { defaultMs: 1000, minMs: 100, maxMs: 60_000 },
  orientations: ['landscape', 'portrait'],
  uses: [],
  background: '#000',
  protocol: PROTOCOL_VERSION,
};

export interface ContentOptions {
  transition?: Transition;
  /** Manifest schema. Schema 1 keys templates without their owner. Default `MANIFEST_SCHEMA`. */
  schema?: number;
  /** Appended to the template as a comment, so the template file (and its hash) differs from other content's. */
  variant?: string;
  /** The screen's brand kit, with its font files and logo as bytes. */
  brand?: FixtureBrand;
}

export interface FixtureBrand {
  colors: BrandColors;
  shape: BrandShape;
  fonts: Partial<Record<'display' | 'body', { id: string; family: string; files: { weight: number; data: Buffer }[] }>>;
  logo?: { onDark: Buffer; onLight?: Buffer };
}

/**
 * One playlist (`main`, the default) of the given spots, in order. Change any spot's label to get
 * a manifest with a new id, as a publish would.
 */
export function buildContent(
  templateHtml: string,
  spots: FixtureSpot[],
  { transition = { type: 'cut' }, schema = MANIFEST_SCHEMA, variant, brand }: ContentOptions = {},
): Content {
  const html = Buffer.from(variant ? `${templateHtml}<!-- ${variant} -->` : templateHtml);
  const key = schema === 1 ? 'fixture@1.0.0' : TEMPLATE_KEY;
  const htmlSha = sha256(html);
  const spotMap: Record<string, Spot> = {};
  const blobs = new Map<string, Buffer>([[htmlSha, html]]);
  const files: ScreenManifest['files'] = { [htmlSha]: { size: html.byteLength, type: 'text/html' } };
  for (const s of spots) {
    spotMap[s.id] = {
      id: s.id,
      name: s.id,
      kind: 'template',
      template: key,
      durationMs: s.durationMs ?? 1000,
      data: { label: s.label ?? s.id, mode: s.mode ?? 'ok', ...(s.items ? { items: s.items } : {}) },
      assets: {},
      ...(s.bindings ? { bindings: s.bindings } : {}),
    };
    if (s.asset) {
      const sha = sha256(s.asset);
      blobs.set(sha, s.asset);
      files[sha] = { size: s.asset.byteLength, type: 'application/octet-stream' };
      (spotMap[s.id] as Extract<Spot, { kind: 'template' }>).assets.file = sha;
    }
  }
  const addFile = (data: Buffer, type: string) => {
    const sha = sha256(data);
    blobs.set(sha, data);
    files[sha] = { size: data.byteLength, type };
    return sha;
  };
  const fonts: Partial<Record<'display' | 'body', BrandFont>> = {};
  for (const [role, f] of Object.entries(brand?.fonts ?? {}) as ['display' | 'body', NonNullable<FixtureBrand['fonts']['body']>][])
    fonts[role] = { id: f.id, family: f.family, files: f.files.map((x) => ({ weight: x.weight, style: 'normal', file: addFile(x.data, 'font/woff2') })) };
  const logo = brand?.logo && {
    onDark: addFile(brand.logo.onDark, 'image/png'),
    ...(brand.logo.onLight ? { onLight: addFile(brand.logo.onLight, 'image/png') } : {}),
  };
  const dataSources: Record<string, DataSource> = {};
  for (const b of spots.flatMap((s) => Object.values(s.bindings ?? {}))) dataSources[b.source] = { id: b.source, refreshS: MIN_REFRESH_S };
  const body: Omit<ScreenManifest, 'id'> = {
    schema,
    generatedAt: new Date().toISOString(),
    screen: { id: 'test-screen', name: 'Test screen', timezone: 'UTC', orientation: 'landscape' },
    files,
    templates: { [key]: { manifest: templateManifest, html: htmlSha } },
    spots: spotMap,
    playlists: { main: { id: 'main', name: 'Main', transition, items: spots.map((s) => ({ spot: s.id })) } },
    dataSources,
    schedule: [],
    defaultPlaylist: 'main',
    ...(brand ? { brand: { id: 'kit', colors: brand.colors, shape: brand.shape, fonts, ...(logo ? { logo } : {}) } } : {}),
  };
  const manifest: ScreenManifest = { ...body, id: sha256(manifestIdInput(body)) };
  return { manifest, blobs };
}
