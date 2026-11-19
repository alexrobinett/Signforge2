/**
 * Server data for the spot pages, as TanStack Query options (docs/research/cms-data-layer.md,
 * Decision): each key starts with the org, so another org's rows never show after a switch, and
 * each fetch is a tool read through a server function. The editor's store actions write what
 * they save back into these entries (src/state/spot-editor.ts).
 */
import { queryOptions } from '@tanstack/react-query';
import { getAssets } from '~/server/assets.functions';
import { getBrandKits, getDataSource, getDataSources, getSpot, getSpotPreview, getSpots, getTemplates } from '~/server/spots.functions';

type Orientation = 'landscape' | 'portrait';

export const spotKeys = {
  all: (orgId: string) => ['org', orgId, 'spots'] as const,
  one: (orgId: string, spotId: string) => ['org', orgId, 'spots', spotId] as const,
};

export const spotsQuery = (orgId: string) => queryOptions({ queryKey: spotKeys.all(orgId), queryFn: () => getSpots() });

export const spotQuery = (orgId: string, spotId: string) => queryOptions({ queryKey: spotKeys.one(orgId, spotId), queryFn: () => getSpot({ data: spotId }) });

export const templatesQuery = (orgId: string) => queryOptions({ queryKey: ['org', orgId, 'templates'], queryFn: () => getTemplates(), staleTime: 60_000 });

export const assetsQuery = (orgId: string) => queryOptions({ queryKey: ['org', orgId, 'assets'], queryFn: () => getAssets() });

export const brandKitsQuery = (orgId: string) => queryOptions({ queryKey: ['org', orgId, 'brandKits'], queryFn: () => getBrandKits(), staleTime: 60_000 });

/** What the stage compiles a draft against, for one orientation and kit (`get_spot_preview`). */
export const spotPreviewQuery = (orgId: string, p: { orientation: Orientation; templateVersionId?: string; brandKitId?: string }) =>
  queryOptions({
    queryKey: ['org', orgId, 'spotPreview', p.orientation, p.templateVersionId ?? null, p.brandKitId ?? null],
    queryFn: () => getSpotPreview({ data: p }),
    staleTime: 60_000,
  });

export const dataSourceKeys = {
  all: (orgId: string) => ['org', orgId, 'dataSources'] as const,
  one: (orgId: string, dataSourceId: string) => ['org', orgId, 'dataSources', dataSourceId] as const,
};

/** The org's data sources, for the editor's source pickers. */
export const dataSourcesQuery = (orgId: string) => queryOptions({ queryKey: dataSourceKeys.all(orgId), queryFn: () => getDataSources() });

/**
 * One source and its latest snapshot: the live values the editor shows and the stage plays. Read
 * again every 30 seconds while the editor shows it, so a new source's first poll appears.
 */
export const dataSourceQuery = (orgId: string, dataSourceId: string) =>
  queryOptions({ queryKey: dataSourceKeys.one(orgId, dataSourceId), queryFn: () => getDataSource({ data: dataSourceId }), refetchInterval: 30_000 });
