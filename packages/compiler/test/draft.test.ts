import type { FieldDef } from '@signforge/contract';
import { describe, expect, it } from 'vitest';
import { compileProbe, draftCheck, spotFromDraft, type DraftAsset, type DraftReads, type Probe, type SpotDraft } from '../src/draft';
import { opts, promo } from './fixtures';

const sha = (c: string) => c.repeat(64);

const photo: DraftAsset = {
  kind: 'image',
  status: 'verified',
  sha256: sha('b'),
  type: 'image/jpeg',
  size: 2000,
  renditions: [
    { orientation: 'landscape', sha256: sha('b'), type: 'image/jpeg', size: 2000, sample: null },
    { orientation: 'portrait', sha256: sha('c'), type: 'image/jpeg', size: 1500, sample: null },
  ],
};
const clip: DraftAsset = { kind: 'video', status: 'verified', sha256: sha('d'), type: 'video/mp4', size: 9000, renditions: [] };

/** An org with the promo template (approved), a photo and a clip; `assets` overrides them by id. */
function reads(assets: Record<string, DraftAsset | undefined> = {}): DraftReads {
  const all: Record<string, DraftAsset | undefined> = { photo, clip, ...assets };
  return {
    asset: (id) => all[id],
    templateVersion: (id) => (id === 'tpv_promo' ? { key: 'base/promo@1.0.0', manifest: promo, html: sha('a'), size: 1000, status: 'approved' } : undefined),
  };
}

const draft = (d: Partial<SpotDraft> & Pick<SpotDraft, 'kind'>): SpotDraft => ({
  id: 'deal',
  name: 'Deal',
  durationMs: 8000,
  templateVersionId: null,
  data: null,
  assets: null,
  bindings: null,
  assetId: null,
  fit: null,
  url: null,
  ...d,
});

describe('draftCheck', () => {
  const fields: Record<string, FieldDef> = {
    photo: { type: 'image', label: 'Photo' },
    logo: { type: 'image', label: 'Logo' },
    target: { type: 'datetime', label: 'Target' },
    opens: { type: 'date', label: 'Opens', default: '2026-12-01' },
    closes: { type: 'date', label: 'Closes', default: '2026-12-31' },
    title: { type: 'text', label: 'Title' },
    events: {
      type: 'list',
      label: 'Events',
      item: { name: { type: 'text', label: 'Name' }, at: { type: 'datetime', label: 'At', min: '2026-01-01T00:00' }, day: { type: 'date', label: 'Day' } },
    },
  };

  it('leaves out an image with no asset and a date or datetime not picked: what a draft may save without, and a publish holds back for', () => {
    // A default stands in for a value left out; a value cleared to '' is not picked.
    const draft = { data: { target: '', closes: '', title: '', extra: 1 }, assets: { logo: 'ast_1' }, bindings: {} };
    const checked = draftCheck(fields, draft);
    expect(Object.keys(checked.fields)).toEqual(['logo', 'opens', 'title', 'events']);
    expect(checked.data).toEqual({ extra: 1, title: '' });
    expect(Object.keys(draftCheck(fields, { ...draft, data: { target: '2026-12-24T18:00' } }).fields)).toEqual([
      'logo',
      'target',
      'opens',
      'closes',
      'title',
      'events',
    ]);
  });

  it('keeps a bound date, unpicked or not, as it keeps a bound image: a bound field needs its fallback', () => {
    const checked = draftCheck(fields, { data: { target: '' }, assets: {}, bindings: { target: {}, photo: {} } });
    expect(Object.keys(checked.fields)).toEqual(['photo', 'target', 'opens', 'closes', 'title', 'events']);
    expect(checked.data).toEqual({ target: '' });
  });

  it("checks a list row with a value its field takes in an unpicked date's place, and the rest of the row as it is", () => {
    const events = [{ name: 'Doors', at: '', day: '' }, { name: 'Talk', at: '2026-11-27T18:00', day: '2026-11-27' }, { name: 'Late' }];
    expect(draftCheck(fields, { data: { events }, assets: {}, bindings: {} }).data).toEqual({
      events: [
        { name: 'Doors', at: '2026-01-01T00:00', day: '1900-01-01' },
        { name: 'Talk', at: '2026-11-27T18:00', day: '2026-11-27' },
        { name: 'Late', at: '2026-01-01T00:00', day: '1900-01-01' },
      ],
    });
  });
});

