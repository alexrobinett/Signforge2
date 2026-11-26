/**
 * The publish tools' outputs as the CMS reads them (`publish`, `get_publish`, `list_publishes` in
 * packages/tools, the source of truth), and a rollout in words: which screens wait, and why
 * (docs/research/cms-ux.md, ideas 5 and 6).
 */

import type { ToolOutput } from '@signforge/tools/outputs';

/** A publish as `list_publishes` and `get_publish` return it. */
export type PublishView = ToolOutput<'list_publishes'>['publishes'][number];

/** `get_publish`'s answer: its publish null when the org has never published. */
export type PublishDetail = ToolOutput<'get_publish'>;

/** One screen of a publish's rollout. */
export type RolloutScreen = PublishDetail['screens'][number];

type Outcome = RolloutScreen['outcome'];

/** How a past publish's rollout stands, in a few words. */
export function standing(p: PublishView): string {
  if (!p.screens) return 'reached no screen';
  // Finished: what it reached then, whatever later publishes did since.
  if (p.reached !== null) return p.reached === p.screens ? 'complete' : p.reached ? `played on ${p.reached} of ${p.screens}` : 'moved on';
  if (p.replaced === p.screens) return 'moved on';
  return `${p.playing} of ${p.screens}`;
}

/** Whether a rollout is over, as its page says "complete": it switched screens, and each plays it, was replaced or was revoked. */
export const rolloutComplete = (p: Pick<PublishView, 'screens' | 'open'>) => p.screens > 0 && p.open === 0;

/** One kind of what a publish changed, for the page to say (#370): the words around its names, which it shows, and how many more. */
export interface ChangePart {
  lead: string;
  names: readonly string[];
  more: number;
  tail: string;
}

/** Names shown at most per kind: the rest are counted. */
const SHOWN = 3;

/**
 * What a publish changed, kind by kind (#370): its spots and playlists made live, the playlists whose schedule
 * entries it made live, and those it took off the schedule; three names each at most, the rest counted.
 */
export function changeParts(changes: NonNullable<PublishView['changes']>): ChangePart[] {
  return changes.map((g) => {
    const names = g.names.slice(0, SHOWN);
    const more = g.omitted + g.names.length - names.length;
    const plural = g.count === 1 ? '' : 's';
    if (g.kind === 'spot') return { lead: `spot${plural}`, names, more, tail: '' };
    if (g.kind === 'playlist') return { lead: `playlist${plural}`, names, more, tail: '' };
    return g.removed ? { lead: 'took', names, more, tail: 'off the schedule' } : { lead: 'the schedule for', names, more, tail: '' };
  });
}

/** A publish's name as people say it. */
export const versionName = (p: { revision: number }) => `v${p.revision}`;

/** What a publish's screens play, in words: a roll back's is the earlier version, again. */
const playsWord = (p: Pick<PublishView, 'revision' | 'restoresRevision'>) =>
  p.restoresRevision === null ? versionName(p) : `${versionName({ revision: p.restoresRevision })} again`;

/** A publish's title: its version, and for a roll back where it went back to. */
const publishTitle = (p: Pick<PublishView, 'revision' | 'restoresRevision'>) =>
  p.restoresRevision === null ? versionName(p) : `${versionName(p)}: back to ${versionName({ revision: p.restoresRevision })}`;

/**
 * Who made a publish, in words: "you" for `me`'s own (#253). The API names a member with no name by
 * their address before the @, so "a member" is left for a user since deleted.
 */
export const byWord = (p: Pick<PublishView, 'by'>, me: string) =>
  p.by.kind === 'user' && p.by.id === me ? 'you' : p.by.name || (p.by.kind === 'agent' ? 'an agent' : p.by.kind === 'system' ? p.by.id : 'a member');

const ORDER: Outcome[] = ['playing', 'waiting', 'downloading', 'asleep', 'unreachable', 'fell_back', 'revoked', 'replaced'];

/**
 * An outcome this page does not know: the API's, deployed ahead of the CMS while the two differ, a word it has since
 * added or renamed (`offline` became `unreachable`, #532). Its screens are counted and said, not left out (#541).
 */
