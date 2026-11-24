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
 * `end_takeover` deletes a takeover and publishes that alone, the same way, in one batch.
 *
 * `publish_manifest_to_screen` points one screen at a manifest `sf push` uploaded.
 */
import { published, type OrgScope } from '@signforge/db';
import { z } from 'zod';
import { madeBySpotEditor } from './data-sources';
import { sha256Hex } from './dispatch';
import { id } from './fields';
import { parseHeartbeat } from './heartbeat';
import { keysetPage, pageInput } from './paging';
import { publishOrg, type DraftPin } from './publishing';
import { manifestKey } from './r2';
import { outcomeOf, tally } from './rollout';
import { screenState } from './screen-state';
import { stateInput } from './screens';
import { unreachableAfterMs } from './settings';
import { defineTool, notFound, ToolError, type ToolContext } from './tool';
import { draftRef, outputs, type publishOutput, type ToolOutput } from './outputs';

const SHA256 = /^[0-9a-f]{64}$/;

const publishManifestToScreen = defineTool({
  name: 'publish_manifest_to_screen',
  description:
    "Make a manifest already uploaded for a screen its desired manifest, so the screen switches to it at once (over its socket, or at its next sync if that is down). The manifest it replaces stays available to the screen while it switches. Use it to publish what `sf push` uploaded or to roll back to the screen's previousManifestId. Publishing the current manifest again changes nothing. Returns { screenId, manifestId, changed }.",
  scope: 'content:publish',
  minRole: 'editor',
  mutates: true,
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
    // A manifest is stored only once every file it lists is in R2 (the /admin upload checks), so
    // a stored manifest is one the screen can fetch completely. The key is under this org alone.
    if (!(await blobs.head(manifestKey(org.orgId, screen.id, input.manifestId)))) {
      throw new ToolError('not_found', `manifest ${input.manifestId} has not been uploaded for screen ${screen.id}`);
    }
    const changed = screen.desiredManifestId !== input.manifestId;
    if (changed) {
      write(org.screens.stage.setDesiredManifest(screen.id, input.manifestId));
      // The screen's socket carries it at once; its next sync would anyway.
      notify((screens) => screens.manifest(screen.id, input.manifestId));
    }
    return { screenId: screen.id, manifestId: input.manifestId, changed };
  },
});

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
) {
  const { org, actor, write, notify } = ctx;
  const [previous] = await org.publishes.history({ limit: 1 });
  const made = write(org.publishes.stage.insert({ status: 'published', actorKind: actor.kind, actorId: actor.id, revision, restoresId }));
  write(org.publishes.stage.addScreens(made.id, rows));
  for (const r of rows) write(org.screens.stage.setDesiredManifest(r.screenId, r.manifestId));
  if (rows.length) notify((screens) => screens.manifests(rows));
  return { id: made.id, revision, screens: rows.length, previousId: previous?.id ?? null };
}

/**
 * A publish: promote the chosen drafts (all with `drafts` undefined), delete the `end` entries,
 * compile every screen, store and switch the changed ones. `publish`, `end_takeover`, and an
 * approved request (`exact`: nothing removed that it does not pin; `brand`, the brand state it was
 * asked under, which the manifests must be compiled with, held to the commit).
 */
export async function runPublish(
  ctx: ToolContext<unknown>,
  drafts: readonly DraftPin[] | undefined,
  end: readonly string[] = [],
  approval?: { brand: string },
): Promise<ToolOutput<'publish'>> {
  const { org, blobs, write } = ctx;
  const result = await publishOrg(org, { hash: sha256Hex, now: new Date() }, drafts, end, approval !== undefined);
  // The brand kits as compiled, not as read again: a kit changed and changed back while it compiled
  // would pass a second read, and its batch then guards the very rows the manifests were made from.
  if (approval && result.brand !== approval.brand)
    throw new ToolError('conflict', 'the brand kits have changed since this was asked for, and would go live with it: ask again', { brand: true });
  // The pins' guards, and the brand state's, go with the batch whether or not anything else is written.
  write({ row: undefined, writes: result.pinGuards });
  if (approval) write(org.brandKits.stage.unchanged(result.brand));
  const screens = result.screens.map((s) => ({
    screenId: s.screenId,
    outcome: !s.manifest ? ('failed' as const) : s.manifest.id === s.current ? ('unchanged' as const) : ('updated' as const),
    problems: s.problems,
  }));
  const report = { promoted: result.drafts.promoted, held: result.drafts.held, removed: result.drafts.removed, madeDefault: result.madeDefault, screens };
  const changed = result.screens.flatMap((s) => (s.manifest && s.manifest.id !== s.current ? [s.manifest] : []));
  // Deleted entries go in the same batch as the switches; on their own they make no publish.
  write({ row: undefined, writes: result.removals });
  if (!result.drafts.promoted.length && !changed.length) return { publish: null, ...report, removedDataSources: [] };
  write({ row: undefined, writes: result.writes });
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
  const made = await switchScreens(
    ctx,
    result.revision + 1,
    changed.map((m) => ({ screenId: m.screen.id, manifestId: m.id })),
  );
  // Stored before the switch commits, so a screen told of a manifest can fetch it. Keyed by
  // content: one stored by a publish that then lost its commit is the same object again.
  await Promise.all(
    changed.map((m) => blobs.put(manifestKey(org.orgId, m.screen.id, m.id), JSON.stringify(m), { httpMetadata: { contentType: 'application/json' } })),
  );
  return { publish: made, ...report, removedDataSources };
}

