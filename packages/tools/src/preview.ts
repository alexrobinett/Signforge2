/**
 * `preview_publish` (#187): what pressing Publish would do, worked out as the publish works it out (`dryPublish`, the
 * dry run the agent drawer's publish card and the approvals queue use) and written nowhere. It names each screen whose
 * manifest would change and why: a group it would join or leave since the last publish (its record of whom each group
 * reached, `publishes.targets_json`), or a draft going live that reaches it. Smart groups make membership move with
 * labels, so a label edit shows here before it reaches any screen.
 */
import { reaches, targetIdOf, type ScheduleScreen } from '@signforge/compiler/schedule';
import { published } from '@signforge/db';
import { sha256Hex } from './dispatch';
import { outputs } from './outputs';
import { dryPublish, groupMoves, readTargets, type OrgGraph } from './publishing';
import { defineTool } from './tool';
import { inputs } from './inputs';

/** A graph's published schedule and playlists, each parsed once (review of #620): what a screen plays, by entry and playlist. */
function publishedOf(graph: OrgGraph) {
  const entries = new Map(
    graph.entries.flatMap((e) => {
      const pub = published(e);
      if (!pub) return [];
      const targetId = targetIdOf(pub);
      return [[e.id, { playlistId: pub.playlistId, aim: { target: pub.target, ...(targetId === undefined ? {} : { targetId }) } }] as const];
    }),
  );
  const items = new Map(graph.playlists.map((p) => [p.id, published(p)?.items ?? []]));
  /** The playlists a screen with these groups plays: the default and every entry's that reaches it. */
  const playlistsOn = (screen: ScheduleScreen) =>
    new Set([graph.defaultPlaylist ?? '', ...[...entries.values()].flatMap((e) => (reaches(e.aim, screen) ? [e.playlistId] : []))]);
  return { entries, items, playlistsOn };
}

export const previewPublish = defineTool({
  name: 'preview_publish',
  description:
    'What publishing every changed draft would do, without publishing: the screens whose content would change and why (a group joined or left since the last publish, a draft going live that reaches it), and how each group would change. For people: an agent sees the same on its publish card. Returns { screens, unchanged, failed, groups, samples }.',
  scope: 'content:read',
  minRole: 'editor',
  mutates: false,
  // The CMS's Publish button and label editors; an agent's publish card already shows what a publish switches (#351).
  people: true,
  input: inputs.preview_publish,
  output: outputs.preview_publish,
  example: {},
  handler: async ({ org }) => {
    const [{ result, samples }, last] = await Promise.all([dryPublish(org, { hash: sha256Hex, now: new Date() }), org.publishes.lastTargets()]);
    const { read, graph, drafts } = result;
    const before = last === null ? null : readTargets(last);
    const groupName = new Map([...(before ?? []).map((g) => [g.groupId, g.name] as const), ...graph.groups.map((g) => [g.id, g.name] as const)]);
    const was = new Map<string, string[]>();
    for (const g of before ?? []) for (const id of g.screenIds) was.set(id, [...(was.get(id) ?? []), g.groupId]);
    const names = new Map(read.screens.map((s) => [s.id, s.name]));
    const playlistNames = new Map([...read.playlists, ...graph.playlists].map((p) => [p.id, published(p)?.name ?? p.name]));
    const spotNames = new Map(read.spots.map((x) => [x.id, x.name]));
    const then = publishedOf(read);
    const after = publishedOf(graph);
    const changed = result.screens.filter((s) => s.manifest && s.manifest.id !== s.current);
    const screens = changed.map(({ screenId, current }) => {
      const now = graph.groupsOf.get(screenId) ?? [];
      const had = was.get(screenId) ?? [];
      const reasons: string[] = [];
      // A screen paired since the last publish gets its first manifest: that is the news, not a draft (review of #620).
      if (current === null) reasons.push('first publish to this screen');
      if (before !== null) {
        for (const g of now) if (!had.includes(g)) reasons.push(`joined ${groupName.get(g) ?? g}`);
        for (const g of had) if (!now.includes(g)) reasons.push(`left ${groupName.get(g) ?? g}`);
      }
      // A draft reaches the screen if it did before this publish or will after it, by either membership.
      const screen = { id: screenId, groups: [...new Set([...now, ...had])] };
      const playlists = new Set([...then.playlistsOn(screen), ...after.playlistsOn(screen)]);
      const spots = new Set([...playlists].flatMap((p) => [...(then.items.get(p) ?? []), ...(after.items.get(p) ?? [])]));
      const reaching = (e: { aim: Parameters<typeof reaches>[0] } | undefined) => e !== undefined && reaches(e.aim, screen);
      for (const d of drafts.removed) {
        const e = then.entries.get(d.id);
        if (e && reaching(e)) reasons.push(`entry ${playlistNames.get(e.playlistId) ?? e.playlistId} removed`);
      }
      for (const d of drafts.promoted) {
        if (d.kind === 'schedule_entry') {
          const old = then.entries.get(d.id);
          const next = after.entries.get(d.id);
          const playlist = next?.playlistId ?? old?.playlistId ?? '';
          if (reaching(old) || reaching(next)) reasons.push(`entry ${playlistNames.get(playlist) ?? playlist} ${old ? 'changed' : 'added'}`);
        }
        if (d.kind === 'playlist' && playlists.has(d.id)) reasons.push(`playlist ${playlistNames.get(d.id) ?? d.id} changed`);
        if (d.kind === 'spot' && spots.has(d.id)) reasons.push(`spot ${spotNames.get(d.id) ?? d.id} changed`);
      }
      if (result.madeDefault) reasons.push(`default playlist ${result.madeDefault.name}`);
      // Nothing above, yet its manifest changes: a brand kit, a template, data or its settings.
      if (!reasons.length) reasons.push('compiled again: a brand kit, template, data source or its settings changed');
      return { screenId, name: names.get(screenId) ?? screenId, reasons };
    });
    // Joins and leaves of the screens it would change only: a publish that changes nothing records nothing anew, so a
    // move no screen plays differently would otherwise show in every later preview (review of #620).
    const groups = before === null ? [] : groupMoves(before, graph, new Set(changed.map((s) => s.screenId)));
    return {
      screens: screens.toSorted((a, b) => a.name.localeCompare(b.name) || (a.screenId < b.screenId ? -1 : 1)),
      unchanged: result.screens.filter((s) => s.manifest && s.manifest.id === s.current).length,
      failed: result.screens.flatMap((s) => (s.manifest ? [] : [{ screenId: s.screenId, name: names.get(s.screenId) ?? s.screenId, problems: s.problems }])),
      groups,
      samples: samples.map((x) => ({ spotId: x.id, name: x.name, fields: x.fields })),
    };
  },
});
