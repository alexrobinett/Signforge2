/**
 * The publish tools' outputs as the CMS reads them (`publish`, `get_publish`, `list_publishes` in
 * packages/tools, the source of truth), and a rollout in words: which screens wait, and why
 * (docs/research/cms-ux.md, ideas 5 and 6).
 */

/** A publish as `list_publishes` and `get_publish` return it. */
export interface PublishView {
  id: string;
  revision: number;
  /** For a roll back: the publish whose screens it put back. */
  restoresId: string | null;
  by: { kind: string; id: string; name: string | null };
  createdAt: number;
  finishedAt: number | null;
  screens: number;
  playing: number;
  replaced: number;
}

export type Outcome = 'playing' | 'downloading' | 'asleep' | 'offline' | 'waiting' | 'fell_back' | 'revoked' | 'replaced';

/** One screen of a publish's rollout. */
export interface RolloutScreen {
  screenId: string;
  name: string;
  outcome: Outcome;
  filesMissing: number | null;
  wakesAt: string | null;
  lastSeenAt: number | null;
}

/** `get_publish`'s answer: null when the org has never published. */
export interface PublishDetail {
  publish: PublishView | null;
  screens: RolloutScreen[];
}

/** What `publish` and `roll_back_publish` made, as the store's actions read it. */
export interface Made {
  id: string;
  revision: number;
  screens: number;
  previousId: string | null;
}

export interface PublishResult {
  publish: Made | null;
  held: { kind: string; id: string; problems: string[] }[];
  screens: { screenId: string; outcome: 'updated' | 'unchanged' | 'failed'; problems: string[] }[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isMade = (v: unknown): v is Made => isRecord(v) && typeof v.id === 'string' && typeof v.revision === 'number' && typeof v.screens === 'number';

/** The publish a `publish` or `roll_back_publish` call made, or null when it changed nothing. */
export function madeOf(output: unknown): Made | null {
  if (isRecord(output) && (output.publish === null || isMade(output.publish))) return output.publish;
  throw new Error('SignForge answered without the publish. Reload the page to see it.');
}

/** A `publish` call's answer, read past the publish it made: drafts held back and screens that could not be compiled. */
export function publishResultOf(output: unknown): PublishResult {
  const publish = madeOf(output);
  const list = (key: string) => (isRecord(output) && Array.isArray(output[key]) ? output[key].filter(isRecord) : []);
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    publish,
    held: list('held').map((h) => ({ kind: String(h.kind), id: String(h.id), problems: strings(h.problems) })),
    screens: list('screens').map((s) => ({
      screenId: String(s.screenId),
      outcome: s.outcome === 'updated' || s.outcome === 'unchanged' ? s.outcome : 'failed',
      problems: strings(s.problems),
    })),
  };
}

/** How a past publish's rollout stands, in a few words. */
export function standing(p: PublishView): string {
  if (!p.screens) return 'no screens';
  if (p.finishedAt) return 'complete';
  if (p.replaced === p.screens) return 'moved on';
  return `${p.playing} of ${p.screens}`;
}

/** A publish's name as people say it. */
export const versionName = (p: { revision: number }) => `v${p.revision}`;

/** Who made a publish, in words. */
export const byWord = (p: PublishView) => p.by.name || (p.by.kind === 'agent' ? 'an agent' : p.by.kind === 'system' ? p.by.id : 'a member');

const ORDER: Outcome[] = ['playing', 'waiting', 'downloading', 'asleep', 'offline', 'fell_back', 'revoked', 'replaced'];

/** Each outcome's mark on the bar: the chart tokens, and the one red for a screen that needs a person. */
export const OUTCOME_COLOR: Record<Outcome, string> = {
  playing: 'var(--chart-1)',
  waiting: 'var(--chart-5)',
  downloading: 'var(--chart-2)',
  asleep: 'var(--chart-3)',
  offline: 'var(--chart-4)',
  fell_back: 'var(--status-needs-you)',
  revoked: 'var(--status-needs-you)',
  replaced: 'var(--border-strong)',
};

/** One part of a rollout: the screens in one state, what it is in a few words, and why they wait. */
export interface Segment {
  outcome: Outcome;
  count: number;
  label: string;
  why: string;
  names: string[];
}

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** A rollout grouped by where each screen stands, in the bar's order, with reasons. */
export function segments(publish: Pick<PublishView, 'revision'>, screens: readonly RolloutScreen[], now: number): Segment[] {
  const v = versionName(publish);
  return ORDER.flatMap((outcome) => {
    const these = screens.filter((s) => s.outcome === outcome);
    if (!these.length) return [];
    const n = these.length;
    const names = these.map((s) => s.name);
    const base = { outcome, count: n, names };
    switch (outcome) {
      case 'playing':
        return [{ ...base, label: `playing ${v}`, why: 'They say they are playing it.' }];
      case 'waiting':
        return [{ ...base, label: 'switching now', why: 'Online: each takes it as it hears of it, in a few seconds.' }];
      case 'downloading': {
        const files = these.reduce((sum, s) => sum + (s.filesMissing ?? 0), 0);
        return [{ ...base, label: 'downloading', why: `${files} ${files === 1 ? 'file' : 'files'} still to fetch, then they switch.` }];
      }
      case 'asleep': {
        const wakes = these.flatMap((s) => (s.wakesAt ? [Date.parse(s.wakesAt)] : [])).sort((a, b) => a - b)[0];
        return [{ ...base, label: wakes ? `asleep, update at ${time(wakes)}` : 'asleep', why: 'Outside their display hours. They take it when they wake.' }];
      }
      case 'offline': {
        const since = these.flatMap((s) => (s.lastSeenAt ? [s.lastSeenAt] : [])).sort((a, b) => a - b)[0];
        const unheard = since ? `Unreachable for ${agoWords(now - since)}` : 'Never heard from';
        return [{ ...base, label: 'offline, update when back', why: `${unheard}, playing what they have from their cache.` }];
      }
      case 'fell_back':
        return [{ ...base, label: 'went back to their last good version', why: `${v} played nothing on them. Open each screen to see why.` }];
      case 'revoked':
        return [{ ...base, label: 'revoked', why: 'Their credential was revoked: pair them again to play anything new.' }];
      case 'replaced':
        return [{ ...base, label: 'moved on', why: 'A later publish switched them since.' }];
    }
  });
}

function agoWords(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

/** The bar's words for a screen reader: how many play it, then each other part. */
export const rolloutLabel = (publish: Pick<PublishView, 'revision'>, segs: readonly Segment[], total: number) =>
  `Rollout of ${versionName(publish)}: ${segs.map((s) => `${s.count} ${s.label}`).join(', ')}, of ${total} screens`;
