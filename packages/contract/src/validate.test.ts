import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  IMAGE_SAMPLE_CELL,
  MANIFEST_SCHEMA,
  MAX_URL_BYTES,
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
  parsePairStartRequest,
  parsePairStartResponse,
  parsePreviewHostMessage,
  parseServerSocketMessage,
  parseSyncRequest,
  parseSyncResponse,
  parseTemplateManifest,
  parseTemplateRuntimeReport,
  requiredFiles,
  sampleAsset,
  validateBrandKit,
  displayHoursProblems,
  scheduleEntryProblems,
  readPath,
  boundValue,
  tableItems,
  validateTableFeed,
  validateBoundValue,
  fitsScreenBox,
  imageSampleSize,
  imageSizeProblem,
  liveSources,
  validateDataSnapshot,
  validateDeviceCommand,
  MAX_IDENTIFY_SECONDS,
  validateDeviceSocketMessage,
  validateManifest,
  validatePairPollResponse,
  validatePairStartRequest,
  validatePairStartResponse,
  validatePreviewHostMessage,
  validateServerSocketMessage,
  validateSpotData,
  validateSyncRequest,
  MAX_SYNC_PLAY_COUNTS,
  MAX_SYNC_SOURCES,
  MAX_SNAPSHOT_BYTES,
  validateSyncResponse,
  validateTemplateManifest,
  validateTemplateRuntimeReport,
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

  it('holds a url to an https address within its maxLength, or empty for none', () => {
    const qr: Record<string, FieldDef> = { qrUrl: { type: 'url', label: 'QR link', maxLength: 40 } };
    expect(validateSpotData(qr, { qrUrl: 'https://example.com/plan' }, {})).toEqual([]);
    expect(validateSpotData(qr, { qrUrl: '' }, {})).toEqual([]);
    for (const bad of ['http://example.com/', 'javascript:alert(1)', '/floor-plan', 'example.com', 'data:text/html,hi'])
      expect(validateSpotData(qr, { qrUrl: bad }, {})).toEqual(['field "qrUrl" must be an https address']);
    expect(validateSpotData(qr, { qrUrl: `https://example.com/${'a'.repeat(30)}` }, {})).toEqual(['field "qrUrl" is longer than 40']);
    expect(validateSpotData(qr, { qrUrl: 42 }, {})).toEqual(['field "qrUrl" must be an https address']);
  });

  it('holds a url to MAX_URL_BYTES of UTF-8, which a QR code can always carry, counting multi-byte characters by their bytes', () => {
    const link: Record<string, FieldDef> = { link: { type: 'url', label: 'Link' } };
    const base = 'https://example.com/';
    expect(MAX_URL_BYTES).toBe(2048);
    // ASCII: one byte a character.
    expect(validateSpotData(link, { link: base + 'a'.repeat(2048 - base.length) }, {})).toEqual([]);
    expect(validateSpotData(link, { link: base + 'a'.repeat(2049 - base.length) }, {})).toEqual(['field "link" is longer than 2048 bytes']);
    // The euro sign is three bytes in UTF-8 and one UTF-16 code unit: 676 of them make exactly 2048 bytes.
    const euros = base + '€'.repeat((2048 - base.length) / 3);
    expect(new TextEncoder().encode(euros).length).toBe(2048);
    expect(validateSpotData(link, { link: euros }, {})).toEqual([]);
    expect(validateSpotData(link, { link: `${euros}a` }, {})).toEqual(['field "link" is longer than 2048 bytes']);
  });

  it('refuses a url that is not well-formed Unicode, which cannot be written as UTF-8, and keeps a surrogate pair', () => {
    const link: Record<string, FieldDef> = { link: { type: 'url', label: 'Link' } };
    for (const lone of ['https://example.com/\uD800', 'https://example.com/\uDC00x', 'https://example.com/\uDC00\uD800'])
      expect(validateSpotData(link, { link: lone }, {})).toEqual(['field "link" must be well-formed text']);
    expect(validateSpotData(link, { link: 'https://example.com/\uD83D\uDE00' }, {})).toEqual([]);
  });

  it('refuses a url with space around it, which the URL parser would ignore but a QR code would carry', () => {
    const link: Record<string, FieldDef> = { link: { type: 'url', label: 'Link' } };
    for (const spaced of [' https://example.com/', 'https://example.com/ ', '\thttps://example.com/\n', ' '])
      expect(validateSpotData(link, { link: spaced }, {})).toEqual(['field "link" must not start or end with a space']);
    expect(validateSpotData(link, { link: 'https://example.com/a%20b' }, {})).toEqual([]);
  });
});