const publish = defineTool({
  name: 'publish',
  description:
    'Publish to screens: promote drafts that pass their checks, compile every screen, and switch each screen whose content changed; the rest are not touched. Without drafts, every changed draft in the organization is published. With drafts, only those, each pinned at the version given: refused with a conflict, details { id, version }, if one has changed since. With drafts: [], no draft, but every screen is compiled again: what a deleted schedule entry or a new default playlist needs. A draft that fails its checks keeps its published version and is listed in held with why; a screen that cannot be compiled keeps what it plays and is listed with its problems. Nothing reaches a screen until the organization has a default playlist: when it has none and the regular schedule entries this publish makes live on every screen at all hours all play one playlist, that playlist becomes the default (madeDefault); a takeover or a narrower entry never sets it, so set one with set_default_playlist first, or its screens get nothing. Deleted schedule entries go with it (all of them, or the pinned ones), and takeovers that have ended, which play nowhere again: listed in removed. With drafts, a pinned draft that needs no promotion is still checked: one changed since fails the publish as a conflict. Returns { publish, promoted, held, removed, madeDefault, screens }; publish is null when no draft was promoted and no screen changed. Undo with roll_back_publish.',
  scope: 'content:publish',
  minRole: 'editor',
  mutates: true,
  publishes: true,
  input: z.object({
    ifDefault: id('playlist')
      .optional()
      .describe(
        "Publish only while this playlist is the organization's default: for drafts pinned because they are the default (it and its spots). Refused with a conflict, details { defaultPlaylistId }, otherwise, checked again as it commits",
      ),
    drafts: z
      .array(draftRef.extend({ version: z.number().int().positive().describe('The version you chose it at') }))
      .max(500)
      .optional()
      .describe(
        'The drafts to publish, each at the version you chose it at; omit to publish every changed draft. An empty list publishes no draft and compiles every screen again: for a deleted schedule entry or a new default playlist',
      ),
  }),
  output: outputs.publish,
  example: {},
  target: (_input, output) => (output.publish ? { kind: 'publish', id: output.publish.id } : undefined),
  // The default it set is a change of the org's settings: its row says so.
  auditDetail: (output) => (output.madeDefault ? { madeDefault: output.madeDefault } : undefined),
  handler: async (ctx) => {
    const { org, input, write } = ctx;
    if (input.ifDefault !== undefined) {
      const now = (await org.settings.get())?.defaultPlaylistId ?? null;
      if (now !== input.ifDefault)
        throw new ToolError('conflict', now ? `the default playlist is now ${now}` : 'the organization has no default playlist now', {
          defaultPlaylistId: now,
        });
    }
    const out = await runPublish(ctx, input.drafts);
    // As the batch runs too, with the pins' guards: a default switched meanwhile fails it.
    if (input.ifDefault !== undefined) write(org.settings.stage.defaultIs(input.ifDefault));
    return out;
  },
});

const endTakeover = defineTool({
  name: 'end_takeover',
  description:
    'End a takeover now: delete it and publish that alone, in one step, so its screens drop it at once (a screen ends the spot on screen when the winning takeover changes) and nothing is left half done. No draft is published with it. Returns what publish returns; publish is null if the takeover was never published.',
  scope: 'content:publish',
  minRole: 'editor',
  mutates: true,
  publishes: true,
  input: z.object({ scheduleEntryId: id('schedule entry').describe('The takeover') }),
  output: outputs.end_takeover,
  example: { scheduleEntryId: 'sch_example' },
  target: (input) => ({ kind: 'schedule_entry', id: input.scheduleEntryId }),
  handler: async (ctx) => {
    const row = await ctx.org.scheduleEntries.get(ctx.input.scheduleEntryId);
    if (!row || row.endsAt === null) throw notFound('takeover', ctx.input.scheduleEntryId);
    return runPublish(ctx, [], [row.id]);
  },
});

const rollBackPublish = defineTool({
  name: 'roll_back_publish',
  description:
    "Put screens back to what an earlier publish gave them: each screen goes back to the manifest it had right after that publish, with nothing compiled again. Screens no publish up to it reached keep what they play. Recorded as a new publish, which itself can be rolled back. Drafts and their published versions are not changed, so the next publish sends the current published content again. A publish keeps the data sources and assets the one before it used, so undoing the latest publish finds them all; a roll back further than that can reach a manifest whose data source or asset has since been deleted, and a screen then shows that spot's last values, then its fallback. To undo a publish, pass it as ifLatest: refused with a conflict if a later publish has been made since, which a roll back would undo too. Returns { publish }, null when every screen already had it.",
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
    write(org.publishes.stage.advance(revision));
    return { publish: await switchScreens(ctx, revision + 1, rows, target.id) };
  },
});

type PublishView = z.output<typeof publishOutput>;

const publishView = (h: Awaited<ReturnType<OrgScope['publishes']['history']>>[number]): PublishView => {
  const { screens, playing, replaced, open } = tally(h.rollout);
  return {
    id: h.id,
    revision: h.revision,
    restoresId: h.restoresId,
    restoresRevision: h.restoresRevision,
    by: { kind: h.actorKind, id: h.actorId, name: h.actorName },
    createdAt: h.createdAt,
    finishedAt: h.finishedAt,
    reached: h.reached,
    screens,
    playing,
    replaced,
    open,
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
    'Get one publish, or the latest without publishId, with its rollout: each screen it switched, and where it stands. playing: it says it plays it. downloading: it is fetching the new files (filesMissing). asleep: outside its display hours until wakesAt; it takes it when it wakes. offline: not heard from since lastSeenAt; it plays what it has from its cache and takes it when back. waiting: online, and switching now. fell_back: the new manifest played nothing, so it went back to its last good one. revoked: its credential was revoked. replaced: a later publish switched it since. Returns { publish, screens }, or { publish: null } if there has been no publish.',
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
      };
    });
    return { publish: publishView(found), screens };
  },
});

export const publishTools = [publishManifestToScreen, publish, endTakeover, rollBackPublish, listPublishes, getPublish];
