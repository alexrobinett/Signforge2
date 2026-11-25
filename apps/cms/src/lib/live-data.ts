/**
 * Where a spot's live fields come from (issue #79): the data sources the spot editor picks or
 * makes, as `list_data_sources`, `get_data_source` and `find_places` return them, and the
 * Open-Meteo forecast a place and its units make. A template says which of its fields are live in
 * its manifest's `live` (packages/contract `LiveData`): one source, or several by name (#193); the
 * editor binds each source's fields to one data source. A
 * `table` template's list fields may also be typed: they are live only once bound to a CSV or
 * JSON link (issue #84), with a mapping from the table's columns to their items' properties.
 */
import type { DraftBinding } from '@signforge/compiler/draft';
import {
  boundValue,
  readPath,
  SNAPSHOT_STALE_MS,
  TABLE_ROWS_PATH,
  type FieldDef,
  liveSources,
  type LiveSourceDef,
  type TableMapping,
  type TemplateManifest,
  type WEATHER_UNITS,
} from '@signforge/contract';
import type { ToolOutput } from '@signforge/tools/outputs';
import { ago } from './screen-status';

/** One data source, as the data source tools show it. Its feed URL is sealed and never shown. */
export type DataSourceView = ToolOutput<'get_data_source'>['dataSource'];

/** `get_data_source`'s latest snapshot: what a spot bound to the source shows. */
export type SnapshotView = NonNullable<ToolOutput<'get_data_source'>['snapshot']>;

/** A `find_places` result. */
export type PlaceView = ToolOutput<'find_places'>['places'][number];

/** A spot's binding as the spot tools take it. */
export type BindingInput = DraftBinding;

/** The formats a table template reads (`LiveSourceDef` source `table`): a forecast is plain `json`, news `rss`, a calendar `ical`. */
const TABLE_FORMATS = ['csv', 'json-table'] as const;
export type TableFormat = (typeof TABLE_FORMATS)[number];
export const isTableFormat = (format: string): format is TableFormat => TABLE_FORMATS.some((f) => f === format);
type ListDef = Extract<FieldDef, { type: 'list' }>;

/** "Atlanta, Georgia, United States". */
export const placeName = (p: Pick<PlaceView, 'name' | 'region' | 'country'>) => [p.name, p.region, p.country].filter(Boolean).join(', ');

/**
 * The fields a person types: neither live nor one of a source's settings (an Open-Meteo
 * source's units). A table source's live fields are typed until they are bound.
 */
export function typedFields(m: Pick<TemplateManifest, 'fields' | 'live'>, bindings: Record<string, BindingInput>): TemplateManifest['fields'] {
  if (!m.live) return m.fields;
  const skip = new Set(
    Object.values(liveSources(m.live)).flatMap((live) => [
      ...(live.source === 'table' ? Object.keys(live.fields).filter((f) => bindings[f]) : Object.keys(live.fields)),
      live.units?.temperature,
      live.units?.wind,
    ]),
  );
  return Object.fromEntries(Object.entries(m.fields).filter(([name]) => !skip.has(name)));
}

/** One source's live fields, for its fallback section. */
export const liveFields = (m: TemplateManifest, live: LiveSourceDef): TemplateManifest['fields'] =>
  Object.fromEntries(Object.entries(m.fields).filter(([name]) => name in live.fields));

/** The data source a template source's fields are bound to, if any is. */
export function boundSource(live: LiveSourceDef, bindings: Record<string, BindingInput>): string | undefined {
  return Object.keys(live.fields)
    .map((f) => bindings[f]?.dataSourceId)
    .find(Boolean);
}

/**
 * Every field of one template source bound to `dataSourceId` at the template's own path; the
 * spot's other bindings stay. A table source's list fields each get a mapping guessed from the
 * table's `columns`.
 */
export const bindAll = (
  m: TemplateManifest,
  live: LiveSourceDef,
  bindings: Record<string, BindingInput>,
  dataSourceId: string,
  columns: readonly string[] = [],
): Record<string, BindingInput> => ({
  ...bindings,
  ...Object.fromEntries(
    Object.entries(live.fields).map(([field, path]) => {
      const def = m.fields[field];
      return [field, live.source === 'table' && def?.type === 'list' ? { dataSourceId, path, table: guessMapping(def, columns) } : { dataSourceId, path }];
    }),
  ),
});

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** Other words a column may go by, per item property name. */
const ALSO: Record<string, string[]> = { name: ['item', 'title', 'dish', 'product'], price: ['cost', 'amount'], description: ['details', 'desc'] };

