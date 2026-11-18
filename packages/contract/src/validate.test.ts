import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MANIFEST_SCHEMA,
  SCREEN_BOX,
  SUPPORTED_MANIFEST_SCHEMAS,
  SUPPORTED_PROTOCOLS,
  checkTemplateBundle,
  parseBrandKit,
  parseDataSnapshot,
  parseDeviceCommand,
  parseDeviceSocketMessage,
  parseDisplayHours,
  parseManifest,
  parsePairPollResponse,
  parsePairStartResponse,
  parsePreviewHostMessage,
  parseServerSocketMessage,
  parseSyncRequest,
  parseSyncResponse,
  parseTemplateManifest,
  requiredFiles,
  validateBrandKit,
  displayHoursProblems,
  readPath,
  validateBoundValue,
  fitsScreenBox,
  imageSizeProblem,
  validateDataSnapshot,
  validateDeviceCommand,
  MAX_IDENTIFY_SECONDS,
  validateDeviceSocketMessage,
  validateManifest,
  validatePairPollResponse,
  validatePairStartResponse,
  validatePreviewHostMessage,
  validateServerSocketMessage,
  validateSpotData,
  validateSyncRequest,
  MAX_SYNC_PLAY_COUNTS,
  validateSyncResponse,
  validateTemplateManifest,
  type BrandKit,
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

const validBrand = (): BrandKit => ({
  id: 'house',
  colors: { primary: '#123', onPrimary: '#fff', accent: '#f80', onAccent: '#000', background: '#000', surface: '#111', text: '#eee', muted: '#999' },
  shape: 'soft',
  fonts: { display: { id: 'base/inter', family: 'Inter', files: [{ weight: 700, style: 'normal', file: 'sha-font' }] } },
  logo: { onDark: 'sha-logo' },
});

const validManifest = (): ScreenManifest => ({
  schema: 3,
  id: 'm1',
  generatedAt: '2026-11-17T00:00:00.000Z',
  screen: {
    id: 's1',
    name: 'Counter',
    timezone: 'Europe/London',
    orientation: 'landscape',
    displayHours: { weekly: [{ from: '07:00', to: '22:00', days: [1, 2] }] },
  },
  files: {
    'sha-html': { size: 10, type: 'text/html' },
    'sha-photo': { size: 10, type: 'image/jpeg' },
    'sha-font': { size: 10, type: 'font/woff2' },
    'sha-logo': { size: 10, type: 'image/svg+xml' },
  },
  brand: validBrand(),
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
  schedule: [
    { id: 'e1', playlist: 'all', priority: 1, target: 'screen', from: '06:00', to: '10:00' },
    { id: 'takeover', playlist: 'all', priority: 100, target: 'screen', startsAt: '2026-11-17T14:00:00Z', endsAt: '2026-11-17T16:00:00Z' },
  ],
  defaultPlaylist: 'all',
});

const validSyncRequest = (): SyncRequest => ({
  seq: 3,
  epoch: 'e7Hq2',
  player: { version: '1.2.3', manifestSchemas: [2, 3], protocols: [1, 2] },
  manifest: { active: 'm1', filesMissing: 0, fallbackFrom: 'm2' },
  display: { on: true, methods: { signal: 'ok' }, override: { state: 'off', until: '2026-11-17T18:00:00Z' } },
  deviceTime: '2026-11-17T13:05:00Z',
  clock: { offsetMs: -1200, trusted: true },
  playCounts: [{ hour: '2026-11-17T13:00Z', spot: 'menu', plays: 4, ms: 32_000 }],
  snapshots: { feed: 1_763_384_400_000 },
  dataRejected: { feed: 2 },
});

