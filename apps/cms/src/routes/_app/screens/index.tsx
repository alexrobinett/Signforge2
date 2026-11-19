/**
 * Screens: the live tile wall by default (canvas board Screens A), or the dense table (board B, on
 * the light kit). Each screen says what it should be showing and what it is doing, as a fact, and
 * what it is doing stays current while the page is open (src/queries/screens.ts).
 * Groups are locations: each rolls up to its most urgent screen.
 */
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { CloudOffIcon, LayoutGridIcon, PlusIcon, SearchIcon, TableIcon } from 'lucide-react';
import { useMemo } from 'react';
import { PageHeader } from '~/components/page';
import { EmptyFleet } from '~/components/screens/empty-fleet';
import { PairScreenForm } from '~/components/screens/pair-screen-form';
import { ScreenThumb } from '~/components/screens/screen-thumb';
import { KIND_WORD, ScreenStatus, StatusWord, toneOf } from '~/components/screens/status';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { NativeSelect } from '~/components/ui/select';
import { describeHours } from '~/components/screens/display-hours-editor';
import { ago, describeScreen, rollup, summarise } from '~/lib/screen-status';
import { isStateKind, STATE_KINDS, type GroupView, type ScreenView, type StateKind } from '~/lib/screen-types';
import { useCanManage, useNow, useOrgId } from '~/lib/live';
import { cn } from '~/lib/utils';
import { withStatus } from '~/lib/fleet-status';
import { screensQuery, screenStatusQuery } from '~/queries/screens';
import { getOrgSettings } from '~/server/settings.functions';

type View = 'tiles' | 'table';
interface Search {
  view?: View;
  q?: string;
  group?: string;
  status?: StateKind;
}

export const Route = createFileRoute('/_app/screens/')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(s.view === 'table' ? { view: 'table' as const } : {}),
    ...(typeof s.q === 'string' && s.q ? { q: s.q } : {}),
    ...(typeof s.group === 'string' && s.group ? { group: s.group } : {}),
    ...(isStateKind(s.status) ? { status: s.status } : {}),
  }),
  // The org's settings give the pairing form its defaults for new screens. The list is read again
  // on every load, as after a change (`router.invalidate()` in the store's actions), never from the cache.
  loader: async ({ context: { queryClient }, parentMatchPromise }) => {
    const orgId = (await parentMatchPromise).loaderData?.organization?.id;
    const [settings] = await Promise.all([getOrgSettings(), orgId && queryClient.query({ ...screensQuery(orgId), staleTime: 0 })]);
    return { settings };
  },
  head: () => ({ meta: [{ title: 'Screens · SignForge' }] }),
  component: ScreensPage,
});

