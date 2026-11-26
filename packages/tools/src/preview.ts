/**
 * `preview_publish` (#187): what pressing Publish would do, worked out as the publish works it out (`dryPublish`, the
 * dry run the agent drawer's publish card and the approvals queue use) and written nowhere. It names each screen whose
 * manifest would change and why: a group it would join or leave since the last publish (its record of whom each group
 * reached, `publishes.targets_json`), or a draft going live that reaches it. Smart groups make membership move with
 * labels, so a label edit shows here before it reaches any screen.
 */
import { reaches, targetIdOf } from '@signforge/compiler/schedule';
import { published, type ScheduleEntryRow } from '@signforge/db';
import { z } from 'zod';
import { sha256Hex } from './dispatch';
import { outputs } from './outputs';
import { dryPublish, readTargets, type OrgGraph } from './publishing';
import { defineTool } from './tool';

/** Whom an entry, as published in a graph, reaches: a screen with these groups. */
const reachesScreen = (e: ScheduleEntryRow | undefined, screenId: string, groups: readonly string[]) => {
  const pub = e && published(e);
  if (!pub) return false;
  const targetId = targetIdOf(pub);
  return reaches({ target: pub.target, ...(targetId === undefined ? {} : { targetId }) }, { id: screenId, groups: [...groups] });
};

/** The playlists a screen plays in a graph, as published: the default and every entry's that reaches it. */
const playlistsOn = (graph: OrgGraph, screenId: string, groups: readonly string[]) =>
  new Set([graph.defaultPlaylist ?? '', ...graph.entries.flatMap((e) => (reachesScreen(e, screenId, groups) ? [published(e)!.playlistId] : []))]);

/** The spots the playlists hold, as published in a graph. */
const spotsIn = (graph: OrgGraph, playlists: ReadonlySet<string>) =>
  new Set(graph.playlists.flatMap((p) => (playlists.has(p.id) ? (published(p)?.items ?? []) : [])));

export const previewPublish = defineTool({
  name: 'preview_publish',
  description:
    'What publishing every changed draft would do, without publishing: the screens whose content would change and why (a group joined or left since the last publish, a draft going live that reaches it), and how each group would change. For people: an agent sees the same on its publish card. Returns { screens, unchanged, failed, groups, samples }.',
  scope: 'content:read',
  minRole: 'editor',
  mutates: false,
  // The CMS's Publish button and label editors; an agent's publish card already shows what a publish switches (#351).
  people: true,
  input: z.object({}),
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
    const playlistName = (id: string) => {
      const p = graph.playlists.find((x) => x.id === id) ?? read.playlists.find((x) => x.id === id);
      return (p && (published(p)?.name ?? p.name)) || id;
    };
    const spotName = (id: string) => read.spots.find((x) => x.id === id)?.name ?? id;
    const changed = result.screens.filter((s) => s.manifest && s.manifest.id !== s.current);
    const screens = changed.map(({ screenId }) => {
      const now = graph.groupsOf.get(screenId) ?? [];
      const then = was.get(screenId) ?? [];
      const reasons: string[] = [];
      if (before !== null) {
        for (const g of now) if (!then.includes(g)) reasons.push(`joined ${groupName.get(g) ?? g}`);
        for (const g of then) if (!now.includes(g)) reasons.push(`left ${groupName.get(g) ?? g}`);
      }
      // A draft reaches the screen if it did before this publish or will after it, by either membership.
      const groups = [...new Set([...now, ...then])];
      const playlists = new Set([...playlistsOn(read, screenId, groups), ...playlistsOn(graph, screenId, groups)]);
      const spots = new Set([...spotsIn(read, playlists), ...spotsIn(graph, playlists)]);
      for (const d of drafts.removed) {
        const e = read.entries.find((x) => x.id === d.id);
        if (reachesScreen(e, screenId, groups)) reasons.push(`entry ${playlistName(published(e!)!.playlistId)} removed`);
      }
      for (const d of drafts.promoted) {
        if (d.kind === 'schedule_entry') {
          const old = read.entries.find((x) => x.id === d.id);
          const after = graph.entries.find((x) => x.id === d.id);
          if (reachesScreen(old, screenId, groups) || reachesScreen(after, screenId, groups)) {
            const playlist = (after && published(after)?.playlistId) ?? (old && published(old)?.playlistId) ?? '';
            reasons.push(`entry ${playlistName(playlist)} ${old && published(old) ? 'changed' : 'added'}`);
          }
        }
        if (d.kind === 'playlist' && playlists.has(d.id)) reasons.push(`playlist ${playlistName(d.id)} changed`);
        if (d.kind === 'spot' && spots.has(d.id)) reasons.push(`spot ${spotName(d.id)} changed`);
      }
      if (result.madeDefault) reasons.push(`default playlist ${result.madeDefault.name}`);
      // Nothing above, yet its manifest changes: a brand kit, a template, data or its settings.
      if (!reasons.length) reasons.push('compiled again: a brand kit, template, data source or its settings changed');
      return { screenId, name: names.get(screenId) ?? screenId, reasons };
    });
    // Each group's membership against the last publish's record, who would join and who would leave; a group deleted
    // since is left by all it had. With no record yet (no publish since #187) nothing is compared.
    const ids = [...new Set([...graph.groups.map((g) => g.id), ...(before ?? []).map((g) => g.groupId)])];
    const groups =
      before === null
        ? []
        : ids.flatMap((id) => {
            const members = [...graph.groupsOf].flatMap(([screen, gs]) => (gs.includes(id) ? [screen] : [])).toSorted();
            const had = before.find((x) => x.groupId === id)?.screenIds ?? [];
            const joined = members.filter((x) => !had.includes(x));
            const left = had.filter((x) => !members.includes(x));
            return joined.length || left.length ? [{ groupId: id, name: groupName.get(id) ?? id, joined, left }] : [];
          });
    return {
      screens: screens.toSorted((a, b) => a.name.localeCompare(b.name) || (a.screenId < b.screenId ? -1 : 1)),
      unchanged: result.screens.filter((s) => s.manifest && s.manifest.id === s.current).length,
      failed: result.screens.flatMap((s) => (s.manifest ? [] : [{ screenId: s.screenId, name: names.get(s.screenId) ?? s.screenId, problems: s.problems }])),
      groups,
      samples: samples.map((x) => ({ spotId: x.id, name: x.name, fields: x.fields })),
    };
  },
});
