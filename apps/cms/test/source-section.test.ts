// The Source section of a template with several named sources (#193): one block per source, whose
// element ids stay apart whatever the sources are named.
import type { TemplateManifest } from '@signforge/contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ComponentProps, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SourceSection } from '../src/components/spots/source-section';
import { draftOf, type SpotView } from '../src/lib/spots';
import { dataSourceKeys } from '../src/queries/spots';
import { StoreProvider } from '../src/state/provider';
import { createSpotEditorSlice, type SpotEditorSlice } from '../src/state/spot-editor';
import { createSpotSourceSlice, sourceStateOf, type SpotSourceSlice } from '../src/state/spot-source';
import { createStore } from 'zustand/vanilla';

vi.mock('~/lib/tab-org', () => ({ tabOrgHeaders: async () => ({}) }));
vi.mock('~/server/spots.functions', () => ({
  getBrandKits: vi.fn(),
  getDataSource: vi.fn(),
  getDataSources: vi.fn(),
  getSpot: vi.fn(),
  getSpotPreview: vi.fn(),
  getSpots: vi.fn(),
  getTemplates: vi.fn(),
}));
vi.mock('~/server/assets.functions', () => ({ getAssets: vi.fn() }));

const ORG = 'org_1';

describe('a template with two named sources in the Source section', () => {
  it('gives every control an id of its own, even when one source is named like another with a suffix', () => {
    // A table source `a` and a feed source `a-table`: "source-" + name + "-table-url" would be the same for both.
    const manifest: TemplateManifest = {
      id: 'frame',
      version: '1.0.0',
      name: 'Frame',
      fields: {
        rows: { type: 'list', label: 'Rows', default: [], item: { title: { type: 'text', label: 'Title' } } },
        items: { type: 'list', label: 'Headlines', default: [], item: { title: { type: 'text', label: 'Title' } } },
      },
      duration: { defaultMs: 1000, minMs: 1000, maxMs: 1000 },
      orientations: ['landscape'],
      uses: [],
      background: '#000',
      live: {
        sources: {
          a: { label: 'Menu', source: 'table', fields: { rows: 'rows' } },
          'a-table': { label: 'News', source: 'rss', fields: { items: 'items' } },
        },
      },
    };
    const spot: SpotView = {
      id: 'spt_frame',
      name: 'Frame',
      kind: 'template',
      templateVersionId: 'tpv_frame',
      durationMs: 1000,
      data: {},
      assets: {},
      bindings: {},
      assetId: null,
      fit: null,
      url: null,
      version: 1,
      published: false,
      draftChanged: false,
      publishedAt: null,
      createdAt: 0,
      updatedAt: 0,
    };
    const queryClient = new QueryClient();
    queryClient.setQueryData(dataSourceKeys.all(ORG), { dataSources: [] });
    // The two slices the section reads; the provider takes the whole app's store.
    // Both forms open: the table's link form and, with no feed in the org, the feed's. A server
    // render reads the store as it was made, so the table's form is open from the start.
    const store = createStore<SpotEditorSlice & SpotSourceSlice>()((set, get) => {
      const sources = createSpotSourceSlice(set as never, get as never, { router: {}, queryClient } as never);
      const table = { ...sourceStateOf(sources.spotSource, { spot, source: 'a' }), adding: true };
      return {
        ...createSpotEditorSlice(set as never, get as never, { router: {}, queryClient } as never),
        ...sources,
        spotSource: { spotId: spot.id, pickers: { a: table } },
      };
    });
    const section = createElement(SourceSection, {
      orgId: ORG,
      spot,
      manifest,
      live: manifest.live!,
      draft: draftOf(spot),
      assets: [],
      canManage: true,
      onChange: () => {},
    });
    // StoreProvider's props name its children; built apart, as createElement's arguments cannot satisfy them.
    const provider: ComponentProps<typeof StoreProvider> = { store: store as never, children: section };
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: queryClient }, createElement(StoreProvider, provider)));
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(4);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });
});