function ScreensPage() {
  const orgId = useOrgId();
  const { data } = useSuspenseQuery(screensQuery(orgId));
  const { data: live, errorUpdatedAt, dataUpdatedAt } = useQuery(screenStatusQuery(orgId));
  // Not `isError`: a query with no data yet goes back to pending on each retry, so the notice would blink.
  const pollFailing = errorUpdatedAt > dataUpdatedAt;
  const { groups } = data;
  const screens = withStatus(data.screens, data.at, live);
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const canManage = useCanManage();
  const heardAt = Math.max(data.at, live?.at ?? 0);
  const now = useNow(heardAt);

  const view: View = search.view ?? 'tiles';
  const groupsOf = useMemo(() => {
    const m = new Map<string, GroupView[]>();
    for (const g of groups) for (const id of g.screenIds) m.set(id, [...(m.get(id) ?? []), g]);
    return m;
  }, [groups]);

  const shown = screens.filter((s) => {
    if (search.group && !groupsOf.get(s.id)?.some((g) => g.id === search.group)) return false;
    if (search.status && s.state.kind !== search.status) return false;
    if (search.q) {
      const q = search.q.toLowerCase();
      if (!s.name.toLowerCase().includes(q) && !s.showing?.spot?.name.toLowerCase().includes(q)) return false;
    }
    return true;
  });
  const set = (next: Partial<Search>) => void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });

  if (!screens.length) {
    return (
      <div className="space-y-6">
        <PageHeader title="Screens" description="No screens here yet." />
        {/* The player build on this site (vite.config.ts), with the device API on this origin too. */}
        <EmptyFleet groups={groups} canManage={canManage} testScreenHref="/test-screen/?kind=browser&content=/v1/device" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Screens">{canManage && <PairDialog groups={groups} />}</PageHeader>
      <Summary screens={screens} />
      <NotCurrent failing={pollFailing} heardAt={heardAt} now={now} />

      {groups.length > 0 && <Locations groups={groups} screens={screens} onPick={(group) => set({ group })} />}

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-sm flex-[1_1_16rem]">
          <label htmlFor="screen-search" className="sr-only">
            Search screens
          </label>
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            id="screen-search"
            type="search"
            placeholder="Search by name or spot"
            defaultValue={search.q}
            onChange={(e) => set({ q: e.target.value || undefined })}
            className="pl-9"
          />
        </div>
        {groups.length > 0 && (
          <fieldset className="flex flex-wrap gap-1.5">
            <legend className="sr-only">Filter by group</legend>
            <Chip pressed={!search.group} onClick={() => set({ group: undefined })}>
              All {screens.length}
            </Chip>
            {groups.map((g) => (
              <Chip key={g.id} pressed={search.group === g.id} onClick={() => set({ group: search.group === g.id ? undefined : g.id })}>
                {g.name} {g.screenIds.length}
              </Chip>
            ))}
          </fieldset>
        )}
        <div className="flex items-center gap-2 text-sm text-muted-foreground sm:ml-auto">
          <label htmlFor="screen-status">Status</label>
          <NativeSelect
            id="screen-status"
            value={search.status ?? ''}
            onChange={(e) => set({ status: isStateKind(e.target.value) ? e.target.value : undefined })}
          >
            <option value="">Any</option>
            {STATE_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_WORD[k]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <fieldset className="flex rounded-lg border border-border-strong bg-card p-0.5">
          <legend className="sr-only">View</legend>
          {(
            [
              ['tiles', 'Tiles', LayoutGridIcon],
              ['table', 'Table', TableIcon],
            ] as const
          ).map(([v, label, Icon]) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => set({ view: v === 'tiles' ? undefined : v })}
              className={cn(
                'flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                view === v ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="size-4" aria-hidden /> {label}
            </button>
          ))}
        </fieldset>
      </div>

      {shown.length === 0 ? (
        <p className="rounded-xl border bg-card p-8 text-center text-muted-foreground">No screens match. Clear the search or filters to see them all.</p>
      ) : view === 'tiles' ? (
        <Tiles screens={shown} groupsOf={groupsOf} now={now} />
      ) : (
        <ScreenTable screens={shown} groupsOf={groupsOf} now={now} />
      )}
    </div>
  );
}

/** The facts under the heading; the screens that need a person in the one red. */
function Summary({ screens }: { screens: ScreenView[] }) {
  const parts = summarise(screens).split(' · ');
  const needs = parts.at(-1)?.endsWith(' you') ? parts.pop() : undefined;
  return (
    <p role="status" className="-mt-4 text-[15px] text-muted-foreground">
      {parts.join(' · ')}
      {needs && (
        <>
          {' · '}
          <strong className="font-semibold text-status-needs-you-foreground">{needs}</strong>
        </>
      )}
    </p>
  );
}

/**
 * While the poll fails, the states on the page are the last ones heard, so it says so and since
 * when; the next good poll clears it. The live region stays in the accessibility tree while empty
 * (visually hidden, not `display: none`), so the notice is announced when it comes.
 */
function NotCurrent({ failing, heardAt, now }: { failing: boolean; heardAt: number; now: number }) {
  return (
    <div role="status" className="empty:sr-only">
      {failing && (
        <p className="flex items-start gap-3 rounded-xl border bg-card px-4 py-3.5 text-[15px] leading-normal">
          <CloudOffIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
          <span>
            <strong className="font-semibold">Status is not current.</strong> SignForge has not answered since{' '}
            {new Date(heardAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} ({ago(now - heardAt)} ago). This page keeps trying.
          </span>
        </p>
      )}
    </div>
  );
}

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'h-10 rounded-full border px-3.5 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        pressed ? 'border-foreground bg-foreground font-medium text-background' : 'border-border-strong bg-card hover:bg-accent',
      )}
    >
      {children}
    </button>
  );
}

