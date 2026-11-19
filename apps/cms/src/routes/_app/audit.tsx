/**
 * Audit log (canvas board SettingsAudit): every change by a person, agent or screen, newest first,
 * beside the settings navigation. Filters by who, what, target and when, and a text search, live
 * in the URL; Load older reads the page after; Export CSV downloads what the filters match
 * (src/state/audit.ts). Times are in the org's time zone. The board's Location filter waits for
 * locations; Target takes its place.
 */
import { useSuspenseInfiniteQuery } from '@tanstack/react-query';
import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router';
import { DownloadIcon, LoaderCircleIcon } from 'lucide-react';
import { useId, useMemo, type MouseEvent, type SubmitEvent } from 'react';
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
import { getMembers, getOrgSettings } from '~/server/settings.functions';
import { useAppStore } from '~/state/provider';

/** A search param as text: the router reads `?q=142` as a number. */
function text(v: unknown, max: number): string | undefined {
  const s = typeof v === 'number' ? String(v) : v;
  return typeof s === 'string' && s && s.length <= max ? s : undefined;
}

export const Route = createFileRoute('/_app/audit')({
  validateSearch: (s: Record<string, unknown>): AuditFilters => {
    const f: AuditFilters = { who: text(s.who, 200), what: text(s.what, 64), target: text(s.target, 40), targetId: text(s.targetId, 200), q: text(s.q, 100) };
    if (isWhen(s.when)) f.when = s.when;
    return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));
  },
  loaderDeps: ({ search }) => search,
  // The first page is read again on every load, as after a change elsewhere, never from the cache.
  loader: async ({ context: { queryClient }, parentMatchPromise, deps }) => {
    const orgId = (await parentMatchPromise).loaderData?.organization?.id;
    const [settings, people] = await Promise.all([
      getOrgSettings(),
      getMembers(),
      orgId && queryClient.infiniteQuery({ ...auditQuery(orgId, deps), staleTime: 0 }),
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
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useSuspenseInfiniteQuery(auditQuery(orgId, search));
  const exporting = useAppStore((s) => s.audit.exporting);
  const exportNote = useAppStore((s) => s.audit.exportNote);
  const exportAuditLog = useAppStore((s) => s.exportAuditLog);
  const names = useMemo(() => new Map(members.map((m) => [m.userId, m.user.name || m.user.email])), [members]);
  const entries = data.pages.flatMap((p) => p.entries);
  const timezone = settings?.timezone ?? 'UTC';
  const kept = settings ? ` Kept ${settings.auditRetentionDays} days.` : '';
  const filtered = Object.keys(search).length > 0;

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
      <SettingsNav />
      <div className="min-w-0 flex-1 space-y-4">
        <PageHeader title="Audit log" description={`Every change by a person, agent or screen.${kept} Times in ${timezone}.`}>
          <Button variant="outline" disabled={exporting} onClick={() => void exportAuditLog(auditInput(search, Date.now()), (e) => csvRow(e, names, me))}>
            {exporting ? <LoaderCircleIcon className="animate-spin" aria-hidden /> : <DownloadIcon aria-hidden />} Export CSV
          </Button>
        </PageHeader>
        <p role="status" className={cn('text-sm empty:hidden', exportNote?.failed ? 'font-medium text-destructive' : 'text-muted-foreground')}>
          {exportNote?.text}
        </p>

        <Filters members={members.map((m) => ({ id: m.userId, name: names.get(m.userId) ?? m.userId }))} />

        {search.targetId && (
          <p className="text-sm">
            Only {targetLabel(search.target ?? '')} <span className="font-mono text-[13px]">{search.targetId}</span>.{' '}
            <Link to="/audit" search={({ targetId: _, ...rest }) => rest} className="font-medium text-primary underline-offset-4 hover:underline">
              Show every {targetLabel(search.target ?? '').toLowerCase()}
            </Link>
          </p>
        )}

        {entries.length ? (
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="w-full border-collapse text-[15px] sm:min-w-[44rem]">
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

        <div className="flex flex-wrap items-center justify-between gap-3 text-[15px]">
          <span className="text-muted-foreground">
            Showing {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
            {entries.length > 0 && !hasNextPage ? ', all there are' : ''}
          </span>
          {hasNextPage && (
            <Button variant="outline" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
              {isFetchingNextPage && <LoaderCircleIcon className="animate-spin" aria-hidden />} Load older
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Agents and screens apart from people, as on the board; a person and the system in the text colour. */
const ACTOR_COLOR: Record<AuditEntry['actor']['kind'], string> = { user: '', system: '', agent: 'text-actor-agent', device: 'text-actor-device' };

function EntryRow({ entry: e, who, time }: { entry: AuditEntry; who: string; time: string }) {
  const detail = detailText(e);
  return (
    <tr className={cn('border-t align-top', e.detail.refused !== undefined && 'bg-accent/50')}>
      <td className="px-3 py-2 font-mono text-[13px] whitespace-nowrap text-muted-foreground">
        <time dateTime={new Date(e.at).toISOString()}>{time}</time>
      </td>
      <td className={cn('px-3 py-2 font-semibold whitespace-nowrap', ACTOR_COLOR[e.actor.kind])}>{who}</td>
      <td className="px-3 py-2">
        {whatText(e)}
        {detail && <span className="mt-0.5 block font-mono text-[13px] break-all text-muted-foreground">{detail}</span>}
        {/* Phones have no room for the last two columns: they read under what was done. */}
        <span className="mt-0.5 block text-sm break-all text-muted-foreground sm:hidden">
          {e.target && `${targetLabel(e.target.kind)} ${e.target.id} · `}
          {viaText(e)}
        </span>
      </td>
      <td className="hidden px-3 py-2 sm:table-cell">
        {e.target && (
          <>
            {targetLabel(e.target.kind)}
            <Link
              to="/audit"
              search={(s) => ({ ...s, target: e.target?.kind, targetId: e.target?.id })}
              className="block font-mono text-[13px] break-all text-primary underline-offset-4 hover:underline"
              aria-label={`Only ${targetLabel(e.target.kind).toLowerCase()} ${e.target.id}`}
            >
              {e.target.id}
            </Link>
          </>
        )}
      </td>
      <td className="hidden px-3 py-2 text-sm whitespace-nowrap text-muted-foreground sm:table-cell">{viaText(e)}</td>
    </tr>
  );
}

/** The filters: each choice applies at once; the search when submitted. */
function Filters({ members }: { members: { id: string; name: string }[] }) {
  const id = useId();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const set = (key: keyof AuditFilters, value: string) =>
    void navigate({ search: (s) => ({ ...s, [key]: value || undefined, ...(key === 'target' ? { targetId: undefined } : {}) }), replace: true });

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = new FormData(e.currentTarget).get('q');
    set('q', typeof q === 'string' ? q.trim() : '');
  }

  function clear(e: MouseEvent<HTMLButtonElement>) {
    const q = e.currentTarget.form?.elements.namedItem('q');
    if (q instanceof HTMLInputElement) q.value = '';
    void navigate({ search: {}, replace: true });
  }

  return (
    <search aria-label="Filter the audit log">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
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
          <Input id={`${id}-q`} name="q" type="search" defaultValue={search.q} placeholder="Screen, spot, name, agent…" />
        </div>
        {Object.keys(search).length > 0 && (
          <Button type="button" variant="ghost" onClick={clear}>
            Clear filters
          </Button>
        )}
      </form>
    </search>
  );
}