describe('date and datetime fields', () => {
  const when: Record<string, FieldDef> = {
    day: { type: 'date', label: 'Day', min: '2026-01-01', max: '2026-12-31' },
    at: { type: 'datetime', label: 'Starts', min: '2026-11-01T00:00', max: '2026-11-30T23:59' },
  };
  const check = (data: Record<string, unknown>) => validateSpotData(when, { day: '2026-06-15', at: '2026-11-27T18:00', ...data }, {});

  it('holds a date to a real calendar day, YYYY-MM-DD, within min and max', () => {
    expect(check({})).toEqual([]);
    for (const day of ['2026-01-01', '2026-12-31', '2026-02-28']) expect(check({ day })).toEqual([]);
    for (const bad of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-6-15', '15/06/2026', '2026-06-15T09:00', 20260615])
      expect(check({ day: bad })).toEqual(['field "day" must be a date (YYYY-MM-DD)']);
    expect(check({ day: '2025-12-31' })).toEqual(['field "day" must be on or after 2026-01-01']);
    expect(check({ day: '2027-01-01' })).toEqual(['field "day" must be on or before 2026-12-31']);
    // A leap day where there is one.
    expect(validateSpotData({ day: { type: 'date', label: 'Day' } }, { day: '2028-02-29' }, {})).toEqual([]);
  });

  it('names an empty date or datetime as one not picked yet: a draft may hold it, a screen may not', () => {
    expect(check({ day: '', at: '' })).toEqual(['field "day" has no date yet', 'field "at" has no date and time yet']);
  });

  it('refuses a year before 1900, as typing "26" into a picker\'s year gives 0026', () => {
    const open: Record<string, FieldDef> = { day: { type: 'date', label: 'Day' }, at: { type: 'datetime', label: 'At' } };
    const year = (day: string, at: string) => validateSpotData(open, { day, at }, {});
    expect(year('0026-11-27', '0026-11-27T18:00')).toEqual(['field "day" must be in 1900 or later', 'field "at" must be in 1900 or later']);
    expect(year('1899-12-31', '0000-01-01T00:00')).toEqual(['field "day" must be in 1900 or later', 'field "at" must be in 1900 or later']);
    expect(year('1900-01-01', '1900-01-01T00:00')).toEqual([]);
    expect(validateTemplateManifest({ ...structuredClone(template), fields: { day: { type: 'date', label: 'Day', min: '0026-01-01' } } })).toEqual([
      'field "day": min must be in 1900 or later',
    ]);
  });

  it('holds a datetime to a wall time, YYYY-MM-DDTHH:mm with no zone, within min and max', () => {
    for (const at of ['2026-11-01T00:00', '2026-11-30T23:59', '2026-11-27T18:00']) expect(check({ at })).toEqual([]);
    // An instant or an offset is a different value: the screen's zone, not the editor's, places a wall time.
    for (const bad of [
      '2026-11-27T18:00Z',
      '2026-11-27T18:00+01:00',
      '2026-11-27T18:00:00',
      '2026-11-27 18:00',
      '2026-11-27',
      '2026-11-27T24:00',
      '2026-11-27T18:60',
      '2026-11-31T09:00',
    ])
      expect(check({ at: bad })).toEqual(['field "at" must be a date and time (YYYY-MM-DDTHH:mm)']);
    expect(check({ at: '2026-10-31T23:59' })).toEqual(['field "at" must be at or after 2026-11-01 00:00']);
    expect(check({ at: '2026-12-01T00:00' })).toEqual(['field "at" must be at or before 2026-11-30 23:59']);
  });

  it('takes wall times at DST edges, which have no instant or two in some zones: the zone settles them, not the contract', () => {
    const at: Record<string, FieldDef> = { at: { type: 'datetime', label: 'At' } };
    // 02:30 on 8 March 2026 never happens in New York; 01:30 on 1 November 2026 happens twice there.
    for (const edge of ['2026-03-08T02:30', '2026-11-01T01:30', '2026-03-29T01:30', '2026-10-25T02:30'])
      expect(validateSpotData(at, { at: edge }, {})).toEqual([]);
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
  schema: MANIFEST_SCHEMA,
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

const M1 = '1'.repeat(64);
const M2 = '2'.repeat(64);

const validSyncRequest = (): SyncRequest => ({
  seq: 3,
  epoch: 'e7Hq2',
  player: { version: '1.2.3', manifestSchemas: [2, 3], protocols: [1, 2] },
  manifest: { active: M1, filesMissing: 0, fallbackFrom: M2, lastGood: M1 },
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
  snapshots: [{ id: 'feed', version: 1_763_384_400_000, fetchedAt: '2026-11-17T13:00:00Z', checkedAt: '2026-11-17T13:05:00Z', data: { headline: 'Hi' } }],
  checked: { other: { version: 1_763_384_000_000, checkedAt: '2026-11-17T13:04:00Z' } },
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

const runtimeReport = () => ({
  ok: false,
  problems: ['requested https://example.com/x (blocked)'],
  runner: { image: 'registry.cloudflare.com/acct/template-check@sha256:00', browser: 'HeadlessChrome/146.0.0.0' },
  renders: [
    { orientation: 'landscape', viewport: { width: 1920, height: 1080 }, readyMs: 84.5, frames: { count: 60, longestMs: 17.1 } },
    { orientation: 'portrait', viewport: { width: 1080, height: 1920 }, readyMs: null, frames: null },
  ],
  cost: { startMs: 0, checkMs: 2310 },
});

const validators: [string, (v: unknown) => string[], (() => unknown)?][] = [
  ['validateManifest', validateManifest, validManifest],
  ['validateTemplateManifest', validateTemplateManifest, () => structuredClone(template)],
  ['validateDataSnapshot', validateDataSnapshot, () => validSyncResponse().snapshots[0]],
  ['validateBrandKit', validateBrandKit, validBrand],
  ['validateBoundValue', (v) => validateBoundValue(template.fields, 'items', v), () => [{ name: 'Soup', hot: true }]],
  ['validateTableFeed', validateTableFeed, () => ({ columns: ['Item', 'Price'], rows: [['Soup', 4.5]] })],
  [
    'boundValue',
    (v) => boundValue(template.fields, 'items', v, { columns: ['Item'], rows: [['Soup']] }, 'en-US').problems,
    () => ({ ...tableBinding(), table: { columns: { name: 'Item' } } }),
  ],
  ['displayHoursProblems', displayHoursProblems, () => validManifest().screen.displayHours],
  ['scheduleEntryProblems', scheduleEntryProblems, () => validManifest().schedule[1]],
  ['validatePairStartRequest', validatePairStartRequest, () => ({ kind: 'browser' })],
  ['validatePairStartResponse', validatePairStartResponse, () => ({ code: 'ABC123', pollToken: 'p', expiresAt: '2026-11-17T13:15:00Z' })],
  ['validatePairPollResponse', validatePairPollResponse, () => ({ status: 'paired', screenId: 's1', credential: 'sfd_s1.secret' })],
  ['validateSyncRequest', validateSyncRequest, validSyncRequest],
  ['validateSyncResponse', validateSyncResponse, validSyncResponse],
  ['validateDeviceCommand', validateDeviceCommand, () => ({ type: 'display', override: { state: 'on', until: '2026-11-17T18:00:00Z' } })],
  ['validateServerSocketMessage', validateServerSocketMessage, () => ({ type: 'command', command: { type: 'reboot' } })],
  ['validateDeviceSocketMessage', validateDeviceSocketMessage, () => ({ type: 'applied', manifest: M1 })],
  [
    'validatePreviewHostMessage',
    validatePreviewHostMessage,
    () => ({ sfPreview: 1, type: 'draft', manifest: validManifest(), data: validSyncResponse().snapshots }),
  ],
  ['validateTemplateRuntimeReport', validateTemplateRuntimeReport, runtimeReport],
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
  ['parsePairStartRequest', parsePairStartRequest, validatePairStartRequest],
  ['parsePairStartResponse', parsePairStartResponse, validatePairStartResponse],
  ['parsePairPollResponse', parsePairPollResponse, validatePairPollResponse],
  ['parseSyncRequest', parseSyncRequest, validateSyncRequest],
  ['parseSyncResponse', parseSyncResponse, validateSyncResponse],
  ['parseDeviceCommand', parseDeviceCommand, validateDeviceCommand],
  ['parseServerSocketMessage', parseServerSocketMessage, validateServerSocketMessage],
  ['parseDeviceSocketMessage', parseDeviceSocketMessage, validateDeviceSocketMessage],
  ['parsePreviewHostMessage', parsePreviewHostMessage, validatePreviewHostMessage],
  ['parseTemplateRuntimeReport', parseTemplateRuntimeReport, validateTemplateRuntimeReport],
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

describe('validateTemplateRuntimeReport', () => {
  it('holds ok to the problems: a report cannot pass with problems or fail without one', () => {
    expect(validateTemplateRuntimeReport({ ...runtimeReport(), ok: true })).toEqual(['ok must be true exactly when there are no problems']);
    expect(validateTemplateRuntimeReport({ ...runtimeReport(), problems: [] })).toEqual(['ok must be true exactly when there are no problems']);
    expect(validateTemplateRuntimeReport({ ...runtimeReport(), ok: true, problems: [] })).toEqual([]);
  });
});

describe('validateTemplateManifest', () => {
  it('lists each orientation once: a repeat would be rendered again by every check of the template', () => {
    expect(validateTemplateManifest({ ...structuredClone(template), orientations: ['landscape', 'landscape', 'portrait'] })).toEqual([
      'orientations must not repeat',
    ]);
  });

  it('checks each field definition, so the spot check can trust it', () => {
    const bad = structuredClone(template) as unknown as { fields: Record<string, unknown> };
    bad.fields.price = { type: 'number', label: 'Price', min: 10, max: 1, step: 0 };
    bad.fields.size = { type: 'select', label: 'Size', options: [] };
    bad.fields.items = { type: 'list', label: 'Items', item: { pic: { type: 'image', label: 'Pic' } } };
    bad.fields.odd = { type: 'video', label: 'Odd' };
    bad.fields.link = { type: 'url', label: 'Link', maxLength: 0 };
    expect(validateTemplateManifest(bad)).toEqual([
      'field "price": step must be a number above 0',
      'field "price": min must not be above max',
      'field "items.pic": a list row cannot hold an image',
      'field "size": options must be a list of text',
      'field "odd": type must be one of text, number, boolean, color, select, url, date, datetime, image, list',
      'field "link": maxLength must be a whole number above 0',
    ]);
  });

  it('takes date and datetime fields, in list rows too, with min and max of their own kind and a default between them', () => {
    const m = structuredClone(template);
    m.fields.target = { type: 'datetime', label: 'Target', min: '2026-01-01T00:00', max: '2027-01-01T00:00', default: '2026-12-31T18:00' };
    m.fields.events = { type: 'list', label: 'Events', item: { day: { type: 'date', label: 'Day', default: '2026-11-27' } } };
    expect(validateTemplateManifest(m)).toEqual([]);
    const bad = structuredClone(template) as unknown as { fields: Record<string, unknown> };
    bad.fields.day = { type: 'date', label: 'Day', min: '2026-12-31', max: '2026-01-01' };
    bad.fields.at = { type: 'datetime', label: 'At', min: '2026-01-01', max: 7 };
    bad.fields.from = { type: 'date', label: 'From', min: '2026-01-01', default: '2025-06-01' };
    expect(validateTemplateManifest(bad)).toEqual([
      'field "day": min must not be after max',
      'field "at": min must be a date and time (YYYY-MM-DDTHH:mm)',
      'field "at": max must be a date and time (YYYY-MM-DDTHH:mm)',
      'field "from" default: field "from" must be on or after 2026-01-01',
    ]);
  });

  it('takes url fields, in list rows too, with a default that is https or empty', () => {
    const m = structuredClone(template);
    m.fields.qrUrl = { type: 'url', label: 'QR link', maxLength: 300, default: '' };
    m.fields.links = { type: 'list', label: 'Links', item: { href: { type: 'url', label: 'Link', default: 'https://example.com/' } } };
    expect(validateTemplateManifest(m)).toEqual([]);
    m.fields.qrUrl = { type: 'url', label: 'QR link', default: 'http://example.com/' };
    expect(validateTemplateManifest(m)).toEqual(['field "qrUrl" default: field "qrUrl" must be an https address']);
  });

  it('holds a default to its own field', () => {
    const bad = structuredClone(template);
    bad.fields.price = { type: 'number', label: 'Price', max: 10, default: 50 };
    expect(validateTemplateManifest(bad)).toEqual(['field "price" default: field "price" must be at most 10']);
  });

  const weather = (): TemplateManifest => ({
    ...structuredClone(template),
    fields: {
      city: { type: 'text', label: 'City', default: 'Atlanta' },
      temp: { type: 'number', label: 'Temperature', default: 72 },
      high: { type: 'number', label: 'High', default: 78 },
      unit: { type: 'select', label: 'Unit', options: ['°F', '°C'], default: '°F' },
      windUnit: { type: 'select', label: 'Wind unit', options: ['mph', 'km/h'], default: 'mph' },
      photo: { type: 'image', label: 'Photo' },
    },
    live: {
      source: 'open-meteo',
      fields: { temp: 'current.temperature_2m', high: 'daily.temperature_2m_max.0' },
      place: 'city',
      units: { temperature: 'unit', wind: 'windUnit' },
    },
  });

  totalOn('validateTemplateManifest with a live declaration', mutated(weather), validateTemplateManifest);

  it('takes a declaration of the fields a data source fills, with their default paths', () => {
    expect(validateTemplateManifest(weather())).toEqual([]);
    expect(validateTemplateManifest({ ...structuredClone(template), live: { source: 'rss', fields: { items: 'items' } } })).toEqual([]);
  });

  it('holds the declaration to fields the template has, that can take live data, at paths a binding can name', () => {
    const bad = weather();
    bad.live = { source: 'open-meteo', fields: { temp: 'current..temperature_2m', photo: 'url', gone: 'x', high: '' } };
    expect(validateTemplateManifest(bad)).toEqual([
      'live: field "temp": "current..temperature_2m" is not a dot path such as current.temperature_2m',
      'live: field "photo" is an image, which cannot take live data',
      'live: field "gone" is not a field of the template',
      'live: field "high": "" is not a dot path such as current.temperature_2m',
    ]);
    expect(validateTemplateManifest({ ...weather(), live: { source: 'weather.com', fields: {} } })).toEqual([
      'live: source must be one of open-meteo, rss, ical, table',
      'live: fields must name at least one field',
    ]);
  });

  it('names the place and unit fields of an Open-Meteo template only, each the right kind of field with options the forecast offers', () => {
    const m = weather();
    m.fields.unit = { type: 'select', label: 'Unit', options: ['°F', 'K'], default: '°F' };
    m.live = { source: 'open-meteo', fields: { temp: 'current.temperature_2m' }, place: 'temp', units: { temperature: 'unit', wind: 'city' } };
    expect(validateTemplateManifest(m)).toEqual([
      'live: place "temp" must be a text field the source does not fill',
      'live: units.temperature "unit" must be a select field with options from °F, °C',
      'live: units.wind "city" must be a select field with options from mph, km/h',
    ]);
    expect(validateTemplateManifest({ ...weather(), live: { source: 'rss', fields: { temp: 'items' }, place: 'city' } })).toEqual([
      'live: place and units are for open-meteo sources only',
    ]);
  });

  /** Weather from Open-Meteo and headlines from a feed, as an Info frame takes them (#193). */
  const twoSources = (): TemplateManifest => {
    const m = weather();
    m.fields.items = { type: 'list', label: 'Headlines', item: { title: { type: 'text', label: 'Title' } }, default: [] };
    m.live = {
      sources: {
        weather: { label: 'Weather', source: 'open-meteo', fields: { temp: 'current.temperature_2m' }, place: 'city', units: { temperature: 'unit' } },
        headlines: { label: 'Headlines', source: 'rss', fields: { items: 'items' } },
      },
    };
    return m;
  };

  totalOn('validateTemplateManifest with several live sources', mutated(twoSources), validateTemplateManifest);

  it('takes several named sources, each with a label and the fields it feeds, and reads either form by name', () => {
    expect(validateTemplateManifest(twoSources())).toEqual([]);
    expect(Object.keys(liveSources(twoSources().live!))).toEqual(['weather', 'headlines']);
    const one = weather().live!;
    expect(liveSources(one)).toEqual({ source: one });
  });

  it('holds each named source to the rules of one, and feeds a field from one source only', () => {
    const m = twoSources();
    m.live = {
      sources: {
        weather: { label: '', source: 'open-meteo', fields: { temp: 'current.temperature_2m' }, place: 'temp' },
        headlines: { label: 'Headlines', source: 'rss', fields: { items: 'items', temp: 'title' }, units: { wind: 'windUnit' } },
        'no good': { label: 'Bad', source: 'table', fields: { high: 'rows' } },
      },
    };
    expect(validateTemplateManifest(m)).toEqual([
      'live: sources.weather: label is required',
      'live: field "temp" is fed by both "weather" and "headlines"',
      'live: source name "no good" must be letters, digits, dashes and underscores',
      'live: sources.weather: place "temp" must be a text field the source does not fill',
      'live: sources.headlines: place and units are for open-meteo sources only',
      'live: sources.no good: field "high": a table fills list fields only, at "rows"',
    ]);
  });

  it('keeps a field a named source leaves to people free of every other source', () => {
    const m = twoSources();
    m.live = {
      sources: {
        weather: { label: 'Weather', source: 'open-meteo', fields: { temp: 'current.temperature_2m' }, place: 'city' },
        headlines: { label: 'Headlines', source: 'rss', fields: { city: 'title' } },
      },
    };
    expect(validateTemplateManifest(m)).toEqual(['live: sources.weather: place "city" must be a text field the source does not fill']);
  });

  it('lets two forecasts name a place or units field once only, as each sets it when it is picked', () => {
    const m = twoSources();
    m.fields.away = { type: 'number', label: 'Away', default: 60 };
    m.live = {
      sources: {
        home: { label: 'Home', source: 'open-meteo', fields: { temp: 'current.temperature_2m' }, place: 'city', units: { temperature: 'unit' } },
        away: {
          label: 'Away',
          source: 'open-meteo',
          fields: { away: 'current.temperature_2m' },
          place: 'city',
          units: { temperature: 'unit', wind: 'windUnit' },
        },
      },
    };
    expect(validateTemplateManifest(m)).toEqual([
      'live: field "city" is the place or units of both "home" and "away"',
      'live: field "unit" is the place or units of both "home" and "away"',
    ]);
  });

  it('takes one source or several, not both, and at least one', () => {
    expect(validateTemplateManifest({ ...weather(), live: { ...weather().live, sources: twoSources().live } })).toEqual([
      'live: takes one source or several sources, not both',
    ]);
    expect(validateTemplateManifest({ ...weather(), live: { sources: {} } })).toEqual(['live: sources must name at least one source']);
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

const menuItems: Extract<FieldDef, { type: 'list' }> = {
  type: 'list',
  label: 'Items',
  maxItems: 3,
  item: {
    name: { type: 'text', label: 'Name', maxLength: 12 },
    price: { type: 'text', label: 'Price', maxLength: 10 },
    tag: { type: 'select', label: 'Tag', options: ['', 'New', 'Vegan'], default: '' },
    hot: { type: 'boolean', label: 'Hot', default: false },
  },
};
const menuTable = {
  columns: ['Item', 'Price', 'Section', 'Tag', 'Hot'],
  rows: [
    ['Soup', 4.5, 'Starters', 'vegan', 'yes'],
    ['Steak', '$21', 'Mains', '', 'no'],
    ['Pie', 12, 'Mains', 'NEW', ''],
    ['Bread', '3', 'starters', 'Spicy', 'no'],
    ['', '2', 'Mains', '', ''],
  ],
};
const tableBinding = () => ({ source: 'menu', path: 'rows', table: { columns: { name: 'Item', price: 'Price' } } });

describe('table bindings', () => {
  it('checks a TableFeed: distinct names, one text or number cell per column', () => {
    expect(validateTableFeed(menuTable)).toEqual([]);
    expect(validateTableFeed({ columns: ['A', 'A'], rows: [['x', 'y']] })).toEqual(['table columns must have distinct names']);
    expect(validateTableFeed({ columns: ['A', 'B'], rows: [['x', 'y'], ['x']] })).toEqual(['table row 2 must have 2 cells of text or numbers']);
    expect(validateTableFeed({ columns: ['A'], rows: [[true]] })).toEqual(['table row 1 must have 1 cells of text or numbers']);
    expect(validateTableFeed({ columns: [''], rows: [] })).toEqual(['table columns must be a list of names']);
  });

  it('maps rows onto items: numbers as prices in the locale, selects in any case, empty cells to defaults', () => {
    const columns = { name: 'Item', price: 'Price', tag: 'Tag', hot: 'Hot' };
    expect(tableItems({ ...menuItems, maxItems: 10 }, { columns }, menuTable, 'en-US')).toEqual({
      items: [
        { name: 'Soup', price: '4.50', tag: 'Vegan', hot: true },
        { name: 'Steak', price: '$21', tag: '', hot: false },
        { name: 'Pie', price: '12', tag: 'New', hot: false },
      ],
      problems: ['row 4: tag must be one of , New, Vegan', 'row 5 has no name'],
    });
    expect(tableItems(menuItems, { columns: { name: 'Item', price: 'Price' } }, menuTable, 'fr-FR').items?.[0]).toEqual({
      name: 'Soup',
      price: '4,50',
      tag: '',
      hot: false,
    });
  });

  it('fills a url property from a trimmed cell, leaving out a row whose address is not https', () => {
    const links: Extract<FieldDef, { type: 'list' }> = {
      type: 'list',
      label: 'Links',
      item: { name: { type: 'text', label: 'Name' }, href: { type: 'url', label: 'Link', default: '' } },
    };
    const table = {
      columns: ['Name', 'Link'],
      rows: [
        ['Plan', ' https://example.com/plan '],
        ['Menu', 'http://example.com/menu'],
        ['Desk', ''],
      ],
    };
    expect(tableItems(links, { columns: { name: 'Name', href: 'Link' } }, table, 'en-US')).toEqual({
      items: [
        { name: 'Plan', href: 'https://example.com/plan' },
        { name: 'Desk', href: '' },
      ],
      problems: ['row 2: href must be an https address'],
    });
  });

  it("fills date and datetime properties from a cell's ISO text, a spreadsheet's space or zero seconds too, leaving out a row that is not one", () => {
    const events: Extract<FieldDef, { type: 'list' }> = {
      type: 'list',
      label: 'Events',
      item: { day: { type: 'date', label: 'Day' }, at: { type: 'datetime', label: 'At', default: '2026-11-27T09:00' } },
    };
    const table = {
      columns: ['Day', 'At'],
      rows: [
        [' 2026-11-27 ', '2026-11-27T18:00'],
        ['2026-11-28', '2026-11-28T18:30:00'],
        ['2026-11-29', '2026-11-29T07:15:00'],
        ['2026-11-30', ''],
        ['27/11/2026', '2026-11-27T18:00'],
        ['2026-12-01', '2026-12-01T18:00Z'],
        [46_000, '2026-12-02T18:00:30'],
        // As a spreadsheet exports it, padded or not.
        ['2026-12-03', '2026-12-03 18:00'],
        ['2026-12-04', ' 2026-12-04 18:30:00 '],
      ],
    };
    expect(tableItems(events, { columns: { day: 'Day', at: 'At' } }, table, 'en-US')).toEqual({
      items: [
        { day: '2026-11-27', at: '2026-11-27T18:00' },
        { day: '2026-11-28', at: '2026-11-28T18:30' },
        { day: '2026-11-29', at: '2026-11-29T07:15' },
        { day: '2026-11-30', at: '2026-11-27T09:00' },
        { day: '2026-12-03', at: '2026-12-03T18:00' },
        { day: '2026-12-04', at: '2026-12-04T18:30' },
      ],
      problems: ['row 5: day must be a date (YYYY-MM-DD)', 'row 6: at must be a date and time (YYYY-MM-DDTHH:mm)', 'row 7: day must be a date (YYYY-MM-DD)'],
    });
  });

  it("sorts a column of dates and times by time, whichever separator each row's cell has, and leaves the cells as the file has them", () => {
    const events: Extract<FieldDef, { type: 'list' }> = {
      type: 'list',
      label: 'Events',
      item: { name: { type: 'text', label: 'Name' }, when: { type: 'text', label: 'When' } },
    };
    const table = {
      columns: ['Event', 'Starts'],
      rows: [
        ['Late', '2026-11-27 18:30'],
        ['Early', '2026-11-27T09:00'],
        ['Noon', ' 2026-11-27 12:00:00'],
        ['Next day', '2026-11-28T08:00'],
      ],
    };
    const sorted = tableItems(events, { columns: { name: 'Event', when: 'Starts' }, sort: { column: 'Starts' } }, table, 'en-US');
    expect(sorted.items).toEqual([
      { name: 'Early', when: '2026-11-27T09:00' },
      { name: 'Noon', when: '2026-11-27 12:00:00' },
      { name: 'Late', when: '2026-11-27 18:30' },
      { name: 'Next day', when: '2026-11-28T08:00' },
    ]);
  });

  it('filters, sorts, then keeps maxItems rows', () => {
    const columns = { name: 'Item', price: 'Price' };
    const names = (t: Parameters<typeof tableItems>[1]) => tableItems(menuItems, t, menuTable, 'en-US').items?.map((i) => i.name);
    expect(names({ columns, filter: { column: 'Section', equals: ' starters ' } })).toEqual(['Soup', 'Bread']);
    expect(names({ columns, sort: { column: 'Item' } })).toEqual(['Bread', 'Pie', 'Soup']);
    expect(names({ columns, sort: { column: 'Price', descending: true } })).toEqual(['Steak', 'Pie', 'Soup']);
    expect(names({ columns, filter: { column: 'Section', equals: 'Mains' }, sort: { column: 'Item' } })).toEqual(['Pie', 'Steak']);
  });

  it('gives no items when every row it read fails, but an empty list when the filter keeps none', () => {
    const long = {
      columns: ['Item', 'Price'],
      rows: [
        ['Soup', '$4.50 a bowl'],
        ['Stew', '$11.00 a pot'],
      ],
    };
    expect(tableItems(menuItems, { columns: { name: 'Item', price: 'Price' } }, long, 'en-US')).toEqual({
      problems: ['row 1: price is longer than 10', 'row 2: price is longer than 10'],
    });
    const fields = { items: menuItems };
    expect(boundValue(fields, 'items', { source: 'menu', path: 'rows', table: { columns: { name: 'Item', price: 'Price' } } }, long, 'en-US')).toEqual({
      problems: ['field "items": row 1: price is longer than 10', 'field "items": row 2: price is longer than 10'],
    });
    expect(tableItems(menuItems, { columns: { name: 'Item', price: 'Price' }, filter: { column: 'Item', equals: 'Pie' } }, long, 'en-US')).toEqual({
      items: [],
      problems: [],
    });
  });

  it('gives no items for a table without a mapped column, or not a table at all', () => {
    expect(tableItems(menuItems, { columns: { name: 'Dish', price: 'Price' }, sort: { column: 'Rank' } }, menuTable, 'en-US')).toEqual({
      problems: ['the table has no column "Dish", "Rank"'],
    });
    expect(tableItems(menuItems, { columns: { name: 'Item', price: 'Price' } }, { items: [] }, 'en-US')).toEqual({
      problems: ['table columns must be a list of names'],
    });
  });

  it('reads a bound value by path, or by a table mapping', () => {
    const fields = { title: { type: 'text', label: 'Title' }, items: menuItems };
    expect(boundValue(fields, 'title', { source: 'menu', path: 'rows.1.0' }, menuTable, 'en-US')).toEqual({ value: 'Steak', problems: [] });
    expect(boundValue(fields, 'title', { source: 'menu', path: 'rows.9.0' }, menuTable, 'en-US')).toEqual({
      problems: ['field "title" has no value at the bound path'],
    });
    expect(boundValue(fields, 'items', tableBinding(), menuTable, 'en-US')).toEqual({
      value: [
        { name: 'Soup', price: '4.50', tag: '', hot: false },
        { name: 'Steak', price: '$21', tag: '', hot: false },
        { name: 'Pie', price: '12', tag: '', hot: false },
      ],
      problems: [],
    });
    expect(boundValue(fields, 'items', { ...tableBinding(), table: { columns: { name: 'Dish', price: 'Price' } } }, menuTable, 'en-US')).toEqual({
      problems: ['field "items": the table has no column "Dish"'],
    });
    // Without its table, the rows are lists, which no list field takes: a player before #84 shows the fallback.
    expect(boundValue(fields, 'items', { source: 'menu', path: 'rows' }, menuTable, 'en-US').value).toBeUndefined();
  });

  it("holds a spot's table binding to a list field, its item properties, and a column for each property without a default", () => {
    const fields = { title: { type: 'text', label: 'Title', default: 'Menu' }, items: { ...menuItems, default: [] } };
    expect(validateSpotData(fields, {}, {}, { items: tableBinding() })).toEqual([]);
    expect(validateSpotData(fields, {}, {}, { title: tableBinding() })).toEqual([
      'binding for "title" maps a table, which fills a list field only, and "title" is a text field',
    ]);
    expect(
      validateSpotData(
        fields,
        {},
        {},
        {
          items: {
            source: 'menu',
            path: 'items',
            table: { columns: { colour: 'C', price: '' }, filter: { column: 'S' }, sort: { column: 'X', descending: 'yes' } },
          },
        },
      ),
    ).toEqual([
      'binding for "items": a table binding\'s path is "rows"',
      'binding for "items": "colour" is not a property of its items (name, price, tag, hot)',
      'binding for "items": the column for "price" must be a column name',
      'binding for "items" needs a column for "name"',
      'binding for "items": filter needs a column and the text it equals',
      'binding for "items": sort needs a column, and descending true or false',
    ]);
  });

  it('lets a template declare list fields a table fills, at rows', () => {
    const m = { ...structuredClone(template), live: { source: 'table', fields: { items: 'rows' } } };
    expect(validateTemplateManifest(m)).toEqual([]);
    expect(validateTemplateManifest({ ...m, live: { source: 'table', fields: { title: 'rows', items: 'items' } } })).toEqual([
      'live: field "title": a table fills list fields only, at "rows"',
      'live: field "items": a table fills list fields only, at "rows"',
    ]);
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
    expect(MANIFEST_SCHEMA).toBe(7);
    expect(SUPPORTED_MANIFEST_SCHEMAS).toEqual([6, 7]);
    expect(validateManifest({ ...validManifest(), schema: 6 })).toEqual([]);
    expect(validateManifest({ ...validManifest(), schema: 7 })).toEqual([]);
    // A player that knows only schemas 5 and 6 refuses a template with several live sources (#193): the server tells it to reload (apps/api sync's canPlay).
    expect(validateManifest({ ...validManifest(), schema: 5 })).toEqual(['manifest schema 5 is not one this player can play (6, 7)']);
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

describe('image samples', () => {
  const withSample = (sample: { size: number; type: string } | undefined) => {
    const m = validManifest();
    m.files['sha-photo']!.sample = 'sha-sample';
    if (sample) m.files['sha-sample'] = sample;
    return m;
  };

  it("lists the sample of a template spot's image among the files a screen must hold, and no other image's", () => {
    const m = withSample({ size: 10, type: 'image/png' });
    expect([...requiredFiles(m)].sort()).toEqual(['sha-font', 'sha-html', 'sha-logo', 'sha-photo', 'sha-sample']);
    m.spots.menu = { id: 'menu', name: 'Menu', kind: 'image', file: 'sha-photo', fit: 'cover', durationMs: 8000 };
    expect([...requiredFiles(m)].sort()).toEqual(['sha-font', 'sha-html', 'sha-logo', 'sha-photo']);
  });

  it('refuses a sample that is not a PNG listed in files', () => {
    expect(validateManifest(withSample({ size: 10, type: 'image/png' }))).toEqual([]);
    expect(validateManifest(withSample(undefined))).toEqual(["file sha-photo's sample must be a PNG listed in files"]);
    expect(validateManifest(withSample({ size: 10, type: 'image/jpeg' }))).toEqual(["file sha-photo's sample must be a PNG listed in files"]);
  });

  it('has a column per cell of the width, and a row per cell of the height for the darkest and again for the lightest', () => {
    expect(IMAGE_SAMPLE_CELL).toBe(16);
    expect(imageSampleSize(1920, 1080)).toEqual({ width: 120, height: 136 });
    expect(imageSampleSize(3413, 1920)).toEqual({ width: 214, height: 240 });
    expect(imageSampleSize(1, 1)).toEqual({ width: 1, height: 2 });
  });

  it('carries the sample in init beside its field', () => {
    expect(sampleAsset('photo')).toBe('photo:sample');
  });
});

describe('scheduleEntryProblems', () => {
  it('checks one entry as validateManifest does, apart from its playlist, which a manifest lists', () => {
    const entry = { id: 'breakfast', playlist: 'not-in-any-manifest', priority: 0, target: 'group', days: [1, 2, 3, 4, 5], from: '06:00', to: '10:30' };
    expect(scheduleEntryProblems(entry)).toEqual([]);
    expect(scheduleEntryProblems({ ...entry, days: [7], from: '6am', startDate: 'Monday', target: 'shop' })).toEqual([
      'schedule entry "breakfast": target must be org, group or screen',
      'schedule entry "breakfast": from must be HH:MM',
      'schedule entry "breakfast": days must be 0-6',
      'schedule entry "breakfast": startDate must be YYYY-MM-DD',
    ]);
    expect(scheduleEntryProblems({ ...entry, startsAt: '2026-11-17T16:00:00Z', endsAt: '2026-11-17T14:00:00Z' })).toEqual([
      'schedule entry "breakfast": endsAt must be after startsAt',
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
  it('rejects a snapshot without an id, version, times or data', () => {
    expect(validateDataSnapshot({ id: '../x', version: -1, fetchedAt: 'yesterday' })).toEqual([
      'snapshot id "../x" is not a valid id',
      'snapshot version must be a whole number, 0 or more',
      'snapshot fetchedAt must be an ISO 8601 time',
      'snapshot checkedAt must be an ISO 8601 time',
      'snapshot has no data',
    ]);
  });

  it('caps a snapshot at 64 kB of data', () => {
    const snap = validSyncResponse().snapshots[0]!;
    const fill = (n: number) => ({ ...snap, data: { t: 'é'.repeat(n) } });
    // {"t":"…"} is 8 bytes around the text, and é is 2 bytes in UTF-8.
    expect(validateDataSnapshot(fill((MAX_SNAPSHOT_BYTES - 8) / 2))).toEqual([]);
    expect(validateDataSnapshot(fill((MAX_SNAPSHOT_BYTES - 8) / 2 + 1))).toEqual([`snapshot data is over ${MAX_SNAPSHOT_BYTES} bytes as JSON`]);
  });

  it('tells a screen when a snapshot it holds was last checked', () => {
    expect(validateSyncResponse({ ...validSyncResponse(), checked: undefined })).toEqual([]);
    expect(
      validateSyncResponse({
        ...validSyncResponse(),
        checked: { '../x': { version: 1, checkedAt: 'now' }, feed: { version: -1, checkedAt: '2026-11-17T13:04:00Z' } },
      }),
    ).toEqual(['checked: "../x" must be a source id with a version and checkedAt', 'checked: "feed" must be a source id with a version and checkedAt']);
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
      'manifest needs filesMissing, and active, fallbackFrom and lastGood when there are any, as sha256 ids',
      `playCounts holds at most ${MAX_SYNC_PLAY_COUNTS} counts`,
      'dataRejected: "feed" must be a source id with a count',
    ]);
    const { dataRejected: _, ...without } = validSyncRequest();
    expect(validateSyncRequest(without)).toEqual([]);
  });

  it('checks no play count of a list over the bound, so a body at the ceiling stays one problem', () => {
    // About MAX_SYNC_REQUEST_BYTES of `{}`: checking each entry first made a problem apiece.
    const r = validSyncRequest() as unknown as Record<string, unknown>;
    r.playCounts = Array.from({ length: 349_000 }, () => ({}));
    expect(validateSyncRequest(r)).toEqual([`playCounts holds at most ${MAX_SYNC_PLAY_COUNTS} counts`]);
  });

  it('takes only sha256 manifest ids from a screen', () => {
    const r = validSyncRequest() as unknown as Record<string, unknown>;
    // Each id on its own, so no one check hides behind another: too long, and hex in uppercase.
    const upper = 'ABCDEF'.repeat(10) + 'ABCD';
    for (const field of ['active', 'fallbackFrom', 'lastGood'])
      for (const bad of ['x'.repeat(10_000), upper]) {
        r.manifest = { ...validSyncRequest().manifest, [field]: bad };
        expect(validateSyncRequest(r), `${field} ${bad.slice(0, 8)}`).toEqual([
          'manifest needs filesMissing, and active, fallbackFrom and lastGood when there are any, as sha256 ids',
        ]);
      }
    expect(validateDeviceSocketMessage({ type: 'applied', manifest: upper })).toEqual(['applied message needs a sha256 manifest id']);
    expect(validateDeviceSocketMessage({ type: 'applied', manifest: upper.toLowerCase() })).toEqual([]);
  });

  it('takes an applied message with or without the time the screen observed it', () => {
    const manifest = 'a'.repeat(64);
    expect(validateDeviceSocketMessage({ type: 'applied', manifest, observedAt: '2026-11-18T12:00:00.000Z' })).toEqual([]);
    // A player from before gh-44 sends none.
    expect(validateDeviceSocketMessage({ type: 'applied', manifest })).toEqual([]);
    for (const bad of ['soon', 1795032877648, null])
      expect(validateDeviceSocketMessage({ type: 'applied', manifest, observedAt: bad }), String(bad)).toEqual([
        'applied message observedAt must be an ISO 8601 time when present',
      ]);
  });

  it('reports a source map with many bad entries as one problem, so the work it makes stays bounded', () => {
    const bad = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`bad id ${i}`, -1]));
    expect(validateSyncRequest({ ...validSyncRequest(), snapshots: bad, dataRejected: bad })).toEqual([
      'snapshots: "bad id 0" must be a source id with a version number (and 4999 more)',
      'dataRejected: "bad id 0" must be a source id with a count (and 4999 more)',
    ]);
  });

  it('takes source maps over MAX_SYNC_SOURCES: a player before gh-45 sends every source it has seen since it started', () => {
    const many = Object.fromEntries(Array.from({ length: MAX_SYNC_SOURCES + 44 }, (_, i) => [`s${i}`, 1]));
    expect(validateSyncRequest({ ...validSyncRequest(), snapshots: many, dataRejected: many })).toEqual([]);
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

describe('forbidden code lint', () => {
  const problems = (sources: Record<string, string>) =>
    checkTemplateBundle({ manifest: template, html: '<p>', sources: { 'main.ts': '', ...sources } }).checks.find((c) => c.check === 'source-code')?.problems;

  it('refuses inline event handlers and javascript: URLs, which the policy does not run', () => {
    const handler = ['inline event handlers do not run in a template; use addEventListener'];
    expect(problems({ 'index.html': '<img src="a.png"\n  onerror="x()">' })).toEqual(handler);
    expect(problems({ 'main.ts': 'box.innerHTML = `<b onclick="go()">`;' })).toEqual(handler);
    expect(problems({ 'main.ts': "el.setAttribute('onload', 'x')" })).toEqual(handler);
    expect(problems({ 'index.html': '<a href="javascript:go()">' })).toEqual(['`javascript:` URLs do not run in a template']);
  });

  it('passes handlers set as properties or with addEventListener', () => {
    expect(problems({ 'main.ts': "img.onload = () => done();\nel.addEventListener('click', f);\nconst ok = a < b && c.onx === 1;" })).toEqual([]);
  });

  it("passes a style.css that imports another package's stylesheet, which the build bundles (the look kit)", () => {
    expect(problems({ 'style.css': "@import '@signforge/template-looks/looks.css';\n.a { color: var(--lk-text); }" })).toEqual([]);
  });
});

describe('forbidden CSS', () => {
  const problems = (html: string) =>
    checkTemplateBundle({ manifest: template, html, sources: { 'main.ts': '' } }).checks.find((c) => c.check === 'forbidden-css')?.problems;

  it('refuses a bundle that still imports a stylesheet at run time', () => {
    expect(problems('<style>@import "x.css";.a{color:red}</style>')).toEqual(['stylesheets must be bundled, not imported at run time']);
    expect(problems('<style>@IMPORT "x.css";</style>')).toEqual(['stylesheets must be bundled, not imported at run time']);
    expect(problems('<style>.a{color:red}</style>')).toEqual([]);
  });
});

describe('network check', () => {
  const problems = (html: string) =>
    checkTemplateBundle({ manifest: template, html, sources: { 'main.ts': '' } }).checks.find((c) => c.check === 'network')?.problems;
  const refused = ['a template may not load anything from the network'];

  // A stylesheet that style.css imports reaches the bundle without meeting the source lint.
  it('refuses absolute and protocol-relative URLs in the bundle', () => {
    for (const html of [
      '<style>.b{background:url(//tracker.example/p.gif)}</style>',
      '<style>.b{background:url( "//tracker.example/p.gif")}</style>',
      '<style>.b{background:url(https://tracker.example/p.gif)}</style>',
      '<img src="//tracker.example/p.gif">',
      "<a href='https://tracker.example/'>",
      // A string in image-set() is fetched as a URL, with no url() around it.
      '<style>.b{background-image:image-set("//t.example/p.gif" 1x)}</style>',
      '<style>.b{background-image:-webkit-image-set("https://t.example/p.gif" 1x)}</style>',
      "<style>.b{background-image:image-set('data:image/png;base64,AA==' 1x, 'HTTPS://t.example/p.gif' 2x)}</style>",
      '<style>/* a note */.b{background-image:image-set("//t.example/p.gif" 1x)}</style>',
    ])
      expect(problems(html), html).toEqual(refused);
  });

  it('passes data: URLs, paths, and network addresses in comments, such as a font licence notice', () => {
    expect(problems('<style>.b{background:url(data:image/png;base64,AA==)}</style><img src="a.png"><a href="#x">')).toEqual([]);
    const notice = '/*! Copyright 2022 The Inter Project Authors (https://github.com/rsms/inter-tight)\n   see "https://openfontlicense.org" */';
    expect(problems(`<style>${notice}.b{content:"a"}.c{background-image:image-set("p.png" 1x)}</style>`)).toEqual([]);
  });
});

describe('script check', () => {
  const problems = (html: string) =>
    checkTemplateBundle({ manifest: template, html, sources: { 'main.ts': '' } }).checks.find((c) => c.check === 'scripts')?.problems;
  const START = ['every script must start with exactly "use strict"; (sf build makes it so): one that does not, does not run'];

  it('passes classic scripts that start with exactly "use strict";, and data blocks', () => {
    expect(problems('<script>"use strict";go()</script><script type="text/javascript">"use strict";\r\nmore()</script>')).toEqual([]);
    expect(problems('<script type="application/json">{"a":1}</script>')).toEqual([]);
  });

  it('refuses a script that starts any other way, whatever comes first', () => {
    for (const text of ['\uFEFF"use strict";x()', '/* licence */"use strict";x()', "'use strict';x()", '"use strict"\r\nx()', ' "use strict";x()', 'x()'])
      expect(problems(`<script>${text}</script>`), JSON.stringify(text)).toEqual(START);
  });

  it('refuses a module, another executable type and an external script, read as the browser reads them', () => {
    const type = (t: string) => [`a script with type "${t}" does not run in a template: use no type (sf build makes a classic script)`];
    const external = ['a script must be inline: an external script does not run in a template'];
    expect(problems('<script type="module">"use strict";x()</script>')).toEqual(type('module'));
    expect(problems('<script type="&#109;odule">"use strict";x()</script>')).toEqual(type('module'));
    expect(problems('<script type=" MODULE ">"use strict";x()</script>')).toEqual(type('module'));
    expect(problems('<script type="text/ecmascript">"use strict";x()</script>')).toEqual(type('text/ecmascript'));
    expect(problems('<script language="javascript1.5">"use strict";x()</script>')).toEqual(type('text/javascript1.5'));
    expect(problems('<script type="importmap">{}</script>')).toEqual(type('importmap'));
    expect(problems('<script src="x.js"></script>')).toEqual(external);
    expect(problems('<svg><script href="x.js"/></svg>')).toEqual(external);
    expect(problems('<svg><script xlink:href="x.js"></script></svg>')).toEqual(external);
  });

  it('reads a script in SVG and in a template element, and refuses SVG script text that is not plain', () => {
    expect(problems('<svg><script>"use strict";x()</script></svg><template><script>y()</script></template>')).toEqual(START);
    expect(problems('<svg><script>"use strict";a &lt; b</script></svg>')).toEqual([
      'a script must be plain text: no character references, CDATA or elements in it',
    ]);
  });

  it('refuses a select that holds script markup, where browsers parse differently, and skips a script in MathML', () => {
    const select = ['a <select> may not hold a script: browsers parse <select> differently, and none runs in a template'];
    expect(problems('<select><script>"use strict";x()</script></select>')).toEqual(select);
    // A script that only Chromium's customizable-select parsing finds: the markup is refused all the same.
    expect(problems('<select><svg><textarea><script>"use strict";x()</script></textarea></svg></select>')).toEqual(select);
    expect(problems('<select><option>One</option><option>Two</option></select>')).toEqual([]);
    expect(problems('<math><script>x()</script></math>')).toEqual([]);
  });

  it('passes text that only looks like a script: in a textarea, a comment, an attribute', () => {
    expect(problems('<textarea><script>x()</script></textarea><!-- <script>y()</script> --><p title="<script>z()</script>">')).toEqual([]);
  });
});

describe('validatePairStartRequest', () => {
  it('takes an empty body as a device, and a known kind', () => {
    expect(validatePairStartRequest({})).toEqual([]);
    expect(validatePairStartRequest({ kind: 'device' })).toEqual([]);
    expect(validatePairStartRequest({ kind: 'browser' })).toEqual([]);
  });
  it('refuses another kind', () => {
    expect(validatePairStartRequest({ kind: 'tv' })).toEqual(['kind must be one of device, browser']);
    expect(validatePairStartRequest(null)).toEqual(['request is not an object']);
  });
});
