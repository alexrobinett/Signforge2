import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  SCREEN_BOX,
  displayHoursProblems,
  readPath,
  validateBoundValue,
  fitsScreenBox,
  imageSizeProblem,
  validateDataSnapshot,
  validateDeviceCommand,
  validateDeviceSocketMessage,
  validateManifest,
  validatePairPollResponse,
  validatePairStartResponse,
  validateServerSocketMessage,
  validateSpotData,
  validateSyncRequest,
  validateSyncResponse,
  validateTemplateManifest,
  type FieldDef,
  type ScreenManifest,
  type SyncRequest,
  type SyncResponse,
  type TemplateManifest,
} from './index';

/** Any JSON value, including the keys that trip up naive lookups. */
const json = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: 'small' },
    fc.constant(null),
    fc.boolean(),
    fc.double(),
    fc.integer(),
    fc.string(),
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(fc.oneof(fc.string(), fc.constantFrom('__proto__', 'constructor', 'toString', 'type', 'id', 'kind')), tie('value'), { maxKeys: 5 }),
  ),
})).value;

const total = (name: string, run: (...args: unknown[]) => unknown, arity = 1) =>
  it(`${name} never throws and always returns a list of problems`, () => {
    fc.assert(
      fc.property(fc.array(json, { minLength: arity, maxLength: arity }), (args) => {
        const out = run(...args);
        expect(Array.isArray(out)).toBe(true);
        for (const p of out as unknown[]) expect(typeof p).toBe('string');
      }),
      { numRuns: 500 },
    );
  });

describe('validateSpotData', () => {
  total('validateSpotData', (f, d, a, b) => validateSpotData(f as never, d as never, a as never, b as never), 4);

  const fields: Record<string, FieldDef> = { price: { type: 'number', label: 'Price', min: 0, max: 100, step: 0.5 } };

  it('holds a number to its min, max and step', () => {
    expect(validateSpotData(fields, { price: 9.5 }, {})).toEqual([]);
    expect(validateSpotData(fields, { price: -1 }, {})).toEqual(['field "price" must be at least 0']);
    expect(validateSpotData(fields, { price: 101 }, {})).toEqual(['field "price" must be at most 100']);
    expect(validateSpotData(fields, { price: 9.25 }, {})).toEqual(['field "price" must be a multiple of 0.5']);
    expect(validateSpotData(fields, { price: Number.NaN }, {})).toEqual(['field "price" must be a number']);
  });
});

describe('image size', () => {
  it('refuses an image whose decoded pixels would exceed the budget, even with one side in the box', () => {
    expect(imageSizeProblem(1920, 1080, SCREEN_BOX.landscape)).toBeUndefined();
    // A 16:9 photo scaled to cover a portrait box.
    expect(imageSizeProblem(3413, 1920, SCREEN_BOX.portrait)).toBeUndefined();
    expect(imageSizeProblem(65_535, 1080, SCREEN_BOX.landscape)).toBe('65535x1080 is 70.8 million pixels; a screen decodes at most 8.3 million (3840x2160)');
    expect(fitsScreenBox(65_535, 1080, SCREEN_BOX.landscape)).toBe(false);
    expect(imageSizeProblem(3840, 2160, SCREEN_BOX.landscape)).toBe('3840x2160 is larger than a landscape screen needs: scale it to cover 1920x1080');
  });
});

// ------------------------------------------------------------------ fixtures

const template: TemplateManifest = {
  id: 'menu',
  version: '1.0.0',
  name: 'Menu',
  background: '#000',
  orientations: ['landscape'],
  uses: [],
  duration: { defaultMs: 8000, minMs: 4000, maxMs: 20_000 },
  fields: {
    title: { type: 'text', label: 'Title', maxLength: 40 },
    price: { type: 'number', label: 'Price', min: 0, max: 100, step: 0.5, default: 5 },
    photo: { type: 'image', label: 'Photo' },
    items: {
      type: 'list',
      label: 'Items',
      maxItems: 2,
      item: { name: { type: 'text', label: 'Name' }, hot: { type: 'boolean', label: 'Hot', default: false } },
    },
  },
};