describe('spotFromDraft', () => {
  it("turns a template draft into the contract's spot: the rendition for the orientation, the template and its bundle, bindings as a screen reads them", () => {
    const into = { templates: {}, files: {} };
    const { spot, problems } = spotFromDraft(
      draft({
        kind: 'template',
        templateVersionId: 'tpv_promo',
        data: { title: 'Two for $4' },
        assets: { photo: 'photo' },
        bindings: { title: { dataSourceId: 'src_menu', path: 'items.0.name' } },
      }),
      'portrait',
      reads(),
      into,
    );
    expect(problems).toEqual([]);
    expect(spot).toEqual({
      id: 'deal',
      name: 'Deal',
      durationMs: 8000,
      kind: 'template',
      template: 'base/promo@1.0.0',
      data: { title: 'Two for $4' },
      assets: { photo: sha('c') },
      bindings: { title: { source: 'src_menu', path: 'items.0.name' } },
    });
    expect(into).toEqual({
      templates: { 'base/promo@1.0.0': { manifest: promo, html: sha('a') } },
      files: { [sha('a')]: { size: 1000, type: 'text/html' }, [sha('c')]: { size: 1500, type: 'image/jpeg' } },
    });
  });

  it("lists a rendition's sample in its file entry, and the sample among the files", () => {
    const sampled: DraftAsset = {
      ...photo,
      renditions: [
        photo.renditions[0]!,
        { orientation: 'portrait', sha256: sha('c'), type: 'image/jpeg', size: 1500, sample: { sha256: sha('e'), size: 300 } },
      ],
    };
    const into = { templates: {}, files: {} };
    const { spot } = spotFromDraft(draft({ kind: 'image', assetId: 'photo' }), 'portrait', reads({ photo: sampled }), into);
    expect(spot).toMatchObject({ file: sha('c') });
    expect(into.files).toEqual({ [sha('c')]: { size: 1500, type: 'image/jpeg', sample: sha('e') }, [sha('e')]: { size: 300, type: 'image/png' } });
  });

  it('gives a spot with no bindings none at all', () => {
    const { spot } = spotFromDraft(draft({ kind: 'template', templateVersionId: 'tpv_promo', bindings: {} }), 'landscape', reads(), {
      templates: {},
      files: {},
    });
    expect(spot).not.toHaveProperty('bindings');
  });

  it('refuses an image or video draft with no asset, and draws nothing', () => {
    for (const kind of ['image', 'video'] as const) {
      expect(spotFromDraft(draft({ kind }), 'landscape', reads(), { templates: {}, files: {} })).toEqual({ problems: ['no asset'] });
    }
  });

  it('plays a video as its own file, and an image fitted to cover unless the draft says otherwise', () => {
    const files = {};
    expect(spotFromDraft(draft({ kind: 'video', assetId: 'clip' }), 'portrait', reads(), { templates: {}, files }).spot).toMatchObject({
      file: sha('d'),
      fit: 'cover',
    });
    expect(files).toEqual({ [sha('d')]: { size: 9000, type: 'video/mp4' } });
    expect(spotFromDraft(draft({ kind: 'image', assetId: 'photo', fit: 'contain' }), 'landscape', reads(), { templates: {}, files }).spot).toMatchObject({
      file: sha('b'),
      fit: 'contain',
    });
  });

  it('gives only a verified asset a file: one still being checked, rejected or missing is refused, and adds no file', () => {
    const into = { templates: {}, files: {} };
    expect(spotFromDraft(draft({ kind: 'image', assetId: 'photo' }), 'landscape', reads({ photo: { ...photo, status: 'pending' } }), into)).toEqual({
      problems: ['asset photo is still being checked'],
    });
    expect(
      spotFromDraft(
        draft({ kind: 'template', templateVersionId: 'tpv_promo', assets: { photo: 'clip' } }),
        'landscape',
        reads({ clip: { ...clip, status: 'rejected' } }),
        { templates: {}, files: {} },
      ),
    ).toEqual({ problems: ['asset clip was rejected'] });
    expect(spotFromDraft(draft({ kind: 'image', assetId: 'gone' }), 'landscape', reads(), into)).toEqual({ problems: ['asset gone does not exist'] });
    expect(
      spotFromDraft(draft({ kind: 'image', assetId: 'photo' }), 'portrait', reads({ photo: { ...photo, renditions: photo.renditions.slice(0, 1) } }), into),
    ).toEqual({ problems: ['asset photo has no portrait rendition'] });
    expect(into).toEqual({ templates: {}, files: {} });
  });

  it('refuses a template version the org does not have, or a draft version, in the words the publish uses', () => {
    expect(spotFromDraft(draft({ kind: 'template', templateVersionId: 'tpv_gone' }), 'landscape', reads(), { templates: {}, files: {} })).toEqual({
      problems: ['template version tpv_gone does not exist'],
    });
    const drafted: DraftReads = { ...reads(), templateVersion: (id) => ({ ...reads().templateVersion(id)!, status: 'draft' }) };
    const into = { templates: {}, files: {} };
    expect(spotFromDraft(draft({ kind: 'template', templateVersionId: 'tpv_promo' }), 'landscape', drafted, into)).toEqual({
      problems: ['template base/promo@1.0.0 is draft; only an approved version can be published'],
    });
    expect(into).toEqual({ templates: {}, files: {} });
  });
});

