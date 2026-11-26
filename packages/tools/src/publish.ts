/**
 * Publishing (docs/backend-plan.md#publishing): drafts to screens, a publish's rollout, and
 * rolling screens back to an earlier publish.
 *
 * `publish` promotes drafts and compiles every screen (`publishOrg`), stores each changed
 * manifest in R2, then commits in one batch: the promotions and the publish's place in order,
 * the publish's row and rollout rows, and each changed screen's switch. A screen whose manifest
 * did not change is not touched. The dispatcher runs it one call at a time per org, and again
 * from a fresh read when it loses a race (`publishes` on the tool). Screens are told after the
 * commit, through the notifier's `manifests` (the API: a queue, 50 screens a message). The same
 * batch deletes the weather sources the spot editor made that no spot binds any more.
 *
 * `takeover` ends a takeover, deleting it and publishing that alone, the same way, in one batch.
 *
 * `publish_manifest_to_screen` points one screen at a manifest `sf push` uploaded.
 */
import type { ScreenManifest } from '@signforge/contract';
import { published, rollbackOpen, STORAGE_GRACE_MS, type OrgScope, type ScheduleEntryRow, type StoredManifest } from '@signforge/db';
import { z } from 'zod';
import { clearOfSweep } from './assets';
import { madeBySpotEditor } from './data-sources';
import { sha256Hex } from './dispatch';
import { id } from './fields';
import { parseHeartbeat } from './heartbeat';
import { defaultConflict } from './playlists';
import { keysetPage, pageInput } from './paging';
import { publishOrg, type DraftKind, type DraftPin, type SampleAck } from './publishing';
import { AIMED, aimed, entryView, missingAim, takeoverFields, takeoverOf } from './schedule';
import { manifestKey } from './r2';
import { outcomeOf, tally } from './rollout';
import { screenState } from './screen-state';
import { stateInput } from './screens';
import { unreachableAfterMs } from './settings';
import { defineTool, isAgent, notFound, ToolError, type Actor, type ToolContext } from './tool';
import { draftRef, outputs, publishChanges, type publishOutput, type ToolOutput } from './outputs';

const SHA256 = /^[0-9a-f]{64}$/;

const publishManifestToScreen = defineTool({
  name: 'publish_manifest_to_screen',
  description:
    "Make a manifest already uploaded for a screen its desired manifest, so the screen switches to it at once (over its socket, or at its next sync if that is down). The manifest it replaces stays available to the screen while it switches. Use it to publish what `sf push` uploaded or to roll back to the screen's previousManifestId. Publishing the current manifest again changes nothing. Returns { screenId, manifestId, changed }.",
  scope: 'content:publish',
  minRole: 'editor',
  mutates: true,
  // A developer's path (`sf push`, /admin), which act as the system: no agent pushes a raw manifest (#345).
  people: true,
  input: z.object({
    screenId: id('screen'),
    manifestId: z.string().regex(SHA256, 'not a manifest id (64 lowercase hex characters)').describe("The manifest's id, the SHA-256 in its `id` field"),
  }),
  output: outputs.publish_manifest_to_screen,
  example: { screenId: 'scr_example', manifestId: '0'.repeat(64) },
  target: (input) => ({ kind: 'screen', id: input.screenId }),
  handler: async ({ org, blobs, input, write, notify }) => {
    const screen = await org.screens.get(input.screenId);
    if (!screen) throw notFound('screen', input.screenId);
    // Seen stored from now, so never one the storage sweep deletes before this commits (#235).
    const since = Date.now();
    const at = { screenId: screen.id, manifestId: input.manifestId };
    await manifestsNotSwept(org, [at], since);
    // A manifest is stored only once every file it lists is in R2 (the /admin upload checks), so
    // a stored manifest is one the screen can fetch completely. The key is under this org alone.
    const stored = await blobs.get(manifestKey(org.orgId, screen.id, input.manifestId));
    if (!stored) {
      throw new ToolError('not_found', `manifest ${input.manifestId} has not been uploaded for screen ${screen.id}`);
    }
    const changed = screen.desiredManifestId !== input.manifestId;
    if (changed) {
      // Checked as /admin stored it. Its files are fenced against the storage sweep and indexed with the switch, so the
      // sweep keeps them from the commit on (#235, review of #429, round 2).
      const files = Object.keys((await stored.json<Pick<ScreenManifest, 'files'>>()).files);
      await clearOfSweep(org, write, files);
      // A file the sweep deleted since the push checked it was there (#432): refused, from a read and at the commit.
      const now = Date.now();
      const deleted = await org.storage.deleted(files, now);
      if (deleted.length) throw new ToolError('conflict', 'the storage clean-up deleted files this manifest names: push again to upload them', { deleted });
      write({ row: undefined, writes: org.storage.stage.notDeleted(files, now) });
      write(org.storage.stage.index([{ screenId: screen.id, id: input.manifestId, files }], Date.now()));
      write({ row: undefined, writes: org.storage.stage.manifestsStored([at], since, since) });
      write(org.screens.stage.setDesiredManifest(screen.id, input.manifestId));
      // The screen's socket carries it at once; its next sync would anyway.
      notify((screens) => screens.manifest(screen.id, input.manifestId));
    }
    return { screenId: screen.id, manifestId: input.manifestId, changed };
  },
});

