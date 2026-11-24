/**
 * The approvals queue (#115, canvas board AgentApprovals): publish requests waiting for someone who
 * may publish, each with what approving it would do now (`check_publish_request`) and, for the spots
 * it pins, the version screens have beside the draft it would publish.
 */
import type { ToolOutput } from '@signforge/tools/outputs';
import type { SpotView } from '~/lib/spots';

export type RequestCheck = ToolOutput<'check_publish_request'>;
export type RequestView = RequestCheck['request'];

/** A pinned spot's stage: what screens have now (null: never published) and the draft approving publishes. */
export interface SpotStage {
  now: SpotView | null;
  after: SpotView;
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

/** Who asked, as the card says it: an agent by its client's name, or a member by theirs. */
export function askerWords(r: RequestView): string {
  const { kind, name } = r.requestedBy;
  return kind === 'agent' ? `${name ?? 'An agent no longer connected'}, agent via MCP` : `${name ?? 'A former member'}, member`;
}

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
