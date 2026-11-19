/**
 * Where a spot's live data comes from (issue #79): the spot editor's Source section. People choose
 * the source, never the values: a place and units for a weather template, a news feed, a calendar.
 * Choosing one finds or makes the org's data source (`create_data_source`) and binds every live
 * field the template declares (`live.fields`) to it, in the draft the editor saves
 * (src/state/spot-editor.ts). A source another spot uses is left as it is.
 *
 * A weather source follows from the place, the units and the template's variables
 * (`weatherSource` in src/lib/live-data.ts), so a second spot for the same place and units reuses it.
 */
import type { LiveData, TemplateManifest } from '@signforge/contract';
import { bindAll, type PlaceView, SOURCE_FORMAT, weatherSource, type WeatherUnits } from '~/lib/live-data';
import type { SpotView } from '~/lib/spots';
import { callTool, toolMessage } from '~/lib/tools';
import { dataSourceKeys, dataSourceQuery, dataSourcesQuery } from '~/queries/spots';
import type { SliceCreator } from './store';

/** How long typing a place pauses before it is looked up. */
const SEARCH_DELAY_MS = 300;
/** A new calendar's look-ahead, as `create_data_source` defaults it. */
const DEFAULT_HORIZON_DAYS = 30;

interface SpotSourceState {
  /** The spot this state belongs to; another spot's page starts from `initial`. */
  spotId: string | null;
  /** The picker is open over a source already bound ("Change source"); a spot with none always shows it. */
  changing: boolean;
  placeQuery: string;
  /** What the last search found; null before one. */
  places: PlaceView[] | null;
  searching: boolean;
  /** The units the next place is fetched in; null: the spot's own. */
  units: WeatherUnits | null;
  /** The form that adds a feed by its address. */
  adding: boolean;
  /** "If the source is down" is open, as the person left it: a re-render never closes it under someone typing. */
  fallbackOpen: boolean;
  feedUrl: string;
  feedName: string;
  horizonDays: number;
  pending: boolean;
  error: string | null;
}

/** What the source actions need of the open spot. */
export interface SourceTarget {
  orgId: string;
  spot: SpotView;
  manifest: TemplateManifest;
  live: LiveData;
}

export interface SpotSourceSlice {
  spotSource: SpotSourceState;
  /** Opens or closes the picker over a bound source; a weather picker opens looking up `placeQuery` (the spot's place). */
  changeSource: (spotId: string, open: boolean, placeQuery?: string) => void;
  /** The place being typed; looked up a moment after typing stops. */
  typePlace: (spotId: string, query: string) => void;
  pickUnits: (spotId: string, units: WeatherUnits) => void;
  /** Binds the weather fields to the forecast for `place`, making that source if the org has none. */
  connectWeather: (target: SourceTarget, place: PlaceView, units: WeatherUnits) => Promise<void>;
  /** Binds the live fields to one of the org's sources. */
  connectSource: (target: SourceTarget, dataSourceId: string) => Promise<void>;
  openFeedForm: (spotId: string, open: boolean) => void;
  /** The fallback section opened or closed, as the person toggled it. */
  toggleFallback: (spotId: string, open: boolean) => void;
  editFeed: (spotId: string, change: Partial<Pick<SpotSourceState, 'feedUrl' | 'feedName' | 'horizonDays'>>) => void;
  /** Adds the feed in the form as a source and binds the live fields to it. */
  addFeed: (target: SourceTarget) => Promise<void>;
}

const initial: SpotSourceState = {
  spotId: null,
  changing: false,
  placeQuery: '',
  places: null,
  searching: false,
  units: null,
  adding: false,
  fallbackOpen: false,
  feedUrl: '',
  feedName: '',
  horizonDays: DEFAULT_HORIZON_DAYS,
  pending: false,
  error: null,
};

/** The source state of `spotId`'s page: the store's, or a fresh one for another spot. */
export const sourceStateOf = (state: SpotSourceState, spotId: string): SpotSourceState => (state.spotId === spotId ? state : initial);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `find_places`'s places, read field by field. */
function placesOf(output: unknown): PlaceView[] {
  const places = isRecord(output) && Array.isArray(output.places) ? output.places : [];
  return places.flatMap((p: unknown) =>
    isRecord(p) &&
    typeof p.id === 'number' &&
    typeof p.name === 'string' &&
    typeof p.region === 'string' &&
    typeof p.country === 'string' &&
    typeof p.latitude === 'number' &&
    typeof p.longitude === 'number' &&
    typeof p.timezone === 'string'
      ? [{ id: p.id, name: p.name, region: p.region, country: p.country, latitude: p.latitude, longitude: p.longitude, timezone: p.timezone }]
      : [],
  );
}

/** The id of the source in a `{ dataSource }` output. */
function sourceIdOf(output: unknown): string {
  if (isRecord(output) && isRecord(output.dataSource) && typeof output.dataSource.id === 'string') return output.dataSource.id;
  throw new Error('SignForge answered without the data source. Reload the page to see it.');
}