/**
 * Refuses a writer while the storage sweep is deleting a manifest it is about to store again or point screens at
 * (#235): claimed at `since`, or deleted at or after it, `since` being before the writer stores them.
 */
async function manifestsNotSwept(org: OrgScope, stored: readonly StoredManifest[], since: number) {
  if ((await org.storage.manifestsGone(stored, since, since)).length)
    throw new ToolError('conflict', 'the storage clean-up is deleting an earlier copy of this content: try again in a few minutes');
}

/** How long a source the spot editor made is kept unbound: its autosave binds it a second or so later, longer while the draft cannot be saved. */
const SOURCE_GRACE_MS = 15 * 60_000;

/** The data source ids a spot's stored bindings (`bindings_json`) name. */
function sourcesIn(json: string | null | undefined): string[] {
  if (!json) return [];
  // Written by the spot tools, from the contract's `Binding`s.
  const bindings: Record<string, { source: string }> = JSON.parse(json);
  return Object.values(bindings).map((b) => b.source);
}

/**
 * Stage a publish's record and its screens' switches, and queue telling the screens: the part of
 * a publish and a roll back that is the same. The caller has staged the move of the revision.
 */
async function switchScreens(
  ctx: Pick<ToolContext<unknown>, 'org' | 'actor' | 'write' | 'notify'>,
  revision: number,
  rows: { screenId: string; manifestId: string }[],
  restoresId?: string,
  changes?: PublishView['changes'],
) {
  const { org, actor, write, notify } = ctx;
  const [previous] = await org.publishes.history({ limit: 1 });
  const changesJson = changes ? JSON.stringify(changes) : null;
  const made = write(org.publishes.stage.insert({ status: 'published', actorKind: actor.kind, actorId: actor.id, revision, restoresId, changesJson }));
  write(org.publishes.stage.addScreens(made.id, rows));
  for (const r of rows) write(org.screens.stage.setDesiredManifest(r.screenId, r.manifestId));
  if (rows.length) notify((screens) => screens.manifests(rows));
  return { id: made.id, revision, screens: rows.length, previousId: previous?.id ?? null };
}

/** What a publish is held to, each checked against what it compiled and guarded in its batch. */
interface HeldTo {
  /** An approved request's: nothing removed that it does not pin. */
  exact?: boolean;
  /** The brand state (`brandKits.state`) the manifests must be compiled with. */
  brand?: string;
  /** The default playlist the manifests must be compiled with; null: none. */
  ifDefault?: string | null;
  /** The screens it must switch, exactly, by id. */
  screens?: readonly string[];
}

/**
 * A publish: promote the chosen drafts (all with `drafts` undefined), delete the `end` entries,
 * compile every screen, store and switch the changed ones. `publish`, `takeover`, and an
 * approved request. `held`: what it may publish only while it is still so (`HeldTo`), each held to
 * the commit. `added`: entries staged before this in the call's batch (`takeover`'s publish).
 */
