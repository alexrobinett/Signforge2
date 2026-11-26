// Picking a place for a weather spot (#541, review of #546): the source it finds or makes, with save_data_source
// stubbed, so what the editor asks the server for is what is checked.
import { liveSources, parseTemplateManifest, type LiveSourceDef, type TemplateManifest } from '@signforge/contract';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { weatherSource } from '../src/lib/live-data';
import { Refusal } from '../src/lib/tools';
import { createSpotSourceSlice, type SpotSourceSlice } from '../src/state/spot-source';
import { ORG, watchedQueries } from './store-kit';

const callTool = vi.fn();
const listed = vi.fn<() => string[]>();
vi.mock('~/lib/tools', async (actual) => ({ ...(await actual<object>()), callTool: (name: string, input: unknown) => callTool(name, input) }));
vi.mock('~/server/spots.functions', () => ({
  getDataSources: async () => ({ dataSources: listed().map((id) => ({ id })) }),
  getDataSource: async () => null,
  getBrandKits: vi.fn(),
  getSpot: vi.fn(),
  getSpotPreview: vi.fn(),
  getSpots: vi.fn(),
  getTemplates: vi.fn(),
}));
vi.mock('~/server/assets.functions', () => ({ getAssets: vi.fn() }));

const ATLANTA = {
  id: 4180439,
  name: 'Atlanta',
  region: 'Georgia',
  country: 'United States',
  latitude: 33.749,
  longitude: -84.38798,
  timezone: 'America/New_York',
};

/** A base template's manifest and its forecast source. */
function base(name: string): { manifest: TemplateManifest; live: LiveSourceDef } {
  const parsed = parseTemplateManifest(JSON.parse(readFileSync(new URL(`../../../templates/${name}/template.json`, import.meta.url), 'utf8')));
  if (!parsed.ok) throw new Error(parsed.problems.join('; '));
  const live = Object.values(liveSources(parsed.value.live!)).find((l) => l.source === 'open-meteo')!;
  return { manifest: parsed.value, live };
}

/** The editor's store for one spot of `template` bound to `boundTo`; `bindings` holds what the pick binds. */
function picking(template: string, boundTo?: string) {
  const { manifest, live } = base(template);
  const { queryClient } = watchedQueries();
  let bindings: Record<string, { dataSourceId: string }> = {};
  const store = createStore<SpotSourceSlice & { readTables: Record<string, never> }>()((set, get) => ({
    ...createSpotSourceSlice(set as never, get as never, { queryClient } as never),
    readTables: {},
    editSpot: (_org: string, _spot: string, change: (d: { data: object; bindings: typeof bindings }) => { bindings: typeof bindings }) => {
      bindings = change({ data: {}, bindings }).bindings;
    },
  }));
  const spot = {
    id: 'spot_1',
    bindings: boundTo ? Object.fromEntries(Object.keys(live.fields).map((f) => [f, { dataSourceId: boundTo, path: live.fields[f] }])) : {},
  };
  const target = { orgId: ORG, spot, manifest, live, source: 'default' } as never;
  return {
    connect: (units: { temperature: '°C' | '°F'; wind: 'mph' | 'km/h' }) => store.getState().connectWeather(target, ATLANTA, units),
    bound: () => [...new Set(Object.values(bindings).map((b) => b.dataSourceId))],
    error: () => Object.values(store.getState().spotSource.pickers)[0]?.error ?? null,
  };
}

const made = () => callTool.mock.calls.filter(([name]) => name === 'save_data_source').map(([, input]) => input.id);
const others = (n: number) => Array.from({ length: n }, (_, i) => `src_other_${i}`);

beforeEach(() => {
  callTool.mockReset();
  callTool.mockImplementation(async (_name: string, input: { id: string }) => ({ dataSource: { id: input.id } }));
});

describe('an Info frame spot picking a place (review of #546)', () => {
  it("reads a °C and mph org's Weather source for the place, making none", async () => {
    const weather = (await weatherSource(base('weather').live, ATLANTA, { temperature: '°C', wind: 'mph' })).id;
    listed.mockReturnValue([weather]);
    const p = picking('info-frame');
    await p.connect({ temperature: '°C', wind: 'mph' });
    expect(made()).toEqual([]);
    expect(p.bound()).toEqual([weather]);
  });

  it('keeps the source it was made before wind followed temperature, at the cap, with no refusal', async () => {
    const before = (await weatherSource(base('weather').live, ATLANTA, { temperature: '°C', wind: 'mph' })).id;
    listed.mockReturnValue([before, ...others(9)]);
    callTool.mockRejectedValue(new Refusal('conflict', 'an organization has at most 10 data sources', { max: 10 }));
    const p = picking('info-frame', before);
    await p.connect({ temperature: '°C', wind: 'km/h' });
    expect(made()).toEqual([]);
    expect(p.bound()).toEqual([before]);
    expect(p.error()).toBeNull();
  });
});

describe('a spot whose shared source cannot be made', () => {
  const older = 'weather-4180439-c-kmh-bbbbbb';

  it('stays on the same place source it reads when the org is at its ten', async () => {
    listed.mockReturnValue([older, ...others(9)]);
    callTool.mockRejectedValue(new Refusal('conflict', 'an organization has at most 10 data sources', { max: 10 }));
    const p = picking('weather', older);
    await p.connect({ temperature: '°C', wind: 'km/h' });
    expect(p.bound()).toEqual([older]);
    expect(p.error()).toBeNull();
  });

  it('says any other refusal, binding nothing new', async () => {
    listed.mockReturnValue([older]);
    callTool.mockRejectedValue(new Refusal('network', 'Could not reach SignForge'));
    const p = picking('weather', older);
    await p.connect({ temperature: '°C', wind: 'km/h' });
    expect(p.bound()).toEqual([]);
    expect(p.error()).toMatch(/Could not reach SignForge/);
  });
});
