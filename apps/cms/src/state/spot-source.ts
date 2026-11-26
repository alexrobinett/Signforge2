/**
 * Where a spot's live data comes from (issue #79): the spot editor's Source section. People choose
 * the source, never the values: a place and units for a weather template, a news feed, a calendar.
 * Choosing one finds or makes the org's data source (`save_data_source`) and binds every field
 * the template's source declares (`live.fields`) to it, in the draft the editor saves
 * (src/state/spot-editor.ts). A source another spot uses is left as it is. A template with several
 * named sources (#193) has a picker for each, with state of its own.
 *
 * A weather source follows from the place, the units and the template's variables
 * (`weatherSource` in src/lib/live-data.ts), so a second spot for the same place and units reuses it.
 *
 * A table template's list fields (issue #84) come from a CSV or JSON link: `read_table` shows its
 * columns and first rows, then the link becomes a `csv` or `json-table` source and the fields are
 * bound with a guessed mapping the person then adjusts. What was read is kept (`readTables`) for
 * the stage to play until the source's first poll.
 */
import { type LiveSourceDef, readPath, type TableFeed, type TemplateManifest } from '@signforge/contract';
import { bindAll, type PlaceView, type TableFormat, weatherSource, weatherToKeep, type WeatherUnits } from '~/lib/live-data';
import type { SpotView } from '~/lib/spots';
import { callTool, toolMessage } from '~/lib/tools';
import { dataSourceKeys, dataSourceQuery, dataSourcesQuery } from '~/queries/spots';
import type { SliceCreator } from './store';

/** How long typing a place pauses before it is looked up. */
const SEARCH_DELAY_MS = 300;
/** A new calendar's look-ahead, as `save_data_source` defaults it. */
const DEFAULT_HORIZON_DAYS = 30;

/** One source picker's state. */
interface SpotSourceState {
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
  /** The feed chosen in the list, not yet used: a select binds nothing until its button is pressed. */
  feedChoice: string | null;
  /** A bind just replaced the picker that had focus: "Change source" takes it once it is on the page. */
  focusChange: boolean;
  feedUrl: string;
  feedName: string;
  horizonDays: number;
  /** The "From a CSV or JSON link" form. */
  tableUrl: string;
  tableFormat: TableFormat;
  /** JSON only: where the list of objects is, such as data.items; empty for the whole file. */
  rowsPath: string;
  tableName: string;
  /** What `read_table` read from the form's link; null before a read, and after the form changes. */
  table: TableFeed | null;
  reading: boolean;
  pending: boolean;
  error: string | null;
}

type TableForm = Pick<SpotSourceState, 'tableUrl' | 'tableFormat' | 'rowsPath' | 'tableName'>;

/** One source picker on a spot's page: the spot, and the name of the template's source it binds (`liveSources`). */
export interface PickerRef {
  spot: Pick<SpotView, 'id'>;
  source: string;
}

/** What the source actions need of the open spot and one of its template's sources. */
export interface SourceTarget extends PickerRef {
  orgId: string;
  spot: SpotView;
  manifest: TemplateManifest;
  live: LiveSourceDef;
}

/** The pickers of one spot's page, by source name; another spot's page starts from none. */
interface SpotSources {
  spotId: string | null;
  pickers: Partial<Record<string, SpotSourceState>>;
}

export interface SpotSourceSlice {
  spotSource: SpotSources;
  /** By source id, the table `read_table` read when the editor added it: the stage plays it until the first poll. */
  readTables: Partial<Record<string, TableFeed>>;
  /** Opens or closes the picker over a bound source; a weather picker opens looking up `placeQuery` (the spot's place). */
  changeSource: (at: PickerRef, open: boolean, placeQuery?: string) => void;
  /** The place being typed; looked up a moment after typing stops. */
  typePlace: (at: PickerRef, query: string) => void;
  pickUnits: (at: PickerRef, units: WeatherUnits) => void;
  /** Binds the weather fields to the forecast for `place`, making that source if the org has none. */
  connectWeather: (target: SourceTarget, place: PlaceView, units: WeatherUnits) => Promise<void>;
  /** Binds the source's fields to one of the org's sources. */
  connectSource: (target: SourceTarget, dataSourceId: string) => Promise<void>;
  openFeedForm: (at: PickerRef, open: boolean) => void;
  /** The fallback section opened or closed, as the person toggled it. */
  toggleFallback: (at: PickerRef, open: boolean) => void;
  chooseFeed: (at: PickerRef, dataSourceId: string) => void;
  /** "Change source" has taken focus after a bind. */
  focusedChange: (at: PickerRef) => void;
  editFeed: (at: PickerRef, change: Partial<Pick<SpotSourceState, 'feedUrl' | 'feedName' | 'horizonDays'>>) => void;
  /** Adds the feed in the form as a source and binds the live fields to it. */
  addFeed: (target: SourceTarget, format: 'rss' | 'ical') => Promise<void>;
  /** The table form changed; what was read from the old link no longer shows, unless only the name changed. */
  editTable: (at: PickerRef, change: Partial<TableForm>) => void;
  /** Reads the form's link now (`read_table`), to show its columns and first rows. */
  readTable: (at: PickerRef) => Promise<void>;
  /** Adds the link that was read as a source and binds the table fields to it, with a guessed mapping. */
  addTable: (target: SourceTarget) => Promise<void>;
}