export async function runPublish(
  ctx: ToolContext<unknown>,
  drafts: readonly DraftPin[] | undefined,
  end: readonly string[] = [],
  held: HeldTo = {},
  allowSample: readonly SampleAck[] = [],
  added: readonly ScheduleEntryRow[] = [],
): Promise<ToolOutput<'publish'>> {
  const { org, blobs, write } = ctx;
  const { brand, ifDefault, screens: switching } = held;
  const result = await publishOrg(org, { hash: sha256Hex, now: new Date() }, drafts, end, held.exact ?? false, allowSample, added);
  // The brand kits as compiled, not as read again: a kit changed and changed back while it compiled
  // would pass a second read, and its batch then guards the very rows the manifests were made from.
  if (brand !== undefined && result.brand !== brand)
    throw new ToolError('conflict', 'the brand kits have changed since this was asked for, and would go live with it: ask again', { brand: true });
  // `ifDefault` against the default as compiled, not as read before: one switched and switched back
  // while it compiled would pass a check made first, and its manifests fall back to the other.
  const moved = ifDefault === undefined ? undefined : defaultConflict(result.read.defaultPlaylist, ifDefault);
  if (moved) throw moved;
  const switches = result.screens.flatMap((s) => (s.manifest && s.manifest.id !== s.current ? [s.screenId] : [])).sort();
  if (switching !== undefined && switches.join(',') !== [...switching].sort().join(','))
    throw new ToolError('conflict', 'the screens this publish would switch have changed since they were shown: ask again', { screens: switches });
  // The brand state's, the default's and the screens' guards go with the batch whether or not anything else is written.
  write({ row: undefined, writes: result.keptCleared });
  if (brand !== undefined) write(org.brandKits.stage.unchanged(result.brand));
  if (ifDefault !== undefined) write(org.settings.stage.defaultIs(ifDefault));
  // The screens as compiled: one added or deleted before the batch fails it, and the publish runs again from a fresh read.
  if (switching !== undefined) write(org.screens.stage.are(result.read.screens.map((s) => s.id)));
  const screens = result.screens.map((s) => ({
    screenId: s.screenId,
    outcome: !s.manifest ? ('failed' as const) : s.manifest.id === s.current ? ('unchanged' as const) : ('updated' as const),
    problems: s.problems,
  }));
  const report = { promoted: result.drafts.promoted, held: result.drafts.held, removed: result.drafts.removed, madeDefault: result.madeDefault, screens };
  const changed = result.screens.flatMap((s) => (s.manifest && s.manifest.id !== s.current ? [s.manifest] : []));
  // Stored again below: refused while the storage sweep deletes one of them, or if it deleted one after now (#235).
  const since = Date.now();
  const stored = changed.map((m) => ({ screenId: m.screen.id, manifestId: m.id }));
  await manifestsNotSwept(org, stored, since);
  // Deleted entries go in the same batch as the switches; on their own they make no publish.
  write({ row: undefined, writes: result.removals });
  // The guards of pins live as they are go only beside a write: an approval's decision, or this publish's own. A plain
  // publish of pins that changes nothing writes nothing, no audit row either (#396).
  const pinGuards = { row: undefined, writes: result.pinGuards };
  if (!result.drafts.promoted.length && !changed.length) {
    if (held.exact || result.removals.length || result.keptCleared.length) write(pinGuards);
    return { publish: null, ...report, removedDataSources: [] };
  }
  write({ row: undefined, writes: result.writes });
  // After the revision's guard, which `result.writes` opens with: a batch lost to another publish is told by the first
  // read of its guards, not after every pin's (#396).
  write(pinGuards);
  // What the manifests it stores name, for the storage sweep to keep (#235), and held to the commit: a file of an asset
  // deleted while this compiled refuses the batch, and the publish runs again from a fresh read (review of #429).
  const files = [...new Set(changed.flatMap((m) => Object.keys(m.files)))];
  write({ row: undefined, writes: org.storage.stage.filesLive(files) });
  write({ row: undefined, writes: org.storage.stage.manifestsStored(stored, since, since) });
  write(
    org.storage.stage.index(
      changed.map((m) => ({ screenId: m.screen.id, id: m.id, files: Object.keys(m.files) })),
      Date.now(),
    ),
  );
  // The spot editor's weather sources nothing binds: not as drafted, not as published once this
  // commits, and not as published before it, which Undo sends screens back to (that one goes at
  // the next publish). One made in the last minutes may be about to be bound by an autosave.
  const bound = new Set([...result.read.spots, ...result.graph.spots].flatMap((s) => [s.bindingsJson, published(s)?.bindingsJson].flatMap(sourcesIn)));
  const madeBefore = Date.now() - SOURCE_GRACE_MS;
  const removedDataSources = (await org.dataSources.list())
    .filter((d) => madeBySpotEditor(d.id) && !bound.has(d.id) && d.createdAt < madeBefore)
    .map((d) => d.id)
    .sort();
  write(org.dataSources.stage.deleteUnbound(removedDataSources, madeBefore));
  // What it made live and removed (#370), named as screens have them after it: a draft made live by its draft, which
  // becomes the published one; a schedule entry by its playlist as published after this publish (its draft only when
  // this publish makes that live too); one removed by what was published, as it played.
  const spots = new Map(result.read.spots.map((s) => [s.id, s]));
  const playlists = new Map(result.read.playlists.map((p) => [p.id, p]));
  const entries = new Map(result.read.entries.map((e) => [e.id, e]));
  const promotedPlaylists = new Set(result.drafts.promoted.flatMap((d) => (d.kind === 'playlist' ? [d.id] : [])));
  // Every draft it reports is one this publish read. `live`: the name screens have, not the draft's.
  const playlistName = (id: string, live: boolean) => {
    const p = playlists.get(id);
    if (!p) return '';
    return (live ? published(p)?.name : undefined) ?? p.name;
  };
  const nameOf = (d: { kind: DraftKind; id: string }, removed: boolean) => {
    if (d.kind === 'spot') return spots.get(d.id)?.name ?? '';
    if (d.kind === 'playlist') return playlistName(d.id, false);
    const e = entries.get(d.id);
    if (!e) return '';
    const playlistId = (removed ? published(e)?.playlistId : undefined) ?? e.playlistId;
    return playlistName(playlistId, removed || !promotedPlaylists.has(playlistId));
  };
  const changes = summarizeChanges([
    ...result.drafts.promoted.map((d) => ({ kind: d.kind, name: nameOf(d, false), removed: false })),
    ...result.drafts.removed.map((d) => ({ kind: d.kind, name: nameOf(d, true), removed: true })),
  ]);
  const made = await switchScreens(
    ctx,
    result.revision + 1,
    changed.map((m) => ({ screenId: m.screen.id, manifestId: m.id })),
    undefined,
    changes,
  );
  // Stored before the switch commits, so a screen told of a manifest can fetch it. Keyed by
  // content: one stored by a publish that then lost its commit is the same object again.
  await Promise.all(
    changed.map((m) => blobs.put(manifestKey(org.orgId, m.screen.id, m.id), JSON.stringify(m), { httpMetadata: { contentType: 'application/json' } })),
  );
  return { publish: made, ...report, removedDataSources };
}

