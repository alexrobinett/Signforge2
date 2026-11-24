/**
 * An agent's proposal in the spot and playlist editors (M4-11, #116, canvas board IdeaAgentDraft): who
 * proposed the draft and when, from the audit log (none once the log no longer has it); what it changes
 * against the published version, field by field, Was and Now; Keep and Reject (src/state/proposals.ts);
 * and the draft's audit log strip. Shown while the draft is an agent's, or a Reject set one aside.
 */
import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { SparklesIcon } from 'lucide-react';
import { useId } from 'react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { ACTIONS, auditTime, whoText } from '~/lib/audit';
import { useNow } from '~/lib/live';
import { ago } from '~/lib/screen-status';
import { cn } from '~/lib/utils';
import { proposalQuery } from '~/queries/proposals';
import { useAppStore } from '~/state/provider';

const app = getRouteApi('/_app');

type Change = { field: string; in: 'data' | 'assets' | 'bindings' | null; was?: unknown; now?: unknown };

/** The spot's or playlist's own fields, by the names `get_agent_draft` gives them. */
const OWN: Record<string, string> = {
  name: 'Name',
  durationMs: 'Duration',
  url: 'Web address',
  assetId: 'Image or video',
  fit: 'Fit',
  transition: 'Transition',
  items: 'Spots, in play order',
};

/** A value as a person reads it: text quoted, a duration in seconds, a play order by name, the rest said plainly. */
function valueWords(c: Change, value: unknown, spotNames: ReadonlyMap<string, string>): string {
  if (value === null || value === undefined || value === '') return 'Nothing';
  if (c.field === 'durationMs' && typeof value === 'number') return `${value / 1000} s`;
  if (c.field === 'items' && Array.isArray(value)) return value.map((id) => spotNames.get(String(id)) ?? 'A spot no longer there').join(', ') || 'No spots';
  if (c.field === 'transition' && typeof value === 'string') {
    const t: unknown = JSON.parse(value);
    if (t && typeof t === 'object' && 'type' in t) return 'ms' in t ? `${String(t.type)}, ${Number(t.ms) / 1000} s` : String(t.type);
  }
  if (c.in === 'bindings') return 'From a data source';
  if (c.in === 'assets') return 'An image';
  if (typeof value === 'string') return `“${value.length > 120 ? `${value.slice(0, 120)}…` : value}”`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length === 1 ? '1 row' : `${value.length} rows`;
  return 'Set';
}