const validSyncResponse = (): SyncResponse => ({
  serverTime: '2026-11-17T13:05:01Z',
  nextSyncS: 300,
  epoch: 'e7Hq2',
  ackSeq: 3,
  desiredManifest: 'm1',
  socketTicket: 't',
  snapshots: [{ id: 'feed', version: 1_763_384_400_000, fetchedAt: '2026-11-17T13:00:00Z', data: { headline: 'Hi' } }],
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
  ['validateDataSnapshot', validateDataSnapshot, () => validSyncResponse().snapshots[0]],
  ['validateBrandKit', validateBrandKit, validBrand],
  ['validateBoundValue', (v) => validateBoundValue(template.fields, 'items', v), () => [{ name: 'Soup', hot: true }]],
  ['displayHoursProblems', displayHoursProblems, () => validManifest().screen.displayHours],
  ['validatePairStartResponse', validatePairStartResponse, () => ({ code: 'ABC123', pollToken: 'p', expiresAt: '2026-11-17T13:15:00Z' })],
  ['validatePairPollResponse', validatePairPollResponse, () => ({ status: 'paired', screenId: 's1', credential: 'sfd_s1.secret' })],
  ['validateSyncRequest', validateSyncRequest, validSyncRequest],
  ['validateSyncResponse', validateSyncResponse, validSyncResponse],
  ['validateDeviceCommand', validateDeviceCommand, () => ({ type: 'display', override: { state: 'on', until: '2026-11-17T18:00:00Z' } })],
  ['validateServerSocketMessage', validateServerSocketMessage, () => ({ type: 'command', command: { type: 'reboot' } })],
  ['validateDeviceSocketMessage', validateDeviceSocketMessage, () => ({ type: 'applied', manifest: 'm1' })],
  [
    'validatePreviewHostMessage',
    validatePreviewHostMessage,
    () => ({ sfPreview: 1, type: 'draft', manifest: validManifest(), data: validSyncResponse().snapshots }),
  ],
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

const parsers: [string, (v: unknown) => unknown, (v: unknown) => string[]][] = [
  ['parseManifest', parseManifest, validateManifest],
  ['parseTemplateManifest', parseTemplateManifest, validateTemplateManifest],
  ['parseDataSnapshot', parseDataSnapshot, validateDataSnapshot],
  ['parseBrandKit', parseBrandKit, validateBrandKit],
  ['parseDisplayHours', parseDisplayHours, displayHoursProblems],
  ['parsePairStartResponse', parsePairStartResponse, validatePairStartResponse],
  ['parsePairPollResponse', parsePairPollResponse, validatePairPollResponse],
  ['parseSyncRequest', parseSyncRequest, validateSyncRequest],
  ['parseSyncResponse', parseSyncResponse, validateSyncResponse],
  ['parseDeviceCommand', parseDeviceCommand, validateDeviceCommand],
  ['parseServerSocketMessage', parseServerSocketMessage, validateServerSocketMessage],
  ['parseDeviceSocketMessage', parseDeviceSocketMessage, validateDeviceSocketMessage],
  ['parsePreviewHostMessage', parsePreviewHostMessage, validatePreviewHostMessage],
];

describe('every parser gives back what its validator accepts', () => {
  for (const [name, parse, validate] of parsers) {
    const fixture = validators.find(([v]) => v === validate.name)?.[2];
    it(`${name} returns the value itself when valid, or the validator's problems`, () => {
      fc.assert(
        fc.property(fixture ? fc.oneof(json, mutated(fixture)) : json, (v) => {
          const problems = validate(v);
          expect(parse(v)).toEqual(problems.length ? { ok: false, problems } : { ok: true, value: v });
          if (!problems.length) expect((parse(v) as { value: unknown }).value).toBe(v);
        }),
        { numRuns: 300 },
      );
    });
  }

  it('parseSyncRequest hands back the request, typed', () => {
    const r = validSyncRequest();
    const parsed = parseSyncRequest(r);
    expect(parsed.ok && parsed.value.player.version).toBe('1.2.3');
    expect(parseSyncRequest({ ...r, seq: -1 })).toEqual({ ok: false, problems: ['seq must be a whole number, 0 or more'] });
  });
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

describe('versions', () => {
  it('plays the current manifest schema and the one before it', () => {
    expect(MANIFEST_SCHEMA).toBe(3);
    expect(SUPPORTED_MANIFEST_SCHEMAS).toEqual([2, 3]);
    const old = validManifest() as unknown as Record<string, unknown>;
    old.schema = 2;
    delete old.brand;
    (old.schedule as unknown[]).pop();
    expect(validateManifest(old)).toEqual([]);
    expect(validateManifest({ ...validManifest(), schema: 1 })).toEqual(['manifest schema 1 is not one this player can play (2, 3)']);
  });

  it('drives protocol 1 and 2 bundles, and refuses a newer one', () => {
    expect(SUPPORTED_PROTOCOLS).toEqual([1, 2]);
    const lint = (protocol: number) =>
      checkTemplateBundle({ manifest: { ...structuredClone(template), protocol }, html: '<p>', sources: { 'main.ts': '' } }).checks.find(
        (c) => c.check === 'manifest',
      )!.problems;
    expect(lint(1)).toEqual([]);
    expect(lint(2)).toEqual([]);
    expect(lint(3)).toEqual(['protocol 3 is not supported']);
  });
});

describe('brand', () => {
  it('lists the brand fonts and logo among the files a screen must hold', () => {
    expect([...requiredFiles(validManifest())].sort()).toEqual(['sha-font', 'sha-html', 'sha-logo', 'sha-photo']);
  });

  it('checks every colour, the shape, the fonts and that brand files are listed', () => {
    const m = validManifest() as unknown as { brand: Record<string, unknown>; files: Record<string, unknown> };
    delete m.files['sha-logo'];
    (m.brand.colors as Record<string, unknown>).muted = 7;
    m.brand.shape = 'blob';
    m.brand.fonts = { body: { id: 'inter', family: 'Inter', files: [{ weight: 1200, style: 'oblique', file: 'sha-font' }] } };
    expect(validateManifest(m)).toEqual([
      'brand: colour "muted" must be a CSS colour',
      'brand: shape must be square, soft or round',
      'brand: body font id must be <owner>/<id>',
      'brand: body font file 1: weight must be 1 to 1000',
      'brand: body font file 1: style must be normal or italic',
      'file sha-logo is referenced but not listed',
    ]);
  });
});

describe('takeovers', () => {
  it('bounds an entry by absolute instants, end after start', () => {
    const m = validManifest();
    m.schedule[1] = { ...m.schedule[1]!, startsAt: '2026-11-17T16:00:00Z', endsAt: '2026-11-17T14:00:00Z' };
    expect(validateManifest(m)).toEqual(['schedule entry "takeover": endsAt must be after startsAt']);
    const open = { ...m.schedule[1]!, startsAt: 'soon' };
    delete open.endsAt;
    m.schedule[1] = open;
    expect(validateManifest(m)).toEqual(['schedule entry "takeover": startsAt must be an ISO 8601 time']);
  });
});

describe('snapshots and device bodies', () => {
  it('rejects a snapshot without an id, version, time or data', () => {
    expect(validateDataSnapshot({ id: '../x', version: -1, fetchedAt: 'yesterday' })).toEqual([
      'snapshot id "../x" is not a valid id',
      'snapshot version must be a whole number, 0 or more',
      'snapshot fetchedAt must be an ISO 8601 time',
      'snapshot has no data',
    ]);
  });

  it('carries the seq epoch and the clock both ways', () => {
    const r = validSyncRequest() as unknown as Record<string, unknown>;
    r.epoch = '../e';
    r.clock = { offsetMs: 'far', trusted: 1 };
    r.snapshots = { feed: '2026-11-17T13:00:00Z' };
    expect(validateSyncRequest(r)).toEqual([
      'epoch must be a valid id',
      'clock needs offsetMs and whether the screen trusts it',
      'snapshots: "feed" must be a source id with a version number',
    ]);
    expect(validateSyncResponse({ ...validSyncResponse(), epoch: undefined })).toEqual(['epoch must be a valid id']);
  });

  it('rejects a sync request with bad counts', () => {
    const r = validSyncRequest() as unknown as Record<string, unknown>;
    r.seq = -1;
    r.playCounts = [{ hour: '2026-11-17T13:30Z', spot: 'menu', plays: 1.5, ms: 10 }];
    expect(validateSyncRequest(r)).toEqual([
      'seq must be a whole number, 0 or more',
      'play count 1: hour must be the start of a UTC hour, e.g. 2026-11-17T13:00Z',
      'play count 1: plays must be a whole number, 0 or more',
    ]);
  });

  it('bounds the play counts in one sync, and checks the heartbeat extras', () => {
    const r = validSyncRequest() as unknown as Record<string, unknown>;
    r.playCounts = Array.from({ length: MAX_SYNC_PLAY_COUNTS + 1 }, (_, i) => ({ hour: '2026-11-17T13:00Z', spot: `s${i}`, plays: 1, ms: 1 }));
    r.manifest = { filesMissing: 0, fallbackFrom: '' };
    r.dataRejected = { feed: -1 };
    expect(validateSyncRequest(r)).toEqual([
      'manifest needs filesMissing, and active and fallbackFrom when there are any',
      `playCounts holds at most ${MAX_SYNC_PLAY_COUNTS} counts`,
      'dataRejected: "feed" must be a source id with a count',
    ]);
    const { dataRejected: _, ...without } = validSyncRequest();
    expect(validateSyncRequest(without)).toEqual([]);
  });

  it('lets a screen with nothing published sync, for its socket ticket', () => {
    const { desiredManifest: _, ...unpublished } = validSyncResponse();
    expect(validateSyncResponse(unpublished)).toEqual([]);
    expect(validateSyncResponse({ ...validSyncResponse(), desiredManifest: '' })).toEqual(['desiredManifest must be a manifest id when present']);
  });

  it('rejects a paired response whose credential is for another screen', () => {
    expect(validatePairPollResponse({ status: 'paired', screenId: 's1', credential: 'sfd_s2.secret' })).toEqual(['credential must be sfd_<screenId>.<secret>']);
  });

  it('takes identify with the name to show for a few seconds, and restart', () => {
    expect(validateDeviceCommand({ type: 'identify', name: 'Lobby', seconds: 10 })).toEqual([]);
    expect(validateDeviceCommand({ type: 'restart' })).toEqual([]);
    expect(validateDeviceCommand({ type: 'identify', name: '', seconds: 0 })).toEqual([
      'identify needs the name to show, 1 to 100 characters',
      `identify seconds must be a whole number from 1 to ${MAX_IDENTIFY_SECONDS}`,
    ]);
    expect(validateDeviceCommand({ type: 'identify', name: 'x'.repeat(101), seconds: MAX_IDENTIFY_SECONDS + 1 })).toHaveLength(2);
  });

  it('rejects unknown commands and socket messages', () => {
    expect(validateSyncResponse({ ...validSyncResponse(), commands: [{ type: 'format' }] })).toEqual([
      'command 1: command type must be reload, restart, display, identify or reboot',
    ]);
    expect(validateServerSocketMessage({ type: 'manifest' })).toEqual(['manifest message needs an id']);
  });
});

describe('preview channel', () => {
  const draft = (extra: Record<string, unknown> = {}) => ({ sfPreview: 1, type: 'draft', manifest: validManifest(), ...extra });
  const sha = Object.keys(validManifest().files)[0]!;

  it('takes posted files of the manifest as Blobs', () => {
    expect(validatePreviewHostMessage(draft({ files: { [sha]: new Blob(['x']) } }))).toEqual([]);
  });

  it('refuses another version, a broken manifest, and files the manifest does not name or that are not Blobs', () => {
    expect(validatePreviewHostMessage(draft({ sfPreview: 2 }))).toEqual(['preview protocol 2 is not 1']);
    expect(validatePreviewHostMessage({ ...draft(), manifest: { ...validManifest(), id: '' } })[0]).toMatch(/^draft manifest: /);
    expect(validatePreviewHostMessage(draft({ files: { ['f'.repeat(64)]: new Blob(['x']) } }))).toEqual([
      `file "${'f'.repeat(12)}" is not a file of the manifest`,
    ]);
    expect(validatePreviewHostMessage(draft({ files: { [sha]: 'x' } }))).toEqual([`file "${sha.slice(0, 12)}" is not a Blob`]);
  });
});

describe('brand colour lint', () => {
  const lint = (sources: Record<string, string>) => checkTemplateBundle({ manifest: template, html: '<p>', sources: { 'main.ts': '', ...sources } });

  it('warns on a literal colour outside a var() fallback, and passes the template', () => {
    const css = [
      '.a { color: var(--sf-text, #f8fafc); background: var(--sf-bg, rgb(2 6 23)); }',
      '.b { border-color: color-mix(in srgb, var(--sf-accent, #22d3ee) 40%, transparent); }',
      '.c {',
      '  color: #fff;',
      '  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);',
      '  background: linear-gradient(white, var(--sf-surface));',
      '}',
      '/* a note: #123456 in a comment is not a colour */',
      '.d { font-family: var(--sf-font-display, Inter), sans-serif; }',
    ].join('\n');
    const report = lint({ 'style.css': css });
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual([
      'style.css:4: literal colour #fff in color; use var(--sf-*) with it as the fallback',
      'style.css:5: literal colour rgba(0, 0, 0, 0.4) in box-shadow; use var(--sf-*) with it as the fallback',
      'style.css:6: literal colour white in background; use var(--sf-*) with it as the fallback',
    ]);
  });

  it('reads the style elements of index.html too, and nothing else', () => {
    const report = lint({ 'index.html': '<style>\n.x { fill: hsl(200 50% 50%) }\n</style><p style="x">#abc</p>', 'main.ts': 'const c = "#000";' });
    expect(report.warnings).toEqual(['index.html:2: literal colour hsl(200 50% 50%) in fill; use var(--sf-*) with it as the fallback']);
  });
});