/**
 * A first mapping for a list field from a table's columns: each item property to the column named
 * like it (its name, its label, or a usual other word), and a property without a default to the
 * first column not yet taken. The person changes it in the Source section.
 */
export function guessMapping(def: ListDef, columns: readonly string[]): TableMapping {
  const taken = new Set<string>();
  const mapped: Record<string, string> = {};
  for (const [prop, d] of Object.entries(def.item)) {
    if (d.type === 'image') continue;
    // Own keys only: an org template's item may have a property named `constructor`.
    const words = new Set([prop, d.label, ...(Object.hasOwn(ALSO, prop) ? (ALSO[prop] ?? []) : [])].map(squash));
    const named = columns.find((c) => !taken.has(c) && words.has(squash(c)));
    if (named) mapped[prop] = named;
  }
  for (const c of Object.values(mapped)) taken.add(c);
  for (const [prop, d] of Object.entries(def.item)) {
    if (d.type === 'image' || mapped[prop] || d.default !== undefined) continue;
    const free = columns.find((c) => !taken.has(c));
    if (free === undefined) continue;
    mapped[prop] = free;
    taken.add(free);
  }
  return { columns: mapped };
}

/** The items a table binding fills from a snapshot, as a screen in `locale` would, and what is wrong (the contract's `boundValue`). */
export function tableRows(m: TemplateManifest, field: string, binding: BindingInput, data: unknown, locale: string) {
  const { value, problems } = boundValue(m.fields, field, { source: binding.dataSourceId, path: TABLE_ROWS_PATH, table: binding.table }, data, locale);
  return { items: Array.isArray(value) ? value : undefined, problems };
}

/** The units a forecast is fetched in, as the template's unit fields write them. */
export interface WeatherUnits {
  temperature: (typeof WEATHER_UNITS.temperature)[number];
  wind: (typeof WEATHER_UNITS.wind)[number];
}

const TEMPERATURE_PARAM = { '°F': 'fahrenheit', '°C': 'celsius' } as const;
const WIND_PARAM = { mph: 'mph', 'km/h': 'kmh' } as const;

const isTemperature = (v: unknown): v is WeatherUnits['temperature'] => v === '°F' || v === '°C';
const isWind = (v: unknown): v is WeatherUnits['wind'] => v === 'mph' || v === 'km/h';

/** The units the spot's data says for an Open-Meteo source, else the template's defaults, else °F and mph. */
export function unitsOf(m: TemplateManifest, live: LiveSourceDef, data: Record<string, unknown>): WeatherUnits {
  const value = (field: string | undefined) => {
    if (!field) return undefined;
    const def = m.fields[field];
    return data[field] ?? (def && 'default' in def ? def.default : undefined);
  };
  const t = value(live.units?.temperature);
  const w = value(live.units?.wind);
  return { temperature: isTemperature(t) ? t : '°F', wind: isWind(w) ? w : 'mph' };
}

/** `units` with one of them changed to `value`, if it is a unit of that kind. */
export function withUnit(units: WeatherUnits, kind: keyof WeatherUnits, value: string): WeatherUnits {
  if (kind === 'temperature') return isTemperature(value) ? { ...units, temperature: value } : units;
  return isWind(value) ? { ...units, wind: value } : units;
}

/** The ids `weatherSource` makes. */
const WEATHER_SOURCE_ID = /^weather-\d+-[cf]-(?:mph|kmh)-[0-9a-f]{6}$/;

/**
 * Whether the editor made this source from a place and units (`weatherSource`), so picking the
 * place again makes it again. A feed or calendar was added by its address, which is never shown
 * again: that one a person deletes, not the editor.
 */
export const madeByEditor = (dataSourceId: string) => WEATHER_SOURCE_ID.test(dataSourceId);