export function ProposalPanel({
  orgId,
  kind,
  id,
  version,
  fieldLabels = {},
  spotNames = new Map(),
  unsaved,
  canDecide,
}: {
  orgId: string;
  kind: 'spot' | 'playlist';
  id: string;
  version: number;
  /** A template spot's fields, by key: what each is called on the form. */
  fieldLabels?: Readonly<Record<string, string>>;
  /** For a playlist's play order: its spots by name. */
  spotNames?: ReadonlyMap<string, string>;
  /** The editor holds an edit not saved yet: its save ends the proposal, so neither Keep nor Reject is offered. */
  unsaved: boolean;
  /** The member may change drafts. */
  canDecide: boolean;
}) {
  const read = useQuery(proposalQuery(orgId, kind, id, version));
  const me = app.useLoaderData().user.id;
  const pending = useAppStore((s) => s.proposals.pending === `${kind}:${id}`);
  const reject = useAppStore((s) => s.rejectProposal);
  const keep = useAppStore((s) => s.keepProposal);
  const headingId = useId();
  const now = useNow(read.data?.at ?? 0);
  const proposal = read.data;
  if (!proposal || (!proposal.draft.proposed && !proposal.draft.rejected)) return null;
  const { draft, entries, timezone } = proposal;
  const names = new Map(Object.entries(proposal.names));
  const { by } = draft;
  const what = kind === 'spot' ? 'spot' : 'playlist';
  const label = (c: Change) => (c.in ? (fieldLabels[c.field] ?? c.field) : (OWN[c.field] ?? c.field));
  const busy = pending || unsaved;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4 border-b bg-card px-4 py-4 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id={headingId} className="flex flex-wrap items-center gap-2 text-base font-semibold">
            <Badge variant="agent">
              <SparklesIcon aria-hidden className="size-3" />
              {draft.proposed ? "Agent's draft" : 'Rejected'}
            </Badge>
            <span>
              Draft {draft.version}
              {draft.proposed && by && (
                <>
                  {' · Proposed by '}
                  <bdi className="[overflow-wrap:anywhere]">{by.name ?? 'an agent'}</bdi>
                  {by.kind === 'mcp' ? ', via MCP' : ', from the agent drawer'}
                  {now - by.at < 60_000 ? ' · just now' : ` · ${ago(now - by.at)} ago`}
                </>
              )}
            </span>
          </h2>
          <p className="text-sm text-muted-foreground">
            {draft.proposed
              ? `Agents can draft; publishing needs a person who may publish. Reject puts back the draft it wrote over, and can be undone.`
              : `The agent's draft is kept beside this one: Put it back to make it the draft again.`}
          </p>
        </div>
        {canDecide && (
          <div className="flex flex-wrap gap-2">
            {draft.proposed ? (
              <>
                {/* Not disabled while it runs: focus would leave it (README, React rules). */}
                <Button
                  variant="outline"
                  aria-disabled={busy}
                  className={cn(busy && 'opacity-60')}
                  onClick={() => !busy && void reject(orgId, kind, id, draft.version)}
                >
                  Reject
                </Button>
                <Button aria-disabled={busy} className={cn(busy && 'opacity-60')} onClick={() => !busy && void keep(orgId, kind, id, draft.version)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                aria-disabled={busy}
                className={cn(busy && 'opacity-60')}
                onClick={() => !busy && void reject(orgId, kind, id, draft.version)}
              >
                Put the agent's draft back
              </Button>
            )}
          </div>
        )}
      </div>
      {unsaved && canDecide && <p className="text-sm">Your edit ends the agent's proposal once it saves: the draft is yours then.</p>}
      {draft.proposed &&
        (draft.publishedVersion === null ? (
          <p className="text-sm">This {what} was never published: every field is new.</p>
        ) : draft.changes.length ? (
          <div className="overflow-x-auto">
            <table className="w-full max-w-3xl text-sm">
              <caption className="mb-2 text-left font-semibold">
                {draft.changes.length === 1 ? '1 change' : `${draft.changes.length} changes`} against the published version
              </caption>
              {/* On a phone each change stacks: its field, then Was and Now side by side, each named. */}
              <thead className="max-sm:sr-only">
                <tr className="text-left text-meta text-muted-foreground">
                  <th scope="col" className="py-1 pr-4 font-medium">
                    Field
                  </th>
                  <th scope="col" className="py-1 pr-4 font-medium">
                    Was
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Now
                  </th>
                </tr>
              </thead>
              <tbody>
                {draft.changes.map((c) => (
                  <tr key={`${c.in}:${c.field}`} className="border-t align-top max-sm:grid max-sm:grid-cols-2 max-sm:gap-x-4 max-sm:py-1.5">
                    <th scope="row" className="py-1.5 pr-4 text-left font-medium max-sm:col-span-2 max-sm:py-0.5">
                      {label(c)}
                    </th>
                    <td className="py-1.5 pr-4 text-muted-foreground max-sm:py-0.5">
                      <span aria-hidden className="block text-meta sm:hidden">
                        Was
                      </span>
                      <del className="[overflow-wrap:anywhere]">{valueWords(c, c.was, spotNames)}</del>
                    </td>
                    <td className="py-1.5 max-sm:py-0.5">
                      <span aria-hidden className="block text-meta text-muted-foreground sm:hidden">
                        Now
                      </span>
                      <ins className="font-medium no-underline [overflow-wrap:anywhere]">{valueWords(c, c.now, spotNames)}</ins>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm">It is as published: nothing changes.</p>
        ))}
      {entries.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-sm font-semibold">Audit log for this {what}</h3>
          <ol className="flex flex-col gap-1 text-sm">
            {entries.map((e) => (
              <li key={`${e.at}-${e.action}-${e.actor.id}`} className="flex flex-wrap gap-x-3">
                <span className="text-muted-foreground tabular-nums">{auditTime(e.at, timezone, now)}</span>
                <bdi className="font-medium [overflow-wrap:anywhere]">
                  {/* The proposing agent by the name its chip gives it, not its client's id. */}
                  {e.actor.kind === 'agent' && by?.kind === 'mcp' && e.actor.id === by.id && by.name ? `${by.name}, agent` : whoText(e, names, me)}
                </bdi>
                <span>{ACTIONS[e.action]?.words ?? e.action.replaceAll('_', ' ')}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
