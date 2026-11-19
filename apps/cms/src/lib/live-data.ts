/**
 * Where a spot's live fields come from (issue #79): the data sources the spot editor picks or
 * makes, as `list_data_sources`, `get_data_source` and `find_places` return them, and the
 * Open-Meteo forecast a place and its units make. A template says which of its fields are live in
 * its manifest's `live` (packages/contract `LiveData`); the editor binds those to one source.
 */
import { readPath, type LiveData, type TemplateManifest, type WEATHER_UNITS } from '@signforge/contract';

/** One data source, as the data source tools show it. Its feed URL is sealed and never shown. */
export interface DataSourceView {
  id: string;
  name: string;
  format: 'json' | 'ical' | 'rss';
  refreshS: number;
  horizonDays: number | null;
  failures: number;
  lastError: string | null;
  version: number;
}

/** `get_data_source`'s latest snapshot: what a spot bound to the source shows. */
export interface SnapshotView {
  id: string;
  version: number;
  fetchedAt: string;
  checkedAt: string;
  data: unknown;
}

/** A `find_places` result. */
export interface PlaceView {
  id: number;
  name: string;
  region: string;
  country: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

/** A spot's binding as the spot tools take it. */
export type BindingInput = { dataSourceId: string; path: string };

/** The data source format each kind of live template reads: an Open-Meteo forecast is plain JSON. */
export const SOURCE_FORMAT: Record<LiveData['source'], DataSourceView['format']> = { 'open-meteo': 'json', rss: 'rss', ical: 'ical' };

/** "Atlanta, Georgia, United States". */
export const placeName = (p: Pick<PlaceView, 'name' | 'region' | 'country'>) => [p.name, p.region, p.country].filter(Boolean).join(', ');

/** The fields a person types: neither live nor one of the source's settings (an Open-Meteo template's units). */
export function typedFields(m: TemplateManifest): TemplateManifest['fields'] {
  const live = m.live;
  if (!live) return m.fields;
  const skip = new Set([...Object.keys(live.fields), live.units?.temperature, live.units?.wind]);
  return Object.fromEntries(Object.entries(m.fields).filter(([name]) => !skip.has(name)));
}

/** The live fields, for the fallback section. */
export const liveFields = (m: TemplateManifest, live: LiveData): TemplateManifest['fields'] =>
  Object.fromEntries(Object.entries(m.fields).filter(([name]) => name in live.fields));

/** The source the spot's live fields are bound to, if any is. */
export function boundSource(live: LiveData, bindings: Record<string, BindingInput>): string | undefined {
  return Object.keys(live.fields)
    .map((f) => bindings[f]?.dataSourceId)
    .find(Boolean);
}

/** Every live field bound to `dataSourceId` at the template's own path; the spot's other bindings stay. */
export const bindAll = (live: LiveData, bindings: Record<string, BindingInput>, dataSourceId: string): Record<string, BindingInput> => ({
  ...bindings,
  ...Object.fromEntries(Object.entries(live.fields).map(([field, path]) => [field, { dataSourceId, path }])),
});

/** The units a forecast is fetched in, as the template's unit fields write them. */
export interface WeatherUnits {
  temperature: (typeof WEATHER_UNITS.temperature)[number];
  wind: (typeof WEATHER_UNITS.wind)[number];
}

const TEMPERATURE_PARAM = { '°F': 'fahrenheit', '°C': 'celsius' } as const;
const WIND_PARAM = { mph: 'mph', 'km/h': 'kmh' } as const;

const isTemperature = (v: unknown): v is WeatherUnits['temperature'] => v === '°F' || v === '°C';
const isWind = (v: unknown): v is WeatherUnits['wind'] => v === 'mph' || v === 'km/h';

/** The units the spot's data says, else the template's defaults, else °F and mph. */
export function unitsOf(m: TemplateManifest, data: Record<string, unknown>): WeatherUnits {
  const value = (field: string | undefined) => {
    if (!field) return undefined;
    const def = m.fields[field];
    return data[field] ?? (def && 'default' in def ? def.default : undefined);
  };
  const t = value(m.live?.units?.temperature);
  const w = value(m.live?.units?.wind);
  return { temperature: isTemperature(t) ? t : '°F', wind: isWind(w) ? w : 'mph' };
}

/** `units` with one of them changed to `value`, if it is a unit of that kind. */
export function withUnit(units: WeatherUnits, kind: keyof WeatherUnits, value: string): WeatherUnits {
  if (kind === 'temperature') return isTemperature(value) ? { ...units, temperature: value } : units;
  return isWind(value) ? { ...units, wind: value } : units;
}

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
export async function weatherSource(live: LiveData, place: PlaceView, units: WeatherUnits) {
  const current = new Set<string>();
  const daily = new Set<string>();
  let days = 1;
  for (const path of Object.values(live.fields)) {
    const [block, variable, index] = path.split('.');
    if (!variable) continue;
    if (block === 'current') current.add(variable);
    if (block === 'daily') {
      daily.add(variable);
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
export function pollErrorWords(code: string): string {
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
    default:
      return `the check failed (${code})`;
  }
}
