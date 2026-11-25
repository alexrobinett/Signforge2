/**
 * The approvals queue (#115, canvas board AgentApprovals): publish requests waiting for someone who
 * may publish, each with what approving it would do now (`check_publish_request`) and, for the spots
 * it pins, the version screens have beside the draft it would publish.
 */
import type { ToolOutput } from '@signforge/tools/outputs';
import type { SpotView } from '~/lib/spots';

export type RequestCheck = ToolOutput<'check_publish_request'>;
export type RequestView = RequestCheck['request'];

/** A pinned spot's stage: what screens have now (null: never published), its draft, and the version the request pinned. */
export interface SpotStage {
  now: SpotView | null;
  after: SpotView;
  pinned: number;
}

export interface ApprovalItem {
  check: RequestCheck;
  stages: SpotStage[];
}

/** The most spots of one request played on the page: each is two players. */
export const MAX_STAGES = 3;

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Publish Soup board to Deli": its first draft by name, and how many more. */
export function requestTitle(check: RequestCheck): string {
  const [first, ...rest] = check.changes;
  const name = first ? (first.kind === 'schedule_entry' ? 'a schedule entry' : first.name) : 'drafts';
  return `Publish ${name}${rest.length ? ` and ${count(rest.length, 'more draft')}` : ''}`;
}

/**
 * Who asked, by name, as the card says it: an agent by its client's name, else "An agent" (a name a page
 * may not show, as `AgentName` withholds it) or, once it is disconnected, "An agent no longer connected";
 * a member by theirs, or "A former member".
 */
export function askerName(r: RequestView): string {
  const { kind, name, gone } = r.requestedBy;
  if (name !== null) return name;
  if (kind === 'user') return 'A former member';
  return gone ? 'An agent no longer connected' : 'An agent';
}

/**
 * The approval stage's second column, as its caption and its player's title say it: the pinned draft as approving would
 * publish it, or a draft changed since it was asked for, which approving would not publish (#411).
 */
export function afterStage({ after, pinned }: { after: Pick<SpotView, 'name' | 'version'>; pinned: number }): { caption: string; title: string } {
  return after.version === pinned
    ? { caption: `After approval · Draft ${after.version}`, title: `${after.name} as approving would publish it` }
    : {
        caption: `Draft ${after.version} · changed since it was asked for (Draft ${pinned})`,
        title: `${after.name} at Draft ${after.version}, changed since it was asked for (Draft ${pinned})`,
      };
}

/** What asked: "agent via MCP", or "member". */
export const askerKind = (r: RequestView) => (r.requestedBy.kind === 'agent' ? 'agent via MCP' : 'member');

/** "3 field changes in 2 spots · new playlist": what the pinned drafts change. */
export function changeWords(check: RequestCheck): string {
  const parts: string[] = [];
  const edited = check.changes.filter((c) => !c.fresh);
  const fields = edited.reduce((n, c) => n + c.fields.length, 0);
  if (edited.length) parts.push(`${count(fields, 'field change')}${edited.length > 1 ? ` in ${count(edited.length, 'draft')}` : ''}`);
  for (const c of check.changes.filter((x) => x.fresh)) parts.push(`new ${c.kind === 'schedule_entry' ? 'schedule entry' : c.kind}`);
  return parts.join(' · ');
}

/** The screens it would switch, named: "3 screens: Deli, Deli counter, Deli queue". */
export function reachWords(check: RequestCheck): string {
  const { screens } = check;
  if (!screens.length) return 'changes no screen now';
  const names = screens.slice(0, 5).map((s) => s.name);
  return `${count(screens.length, 'screen')}: ${names.join(', ')}${screens.length > 5 ? ` and ${screens.length - 5} more` : ''}`;
}

/** A draft as the confirmation names it: "Spot Menu, version 7". */
export function pinWords(check: RequestCheck, pin: RequestView['drafts'][number]): string {
  const name = check.changes.find((c) => c.kind === pin.kind && c.id === pin.id)?.name ?? pin.id;
  const what = pin.kind === 'schedule_entry' ? 'Schedule entry' : `${pin.kind === 'spot' ? 'Spot' : 'Playlist'} ${name}`;
  return `${what}, version ${pin.version}`;
}
