/**
 * `find_places`'s geocoder: Open-Meteo's free search (no key), asked from the server so the
 * browser never calls a third party. Its answer is read here, at the edge: a result missing what a
 * forecast URL needs (coordinates, a time zone) is left out.
 */
import type { Place, PlaceFinder } from '@signforge/tools';

const OPEN_METEO_GEOCODING = 'https://geocoding-api.open-meteo.com/v1/search';
const TIMEOUT_MS = 5_000;
/** Results asked for: enough to tell the Atlantas apart. */
const COUNT = 10;

/** workerd's `fetch` throws "Illegal invocation" when called as a method of another object. */
const workerFetch: typeof fetch = (input, init) => fetch(input, init);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === 'string' ? v : '');
const isCoordinate = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function placeOf(r: unknown): Place[] {
  if (!isRecord(r) || !Number.isSafeInteger(r.id) || !text(r.name) || !isCoordinate(r.latitude) || !isCoordinate(r.longitude) || !text(r.timezone)) return [];
  return [
    {
      id: Number(r.id),
      name: text(r.name),
      region: text(r.admin1),
      country: text(r.country),
      latitude: r.latitude,
      longitude: r.longitude,
      timezone: text(r.timezone),
    },
  ];
}

/**
 * Searches Open-Meteo's geocoding. In dev only, `GEOCODING_URL` names another (the CMS e2e's stub,
 * the tests' closed port), as the other dev overrides do: a deployed API never sends a query elsewhere.
 */
export function openMeteoPlaces(env: { ENVIRONMENT: string; GEOCODING_URL?: string }, fetcher: typeof fetch = workerFetch): PlaceFinder {
  const url = (env.ENVIRONMENT === 'dev' && env.GEOCODING_URL) || OPEN_METEO_GEOCODING;
  return {
    async search(query) {
      const q = new URL(url);
      q.search = new URLSearchParams({ name: query, count: String(COUNT), language: 'en', format: 'json' }).toString();
      const res = await fetcher(q.href, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`geocoding answered ${res.status}`);
      const body: unknown = await res.json();
      // No match: Open-Meteo leaves `results` out.
      return isRecord(body) && Array.isArray(body.results) ? body.results.flatMap(placeOf) : [];
    },
  };
}