/**
 * `allowSample` (#360), which only a person may pass: an agent passing it is refused, never quietly
 * ignored. A person's press of the agent drawer's confirmation card that listed exactly these
 * acknowledgements (`confirmed`, #351) is theirs, though the drawer sends it.
 */
export function peopleAllowSample(ctx: { actor: Actor; confirmed: boolean; input: { allowSample?: SampleAck[] } }): SampleAck[] {
  const acks = ctx.input.allowSample ?? [];
  if (acks.length && isAgent(ctx.actor) && !ctx.confirmed) throw new ToolError('forbidden', 'only a person may publish sample text anyway (allowSample)');
  return acks;
}

/** `allowSample`'s input: the spots a `sample_text` refusal named, as it named them. */
export const sampleAcks = z
  .array(
    z.object({
      spotId: id('spot'),
      version: z.number().int().positive().describe('The version the refusal named'),
      fields: z.array(z.string().max(100)).max(200).describe('The fields the refusal named'),
    }),
  )
  .max(500);

const publish = defineTool({
  name: 'publish',
  description:
    'Publish to screens: promote drafts that pass their checks, compile every screen, and switch each screen whose content changed; the rest are not touched. Without drafts, every changed draft in the organization is published. With drafts, only those, each pinned at the version given: refused with a conflict, details { id, version }, if one has changed since. With drafts: [], no draft, but every screen is compiled again: what a deleted schedule entry or a new default playlist needs. A draft that fails its checks keeps its published version and is listed in held with why; a screen that cannot be compiled keeps what it plays and is listed with its problems. Nothing reaches a screen until the organization has a default playlist: when it has none and the regular schedule entries this publish makes live on every screen at all hours all play one playlist, that playlist becomes the default (madeDefault); a takeover or a narrower entry never sets it, so set one with set_default_playlist first, or its screens get nothing. Deleted schedule entries go with it (all of them, or the pinned ones), and takeovers that have ended, which play nowhere again: listed in removed. With drafts, a pinned draft that needs no promotion is still checked: one changed since fails the publish as a conflict. A spot it would promote that still holds the sample text of its template (its sampleFields) refuses the whole publish with sample_text, before any screen is compiled, details { spots: [{ id, name, version, fields }] }: replace the text, or a person publishes again with allowSample naming those spots, versions and fields. Returns { publish, promoted, held, removed, madeDefault, screens }; publish is null when no draft was promoted and no screen changed. Undo with roll_back_publish.',
  scope: 'content:publish',
  minRole: 'editor',
  mutates: true,
  partialAgents: 'only a person publishes sample text anyway (allowSample)',
  publishes: true,
  input: z.object({
    ifDefault: id('playlist')
      .nullable()
      .optional()
      .describe(
        "Publish only while this playlist is the organization's default (null: while it has none): for drafts pinned because they are the default (it and its spots). Refused with a conflict, details { defaultPlaylistId }, otherwise, checked again as it commits",
      ),
    ifBrand: z
      .string()
      .max(200_000)
      .optional()
      .describe(
        "Publish only while the brand kits and their assignments are as they were shown: their state as the agent drawer's publish card read it. Refused with a conflict, details { brand: true }, otherwise, checked again as it commits",
      ),
    ifScreens: z
      .array(id('screen'))
      .max(5000)
      .optional()
      .describe(
        'Publish only if it switches exactly these screens, as they were shown. Refused with a conflict, details { screens }, the ones it would switch now, otherwise; a screen added or deleted before it commits makes it read again',
      ),
    drafts: z
      .array(draftRef.extend({ version: z.number().int().positive().describe('The version you chose it at') }))
      .max(500)
      .optional()
      .describe(
        'The drafts to publish, each at the version you chose it at; omit to publish every changed draft. An empty list publishes no draft and compiles every screen again: for a deleted schedule entry or a new default playlist',
      ),
    allowSample: sampleAcks
      .optional()
      .describe(
        'People only: the spots a sample_text refusal named, { spotId, version, fields } as it named them, once a person has seen them and chose to publish them anyway. It covers that version of each and those fields only: any other refuses again. Refused to an agent',
      ),
  }),
  output: outputs.publish,
  example: {},
  // Behind the drawer's card, a refused press has no output (`refusedPress`): no target then.
  target: (_input, output: { publish: { id: string } | null } | undefined) => (output?.publish ? { kind: 'publish', id: output.publish.id } : undefined),
  // The default it set is a change of the org's settings: its row says so.
  auditDetail: (output) => (output.madeDefault ? { madeDefault: output.madeDefault } : undefined),
  handler: async (ctx) => {
    const { input } = ctx;
    return runPublish(ctx, input.drafts, [], { ifDefault: input.ifDefault, brand: input.ifBrand, screens: input.ifScreens }, peopleAllowSample(ctx));
  },
});

