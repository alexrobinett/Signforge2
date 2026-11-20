/**
 * Brand tools: the font catalogue, an org's brand kits, its default kit, and which kit a group or
 * screen uses. Nothing here changes a screen: a kit is frozen into each manifest at publish, so
 * an edit reaches screens with the next publish. Each kit view says which screens that will be
 * (`reach`), and which screens cannot get a kit because their groups disagree (`conflicts`).
 */
import { brandWarnings, chooseBrandKit, FONTS, fontById, HEX_COLOR, onColor } from '@signforge/compiler';
import { unverified } from '@signforge/compiler/draft';
import { BRAND_SHAPES, type BrandColors } from '@signforge/contract';
import type { BrandAssignment, BrandKitRow, OrgScope } from '@signforge/db';
import { z } from 'zod';
import { id, idempotencyKey, ifVersion, name, version } from './fields';
import { nextOutput, page, pageInput } from './paging';
import { defineTool, notFound, ToolError } from './tool';

// ------------------------------------------------------------------ colours

/** What a kit stores: every colour, except that an absent on-colour is derived for contrast. */
export type StoredColors = Omit<BrandColors, 'onPrimary' | 'onAccent'> & { onPrimary?: string; onAccent?: string };

const DERIVED = [
  ['onPrimary', 'primary'],
  ['onAccent', 'accent'],
] as const;

/** A kit's colours as screens get them: an on-colour not set by hand is black or white, whichever reaches 4.5:1. */
export function kitColors(row: Pick<BrandKitRow, 'colorsJson'>): { colors: BrandColors; derived: ('onPrimary' | 'onAccent')[] } {
  const stored = JSON.parse(row.colorsJson) as StoredColors;
  const derived = DERIVED.filter(([on]) => !stored[on]).map(([on]) => on);
  const colors = { ...stored } as BrandColors;
  for (const [on, fill] of DERIVED) if (!stored[on]) colors[on] = onColor(stored[fill]);
  return { colors, derived };
}

const hex = z
  .string()
  .regex(HEX_COLOR, 'a hex colour, #rgb or #rrggbb')
  .transform((v) => v.toLowerCase())
  .describe('A hex colour, #rrggbb');
const colorsInput = z
  .object({
    primary: hex.describe('Filled buttons and badges'),
    accent: hex.describe('Highlights, tags, the crawl label'),
    background: hex.describe('The page'),
    surface: hex.describe('Cards and rows on the page'),
    text: hex.describe('Body text'),
    muted: hex.describe('Secondary text'),
    onPrimary: hex.optional().describe('Text on primary. Leave out to derive it for 4.5:1 contrast'),
    onAccent: hex.optional().describe('Text on accent. Leave out to derive it for 4.5:1 contrast'),
  })
  .describe('The kit colours');
const colorsPatch = z
  .object({
    primary: hex.optional(),
    accent: hex.optional(),
    background: hex.optional(),
    surface: hex.optional(),
    text: hex.optional(),
    muted: hex.optional(),
    onPrimary: hex.nullable().optional().describe('Null derives it again'),
    onAccent: hex.nullable().optional().describe('Null derives it again'),
  })
  .describe('The colours to change; the rest stay');

const fontId = (role: string) =>
  z
    .string()
    .refine((v) => fontById(v) !== undefined, 'not a font in the catalogue; see list_fonts')
    .describe(`The ${role} font's catalogue id, such as base/inter. See list_fonts`);
const shape = z.enum(BRAND_SHAPES).describe('Corner radius scale');

// ------------------------------------------------------------------ views

const fontOutput = z.object({
  id: z.string(),
  family: z.string(),
  roles: z.array(z.enum(['display', 'body'])).describe('What it suits: headlines, running text, or both'),
  weights: z.array(z.number()),
  licence: z.object({ spdx: z.literal('OFL-1.1'), copyright: z.string(), source: z.string() }),
  available: z.boolean().describe('False until its files are added: a kit may choose it, and screens draw with the template font until then'),
});

