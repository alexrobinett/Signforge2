/**
 * Audit log (canvas board SettingsAudit): every change by a person, agent or screen, newest first,
 * beside the settings navigation. Filters by who, what, target and when live in the URL, so a
 * link shares them; the text search, which can be an email or a name, lives in the store and
 * reaches the server in a POST body (#140); Load older reads the page after; Export CSV downloads what the filters match
 * (src/state/audit.ts). Times are in the org's time zone. The board's Location filter waits for
 * locations; Target takes its place.
 */
import { useSuspenseInfiniteQuery } from '@tanstack/react-query';
import { createFileRoute, getRouteApi, Link, useRouter } from '@tanstack/react-router';
import { DownloadIcon, LoaderCircleIcon, RotateCwIcon } from 'lucide-react';
import { useDeferredValue, useId, useMemo, type MouseEvent, type SubmitEvent } from 'react';
import { EditorFields } from '~/components/editor';
import { PageHeader } from '~/components/page';
import { SettingsNav } from '~/components/settings/parts';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { NativeSelect } from '~/components/ui/select';
import {
  ACTION_GROUPS,
  auditInput,
  auditTime,
  csvRow,
  detailText,
  isWhen,
  TARGET_KINDS,
  targetLabel,
  viaText,
  CMS_AGENT,
  whatText,
  WHENS,
  WHO_OPTIONS,
  whoText,
  type AuditEntry,
  type AuditFilters,
} from '~/lib/audit';
import { useNow, useOrgId } from '~/lib/live';
import { cn } from '~/lib/utils';
import { auditQuery } from '~/queries/audit';
import { backToPage } from '~/server/form-post.server';
import { getMembers, getOrgSettings } from '~/server/settings.functions';
import { useAppStore } from '~/state/provider';

/** A search param as trimmed text, or nothing: the router reads `?targetId=142` as a number, and a URL can say anything. */
function text(v: unknown, max: number): string | undefined {
  const s = (typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '').trim();
  return s && s.length <= max ? s : undefined;
}

export const Route = createFileRoute('/_app/audit')({
  // `q: undefined` drops an old link's `?q=`: the search is never read from a URL.
  validateSearch: (s: Record<string, unknown>): AuditFilters & { q?: undefined } => {
    const target = text(s.target, 40);
    // One target needs its kind: an id alone would say "Only x" over the whole log.
    // Every key, undefined when dropped: the router lays a route's search over the raw params, so a key left out keeps its raw value.
    return {
      who: text(s.who, 200),
      what: text(s.what, 64),
      target,
      targetId: target && text(s.targetId, 200),
      when: isWhen(s.when) ? s.when : undefined,
      q: undefined,
    };
  },
  server: { handlers: backToPage },
  loaderDeps: ({ search }) => search,
  // The first page is read again on every load, as after a change elsewhere, never from the cache.
  // Unsearched: the search is the store's, which a loader can't read; empty in a server render.
  loader: async ({ context: { queryClient }, parentMatchPromise, deps }) => {
    const orgId = (await parentMatchPromise).loaderData?.organization?.id;
    const [settings, people] = await Promise.all([
      getOrgSettings(),
      getMembers(),
      orgId && queryClient.infiniteQuery({ ...auditQuery(orgId, deps, ''), staleTime: 0 }),
    ]);
    return { settings, members: people.members, at: Date.now() };
  },
  head: () => ({ meta: [{ title: 'Audit log · SignForge' }] }),
  component: AuditLogPage,
});

const app = getRouteApi('/_app');