export const createSpotSourceSlice: SliceCreator<SpotSourceSlice> = (set, get, { queryClient }) => {
  const source = (spotId: string, change: (s: SpotSourceState) => SpotSourceState) =>
    set((s) => ({ spotSource: { ...change(sourceStateOf(s.spotSource, spotId)), spotId } }));
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  /** Counts searches, so a slow answer never replaces a newer one. */
  let searchSeq = 0;

  async function search(spotId: string, query: string) {
    const seq = ++searchSeq;
    try {
      const places = placesOf(await callTool('find_places', { query }));
      if (seq === searchSeq) source(spotId, (s) => ({ ...s, places, searching: false }));
    } catch (err) {
      if (seq === searchSeq) source(spotId, (s) => ({ ...s, places: null, searching: false, error: `Could not look the place up: ${toolMessage(err)}` }));
    }
  }

  /**
   * Binds the live fields to `dataSourceId` and sets the fields the source decides (`data`).
   * The stage compiles against the preview's sources and plays the source's snapshot, so both are
   * read first; another spot's source stays as it is.
   */
  async function bind(t: SourceTarget, dataSourceId: string, data: Record<string, unknown>) {
    await Promise.all([
      queryClient.query(dataSourceQuery(t.orgId, dataSourceId)),
      queryClient.invalidateQueries({ queryKey: ['org', t.orgId, 'spotPreview'] }),
    ]);
    get().editSpot(t.spot, (d) => ({ ...d, data: { ...d.data, ...data }, bindings: bindAll(t.live, d.bindings, dataSourceId) }));
    source(t.spot.id, (s) => ({ ...initial, units: s.units, fallbackOpen: s.fallbackOpen }));
  }

  /**
   * Makes a source and reads the org's list again. One made with the same id since the list was
   * read (another tab, a teammate) is refused as a conflict, shown as the error; picking again finds it.
   */
  async function create(orgId: string, input: Record<string, unknown> & { id?: string }): Promise<string> {
    try {
      return sourceIdOf(await callTool('create_data_source', { ...input, idempotencyKey: crypto.randomUUID() }));
    } finally {
      void queryClient.invalidateQueries({ queryKey: dataSourceKeys.all(orgId), exact: true });
    }
  }

  async function attempt(spotId: string, run: () => Promise<void>) {
    source(spotId, (s) => ({ ...s, pending: true, error: null }));
    try {
      await run();
    } catch (err) {
      source(spotId, (s) => ({ ...s, pending: false, error: toolMessage(err) }));
    }
  }

  return {
    spotSource: initial,

    changeSource(spotId, changing, placeQuery) {
      source(spotId, (s) => ({ ...initial, changing, fallbackOpen: s.fallbackOpen }));
      if (changing && placeQuery) get().typePlace(spotId, placeQuery);
    },

    typePlace(spotId, placeQuery) {
      clearTimeout(searchTimer);
      const query = placeQuery.trim();
      source(spotId, (s) => ({ ...s, placeQuery, searching: query.length >= 2, error: null, ...(query.length < 2 ? { places: null } : {}) }));
      if (query.length >= 2) searchTimer = setTimeout(() => void search(spotId, query), SEARCH_DELAY_MS);
    },

    pickUnits: (spotId, units) => source(spotId, (s) => ({ ...s, units })),

    connectWeather: (t, place, units) =>
      attempt(t.spot.id, async () => {
        const wanted = await weatherSource(t.live, place, units);
        const { dataSources } = await queryClient.query(dataSourcesQuery(t.orgId));
        const id = dataSources.some((d) => d.id === wanted.id) ? wanted.id : await create(t.orgId, { ...wanted, format: 'json' });
        const data: Record<string, unknown> = {};
        const { place: placeField, units: unitFields } = t.live;
        const placeDef = placeField ? t.manifest.fields[placeField] : undefined;
        if (placeField && placeDef?.type === 'text') data[placeField] = placeDef.maxLength ? place.name.slice(0, placeDef.maxLength) : place.name;
        if (unitFields?.temperature) data[unitFields.temperature] = units.temperature;
        if (unitFields?.wind) data[unitFields.wind] = units.wind;
        await bind(t, id, data);
      }),

    connectSource: (t, dataSourceId) => attempt(t.spot.id, () => bind(t, dataSourceId, {})),

    openFeedForm: (spotId, adding) => source(spotId, (s) => ({ ...s, adding, error: null })),

    toggleFallback: (spotId, fallbackOpen) => source(spotId, (s) => ({ ...s, fallbackOpen })),

    editFeed: (spotId, change) => source(spotId, (s) => ({ ...s, ...change, error: null })),

    addFeed: (t) =>
      attempt(t.spot.id, async () => {
        const { feedUrl, feedName, horizonDays } = get().spotSource;
        const format = SOURCE_FORMAT[t.live.source];
        const id = await create(t.orgId, {
          // Never the address itself: a private calendar's is a secret, and the name is shown.
          name: feedName.trim() || (URL.canParse(feedUrl.trim()) ? new URL(feedUrl.trim()).hostname : 'Feed'),
          format,
          feedUrl: feedUrl.trim(),
          ...(format === 'ical' ? { horizonDays } : {}),
        });
        await bind(t, id, {});
      }),
  };
};
