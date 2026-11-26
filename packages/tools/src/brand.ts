/**
 * Brand tools: the font catalogue, an org's brand kits, its default kit, and which kit a group or
 * screen uses. Nothing here changes a screen: a kit is frozen into each manifest at publish, so
 * an edit reaches screens with the next publish. Each kit view says which screens that will be
 * (`reach`), and which screens cannot get a kit because their groups disagree (`conflicts`).
 */
import { brandWarnings, chooseBrandKit, FONTS, fontById, HEX_COLOR, onColor } from '@signforge/compiler';
import { unverified } from '@signforge/compiler/draft';
import type { BrandColors } from '@signforge/contract';
import type { BrandAssignment, BrandKitRow, OrgScope } from '@signforge/db';
import { z } from 'zod';
import { id, idempotencyKey, ifVersion, name } from './fields';
import { page, pageInput } from './paging';
import { defineTool, invalidFields, notFound, ToolError } from './tool';
import { brandShape, outputs, type BrandKitView } from './outputs';

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
const colorsPatch = z
  .object({
    primary: hex.optional().describe('Filled buttons and badges'),
    accent: hex.optional().describe('Highlights, tags, the crawl label'),
    background: hex.optional().describe('The page'),
    surface: hex.optional().describe('Cards and rows on the page'),
    text: hex.optional().describe('Body text'),
    muted: hex.optional().describe('Secondary text'),
    onPrimary: hex.nullable().optional().describe('Text on primary. Leave out, or null, to derive it for 4.5:1 contrast'),
    onAccent: hex.nullable().optional().describe('Text on accent. Leave out, or null, to derive it for 4.5:1 contrast'),
  })
  .describe("The kit colours: a new kit's six, or those to change, the rest staying");

const fontId = (role: string) =>
  z
    .string()
    .refine((v) => fontById(v) !== undefined, 'not a font in the catalogue; see list_fonts')
    .describe(`The ${role} font's catalogue id, such as base/inter. See list_fonts`);
// ------------------------------------------------------------------ views

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
  const problem = a.kind !== 'image' || !['image/png', 'image/svg+xml'].includes(a.type) ? 'a logo must be an SVG or PNG image' : unverified(assetId, a.status);
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
  output: outputs.list_fonts,
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
  output: outputs.list_brand_kits,
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
  output: outputs.get_brand_kit,
  example: { brandKitId: 'bk_example' },
  handler: async ({ org, input }) => ({ brandKit: kitView(await requireKit(org, input.brandKitId), await brandContext(org)) }),
});

/** The colours a new kit must give; onPrimary and onAccent are derived when left out. */
const BASE_COLORS = ['primary', 'accent', 'background', 'surface', 'text', 'muted'] as const;

