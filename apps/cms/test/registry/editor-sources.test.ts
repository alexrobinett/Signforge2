// The spot editor and the publish agree on which weather sources the editor made: the editor
// names them (`weatherSource`), and a publish deletes one no spot binds any more (packages/tools
// `madeBySpotEditor`).
import { madeBySpotEditor } from '@signforge/tools';
import { describe, expect, it } from 'vitest';
import { madeByEditor, weatherSource } from '~/lib/live-data';

describe("the spot editor's weather sources", () => {
  it('are the same ones to the CMS and to a publish', async () => {
    const live = { source: 'open-meteo' as const, fields: { temp: 'current.temperature_2m', high: 'daily.temperature_2m_max.0' } };
    const place = {
      id: 4180439,
      name: 'Atlanta',
      region: 'Georgia',
      country: 'United States',
      latitude: 33.749,
      longitude: -84.38798,
      timezone: 'America/New_York',
    };
    const made = await Promise.all(
      (
        [
          { temperature: '°F', wind: 'mph' },
          { temperature: '°C', wind: 'km/h' },
        ] as const
      ).map(async (units) => (await weatherSource(live, place, units)).id),
    );
    for (const id of [...made, 'src_8f2k3j4h5g6f7d8s', 'weather', 'news-bbc', 'weather-atlanta', 'weather-4180439-f-mph']) {
      expect(madeBySpotEditor(id), id).toBe(madeByEditor(id));
    }
    expect(made.every(madeBySpotEditor)).toBe(true);
  });
});