/** What `takeover` takes to publish a new one, refused with `end`. */
const PUBLISH_ONLY = ['playlistId', 'target', 'groupId', 'screenId', 'startsAt', 'endsAt', 'with'] as const;

const takeover = defineTool({
  name: 'takeover',
  description:
    'Take over screens now, or end a takeover now, in one step sent whole or not at all; nothing else is published with it. action publish takes what start_takeover takes, makes the takeover and publishes it, with the drafts it needs in with, each at its version (its playlist and spots, if never published); one that cannot be published leaves no draft. action end, with scheduleEntryId, deletes a takeover and publishes that, so its screens drop it at once. Returns what publish returns, and for publish the takeover as entry.',
  scope: 'content:publish',
  minRole: 'editor',
  mutates: true,
  publishes: true,
  input: z
    .strictObject({
      action: z.enum(['publish', 'end']).describe('publish: make one and publish it; end: end one'),
      scheduleEntryId: id('schedule entry').optional().describe('end: the takeover'),
      playlistId: takeoverFields.playlistId.optional(),
      target: takeoverFields.target.optional(),
      groupId: takeoverFields.groupId,
      screenId: takeoverFields.screenId,
      startsAt: takeoverFields.startsAt,
      endsAt: takeoverFields.endsAt.optional(),
      with: z
        .array(draftRef.extend({ version: z.number().int().positive() }))
        .max(500)
        .optional()
        .describe('publish: drafts published with it, each at the version chosen: its playlist and spots, if never published'),
    })
    .superRefine((v, ctx) => {
      const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
      if (v.action === 'end') {
        if (v.scheduleEntryId === undefined) issue('scheduleEntryId', 'end needs the takeover: scheduleEntryId');
        for (const k of PUBLISH_ONLY) if (v[k] !== undefined) issue(k, `${k} is for publish: end takes scheduleEntryId alone`);
        return;
      }
      if (v.scheduleEntryId !== undefined) issue('scheduleEntryId', 'publish makes a new takeover: scheduleEntryId is for end');
      for (const k of ['playlistId', 'target', 'endsAt'] as const) if (v[k] === undefined) issue(k, `publish needs ${k}`);
      if (!aimed(v)) issue('target', AIMED);
    }),
  output: outputs.takeover,
  example: { action: 'publish', playlistId: 'pls_example', target: 'org', endsAt: '2026-11-17T20:00:00Z' },
  // A refused press has no output (`refusedPress`): no target then, for a new one.
  target: (input, output: { entry?: { id: string } } | undefined) => {
    const entryId = input.scheduleEntryId ?? output?.entry?.id;
    return entryId === undefined ? undefined : { kind: 'schedule_entry', id: entryId };
  },
  handler: async (ctx) => {
    const { org, input, write } = ctx;
    if (input.action === 'end') {
      // Given with end: the input refuses it otherwise.
      const entryId = input.scheduleEntryId!;
      const row = await org.scheduleEntries.get(entryId);
      if (!row || row.endsAt === null) throw notFound('takeover', entryId);
      return runPublish(ctx, [], [row.id]);
    }
    // Given with publish: the input refuses it otherwise.
    const fields = { ...input, playlistId: input.playlistId!, target: input.target!, endsAt: input.endsAt! };
    // The takeover staged first in the batch, then published with what it needs: the publish reads it as there.
    const made = write(await org.scheduleEntries.stage.insert(await takeoverOf(org, fields, Date.now())));
    const out = await runPublish(ctx, [{ kind: 'schedule_entry', id: made.id, version: made.rowVersion }, ...(input.with ?? [])], [], {}, [], [made]);
    // Held (its playlist not published, a check it fails): nothing is written, not even the draft.
    const held = out.held.find((h) => h.kind === 'schedule_entry' && h.id === made.id);
    if (held || !out.promoted.some((p) => p.kind === 'schedule_entry' && p.id === made.id))
      throw new ToolError('conflict', `the takeover cannot be published: ${held?.problems.join('; ') ?? 'it was not promoted'}`, { held: out.held });
    // As published in the same batch.
    return { ...out, entry: entryView(org.scheduleEntries.stage.publish(made).row) };
  },
  refuseFailedCommit: async ({ org, input }) => missingAim(org, input),
});