function PairDialog({ groups }: { groups: GroupView[] }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="lg">
          <PlusIcon aria-hidden /> Pair a screen
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Pair a screen</DialogTitle>
          <DialogDescription>Turn the screen on: it shows a 6-character code. Type it here.</DialogDescription>
        </DialogHeader>
        <PairScreenForm groups={groups} />
      </DialogContent>
    </Dialog>
  );
}

/** Each group as a location, rolled up to its most urgent screen. */
function Locations({ groups, screens, onPick }: { groups: GroupView[]; screens: ScreenView[]; onPick: (id: string) => void }) {
  const byId = new Map(screens.map((s) => [s.id, s]));
  return (
    <ul aria-label="By location" className="flex flex-wrap gap-3">
      {groups.map((g) => {
        const members = g.screenIds.map((id) => byId.get(id)).filter((s): s is ScreenView => !!s);
        const kind = rollup(members);
        const needs = members.filter((s) => s.state.kind === 'needs_you');
        return (
          <li key={g.id} className="min-w-0 flex-[1_1_16rem]">
            <button
              type="button"
              onClick={() => onPick(g.id)}
              className="flex w-full flex-col gap-1.5 rounded-xl border bg-card px-4 py-3.5 text-left outline-none hover:border-border-strong focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <span className="flex items-center justify-between gap-2">
                <strong className="truncate text-[15px] font-semibold">{g.name}</strong>
                {kind && <StatusWord tone={toneOf(kind)}>{KIND_WORD[kind]}</StatusWord>}
              </span>
              <span className="text-[13px] text-muted-foreground">
                {members.length} {members.length === 1 ? 'screen' : 'screens'}
                {needs.length > 0 && ` · ${needs.map((s) => s.name).join(', ')} ${needs.length === 1 ? 'needs' : 'need'} you`}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const shortId = (id: string | null) => (id ? id.slice(0, 7) : 'none');

function versionText(s: ScreenView) {
  const playing = s.reportedManifestId ?? s.heartbeat?.activeManifestId ?? null;
  if (!s.desiredManifestId) return { text: 'none', behind: false };
  if (playing && playing !== s.desiredManifestId) return { text: `${shortId(playing)} → ${shortId(s.desiredManifestId)}`, behind: true };
  return { text: shortId(s.desiredManifestId), behind: false };
}

function Tiles({ screens, groupsOf, now }: { screens: ScreenView[]; groupsOf: Map<string, GroupView[]>; now: number }) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(18rem,100%),1fr))] gap-4">
      {screens.map((s) => {
        const d = describeScreen(s, now);
        const v = versionText(s);
        const where = groupsOf
          .get(s.id)
          ?.map((g) => g.name)
          .join(', ');
        return (
          <li key={s.id} className="relative flex flex-col overflow-hidden rounded-xl border bg-card focus-within:ring-[3px] focus-within:ring-ring/50">
            <div className="relative">
              <ScreenThumb screen={s} />
              <ScreenStatus screen={s} now={now} className="absolute top-2.5 left-2.5" />
              <span className="absolute right-2.5 bottom-2.5 rounded-md bg-black/80 px-1.5 py-0.5 font-mono text-[11px] text-white">
                {s.orientation === 'portrait' ? '9:16' : '16:9'}
              </span>
            </div>
            <div className="flex flex-col gap-1.5 px-4 pt-3.5 pb-4">
              <div className="flex items-baseline justify-between gap-2">
                <Link
                  to="/screens/$screenId"
                  params={{ screenId: s.id }}
                  className="truncate text-base font-semibold outline-none after:absolute after:inset-0 hover:underline"
                >
                  {s.name}
                </Link>
                {s.desiredManifestId && (
                  <span
                    className={cn('font-mono text-xs tabular-nums', v.behind ? 'text-status-updating-foreground' : 'text-muted-foreground')}
                    title="Version (manifest id)"
                  >
                    {v.text}
                  </span>
                )}
              </div>
              <p className="text-[13px] text-muted-foreground">{[s.kind === 'browser' && 'Test screen', where, d.line].filter(Boolean).join(' · ')}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ScreenTable({ screens, groupsOf, now }: { screens: ScreenView[]; groupsOf: Map<string, GroupView[]>; now: number }) {
  return (
    <div className="relative overflow-x-auto rounded-xl border bg-card">
      <table className="w-full min-w-[56rem] border-collapse text-sm">
        <thead className="bg-muted text-xs tracking-wide text-muted-foreground uppercase">
          <tr>
            <th scope="col" className="px-3 py-2.5 pl-4 text-left font-semibold">
              Should be showing
            </th>
            <th scope="col" className="px-3 py-2.5 text-left font-semibold">
              Screen
            </th>
            <th scope="col" className="px-3 py-2.5 text-left font-semibold">
              Status
            </th>
            <th scope="col" className="px-3 py-2.5 text-left font-semibold">
              What it is doing
            </th>
            <th scope="col" className="px-3 py-2.5 text-left font-semibold">
              Display hours
            </th>
            <th scope="col" className="px-3 py-2.5 text-right font-semibold">
              Version
            </th>
            <th scope="col" className="px-3 py-2.5 text-right font-semibold">
              Last heard
            </th>
            <th scope="col" className="px-3 py-2.5 pr-4">
              <span className="sr-only">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {screens.map((s) => {
            const d = describeScreen(s, now);
            const v = versionText(s);
            return (
              <tr key={s.id} className="h-9 border-t hover:bg-muted/50">
                <td className="py-1.5 pr-3 pl-4">
                  <ScreenThumb screen={s} size="row" className="w-24 rounded" />
                </td>
                <th scope="row" className="px-3 py-1.5 text-left font-semibold whitespace-nowrap">
                  <Link to="/screens/$screenId" params={{ screenId: s.id }} className="hover:underline">
                    {s.name}
                  </Link>
                  <div className="text-[13px] font-normal text-muted-foreground">
                    {s.kind === 'browser' && 'Test screen · '}
                    {groupsOf
                      .get(s.id)
                      ?.map((g) => g.name)
                      .join(', ') || 'No group'}
                  </div>
                </th>
                <td className="px-3 py-1.5">
                  <ScreenStatus screen={s} now={now} />
                </td>
                <td className="max-w-[28rem] px-3 py-1.5 leading-snug text-foreground/85">{d.line}</td>
                <td className="px-3 py-1.5 whitespace-nowrap text-muted-foreground">{describeHours(s.displayHours)}</td>
                <td
                  className={cn(
                    'px-3 py-1.5 text-right font-mono text-[13px] whitespace-nowrap tabular-nums',
                    v.behind ? 'text-status-updating-foreground' : 'text-muted-foreground',
                  )}
                >
                  {v.text}
                </td>
                <td
                  className="px-3 py-1.5 text-right font-mono text-[13px] whitespace-nowrap text-muted-foreground tabular-nums"
                  title={s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString() : undefined}
                >
                  {s.lastSeenAt ? `${ago(now - s.lastSeenAt)} ago` : 'never'}
                </td>
                <td className="px-3 py-1.5 pr-4 text-right">
                  {s.state.kind === 'needs_you' && (
                    <Button asChild variant="outline" size="sm">
                      <Link to="/screens/$screenId" params={{ screenId: s.id }} aria-label={`Troubleshoot ${s.name}`}>
                        Troubleshoot
                      </Link>
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