const saveBrandKit = defineTool({
  name: 'save_brand_kit',
  description:
    "Create a brand kit, or change one. Without brandKitId it creates one: a name, colours as hex (primary, accent, background, surface, text and muted), a shape (default soft), optional display and body fonts from read, and an optional logo (an SVG or PNG image asset); pass an idempotencyKey so a retry cannot create it twice. With brandKitId it changes what you give (null derives onPrimary or onAccent again, takes the template's font, or removes a logo); pass the version you read as ifVersion so a change made since is not overwritten. makeDefault makes it the organization's default. describe(brand_kit) has the rules: derived colours, the default, when screens get it. Returns { brandKit }.",
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  idempotent: true,
  // Strict, as every save is: a field it does not take is refused by name, not dropped (review of #499).
  input: z.strictObject({
    brandKitId: id('brand kit').optional().describe('The kit to change; omit to create one'),
    name: name('brand kit').optional(),
    colors: colorsPatch.optional(),
    shape: brandShape.optional(),
    displayFontId: fontId('display').nullable().optional(),
    bodyFontId: fontId('body').nullable().optional(),
    logoOnDarkAssetId: logoFields.logoOnDarkAssetId.nullable().optional(),
    logoOnLightAssetId: logoFields.logoOnLightAssetId.nullable().optional(),
    makeDefault: z.boolean().optional().describe("True makes it the organization's default kit"),
    ifVersion,
    idempotencyKey,
  }),
  output: outputs.save_brand_kit,
  example: {
    name: 'House style',
    colors: { primary: '#1d4ed8', accent: '#f59e0b', background: '#0b0f17', surface: '#1a2130', text: '#f5f7fa', muted: '#a3acbb' },
    displayFontId: 'base/oswald',
    bodyFontId: 'base/inter',
  },
  // The audit log's Made the default follows this, the outcome, not the input's makeDefault (#507).
  auditDetail: (output) => (output.madeDefault ? { madeDefault: true } : undefined),
  target: (input, output) => ({ kind: 'brand_kit', id: input.brandKitId ?? output.brandKit.id }),
  handler: async ({ org, input, write }) => {
    await checkLogo(org, input.logoOnDarkAssetId, 'logoOnDarkAssetId');
    await checkLogo(org, input.logoOnLightAssetId, 'logoOnLightAssetId');
    const lightOnly = (dark: string | null | undefined, light: string | null | undefined) =>
      light && !dark ? invalidFields('a light logo needs a dark one', 'logoOnDarkAssetId') : undefined;
    if (input.brandKitId === undefined) {
      if (input.ifVersion !== undefined) throw invalidFields('a new brand kit has no version yet: ifVersion is for a change', 'ifVersion');
      const { name, colors } = input;
      const missing = BASE_COLORS.filter((k) => colors?.[k] === undefined);
      if (name === undefined || missing.length)
        throw invalidFields(
          `a new brand kit needs a name and the colours ${BASE_COLORS.join(', ')}${missing.length ? ` (missing ${missing.join(', ')})` : ''}; give brandKitId to change one`,
          ...(name === undefined ? ['name'] : []),
          ...missing.map((k) => `colors.${k}`),
        );
      const refused = lightOnly(input.logoOnDarkAssetId, input.logoOnLightAssetId);
      if (refused) throw refused;
      const kit = write(
        await org.brandKits.stage.insert({
          name,
          // Null derives a text colour, as leaving it out does.
          colorsJson: JSON.stringify(Object.fromEntries(Object.entries(colors ?? {}).filter(([, v]) => v !== null && v !== undefined))),
          shape: input.shape ?? 'soft',
          displayFontId: input.displayFontId ?? null,
          bodyFontId: input.bodyFontId ?? null,
          logoOnDarkAssetId: input.logoOnDarkAssetId ?? null,
          logoOnLightAssetId: input.logoOnLightAssetId ?? null,
        }),
      );
      const isFirst = (await org.brandKits.assignments.list()).every((a) => a.target !== 'org');
      if (!(input.makeDefault || isFirst)) return { brandKit: kitView(kit, await brandContext(org)), madeDefault: false };
      // Staged after the kit's insert, so the kit row exists when the batch reaches this one.
      write(await org.brandKits.assignments.stage.set({ target: 'org' }, kit.id, { newKit: true }));
      return { brandKit: kitView(kit, await brandContext(org, { defaultKit: kit.id })), madeDefault: true };
    }
    const kit = await requireKit(org, input.brandKitId);
    let colorsJson: string | undefined;
    if (input.colors) {
      const next: Record<string, string | undefined> = { ...(JSON.parse(kit.colorsJson) as StoredColors) };
      for (const [k, v] of Object.entries(input.colors)) if (v !== undefined) next[k] = v ?? undefined;
      colorsJson = JSON.stringify(next);
    }
    const refused = lightOnly(
      input.logoOnDarkAssetId === undefined ? kit.logoOnDarkAssetId : input.logoOnDarkAssetId,
      input.logoOnLightAssetId === undefined ? kit.logoOnLightAssetId : input.logoOnLightAssetId,
    );
    if (refused) throw refused;
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
    // Made the default only by a save that changes it: not one of the kit that is the default already.
    const wasDefault = (await org.brandKits.assignments.list()).some((a) => a.target === 'org' && a.brandKitId === kit.id);
    if (!input.makeDefault || wasDefault) return { brandKit: kitView(row, await brandContext(org)), madeDefault: false };
    write(await org.brandKits.assignments.stage.set({ target: 'org' }, kit.id));
    return { brandKit: kitView(row, await brandContext(org, { defaultKit: kit.id })), madeDefault: true };
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
  output: outputs.assign_brand_kit,
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

export const brandTools = [listFonts, listBrandKits, getBrandKit, saveBrandKit, assignBrandKit];