const rollBackPublish = defineTool({
  name: 'roll_back_publish',
  description:
    "Put screens back to what an earlier publish gave them: each screen goes back to the manifest it had right after that publish, with nothing compiled again. Screens no publish up to it reached keep what they play. Recorded as a new publish, which itself can be rolled back. Drafts and their published versions are not changed, so the next publish sends the current published content again. A publish keeps the data sources and assets the one before it used, so undoing the latest publish finds them all; a roll back further than that can reach a manifest whose data source or asset has since been deleted, and a screen then shows that spot's last values, then its fallback. To undo a publish, pass it as ifLatest: refused with a conflict if a later publish has been made since, which a roll back would undo too. A publish made more than 90 days ago is refused with a conflict (details { tooOld: true }): the storage clean-up keeps the files of the last 90 days' publishes, and no older. Returns { publish }, null when every screen already had it.",
  scope: 'content:publish',
  minRole: 'editor',
  mutates: true,
  publishes: true,
  input: z.object({
    publishId: id('publish').describe('The publish to go back to'),
    ifLatest: id('publish').optional().describe('For an undo: the publish being undone. Refused with a conflict unless it is still the latest'),
  }),
  output: outputs.roll_back_publish,
  example: { publishId: 'pub_example' },
  target: (input) => ({ kind: 'publish', id: input.publishId }),
  handler: async (ctx) => {
    const { org, input, write } = ctx;
    // The revision before the screens: a publish committed after this read fails the guard.
    const revision = (await org.settings.get())?.publishRevision ?? 0;
    const target = await org.publishes.get(input.publishId);
    if (!target) throw notFound('publish', input.publishId);
    // As far back as the storage sweep keeps every file and manifest, and no further (owner decision on #235).
    if (!rollbackOpen(target.createdAt, Date.now()))
      throw new ToolError(
        'conflict',
        `publish v${target.revision} was made more than 90 days ago: its files may no longer be stored, so it can no longer be rolled back to`,
        { tooOld: true },
      );
    if (input.ifLatest) {
      // Read after the revision: a publish made since fails the batch's guard, and the rerun lands here.
      const [latest] = await org.publishes.history({ limit: 1 });
      if (latest?.id !== input.ifLatest)
        throw new ToolError('conflict', `publish ${input.ifLatest} is no longer the latest: ${latest ? `v${latest.revision}` : 'another'} was made since`, {
          latestId: latest?.id ?? null,
        });
    }
    const [then, screens] = await Promise.all([org.publishes.asOf(target.revision), org.screens.list()]);
    const desired = new Map(screens.map((s) => [s.id, s.desiredManifestId]));
    const rows = then.filter((r) => desired.has(r.screenId) && desired.get(r.screenId) !== r.manifestId);
    if (!rows.length) return { publish: null };
    // Pointed at as they are stored: refused if the storage sweep has deleted or is deleting one (#235).
    const stored = rows.map((r) => ({ screenId: r.screenId, manifestId: r.manifestId }));
    const now = Date.now();
    if ((await org.storage.manifestsGone(stored, now, 0)).length)
      throw new ToolError('conflict', `publish v${target.revision}'s manifests are no longer stored, so it can no longer be rolled back to`, { tooOld: true });
    write({ row: undefined, writes: org.storage.stage.manifestsStored(stored, now, 0) });
    write(org.publishes.stage.advance(revision));
    return { publish: await switchScreens(ctx, revision + 1, rows, target.id) };
  },
});