const initial: SpotSourceState = {
  changing: false,
  placeQuery: '',
  places: null,
  searching: false,
  units: null,
  adding: false,
  fallbackOpen: false,
  feedChoice: null,
  focusChange: false,
  feedUrl: '',
  feedName: '',
  horizonDays: DEFAULT_HORIZON_DAYS,
  tableUrl: '',
  tableFormat: 'csv',
  rowsPath: '',
  tableName: '',
  table: null,
  reading: false,
  pending: false,
  error: null,
};

/** One picker's state: the store's, or a fresh one for another spot's page or a picker not used yet. */
export const sourceStateOf = (state: SpotSources, at: PickerRef): SpotSourceState =>
  (state.spotId === at.spot.id && Object.hasOwn(state.pickers, at.source) ? state.pickers[at.source] : undefined) ?? initial;

export const createSpotSourceSlice: SliceCreator<SpotSourceSlice> = (set, get, { queryClient }) => {
  const source = (at: PickerRef, change: (s: SpotSourceState) => SpotSourceState) =>
    set((s) => ({
      spotSource: {
        spotId: at.spot.id,
        pickers: { ...(s.spotSource.spotId === at.spot.id ? s.spotSource.pickers : {}), [at.source]: change(sourceStateOf(s.spotSource, at)) },
      },
    }));
  /** Each picker's pending search, and a count of its searches, so a slow answer never replaces a newer one. */
  const searches = new Map<string, { timer?: ReturnType<typeof setTimeout>; seq: number }>();
  const searchOf = (at: PickerRef) => {
    const key = `${at.spot.id}/${at.source}`;
    const found = searches.get(key) ?? { seq: 0 };
    searches.set(key, found);
    return found;
  };

  async function search(at: PickerRef, query: string) {
    const mine = searchOf(at);
    const seq = ++mine.seq;
    try {
      const places = (await callTool('find_places', { query })).places;
      if (seq === mine.seq) source(at, (s) => ({ ...s, places, searching: false }));
    } catch (err) {
      if (seq === mine.seq) source(at, (s) => ({ ...s, places: null, searching: false, error: `Could not look the place up: ${toolMessage(err)}` }));
    }
  }

  /**
   * Binds the source's fields to `dataSourceId` and sets the fields the source decides (`data`).
   * The stage compiles against the preview's sources and plays the source's snapshot, so both are
   * read first; another spot's source stays as it is.
   */
  async function bind(t: SourceTarget, dataSourceId: string, data: Record<string, unknown>) {
    const [read] = await Promise.all([
      queryClient.query(dataSourceQuery(t.orgId, dataSourceId)),
      queryClient.invalidateQueries({ queryKey: ['org', t.orgId, 'spotPreview'] }),
    ]);
    // A table's mapping is guessed from its columns: the latest snapshot's, or what was just read.
    const known = readPath(read?.snapshot?.data, 'columns');
    const columns = Array.isArray(known) ? known : (get().readTables[dataSourceId]?.columns ?? []);
    get().editSpot(t.orgId, t.spot.id, (d) => ({
      ...d,
      data: { ...d.data, ...data },
      bindings: bindAll(t.manifest, t.live, d.bindings, dataSourceId, columns),
    }));
    source(t, (s) => ({ ...initial, units: s.units, fallbackOpen: s.fallbackOpen, focusChange: true }));
  }

  /**
   * Makes a source and reads the org's list again. One made with the same id since the list was
   * read (another tab, a teammate) is refused as a conflict, shown as the error; picking again finds it.
   */
  async function create(orgId: string, input: Record<string, unknown> & { id?: string }): Promise<string> {
    try {
      return (await callTool('save_data_source', { ...input, idempotencyKey: crypto.randomUUID() })).dataSource.id;
    } finally {
      void queryClient.invalidateQueries({ queryKey: dataSourceKeys.all(orgId), exact: true });
    }
  }

  async function attempt(at: PickerRef, run: () => Promise<void>) {
    source(at, (s) => ({ ...s, pending: true, error: null }));
    try {
      await run();
    } catch (err) {
      source(at, (s) => ({ ...s, pending: false, error: toolMessage(err) }));
    }
  }

  return {
    spotSource: { spotId: null, pickers: {} },
    readTables: {},

    changeSource(at, changing, placeQuery) {
      source(at, (s) => ({ ...initial, changing, fallbackOpen: s.fallbackOpen }));
      if (changing && placeQuery) get().typePlace(at, placeQuery);
    },

    typePlace(at, placeQuery) {
      const mine = searchOf(at);
      clearTimeout(mine.timer);
      const query = placeQuery.trim();
      source(at, (s) => ({ ...s, placeQuery, searching: query.length >= 2, error: null, ...(query.length < 2 ? { places: null } : {}) }));
      if (query.length >= 2) mine.timer = setTimeout(() => void search(at, query), SEARCH_DELAY_MS);
    },

    pickUnits: (at, units) => source(at, (s) => ({ ...s, units })),

    connectWeather: (t, place, units) =>
      attempt(t, async () => {
        const wanted = await weatherSource(t.live, place, units);
        const { dataSources } = await queryClient.query(dataSourcesQuery(t.orgId));
        // A new one that cannot be made (the org at its ten, #541) leaves the spot on the one it reads, if the same place's.
        const current = weatherToKeep(
          wanted.id,
          Object.keys(t.live.fields).map((f) => t.spot.bindings?.[f]?.dataSourceId),
          dataSources.map((d) => d.id),
        );
        const make = async () => {
          try {
            return await create(t.orgId, { ...wanted, format: 'json' });
          } catch (err) {
            if (current === undefined) throw err;
            return current;
          }
        };
        const id = dataSources.some((d) => d.id === wanted.id) ? wanted.id : await make();
        const data: Record<string, unknown> = {};
        const { place: placeField, units: unitFields } = t.live;
        const placeDef = placeField ? t.manifest.fields[placeField] : undefined;
        if (placeField && placeDef?.type === 'text') data[placeField] = placeDef.maxLength ? place.name.slice(0, placeDef.maxLength) : place.name;
        if (unitFields?.temperature) data[unitFields.temperature] = units.temperature;
        if (unitFields?.wind) data[unitFields.wind] = units.wind;
        await bind(t, id, data);
      }),

    connectSource: (t, dataSourceId) => attempt(t, () => bind(t, dataSourceId, {})),

    openFeedForm: (at, adding) => source(at, (s) => ({ ...s, adding, error: null })),

    toggleFallback: (at, fallbackOpen) => source(at, (s) => ({ ...s, fallbackOpen })),

    chooseFeed: (at, feedChoice) => source(at, (s) => ({ ...s, feedChoice, error: null })),

    focusedChange: (at) => source(at, (s) => ({ ...s, focusChange: false })),

    editFeed: (at, change) => source(at, (s) => ({ ...s, ...change, error: null })),

    // A new address, format or path makes what was read stale; a new name does not.
    editTable: (at, change) =>
      source(at, (s) => ({ ...s, ...change, table: Object.keys(change).every((k) => k === 'tableName') ? s.table : null, error: null })),

    async readTable(at) {
      const { tableUrl, tableFormat, rowsPath } = sourceStateOf(get().spotSource, at);
      source(at, (s) => ({ ...s, reading: true, table: null, error: null }));
      try {
        const output = await callTool('read_table', {
          feedUrl: tableUrl.trim(),
          format: tableFormat,
          ...(tableFormat === 'json-table' && rowsPath.trim() ? { rowsPath: rowsPath.trim() } : {}),
        });
        source(at, (s) => ({ ...s, reading: false, table: output.table }));
      } catch (err) {
        source(at, (s) => ({ ...s, reading: false, error: toolMessage(err) }));
      }
    },

    addTable: (t) =>
      attempt(t, async () => {
        const { tableUrl, tableFormat, rowsPath, tableName, table } = sourceStateOf(get().spotSource, t);
        if (!table) return;
        const url = tableUrl.trim();
        const id = await create(t.orgId, {
          // Never the address itself, as for a feed: it may be a secret.
          name: tableName.trim() || (URL.canParse(url) ? new URL(url).hostname : 'Table'),
          format: tableFormat,
          feedUrl: url,
          ...(tableFormat === 'json-table' && rowsPath.trim() ? { rowsPath: rowsPath.trim() } : {}),
        });
        set((s) => ({ readTables: { ...s.readTables, [id]: table } }));
        await bind(t, id, {});
      }),

    addFeed: (t, format) =>
      attempt(t, async () => {
        const { feedUrl, feedName, horizonDays } = sourceStateOf(get().spotSource, t);
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
