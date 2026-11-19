/**
 * The spot pages' reads, through the tool registry as the signed-in member (`list_spots`,
 * `get_spot`, `list_templates`, `list_brand_kits`, `get_spot_preview`, `list_data_sources`,
 * `get_data_source`). The query keys and options over them are in src/queries/spots.ts.
 */
import { createServerFn } from '@tanstack/react-start';
import type { DataSourceView, SnapshotView } from '~/lib/live-data';
import type { SpotPreview, SpotView } from '~/lib/spots';
import { all, inOrg, tool } from './tools.server';

/**
 * Tool outputs are JSON from `/api/tools`, so they serialize; their template data is typed
 * `unknown` (any JSON value), which Start's type check cannot prove, so it is not asked to.
 */
const read = { method: 'GET', strict: { output: false } } as const;

export const getSpots = createServerFn(read).handler(async () => ({
  spots: await inOrg(() => all('list_spots', (p) => p.spots), []),
}));

export const getSpot = createServerFn(read)
  .validator((spotId: string) => spotId)
  .handler(async ({ data: spotId }) => (await inOrg(() => tool<{ spot: SpotView }>('get_spot', { spotId }, { missing: 'null' }), null))?.spot ?? null);

export const getTemplates = createServerFn(read).handler(async () => ({
  templates: await inOrg(() => all('list_templates', (p) => p.templates), []),
}));

export const getBrandKits = createServerFn(read).handler(async () => ({
  brandKits: await inOrg(() => all('list_brand_kits', (p) => p.brandKits), []),
}));

interface PreviewRequest {
  orientation: 'landscape' | 'portrait';
  templateVersionId?: string;
  brandKitId?: string;
}

export const getSpotPreview = createServerFn(read)
  .validator((input: PreviewRequest) => input)
  .handler(({ data }) => tool<SpotPreview>('get_spot_preview', data));

/** The org's sources, with their health and the spots that read them: the spot editor's pickers and the Integrations page. */
export const getDataSources = createServerFn(read).handler(async () => ({
  dataSources: await inOrg(() => all('list_data_sources', (p) => p.dataSources), []),
}));

export const getDataSource = createServerFn(read)
  .validator((dataSourceId: string) => dataSourceId)
  .handler(({ data: dataSourceId }) =>
    tool<{ dataSource: DataSourceView; snapshot: SnapshotView | null }>('get_data_source', { dataSourceId }, { missing: 'null' }),
  );