async function shortHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest).slice(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The Open-Meteo forecast for a place, in these units, with the variables the template's live
 * paths read (`current.x`, `daily.x.N`). Its id follows from the place, the units and the
 * variables, so a second spot for the same place reuses the source, and a template that reads
 * other variables gets its own. `timeformat=unixtime` makes times numbers, which number fields take.
 */
export async function weatherSource(live: LiveSourceDef, place: PlaceView, units: WeatherUnits) {
  const current = new Set<string>();
  const daily = new Set<string>();
  let days = 1;
  for (const path of Object.values(live.fields)) {
    const [block, variable, index] = path.split('.');
    if (!variable) continue;
    // Open-Meteo always includes `current.time` and `daily.time` and rejects `time` in the query list.
    if (block === 'current' && variable !== 'time') current.add(variable);
    if (block === 'daily') {
      if (variable !== 'time') daily.add(variable);
      days = Math.max(days, Number(index ?? 0) + 1);
    }
  }
  const variables = `current=${[...current].join(',')}&daily=${[...daily].join(',')}`;
  const params = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    ...(current.size ? { current: [...current].join(',') } : {}),
    ...(daily.size ? { daily: [...daily].join(','), forecast_days: String(days) } : {}),
    temperature_unit: TEMPERATURE_PARAM[units.temperature],
    wind_speed_unit: WIND_PARAM[units.wind],
    timezone: place.timezone,
    timeformat: 'unixtime',
  });
  return {
    id: `weather-${place.id}-${units.temperature === '°C' ? 'c' : 'f'}-${WIND_PARAM[units.wind]}-${await shortHash(variables)}`,
    name: `Weather, ${placeName(place)} (${units.temperature}, ${units.wind})`.slice(0, 100),
    feedUrl: `https://api.open-meteo.com/v1/forecast?${params.toString().replaceAll('%2C', ',')}`,
  };
}

/** Whether screens show the snapshot: one confirmed within `SNAPSHOT_STALE_MS`. */
export const isFresh = (snapshot: SnapshotView | null, now: number): snapshot is SnapshotView =>
  snapshot !== null && now - Date.parse(snapshot.checkedAt) <= SNAPSHOT_STALE_MS;

/** How fresh the source's data is, and what screens do about it. */
export function freshness(source: DataSourceView, snapshot: SnapshotView | null, now: number): string {
  const failing = source.lastError ? pollErrorWords(source.lastError) : undefined;
  if (!snapshot)
    return failing
      ? `The first check failed: ${failing}. Screens show the fallback values until it works.`
      : 'Waiting for the first check, within a minute. Until then screens show the fallback values.';
  const since = now - Date.parse(snapshot.checkedAt);
  if (!isFresh(snapshot, now)) return `Not confirmed for ${ago(since)}: screens show the fallback values.`;
  const when = since < 60_000 ? 'Checked just now.' : `Checked ${ago(since)} ago.`;
  return failing ? `${when} The last check failed: ${failing}. Screens keep this data for a day, then show the fallback values.` : when;
}

/** WMO weather codes, as Open-Meteo sends them, in words. */
const WMO: [number[], string][] = [
  [[0], 'clear'],
  [[1], 'mainly clear'],
  [[2], 'partly cloudy'],
  [[3], 'overcast'],
  [[45, 48], 'fog'],
  [[51, 53, 55, 56, 57], 'drizzle'],
  [[61, 63, 65, 66, 67], 'rain'],
  [[71, 73, 75, 77], 'snow'],
  [[80, 81, 82], 'rain showers'],
  [[85, 86], 'snow showers'],
  [[95, 96, 99], 'thunderstorm'],
];
export const weatherWords = (code: unknown) => WMO.find(([codes]) => typeof code === 'number' && codes.includes(code))?.[1];

/** The live value at a binding's path in the snapshot. */
export const liveValue = (snapshot: SnapshotView | null, path: string): unknown => (snapshot ? readPath(snapshot.data, path) : undefined);

/** Why a poll failed, from the poller's category (apps/api `PollError`), in words. */
function pollErrorWords(code: string): string {
  switch (code) {
    case 'timeout':
      return 'the feed took too long to answer';
    case 'http-status':
      return 'the feed answered with an error';
    case 'dns':
    case 'network':
      return 'the feed could not be reached';
    case 'private-address':
    case 'blocked-address':
    case 'ip-literal':
      return 'the feed is on a private address';
    case 'too-large':
      return 'the feed is larger than a screen may hold';
    case 'doctype':
    case 'malformed':
    case 'unknown-format':
      return 'the feed is not one SignForge can read';
    case 'unfit':
      return 'its data does not fit the spots that use it';
    case 'missing-column':
      return 'the file no longer has a column a spot uses';
    case 'not-a-table':
      return 'the JSON is not a list of objects at that path';
    default:
      return `the check failed (${code})`;
  }
}

/**
 * The first rows of a live list by their `title`: a `NewsFeed` item's headline, a `CalendarFeed`
 * event's name. Read by name: the poller stores snapshots with sorted keys, so a row's first text
 * is its date or its source.
 */
export function rowTitles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).flatMap((row: unknown) => {
    const title = readPath(row, 'title');
    return typeof title === 'string' && title ? [title] : [];
  });
}