const fontRef = z.object({ id: z.string(), family: z.string() }).nullable();

const brandKitOutput = z.object({
  id: z.string(),
  name: z.string(),
  colors: z.object({
    primary: z.string(),
    onPrimary: z.string(),
    accent: z.string(),
    onAccent: z.string(),
    background: z.string(),
    surface: z.string(),
    text: z.string(),
    muted: z.string(),
  }),
  derived: z.array(z.enum(['onPrimary', 'onAccent'])).describe('On-colours derived for contrast rather than set by hand'),
  shape,
  displayFont: fontRef,
  bodyFont: fontRef,
  logo: z.object({ onDarkAssetId: z.string(), onLightAssetId: z.string().nullable() }).nullable(),
  isDefault: z.boolean(),
  groupIds: z.array(z.string()).describe('Groups that chose this kit'),
  screenIds: z.array(z.string()).describe('Screens that chose this kit themselves'),
  reach: z.array(z.string()).describe('Screens that get this kit at the next publish: where an edit to it will show'),
  conflicts: z
    .array(z.object({ screenId: z.string(), problem: z.string() }))
    .describe('Screens whose groups choose this kit and another, with no choice of their own: they cannot publish until one is chosen'),
  warnings: z.array(z.string()).describe('Colour pairs below 4.5:1 contrast. Warnings only'),
  version,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type BrandKitView = z.infer<typeof brandKitOutput>;
const kitResult = z.object({ brandKit: brandKitOutput });

/** A choice staged in this call but not committed yet, so a view can show the result. */
interface Pending {
  defaultKit?: string;
  screen?: [screenId: string, kitId: string];
  group?: [groupId: string, kitId: string];
}

/** Everything the kit views need beyond the kit itself: who chose what, and each screen's resulting kit. */
async function brandContext(org: OrgScope, pending: Pending = {}) {
  const [assignments, screens, members] = await Promise.all([org.brandKits.assignments.list(), org.screens.list(), org.screenGroups.allMembers()]);
  const groupsOf = Map.groupBy(members, (m) => m.screenId);
  const of = (target: BrandAssignment['target']) => assignments.filter((a) => a.target === target);
  const byGroup = new Map(of('group').map((a) => [a.groupId!, a.brandKitId]));
  const byScreen = new Map(of('screen').map((a) => [a.screenId!, a.brandKitId]));
  if (pending.group) byGroup.set(...pending.group);
  if (pending.screen) byScreen.set(...pending.screen);
  const defaultKit = pending.defaultKit ?? of('org')[0]?.brandKitId;
  const choices = screens.map((s) => {
    const groups = Object.fromEntries((groupsOf.get(s.id) ?? []).flatMap((m) => (byGroup.has(m.groupId) ? [[m.groupId, byGroup.get(m.groupId)!]] : [])));
    return { screenId: s.id, groups, ...chooseBrandKit({ screen: byScreen.get(s.id), groups, default: defaultKit }) };
  });
  return { byGroup, byScreen, defaultKit, choices };
}
type BrandContext = Awaited<ReturnType<typeof brandContext>>;

const font = (fid: string | null) => {
  const f = fid ? fontById(fid) : undefined;
  return f ? { id: f.id, family: f.family } : null;
};
const keysOf = (m: Map<string, string>, kit: string) =>
  [...m]
    .filter(([, k]) => k === kit)
    .map(([id]) => id)
    .sort();

function kitView(row: BrandKitRow, ctx: BrandContext): BrandKitView {
  const { colors, derived } = kitColors(row);
  return {
    id: row.id,
    name: row.name,
    colors,
    derived,
    shape: row.shape,
    displayFont: font(row.displayFontId),
    bodyFont: font(row.bodyFontId),
    logo: row.logoOnDarkAssetId ? { onDarkAssetId: row.logoOnDarkAssetId, onLightAssetId: row.logoOnLightAssetId } : null,
    isDefault: ctx.defaultKit === row.id,
    groupIds: keysOf(ctx.byGroup, row.id),
    screenIds: keysOf(ctx.byScreen, row.id),
    reach: ctx.choices
      .filter((c) => c.kitId === row.id)
      .map((c) => c.screenId)
      .sort(),
    conflicts: ctx.choices.filter((c) => c.problem && Object.values(c.groups).includes(row.id)).map((c) => ({ screenId: c.screenId, problem: c.problem! })),
    warnings: brandWarnings(colors),
    version: row.rowVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function requireKit(org: OrgScope, brandKitId: string) {
  const row = await org.brandKits.get(brandKitId);
  if (!row) throw notFound('brand kit', brandKitId);
  return row;
}

/** A logo must be a verified SVG or PNG image of this org. */
async function checkLogo(org: OrgScope, assetId: string | null | undefined, field: string) {
  if (assetId == null) return;
  const a = await org.assets.get(assetId);
  if (!a) throw notFound('asset', assetId);
  const problem =
    a.kind !== 'image' || !['image/png', 'image/svg+xml'].includes(a.type)
      ? 'a logo must be an SVG or PNG image'
      : unverified(assetId, a.status);
  if (problem) throw new ToolError('invalid_input', problem, [{ path: field, message: problem }]);
}

const logoFields = {
  logoOnDarkAssetId: id('asset').describe('The logo for dark backgrounds: an SVG or PNG image asset'),
  logoOnLightAssetId: id('asset').describe('The logo for light backgrounds, if it differs'),
};

// ------------------------------------------------------------------ tools

const listFonts = defineTool({
  name: 'list_fonts',
  description:
    'List the fonts a brand kit can use: the curated catalogue of open (SIL OFL 1.1) fonts, each with its licence, ordered by id, a page at a time. Returns { fonts, next }.',
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ ...pageInput }),
  output: z.object({ fonts: z.array(fontOutput), next: nextOutput }),
  example: {},
  handler: async ({ input }) => {
    const { rows, next } = page(FONTS, (f) => [f.id], input);
    return {
      fonts: rows.map((f) => ({
        id: f.id,
        family: f.family,
        roles: [...f.roles],
        weights: [...f.weights],
        licence: { ...f.licence },
        available: f.files.length > 0,
      })),
      next,
    };
  },
});

const listBrandKits = defineTool({
  name: 'list_brand_kits',
  description:
    "List the organization's brand kits, ordered by id, a page at a time: colours, fonts, logo, which is the default, which groups and screens chose each, and which screens each reaches. Returns { brandKits, next }.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ ...pageInput }),
  output: z.object({ brandKits: z.array(brandKitOutput), next: nextOutput }),
  example: {},
  handler: async ({ org, input }) => {
    const { rows, next } = page(await org.brandKits.list(), (k) => [k.id], input);
    const ctx = await brandContext(org);
    return { brandKits: rows.map((r) => kitView(r, ctx)), next };
  },
});

const getBrandKit = defineTool({
  name: 'get_brand_kit',
  description:
    'Get one brand kit: its colours (with derived on-colours), fonts, logo, contrast warnings, and reach, the screens its edits will reach at the next publish. Returns { brandKit }.',
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ brandKitId: id('brand kit') }),
  output: kitResult,
  example: { brandKitId: 'bk_example' },
  handler: async ({ org, input }) => ({ brandKit: kitView(await requireKit(org, input.brandKitId), await brandContext(org)) }),
});