describe('compileProbe', () => {
  const probe: Pick<Probe, 'orientation' | 'timezone' | 'dataSources'> = { orientation: 'landscape', timezone: 'Europe/London', dataSources: [] };

  it('compiles a probe screen playing the drafts, each once, in a playlist of its own', async () => {
    const { manifest, problems } = await compileProbe(
      { ...probe, spots: [draft({ kind: 'image', assetId: 'photo' }), draft({ id: 'page', kind: 'url', url: 'https://example.com/' })] },
      reads(),
      opts(),
    );
    expect(problems).toEqual([]);
    expect(manifest!.screen).toEqual({ id: 'draft-check', name: 'Draft check', timezone: 'Europe/London', orientation: 'landscape' });
    expect(manifest!.playlists[manifest!.defaultPlaylist]!.items).toEqual([{ spot: 'deal' }, { spot: 'page' }]);
  });

  it('compiles nothing when a draft cannot be a spot, and says why once', async () => {
    expect(await compileProbe({ ...probe, spots: [draft({ kind: 'image' })] }, reads(), opts())).toEqual({ problems: ['spot deal: no asset'], refused: true });
    const pending = { ...draft({ kind: 'template', templateVersionId: 'tpv_promo', assets: { photo: 'photo' } }), durationMs: 1 };
    expect(await compileProbe({ ...probe, spots: [pending] }, reads({ photo: { ...photo, status: 'pending' } }), opts())).toEqual({
      problems: ['spot deal: asset photo is still being checked'],
      refused: true,
    });
  });

  it("adds the compiler's own problems, such as data the template refuses", async () => {
    const { manifest, problems, refused } = await compileProbe(
      { ...probe, spots: [draft({ kind: 'template', templateVersionId: 'tpv_promo', data: { title: 'x'.repeat(41) }, assets: { photo: 'photo' } })] },
      reads(),
      opts(),
    );
    expect(manifest).toBeUndefined();
    expect(problems).toEqual(['spot deal: field "title" is longer than 40']);
    expect(refused).toBe(false);
  });
});