const validManifest = (): ScreenManifest => ({
  schema: 2,
  id: 'm1',
  generatedAt: '2026-11-17T00:00:00.000Z',
  screen: {
    id: 's1',
    name: 'Counter',
    timezone: 'Europe/London',
    orientation: 'landscape',
    displayHours: { weekly: [{ from: '07:00', to: '22:00', days: [1, 2] }] },
  },
  files: { 'sha-html': { size: 10, type: 'text/html' }, 'sha-photo': { size: 10, type: 'image/jpeg' } },
  templates: { 'base/menu@1.0.0': { manifest: structuredClone(template), html: 'sha-html' } },
  spots: {
    menu: {
      id: 'menu',
      name: 'Menu',
      kind: 'template',
      template: 'base/menu@1.0.0',
      durationMs: 8000,
      data: { title: 'Lunch', price: 7.5, items: [{ name: 'Soup', hot: true }] },
      assets: { photo: 'sha-photo' },
      bindings: { title: { source: 'feed', path: 'headline' } },
    },
    web: { id: 'web', name: 'Web', kind: 'url', url: 'https://example.com/', durationMs: 5000 },
  },
  playlists: { all: { id: 'all', name: 'All', transition: { type: 'fade', ms: 500 }, items: [{ spot: 'menu' }, { spot: 'web' }] } },
  dataSources: { feed: { id: 'feed', refreshS: 300 } },
  schedule: [{ id: 'e1', playlist: 'all', priority: 1, target: 'screen', from: '06:00', to: '10:00' }],
  defaultPlaylist: 'all',
});

const validSyncRequest = (): SyncRequest => ({
  seq: 3,
  player: { version: '1.2.3', manifestSchemas: [2], protocols: [1] },
  manifest: { active: 'm1', filesMissing: 0 },
  display: { on: true, methods: { signal: 'ok' }, override: { state: 'off', until: '2026-11-17T18:00:00Z' } },
  deviceTime: '2026-11-17T13:05:00Z',
  playCounts: [{ hour: '2026-11-17T13:00Z', spot: 'menu', manifest: 'm1', plays: 4, ms: 32_000 }],
  snapshots: { feed: '2026-11-17T13:00:00Z' },
});

const validSyncResponse = (): SyncResponse => ({
  serverTime: '2026-11-17T13:05:01Z',
  nextSyncS: 300,
  ackSeq: 3,
  desiredManifest: 'm1',
  socketTicket: 't',
  snapshots: [{ id: 'feed', fetchedAt: '2026-11-17T13:00:00Z', data: { headline: 'Hi' } }],
  commands: [{ type: 'reload' }, { type: 'display', override: null }],
});

/** Every path to a value inside `v`, so a mutation can reach any depth. */
function paths(v: unknown, at: (string | number)[] = []): (string | number)[][] {
  if (v === null || typeof v !== 'object') return [at];
  const keys: (string | number)[] = Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v);
  return [at, ...keys.flatMap((k) => paths((v as Record<string | number, unknown>)[k], [...at, k]))];
}

/** A valid value with one place, anywhere inside it, replaced by random JSON or removed. */
const mutated = (make: () => unknown) =>
  fc.tuple(fc.nat(), json, fc.boolean()).map(([n, replacement, remove]) => {
    const v = make() as Record<string | number, unknown>;
    const all = paths(v).filter((p) => p.length);
    const path = all[n % all.length]!;
    let parent = v;
    for (const k of path.slice(0, -1)) parent = parent[k] as Record<string | number, unknown>;
    const last = path[path.length - 1]!;
    if (remove) delete parent[last];
    else parent[last] = replacement;
    return v;
  });