const createBrandKit = defineTool({
  name: 'create_brand_kit',
  description:
    "Create a brand kit: colours as hex, a shape, optional display and body fonts from list_fonts, and an optional logo (an SVG or PNG image asset). Leave out onPrimary and onAccent to have them derived for 4.5:1 contrast; pairs below 4.5:1 come back as warnings. The organization's first kit becomes its default; pass makeDefault for a later one. Screens get it at the next publish. Pass an idempotencyKey so a retry cannot create it twice. Returns { brandKit }.",
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  idempotent: true,
  input: z
    .object({
      name: name('brand kit'),
      colors: colorsInput,
      shape: shape.default('soft'),
      displayFontId: fontId('display').optional(),
      bodyFontId: fontId('body').optional(),
      logoOnDarkAssetId: logoFields.logoOnDarkAssetId.optional(),
      logoOnLightAssetId: logoFields.logoOnLightAssetId.optional(),
      makeDefault: z.boolean().optional().describe("Make it the organization's default kit"),
      idempotencyKey,
    })
    .refine((v) => !v.logoOnLightAssetId || v.logoOnDarkAssetId, { message: 'a light logo needs a dark one', path: ['logoOnLightAssetId'] }),
  output: kitResult,
  example: {
    name: 'House style',
    colors: { primary: '#1d4ed8', accent: '#f59e0b', background: '#0b0f17', surface: '#1a2130', text: '#f5f7fa', muted: '#a3acbb' },
    displayFontId: 'base/oswald',
    bodyFontId: 'base/inter',
  },
  target: (_input, output) => ({ kind: 'brand_kit', id: output.brandKit.id }),
  handler: async ({ org, input, write }) => {
    await checkLogo(org, input.logoOnDarkAssetId, 'logoOnDarkAssetId');
    await checkLogo(org, input.logoOnLightAssetId, 'logoOnLightAssetId');
    const kit = write(
      await org.brandKits.stage.insert({
        name: input.name,
        colorsJson: JSON.stringify(input.colors),
        shape: input.shape,
        displayFontId: input.displayFontId ?? null,
        bodyFontId: input.bodyFontId ?? null,
        logoOnDarkAssetId: input.logoOnDarkAssetId ?? null,
        logoOnLightAssetId: input.logoOnLightAssetId ?? null,
      }),
    );
    const isFirst = (await org.brandKits.assignments.list()).every((a) => a.target !== 'org');
    if (!(input.makeDefault || isFirst)) return { brandKit: kitView(kit, await brandContext(org)) };
    // Staged after the kit's insert, so the kit row exists when the batch reaches this one.
    write(await org.brandKits.assignments.stage.set({ target: 'org' }, kit.id, { newKit: true }));
    return { brandKit: kitView(kit, await brandContext(org, { defaultKit: kit.id })) };
  },
});

