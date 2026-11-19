// find_places's geocoder: Open-Meteo's search, read at the edge. No network: fetch is stubbed.
import { beforeEach, describe, expect, it } from 'vitest';
import { openMeteoPlaces } from '../src/data/places';
import { Client, email, testApp } from './client';

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

describe('openMeteoPlaces', () => {
  it("asks Open-Meteo's geocoding for the name and gives back each place with what a forecast needs", async () => {
    const { fetch, urls } = stub({ results: [atlanta, { ...atlanta, id: 1, name: 'Atlanta', admin1: undefined, country: 'Canada' }], generationtime_ms: 1 });
    expect(await openMeteoPlaces(undefined, fetch).search('Atlanta')).toEqual([
      { id: 4180439, name: 'Atlanta', region: 'Georgia', country: 'United States', latitude: 33.749, longitude: -84.38798, timezone: 'America/New_York' },
      { id: 1, name: 'Atlanta', region: '', country: 'Canada', latitude: 33.749, longitude: -84.38798, timezone: 'America/New_York' },
    ]);
    expect(urls).toEqual(['https://geocoding-api.open-meteo.com/v1/search?name=Atlanta&count=10&language=en&format=json']);
  });

  it('asks the geocoder it is given (a stub in the CMS e2e)', async () => {
    const { fetch, urls } = stub({});
    expect(await openMeteoPlaces('http://127.0.0.1:9/v1/search', fetch).search('Nowhere')).toEqual([]);
    expect(urls).toEqual(['http://127.0.0.1:9/v1/search?name=Nowhere&count=10&language=en&format=json']);
  });

  it('leaves out a result a forecast could not be made for, and fails on an answer that is not one', async () => {
    const { fetch } = stub({ results: [{ ...atlanta, timezone: undefined }, { ...atlanta, latitude: 'north' }, 'x', atlanta] });
    expect((await openMeteoPlaces(undefined, fetch).search('Atlanta')).map((p) => p.id)).toEqual([4180439]);
    await expect(openMeteoPlaces(undefined, stub({ error: true, reason: 'busy' }, 429).fetch).search('Atlanta')).rejects.toThrow('geocoding answered 429');
  });
});

describe('find_places through /api/tools', () => {
  const t = testApp();
  // The limiters count in one-minute windows fixed to the wall clock: start with the test's timeout left in the window.
  beforeEach(async (ctx) => {
    const left = 60_000 - (Date.now() % 60_000);
    if (left < ctx.task.timeout) await new Promise((resolve) => setTimeout(resolve, left));
  });

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