const UNKNOWN = 'unknown';
type Part = Outcome | typeof UNKNOWN;

/** The bar's parts, in order: each known outcome, then any this page does not know. */
export const PARTS: Part[] = [...ORDER, UNKNOWN];

/** Each outcome's mark on the bar: the chart tokens, and the one red for a screen that needs a person. */
export const OUTCOME_COLOR: Record<Part, string> = {
  unknown: 'var(--muted-foreground)',
  playing: 'var(--chart-1)',
  waiting: 'var(--chart-5)',
  downloading: 'var(--chart-2)',
  asleep: 'var(--chart-3)',
  unreachable: 'var(--chart-4)',
  fell_back: 'var(--status-needs-you)',
  revoked: 'var(--status-needs-you)',
  replaced: 'var(--border-strong)',
};

/** One part of a rollout: the screens in one state, what it is in a few words, and why they wait. */
export interface Segment {
  outcome: Part;
  count: number;
  label: string;
  why: string;
  names: string[];
}

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** A rollout grouped by where each screen stands, in the bar's order, with reasons. */
export function segments(publish: Pick<PublishView, 'revision' | 'restoresRevision'>, screens: readonly RolloutScreen[], now: number): Segment[] {
  const v = playsWord(publish);
  const known = new Set<string>(ORDER);
  const unknown = screens.filter((s) => !known.has(s.outcome));
  const others: Segment[] = unknown.length
    ? [
        {
          outcome: UNKNOWN,
          count: unknown.length,
          names: unknown.map((s) => s.name),
          label: 'in a state this page does not know',
          why: 'The server is newer than this page: reload it to see where they stand.',
        },
      ]
    : [];
  const parts = ORDER.flatMap((outcome): Segment[] => {
    const these = screens.filter((s) => s.outcome === outcome);
    if (!these.length) return [];
    const n = these.length;
    const names = these.map((s) => s.name);
    const base = { outcome, count: n, names };
    switch (outcome) {
      case 'playing':
        return [{ ...base, label: `playing ${v}`, why: 'Confirmed by their last check-in.' }];
      case 'waiting':
        return [{ ...base, label: 'switching now', why: 'Online: each takes it as it hears of it, in a few seconds.' }];
      case 'downloading': {
        const files = these.reduce((sum, s) => sum + (s.filesMissing ?? 0), 0);
        const left = files ? `${files} ${files === 1 ? 'file' : 'files'} still to fetch` : 'Fetching their files';
        return [{ ...base, label: 'downloading', why: `${left}, then they switch.` }];
      }
      case 'asleep': {
        const wakes = these.flatMap((s) => (s.wakesAt ? [Date.parse(s.wakesAt)] : [])).sort((a, b) => a - b)[0];
        return [{ ...base, label: wakes ? `asleep, update at ${time(wakes)}` : 'asleep', why: 'Outside their display hours. They take it when they wake.' }];
      }
      case 'unreachable': {
        const since = these.flatMap((s) => (s.lastSeenAt ? [s.lastSeenAt] : [])).sort((a, b) => a - b)[0];
        const unheard = since ? `Unreachable for ${agoWords(now - since)}` : 'Never heard from';
        return [{ ...base, label: 'unreachable, update when back', why: `${unheard}, playing what they have from their cache.` }];
      }
      case 'fell_back':
        return [{ ...base, label: 'went back to their last good version', why: `${v} played nothing on them. Open each screen to see why.` }];
      case 'revoked':
        return [{ ...base, label: 'revoked', why: 'Their credential was revoked: pair them again to play anything new.' }];
      case 'replaced':
        return [{ ...base, label: 'moved on', why: 'A later publish switched them since.' }];
    }
  });
  return [...parts, ...others];
}

function agoWords(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

/** The bar's words for a screen reader: how many play it, then each other part. */
export const rolloutLabel = (publish: Pick<PublishView, 'revision' | 'restoresRevision'>, segs: readonly Segment[], total: number) =>
  `Rollout of ${publishTitle(publish)}: ${segs.map((s) => `${s.count} ${s.label}`).join(', ')}, of ${total} screens`;