const updateBrandKit = defineTool({
  name: 'update_brand_kit',
  description:
    'Change a brand kit. Give only what changes: colours (null for onPrimary or onAccent derives it again), shape, name, fonts (null for the template font), logos (null removes). Screens keep the kit as it was until the next publish; the result says which screens it will reach. Pass the version you read as ifVersion so a change made since is not overwritten. Returns { brandKit }.',
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  input: z.object({
    brandKitId: id('brand kit'),
    name: name('brand kit').optional(),
    colors: colorsPatch.optional(),
    shape: shape.optional(),
    displayFontId: fontId('display').nullable().optional(),
    bodyFontId: fontId('body').nullable().optional(),
    logoOnDarkAssetId: logoFields.logoOnDarkAssetId.nullable().optional(),
    logoOnLightAssetId: logoFields.logoOnLightAssetId.nullable().optional(),
    ifVersion,
  }),
  output: kitResult,
  example: { brandKitId: 'bk_example', colors: { accent: '#e11d48' }, shape: 'round' },
  target: (input) => ({ kind: 'brand_kit', id: input.brandKitId }),
  handler: async ({ org, input, write }) => {
    const kit = await requireKit(org, input.brandKitId);
    await checkLogo(org, input.logoOnDarkAssetId, 'logoOnDarkAssetId');
    await checkLogo(org, input.logoOnLightAssetId, 'logoOnLightAssetId');
    let colorsJson: string | undefined;
    if (input.colors) {
      const next: Record<string, string | undefined> = { ...(JSON.parse(kit.colorsJson) as StoredColors) };
      for (const [k, v] of Object.entries(input.colors)) if (v !== undefined) next[k] = v ?? undefined;
      colorsJson = JSON.stringify(next);
    }
    const dark = input.logoOnDarkAssetId === undefined ? kit.logoOnDarkAssetId : input.logoOnDarkAssetId;
    const light = input.logoOnLightAssetId === undefined ? kit.logoOnLightAssetId : input.logoOnLightAssetId;
    if (light && !dark)
      throw new ToolError('invalid_input', 'a light logo needs a dark one', [{ path: 'logoOnDarkAssetId', message: 'a light logo needs a dark one' }]);
    const row = write(
      await org.brandKits.stage.update(
        kit,
        {
          name: input.name,
          colorsJson: colorsJson !== kit.colorsJson ? colorsJson : undefined,
          shape: input.shape,
          displayFontId: input.displayFontId,
          bodyFontId: input.bodyFontId,
          logoOnDarkAssetId: input.logoOnDarkAssetId,
          logoOnLightAssetId: input.logoOnLightAssetId,
        },
        input.ifVersion,
      ),
    );
    return { brandKit: kitView(row, await brandContext(org)) };
  },
});