function AuditLogPage() {
  const { settings, members, at } = Route.useLoaderData();
  const search = Route.useSearch();
  const orgId = useOrgId();
  const me = app.useLoaderData().user.id;
  const now = useNow(at);
  // Deferred: a new search shows the rows it replaces until its own arrive, not the page's fallback.
  const query = useDeferredValue(useAppStore((s) => s.audit.query));
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError, error, refetch } = useSuspenseInfiniteQuery(
    auditQuery(orgId, search, query),
  );
  const router = useRouter();
  const countId = useId();
  const exporting = useAppStore((s) => s.audit.exporting);
  const exportNote = useAppStore((s) => s.audit.exportNote);
  const exportAuditLog = useAppStore((s) => s.exportAuditLog);
  const names = useMemo(() => new Map(members.map((m) => [m.userId, m.user.name || m.user.email])), [members]);
  const entries = data.pages.flatMap((p) => p.entries);
  const timezone = settings?.timezone ?? 'UTC';
  const kept = settings ? ` Kept ${settings.auditRetentionDays} days.` : '';
  const filtered = Object.values(search).some(Boolean) || query !== '';

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
      <SettingsNav />
      <div className="min-w-0 flex-1 space-y-4">
        <PageHeader title="Audit log" description={`Every change by a person, agent or screen.${kept} Times in ${timezone}.`}>
          <EditorFields>
            <Button variant="outline" disabled={exporting} onClick={() => void exportAuditLog(auditInput(search, query, Date.now()), (e) => csvRow(e, names))}>
              {exporting ? <LoaderCircleIcon className="animate-spin" aria-hidden /> : <DownloadIcon aria-hidden />} Export CSV
            </Button>
          </EditorFields>
        </PageHeader>
        <p role="status" className={cn('text-sm empty:hidden', exportNote?.failed ? 'font-medium text-destructive' : 'text-muted-foreground')}>
          {exportNote?.text}
        </p>

        <Filters members={members.map((m) => ({ id: m.userId, name: names.get(m.userId) ?? m.userId }))} />

        {search.targetId && (
          <p className="text-sm">
            Only {targetLabel(search.target ?? '')} <span className="font-mono text-meta">{search.targetId}</span>.{' '}
            <Link from="/audit" to="/audit" search={({ targetId: _, ...rest }) => rest} className="font-medium text-primary underline-offset-4 hover:underline">
              Show every {targetLabel(search.target ?? '').toLowerCase()}
            </Link>
          </p>
        )}

        {entries.length ? (
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="w-full border-collapse text-md sm:min-w-[44rem]">
              <thead className="bg-muted/60 text-left text-sm text-muted-foreground">
                <tr>
                  <th scope="col" className="w-24 px-3 py-2 font-semibold">
                    Time
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Who
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    What
                  </th>
                  <th scope="col" className="hidden px-3 py-2 font-semibold sm:table-cell">
                    Target
                  </th>
                  <th scope="col" className="hidden px-3 py-2 font-semibold sm:table-cell">
                    Via
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: entries carry no id (#77) and a row holds no state, so a shifted key only redraws its text.
                  <EntryRow key={`${e.at}-${i}`} entry={e} who={whoText(e, names, me)} time={auditTime(e.at, timezone, now)} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="rounded-xl border bg-card p-8 text-center text-muted-foreground">
            {filtered ? 'Nothing matches these filters.' : 'Nothing has been changed yet. Changes appear here as they are made.'}
          </p>
        )}

        {isFetchNextPageError && (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm font-medium text-destructive">
            Could not load older entries: {error?.message}
            {/* The loader reads only the unsearched log again, so a search is read again here. */}
            <Button type="button" variant="outline" size="sm" onClick={() => void router.invalidate().then(() => (query ? refetch() : undefined))}>
              <RotateCwIcon aria-hidden /> Reload
            </Button>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 text-md">
          <span id={countId} tabIndex={-1} role="status" className="text-muted-foreground outline-none">
            Showing {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
            {entries.length > 0 && !hasNextPage ? ', all there are' : ''}
          </span>
          {hasNextPage && (
            <Button
              variant="outline"
              disabled={isFetchingNextPage}
              // The last page takes the button away: focus moves to the count, which says it is all there is.
              onClick={() => void fetchNextPage().then((r) => r.hasNextPage || document.getElementById(countId)?.focus())}
            >
              {isFetchingNextPage && <LoaderCircleIcon className="animate-spin" aria-hidden />} Load older
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Agents and screens apart from people, as on the board, the built-in agent too; a person and the system in the text colour. */
const ACTOR_COLOR: Record<AuditEntry['actor']['kind'], string> = { user: '', system: '', agent: 'text-actor-agent', device: 'text-actor-device' };
const actorColor = (e: AuditEntry) => (e.actor.clientId === CMS_AGENT ? 'text-actor-agent' : ACTOR_COLOR[e.actor.kind]);

function EntryRow({ entry: e, who, time }: { entry: AuditEntry; who: string; time: string }) {
  const detail = detailText(e);
  return (
    <tr className={cn('border-t align-top', e.detail.refused !== undefined && 'bg-accent/50')}>
      <td className="px-3 py-2 text-meta whitespace-nowrap text-muted-foreground tabular-nums">
        <time dateTime={new Date(e.at).toISOString()}>{time}</time>
      </td>
      <td className={cn('px-3 py-2 font-semibold whitespace-nowrap', actorColor(e))}>{who}</td>
      <td className="px-3 py-2">
        {whatText(e)}
        {/* In <bdi>: what a tool was given (an agent's reason for its publish request) cannot reorder the row around it. */}
        {detail && (
          <span className="mt-0.5 block font-mono text-meta break-all text-muted-foreground">
            <bdi>{detail}</bdi>
          </span>
        )}
        {/* Phones have no room for the last two columns: they read under what was done. */}
        <span className="mt-0.5 block text-sm break-all text-muted-foreground sm:hidden">
          {e.target && (
            <>
              {targetLabel(e.target.kind)} <TargetLink target={e.target} className="inline" />
              {' · '}
            </>
          )}
          {viaText(e)}
        </span>
      </td>
      <td className="hidden px-3 py-2 sm:table-cell">
        {e.target && (
          <>
            {targetLabel(e.target.kind)}
            <TargetLink target={e.target} className="block" />
          </>
        )}
      </td>
      <td className="hidden px-3 py-2 text-sm whitespace-nowrap text-muted-foreground sm:table-cell">{viaText(e)}</td>
    </tr>
  );
}

/** A target's id, narrowing the log to that one thing. */
function TargetLink({ target, className }: { target: { kind: string; id: string }; className: string }) {
  return (
    <Link
      from="/audit"
      to="/audit"
      search={(s) => ({ ...s, target: target.kind, targetId: target.id })}
      className={cn('font-mono text-meta break-all text-primary underline-offset-4 hover:underline', className)}
      aria-label={`Only ${targetLabel(target.kind).toLowerCase()} ${target.id}`}
    >
      {target.id}
    </Link>
  );
}

/** The filters: each choice applies at once; the search when submitted. */
function Filters({ members }: { members: { id: string; name: string }[] }) {
  const id = useId();
  const search = Route.useSearch();
  const query = useAppStore((s) => s.audit.query);
  const searchAuditLog = useAppStore((s) => s.searchAuditLog);
  const navigate = Route.useNavigate();
  const set = (key: keyof AuditFilters, value: string) =>
    void navigate({ search: (s) => ({ ...s, [key]: value || undefined, ...(key === 'target' ? { targetId: undefined } : {}) }), replace: true });

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = new FormData(e.currentTarget).get('q');
    searchAuditLog(typeof q === 'string' ? q : '');
  }

  function clear(e: MouseEvent<HTMLButtonElement>) {
    const q = e.currentTarget.form?.elements.namedItem('q');
    if (q instanceof HTMLInputElement) q.value = '';
    searchAuditLog('');
    void navigate({ search: {}, replace: true });
  }

  return (
    <search aria-label="Filter the audit log">
      {/* It waits for the page to hydrate (#140): a filter chosen before then was set back, and the
          browser's own submit put the search in the URL. It posts, should one get through. */}
      <form method="post" onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <EditorFields>
          <div className="grid w-full gap-1.5 sm:w-52">
            <Label htmlFor={`${id}-who`}>Who</Label>
            <NativeSelect className="w-full" id={`${id}-who`} value={search.who ?? ''} onChange={(e) => set('who', e.target.value)}>
              <option value="">Everyone</option>
              {WHO_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
              {members.length > 0 && (
                <optgroup label="Members">
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </NativeSelect>
          </div>
          <div className="grid w-full gap-1.5 sm:w-52">
            <Label htmlFor={`${id}-what`}>What</Label>
            <NativeSelect className="w-full" id={`${id}-what`} value={search.what ?? ''} onChange={(e) => set('what', e.target.value)}>
              <option value="">All changes</option>
              {ACTION_GROUPS.map((g) => (
                <optgroup key={g.group} label={g.group}>
                  {g.actions.map((a) => (
                    <option key={a.value} value={a.value}>
                      {g.group}: {a.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </NativeSelect>
          </div>
          <div className="grid w-[calc(50%-0.375rem)] gap-1.5 sm:w-40">
            <Label htmlFor={`${id}-target`}>Target</Label>
            <NativeSelect className="w-full" id={`${id}-target`} value={search.target ?? ''} onChange={(e) => set('target', e.target.value)}>
              <option value="">Everything</option>
              {TARGET_KINDS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid w-[calc(50%-0.375rem)] gap-1.5 sm:w-40">
            <Label htmlFor={`${id}-when`}>When</Label>
            <NativeSelect className="w-full" id={`${id}-when`} value={search.when ?? ''} onChange={(e) => set('when', e.target.value)}>
              <option value="">Any time</option>
              {WHENS.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid min-w-48 flex-1 gap-1.5">
            <Label htmlFor={`${id}-q`}>Search</Label>
            <Input id={`${id}-q`} name="q" type="search" defaultValue={query} placeholder="Screen, spot, name, agent…" />
          </div>
          {(Object.values(search).some(Boolean) || query !== '') && (
            <Button type="button" variant="ghost" onClick={clear}>
              Clear filters
            </Button>
          )}
        </EditorFields>
      </form>
    </search>
  );
}