type PublishView = z.output<typeof publishOutput>;

/** Names kept per kind, at most; then fewer while the whole is over `CHANGES_BYTES`. */
const CHANGES_NAMES = 10;
/** The most a publish's changes may take on its row, as JSON: D1 refuses a value over 2 MB, and the page shows a line. */
export const CHANGES_BYTES = 4096;

/**
 * What a publish changed, by kind (#370): exact counts, and the first names of each, each once, while the whole is
 * under `CHANGES_BYTES`. A publish of thousands of drafts with long names keeps its counts and a few of them.
 */
export function summarizeChanges(items: readonly { kind: DraftKind; name: string; removed: boolean }[]): z.output<typeof publishChanges> {
  const groups = (['spot', 'playlist', 'schedule_entry'] as const).flatMap((kind) =>
    [false, true].flatMap((removed) => {
      const these = items.filter((i) => i.kind === kind && i.removed === removed);
      if (!these.length) return [];
      const distinct = [...new Set(these.map((i) => i.name))];
      const names = distinct.slice(0, CHANGES_NAMES);
      return [{ kind, removed, count: these.length, names, omitted: distinct.length - names.length }];
    }),
  );
  const bytes = () => new TextEncoder().encode(JSON.stringify(groups)).length;
  while (bytes() > CHANGES_BYTES) {
    const longest = groups.reduce((a, b) => (b.names.length > a.names.length ? b : a));
    if (!longest.names.length) break;
    longest.names.pop();
    longest.omitted += 1;
  }
  return groups;
}