const totalOn = (name: string, arb: fc.Arbitrary<unknown>, run: (v: unknown) => unknown) =>
  it(`${name} never throws on ${arb === json ? 'random JSON' : 'a valid value with one part replaced'}`, () => {
    fc.assert(
      fc.property(arb, (v) => {
        const out = run(v);
        expect(Array.isArray(out) && (out as unknown[]).every((p) => typeof p === 'string')).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

const validators: [string, (v: unknown) => string[], (() => unknown)?][] = [
  ['validateManifest', validateManifest, validManifest],
  ['validateTemplateManifest', validateTemplateManifest, () => structuredClone(template)],
  ['validateDataSnapshot', validateDataSnapshot],
  ['validateBoundValue', (v) => validateBoundValue(template.fields, 'items', v), () => [{ name: 'Soup', hot: true }]],
  ['displayHoursProblems', displayHoursProblems, () => validManifest().screen.displayHours],
  ['validatePairStartResponse', validatePairStartResponse, () => ({ code: 'ABC123', pollToken: 'p', expiresAt: '2026-11-17T13:15:00Z' })],
  ['validatePairPollResponse', validatePairPollResponse, () => ({ status: 'paired', screenId: 's1', credential: 'sfd_s1.secret' })],
  ['validateSyncRequest', validateSyncRequest, validSyncRequest],
  ['validateSyncResponse', validateSyncResponse, validSyncResponse],
  ['validateDeviceCommand', validateDeviceCommand, () => ({ type: 'display', override: { state: 'on', until: '2026-11-17T18:00:00Z' } })],
  ['validateServerSocketMessage', validateServerSocketMessage, () => ({ type: 'command', command: { type: 'reboot' } })],
  ['validateDeviceSocketMessage', validateDeviceSocketMessage, () => ({ type: 'applied', manifest: 'm1' })],
];

describe('every validator is total', () => {
  for (const [name, run, make] of validators) {
    totalOn(name, json, run);
    if (make) {
      it(`${name} accepts its valid fixture`, () => expect(run(make())).toEqual([]));
      totalOn(name, mutated(make), run);
    }
  }
  totalOn(
    'validateSpotData',
    mutated(() => ({ fields: structuredClone(template.fields), ...structuredClone(validManifest().spots.menu) })),
    (v) => {
      const o = v as Record<string, unknown>;
      return validateSpotData(o.fields, o.data, o.assets, o.bindings);
    },
  );
});

// ------------------------------------------------------------------ behaviour

describe('validateTemplateManifest', () => {
  it('checks each field definition, so the spot check can trust it', () => {
    const bad = structuredClone(template) as unknown as { fields: Record<string, unknown> };
    bad.fields.price = { type: 'number', label: 'Price', min: 10, max: 1, step: 0 };
    bad.fields.size = { type: 'select', label: 'Size', options: [] };
    bad.fields.items = { type: 'list', label: 'Items', item: { pic: { type: 'image', label: 'Pic' } } };
    bad.fields.odd = { type: 'video', label: 'Odd' };
    expect(validateTemplateManifest(bad)).toEqual([
      'field "price": step must be a number above 0',
      'field "price": min must not be above max',
      'field "items.pic": a list row cannot hold an image',
      'field "size": options must be a list of text',
      'field "odd": type must be one of text, number, boolean, color, select, image, list',
    ]);
  });

  it('holds a default to its own field', () => {
    const bad = structuredClone(template);
    bad.fields.price = { type: 'number', label: 'Price', max: 10, default: 50 };
    expect(validateTemplateManifest(bad)).toEqual(['field "price" default: field "price" must be at most 10']);
  });
});

describe('validateSpotData limits', () => {
  it('enforces a list maxItems and row shape', () => {
    const data = { title: 'x', items: [{ name: 'a' }, { name: 'b' }, 'c'] };
    expect(validateSpotData(template.fields, data, { photo: 'sha' })).toEqual(['field "items" has more than 2 rows', 'field "items" row 3 must be an object']);
  });

  it('does not take inherited keys for fields', () => {
    expect(validateSpotData(template.fields, { title: 'x', items: [], constructor: 1 }, { photo: 'sha' }, { toString: { source: 'f', path: 'a' } })).toEqual([
      'binding for unknown field "toString"',
      'unknown field "constructor"',
    ]);
  });
});

describe('live values for bound fields', () => {
  total('validateBoundValue', (f, n, v) => validateBoundValue(f, n, v), 3);

  it('accepts a value that fits the field it is bound to', () => {
    expect(validateBoundValue(template.fields, 'title', 'Dinner')).toEqual([]);
    expect(validateBoundValue(template.fields, 'items', [{ name: 'Tea' }])).toEqual([]);
  });

  it('refuses the wrong type, the wrong shape, too many rows and a missing value', () => {
    expect(validateBoundValue(template.fields, 'title', 42)).toEqual(['field "title" must be text']);
    expect(validateBoundValue(template.fields, 'title', 'x'.repeat(41))).toEqual(['field "title" is longer than 40']);
    expect(validateBoundValue(template.fields, 'price', 101)).toEqual(['field "price" must be at most 100']);
    expect(validateBoundValue(template.fields, 'items', {})).toEqual(['field "items" must be a list']);
    expect(validateBoundValue(template.fields, 'items', [{ hot: true }])).toEqual(['field "items" row 1 is missing "name"']);
    expect(validateBoundValue(template.fields, 'items', [{ name: 'a' }, { name: 'b' }, { name: 'c' }])).toEqual(['field "items" has more than 2 rows']);
    expect(validateBoundValue(template.fields, 'title', undefined)).toEqual(['field "title" has no value at the bound path']);
    expect(validateBoundValue(template.fields, 'title', null)).toEqual(['field "title" has no value at the bound path']);
  });

  it('refuses a field that cannot be bound', () => {
    expect(validateBoundValue(template.fields, 'photo', 'sha')).toEqual(['image field "photo" cannot be bound to live data']);
    expect(validateBoundValue(template.fields, 'constructor', 'x')).toEqual(['unknown field "constructor"']);
    expect(validateBoundValue({ bad: { type: 'nope' } }, 'bad', 'x')).toEqual(['field "bad" has no valid definition']);
  });

  it('reads dot paths through own keys only, including array indexes', () => {
    const data = { current: { temp: 41.2 }, daily: { max: [60.6] } };
    expect(readPath(data, 'daily.max.0')).toBe(60.6);
    expect(readPath(data, 'current.missing.deeper')).toBeUndefined();
    expect(readPath(data, 'current.constructor')).toBeUndefined();
    expect(readPath(data, 'daily.max.length')).toBeUndefined();
    expect(readPath('text', 'length')).toBeUndefined();
  });
});

describe('validateManifest', () => {
  it('checks template spot data against the template, as the player will play it', () => {
    const m = validManifest();
    (m.spots.menu as { data: Record<string, unknown> }).data.price = 250;
    m.spots.menu!.durationMs = 60_000;
    expect(validateManifest(m)).toEqual([
      'spot "menu": field "price" must be at most 100',
      'spot "menu": duration 60000 ms is outside the template\'s range 4000 to 20000',
    ]);
  });

  it('checks the screen and each spot kind', () => {
    const m = validManifest() as unknown as { screen: Record<string, unknown>; spots: Record<string, Record<string, unknown>> };
    m.screen.orientation = 'sideways';
    m.screen.locale = 'not a locale!';
    m.spots.web = { id: 'web', name: 'Web', kind: 'gif', durationMs: 5000 };
    expect(validateManifest(m)).toEqual([
      'screen.locale "not a locale!" is not a locale',
      'screen.orientation must be landscape or portrait',
      'spot "web": kind must be template, image, video or url',
    ]);
  });
});

describe('snapshots and device bodies', () => {
  it('rejects a snapshot without an id, time or data', () => {
    expect(validateDataSnapshot({ id: '../x', fetchedAt: 'yesterday' })).toEqual([
      'snapshot id "../x" is not a valid id',
      'snapshot fetchedAt must be an ISO 8601 time',
      'snapshot has no data',
    ]);
  });

  it('rejects a sync request with bad counts', () => {
    const r = validSyncRequest() as unknown as Record<string, unknown>;
    r.seq = -1;
    r.playCounts = [{ hour: '2026-11-17T13:30Z', spot: 'menu', manifest: 'm1', plays: 1.5, ms: 10 }];
    expect(validateSyncRequest(r)).toEqual([
      'seq must be a whole number, 0 or more',
      'play count 1: hour must be the start of a UTC hour, e.g. 2026-11-17T13:00Z',
      'play count 1: plays must be a whole number, 0 or more',
    ]);
  });

  it('rejects a paired response whose credential is for another screen', () => {
    expect(validatePairPollResponse({ status: 'paired', screenId: 's1', credential: 'sfd_s2.secret' })).toEqual(['credential must be sfd_<screenId>.<secret>']);
  });

  it('rejects unknown commands and socket messages', () => {
    expect(validateSyncResponse({ ...validSyncResponse(), commands: [{ type: 'format' }] })).toEqual([
      'command 1: command type must be reload, display or reboot',
    ]);
    expect(validateServerSocketMessage({ type: 'manifest' })).toEqual(['manifest message needs an id']);
  });
});