const setDefaultBrandKit = defineTool({
  name: 'set_default_brand_kit',
  description:
    "Make a brand kit the organization's default: the kit of every screen with no choice of its own and none from its groups. Takes effect at the next publish. Returns { brandKit }.",
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  input: z.object({ brandKitId: id('brand kit') }),
  output: kitResult,
  example: { brandKitId: 'bk_example' },
  target: (input) => ({ kind: 'brand_kit', id: input.brandKitId }),
  handler: async ({ org, input, write }) => {
    const kit = await requireKit(org, input.brandKitId);
    write(await org.brandKits.assignments.stage.set({ target: 'org' }, kit.id));
    return { brandKit: kitView(kit, await brandContext(org, { defaultKit: kit.id })) };
  },
});

const assignBrandKit = defineTool({
  name: 'assign_brand_kit',
  description:
    "Choose the brand kit of one screen or one group (give exactly one of screenId and groupId); a null brandKitId removes the choice. A screen uses its own kit, else its groups' kit, else the default; a screen in two groups that chose different kits, with no kit of its own, cannot publish until one is chosen. Takes effect at the next publish. Returns { brandKit } for the kit chosen, or null when the choice was removed.",
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  input: z
    .object({
      brandKitId: id('brand kit').nullable().describe('The kit to use, or null to remove the choice'),
      screenId: id('screen').optional(),
      groupId: id('group').optional(),
    })
    .refine((v) => (v.screenId === undefined) !== (v.groupId === undefined), 'give exactly one of screenId and groupId'),
  output: z.object({ brandKit: brandKitOutput.nullable() }),
  example: { brandKitId: 'bk_example', screenId: 'scr_example' },
  target: (input) => (input.screenId ? { kind: 'screen', id: input.screenId } : { kind: 'group', id: input.groupId! }),
  handler: async ({ org, input, write }) => {
    const kit = input.brandKitId === null ? undefined : await requireKit(org, input.brandKitId);
    const target = input.screenId ? ({ target: 'screen', screenId: input.screenId } as const) : ({ target: 'group', groupId: input.groupId! } as const);
    if (target.target === 'screen' && !(await org.screens.get(target.screenId))) throw notFound('screen', target.screenId);
    if (target.target === 'group' && !(await org.screenGroups.get(target.groupId))) throw notFound('group', target.groupId);
    write(await org.brandKits.assignments.stage.set(target, kit?.id ?? null));
    if (!kit) return { brandKit: null };
    const pending: Pending = target.target === 'screen' ? { screen: [target.screenId, kit.id] } : { group: [target.groupId, kit.id] };
    return { brandKit: kitView(kit, await brandContext(org, pending)) };
  },
});

export const brandTools = [listFonts, listBrandKits, getBrandKit, createBrandKit, updateBrandKit, setDefaultBrandKit, assignBrandKit];
