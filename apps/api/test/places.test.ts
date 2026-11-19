// find_places's geocoder: Open-Meteo's search, read at the edge. No network: fetch is stubbed.
import { beforeEach, describe, expect, it } from 'vitest';
import { ToolError } from '@signforge/tools';
import { openMeteoPlaces } from '../src/data/places';
import { Client, email, inOneLimiterWindow, testApp } from './client';

/** A fetch that answers `body` and records the URL it was asked for. */
function stub(body: unknown, status = 200) {
  const urls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), { status });
  };
  return { fetch, urls };
}

const atlanta = {
  id: 4180439,
  name: 'Atlanta',
  latitude: 33.749,
  longitude: -84.38798,
  feature_code: 'PPLA',
  country_code: 'US',
  timezone: 'America/New_York',
  country: 'United States',
  admin1: 'Georgia',
};

/** A deployed environment, where GEOCODING_URL is never read. */
const PROD = { ENVIRONMENT: 'prod' };

describe('openMeteoPlaces', () => {
  it("asks Open-Meteo's geocoding for the name and gives back each place with what a forecast needs", async () => {
    const { fetch, urls } = stub({ results: [atlanta, { ...atlanta, id: 1, name: 'Atlanta', admin1: undefined, country: 'Canada' }], generationtime_ms: 1 });
    expect(await openMeteoPlaces(PROD, fetch).search('Atlanta')).toEqual([
      { id: 4180439, name: 'Atlanta', region: 'Georgia', country: 'United States', latitude: 33.749, longitude: -84.38798, timezone: 'America/New_York' },
      { id: 1, name: 'Atlanta', region: '', country: 'Canada', latitude: 33.749, longitude: -84.38798, timezone: 'America/New_York' },
    ]);
    expect(urls).toEqual(['https://geocoding-api.open-meteo.com/v1/search?name=Atlanta&count=10&language=en&format=json']);
  });

  it('asks the geocoder GEOCODING_URL names in dev (a stub in the CMS e2e), and Open-Meteo anywhere else', async () => {
    const { fetch, urls } = stub({});
    expect(await openMeteoPlaces({ ENVIRONMENT: 'dev', GEOCODING_URL: 'http://127.0.0.1:9/v1/search' }, fetch).search('Nowhere')).toEqual([]);
    await openMeteoPlaces({ ENVIRONMENT: 'prod', GEOCODING_URL: 'http://127.0.0.1:9/v1/search' }, fetch).search('Nowhere');
    expect(urls).toEqual([
      'http://127.0.0.1:9/v1/search?name=Nowhere&count=10&language=en&format=json',
      'https://geocoding-api.open-meteo.com/v1/search?name=Nowhere&count=10&language=en&format=json',
    ]);
  });

  it('leaves out a result a forecast could not be made for, and fails on an answer that is not one', async () => {
    const { fetch } = stub({ results: [{ ...atlanta, timezone: undefined }, { ...atlanta, latitude: 'north' }, 'x', atlanta] });
    expect((await openMeteoPlaces(PROD, fetch).search('Atlanta')).map((p) => p.id)).toEqual([4180439]);
    await expect(openMeteoPlaces(PROD, stub({ error: true }, 500).fetch).search('Atlanta')).rejects.toThrow('geocoding answered 500');
  });
});

describe('a busy geocoder', () => {
  it('is a refusal to try again later, not a failure: a 429 or no answer in time', async () => {
    const timedOut: typeof fetch = async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };
    for (const fetcher of [stub({ error: true, reason: 'busy' }, 429).fetch, timedOut]) {
      const refusal = await openMeteoPlaces(PROD, fetcher)
        .search('Atlanta')
        .catch((err: unknown) => err);
      expect(refusal).toBeInstanceOf(ToolError);
      expect(refusal).toMatchObject({ code: 'unavailable', message: 'place search is busy; try again in a minute', details: { retryAfterSeconds: 60 } });
    }
  });
});

describe('find_places through /api/tools', () => {
  const t = testApp();
  beforeEach(inOneLimiterWindow);

  it('lets one member search 30 times a minute, then refuses with rate_limited', async () => {
    const member = new Client(t);
    await member.signIn(email('place-searcher'));
    await member.setActive((await member.createOrg('Searcher')).id);
    // The geocoder is a closed local port (vitest.config.ts), so an allowed search fails upstream: anything but a 429.
    for (let i = 0; i < 30; i++) expect((await member.tool('find_places', { query: 'Atlanta' })).status, `search ${i + 1}`).not.toBe(429);
    const refused = await member.tool('find_places', { query: 'Atlanta' });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: 'rate_limited' });
  });
});