/** A publish's changes as its row keeps them: none when it has none, or when what is there is not that shape. */
function changesOf(json: string | null): PublishView['changes'] {
  if (json === null) return null;
  try {
    const read = publishChanges.safeParse(JSON.parse(json));
    return read.success ? read.data : null;
  } catch {
    return null;
  }
}

const publishView = (h: Awaited<ReturnType<OrgScope['publishes']['history']>>[number]): PublishView => {
  const { screens, playing, replaced, open } = tally(h.rollout);
  return {
    id: h.id,
    revision: h.revision,
    restoresId: h.restoresId,
    restoresRevision: h.restoresRevision,
    by: { kind: h.actorKind, id: h.actorId, name: h.actorName },
    createdAt: h.createdAt,
    rollBackUntil: h.createdAt + STORAGE_GRACE_MS,
    finishedAt: h.finishedAt,
    reached: h.reached,
    screens,
    playing,
    replaced,
    open,
    changes: changesOf(h.changesJson),
  };
};

const listPublishes = defineTool({
  name: 'list_publishes',
  description:
    "List the organization's publishes, newest first, a page at a time: who made each, when, and how its rollout stands. Returns { publishes: Publish[], next }; pass next as cursor for the following page.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ ...pageInput }),
  output: outputs.list_publishes,
  example: {},
  handler: async ({ org, input }) => {
    const { rows, next } = await keysetPage(
      input,
      (after, take) => org.publishes.history({ beforeRevision: after === undefined ? undefined : Number(after[0]), limit: take }),
      (p) => [p.revision],
    );
    return { publishes: rows.map(publishView), next };
  },
});

const getPublish = defineTool({
  name: 'get_publish',
  description:
    "Get one publish, or the latest without publishId, with its rollout: each screen it switched, and where it stands (describe(publish)'s rules say what each state means). Returns { publish, screens }, or { publish: null } if there has been no publish.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ publishId: id('publish').optional().describe('Omit for the latest publish') }),
  output: outputs.get_publish,
  example: {},
  handler: async ({ org, input }) => {
    let beforeRevision: number | undefined;
    if (input.publishId) {
      const asked = await org.publishes.get(input.publishId);
      if (!asked) throw notFound('publish', input.publishId);
      // The history from this publish down: its first row is this one, with its rollout counts.
      beforeRevision = asked.revision + 1;
    }
    const [found] = await org.publishes.history({ limit: 1, beforeRevision });
    if (!found) return { publish: null, screens: [] };
    const [rows, afterMs] = await Promise.all([org.publishes.rollout(found.id), unreachableAfterMs(org)]);
    const now = Date.now();
    const screens = rows.map((r) => {
      const state = screenState(stateInput(r, r.revoked, parseHeartbeat(r.heartbeatJson), afterMs), now);
      const outcome = outcomeOf(r, state);
      return {
        screenId: r.id,
        name: r.name,
        manifestId: r.manifestId,
        outcome,
        filesMissing: outcome === 'downloading' ? state.filesMissing : null,
        wakesAt: outcome === 'asleep' ? state.wakesAt : null,
        lastSeenAt: r.lastSeenAt,
        state: state.kind,
      };
    });
    return { publish: publishView(found), screens };
  },
});

const countDrafts = defineTool({
  name: 'count_drafts',
  description:
    'Count the drafts with changes screens do not have yet, by kind: never published, or edited since (one put back as it was still counts). One count each, for a badge; list them with list_spots, list_playlists or list_schedule_entries and unpublished. Returns { spots, playlists, scheduleEntries }.',
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({}),
  output: outputs.count_drafts,
  example: {},
  handler: async ({ org }) => {
    const [spots, playlists, scheduleEntries] = await Promise.all([
      org.spots.countUnpublished(),
      org.playlists.countUnpublished(),
      org.scheduleEntries.countUnpublished(),
    ]);
    return { spots, playlists, scheduleEntries };
  },
});

export const publishTools = [publishManifestToScreen, publish, takeover, rollBackPublish, listPublishes, getPublish, countDrafts];
