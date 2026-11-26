/**
 * Screens: the live tile wall by default (canvas board Screens A), or the dense table (board B, on
 * the light kit). Each screen says what it should be showing and what it is doing, as a fact, and
 * what it is doing stays current while the page is open (src/queries/screens.ts).
 * Needs attention lists the groups with a screen that needs a person. A retired (revoked) screen
 * is off the list and its counts unless the Retired filter asks for it. The table's rows can be
 * ticked, and the selection added to a group or removed from one.
 * Labels (#185): the search finds label values and group names too, and a typed `key=value` becomes a chip; the chips
 * are kept in the URL (`l=region:north`), so a filtered view can be shared; "Group by" shows the screens in sections by
 * a key's value; the table has a Labels column and each tile its labels (`src/lib/label-filter.ts`).
 */
import { Choice } from '~/components/ui/choice';
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  LayoutGridIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SearchIcon,
  TableIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';
import { useCallback, useId, useMemo, type ReactNode } from 'react';
import { EditorFields } from '~/components/editor';
import { PageHeader } from '~/components/page';
import { EmptyFleet } from '~/components/screens/empty-fleet';
import { LatestPublish } from '~/components/publishes/latest-publish';
import { PairScreenForm } from '~/components/screens/pair-screen-form';
import { NotCurrent } from '~/components/screens/not-current';
import { ScreenThumb } from '~/components/screens/screen-thumb';
import { Badge } from '~/components/ui/badge';
import { KIND_WORD, ScreenStatus } from '~/components/screens/status';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '~/components/ui/dialog';
import { Label } from '~/components/ui/label';
import { LabelChips } from '~/components/screens/labels';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '~/components/ui/dropdown-menu';
import { Input } from '~/components/ui/input';
import { NativeSelect } from '~/components/ui/select';
import { describeHours } from '~/components/screens/display-hours-editor';
import { needingAttention } from '~/lib/groups';
import { matchesTerms, searchFinds, sectionsBy, termsOf, termsParam, typedTerm, withTerm, type LabelSection, type LabelTerm } from '~/lib/label-filter';
import type { LabelKey } from '~/lib/labels';
import { ago, describeScreen, isRetired, summarise } from '~/lib/screen-status';
import { isStateKind, STATE_KINDS, type GroupView, type ScreenView, type StateKind } from '~/lib/screen-types';
import { useCanManage, useCanPublish, useNow, useOrgId } from '~/lib/live';
import { cn } from '~/lib/utils';
import { withStatus } from '~/lib/fleet-status';
import { byName, isScreenSort, sortScreens, type ScreenSort } from '~/lib/targets';
import { labelKeysQuery, screensQuery, screenStatusQuery } from '~/queries/screens';
import { getOrgSettings } from '~/server/settings.functions';
import { useAppStore } from '~/state/provider';
import { selectedIn } from '~/state/screens';

type View = 'tiles' | 'table';
/** A state, or `retired`: the revoked screens, which no other filter shows. */
type StatusFilter = StateKind | 'retired';
interface Search {
  view?: View;
  q?: string;
  group?: string;
  status?: StatusFilter;
  /** Absent: by name. */
  sort?: ScreenSort;
  /** Label chips (#185), `key:value,value` with `;` between: a screen has every key at one of its values. */
  l?: string;
  /** A label key to show the screens in sections by. */
  by?: string;
  /** The Pair a screen dialog is open: ⌘K's Pair a screen comes here (#358). */
  pair?: true;
}

const isStatusFilter = (v: unknown): v is StatusFilter => v === 'retired' || isStateKind(v);

export const Route = createFileRoute('/_app/screens/')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(s.view === 'table' ? { view: 'table' as const } : {}),
    ...(typeof s.q === 'string' && s.q ? { q: s.q } : {}),
    ...(typeof s.group === 'string' && s.group ? { group: s.group } : {}),
    ...(isStatusFilter(s.status) ? { status: s.status } : {}),
    ...(isScreenSort(s.sort) && s.sort !== 'name' ? { sort: s.sort } : {}),
    ...(termsOf(s.l).length ? { l: termsParam(termsOf(s.l)) } : {}),
    ...(typeof s.by === 'string' && s.by ? { by: s.by } : {}),
    ...(s.pair === true ? { pair: true as const } : {}),
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

  const active = screens.filter((s) => !isRetired(s));
  const activeIds = new Set(active.map((s) => s.id));
  const retired = search.status === 'retired';
  const terms = termsOf(search.l);
  const keys = useQuery(labelKeysQuery(orgId)).data?.keys ?? [];
  const setTerms = (next: LabelTerm[]) => set({ l: termsParam(next) });
  const sort = search.sort ?? 'name';
  const matching = (retired ? screens.filter(isRetired) : active).filter((s) => {
    if (search.group && !groupsOf.get(s.id)?.some((g) => g.id === search.group)) return false;
    if (search.status && !retired && s.state.kind !== search.status) return false;
    if (terms.length && !matchesTerms(s, terms)) return false;
    if (search.q && !searchFinds(s, search.q, groupsOf.get(s.id)?.map((g) => g.name) ?? [])) return false;
    return true;
  });
  const shown = sortScreens(matching, sort);
  const sections = search.by ? sectionsBy(shown, search.by) : undefined;
  const set = (next: Partial<Search>) => void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });
  // With no screen yet the page is its own pairing form: ⌘K's Pair a screen focuses its code instead of a dialog (#358).
  const takePair = useCallback(
    (form: HTMLDivElement | null) => {
      if (!form || !search.pair) return;
      form.querySelector('input')?.focus();
      void navigate({ search: (prev) => ({ ...prev, pair: undefined }), replace: true });
    },
    [search.pair, navigate],
  );

  if (!screens.length) {
    return (
      <div className="space-y-6">
        <PageHeader title="Screens" description="No screens here yet." />
        {/* The player build on this site (vite.config.ts), with the device API on this origin too. */}
        <div ref={takePair}>
          <EmptyFleet groups={groups} canManage={canManage} testScreenHref="/test-screen/?kind=browser&content=/v1/device" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Screens">{canManage && <PairDialog groups={groups} />}</PageHeader>
      <Summary screens={active} />
      <NotCurrent failing={pollFailing} heardAt={heardAt} now={now} />
      <LatestPublish orgId={orgId} now={now} />

      <NeedsAttention groups={groups} screens={screens} onPick={(group) => set({ group })} />

      {/* The search and filters navigate, so they wait for the page to hydrate (#140). */}
      <div className="flex flex-wrap items-center gap-3">
        <EditorFields>
          <div className="relative max-w-sm flex-[1_1_16rem]">
            <label htmlFor="screen-search" className="sr-only">
              Search screens
            </label>
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              id="screen-search"
              type="search"
              placeholder="Search by name, spot, label or group"
              value={search.q ?? ''}
              onChange={(e) => set({ q: e.target.value || undefined })}
              onKeyDown={(e) => {
                // A typed key=value becomes a chip: "region=north", then Enter.
                const term = e.key === 'Enter' ? typedTerm(e.currentTarget.value) : undefined;
                if (!term) return;
                e.preventDefault();
                set({ q: undefined, l: termsParam(withTerm(terms, term)) });
              }}
              aria-describedby="screen-search-help"
              className="pl-9"
            />
            <p id="screen-search-help" className="sr-only">
              Type key=value and press Enter to filter by a label.
            </p>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground sm:ml-auto">
            <label htmlFor="screen-group">Group</label>
            <NativeSelect id="screen-group" value={search.group ?? ''} onChange={(e) => set({ group: e.target.value || undefined })}>
              <option value="">All groups</option>
              {[...groups].sort(byName).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g.screenIds.filter((id) => activeIds.has(id)).length})
                </option>
              ))}
            </NativeSelect>
            <Link to="/settings/screens" hash="groups" className="flex min-h-10 items-center text-primary underline-offset-4 hover:underline">
              Manage groups
            </Link>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <label htmlFor="screen-by">Group by</label>
            <NativeSelect id="screen-by" value={search.by ?? ''} onChange={(e) => set({ by: e.target.value || undefined })}>
              <option value="">Nothing</option>
              {keys.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.key}
                </option>
              ))}
              {search.by && !keys.some((k) => k.key === search.by) && <option value={search.by}>{search.by}</option>}
            </NativeSelect>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <label htmlFor="screen-status">Status</label>
            <NativeSelect
              id="screen-status"
              value={search.status ?? ''}
              onChange={(e) => set({ status: isStatusFilter(e.target.value) ? e.target.value : undefined })}
            >
              <option value="">Any</option>
              {STATE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_WORD[k]}
                </option>
              ))}
              <option value="retired">Retired</option>
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
              <Choice
                key={v}
                selected={view === v}
                onClick={() => set({ view: v === 'tiles' ? undefined : v })}
                className="flex h-9 items-center gap-1.5 rounded-[calc(var(--radius-lg)-(--spacing(0.5)))] px-3 text-sm font-medium"
              >
                <Icon className="size-4" aria-hidden /> {label}
              </Choice>
            ))}
          </fieldset>
        </EditorFields>
      </div>

      <LabelFilterRow terms={terms} keys={keys} onChange={setTerms} />

      {shown.length === 0 ? (
        <p className="rounded-xl border bg-card p-8 text-center text-muted-foreground">No screens match. Clear the search or filters to see them all.</p>
      ) : view === 'tiles' ? (
        sections ? (
          sections.map((sec) => (
            <Section key={sec.value ?? ''} by={search.by!} section={sec}>
              <Tiles screens={sec.screens} groupsOf={groupsOf} now={now} />
            </Section>
          ))
        ) : (
          <Tiles screens={shown} groupsOf={groupsOf} now={now} />
        )
      ) : (
        <ScreenTable
          sections={sections ?? [{ value: null, screens: shown }]}
          by={sections ? search.by : undefined}
          groups={groups}
          groupsOf={groupsOf}
          now={now}
          canManage={canManage}
          sort={sort}
        />
      )}
    </div>
  );
}

/** The facts under the heading; the screens that need a person in the one red. */
function Summary({ screens }: { screens: ScreenView[] }) {
  const parts = summarise(screens).split(' · ');
  const needs = parts.at(-1)?.endsWith(' you') ? parts.pop() : undefined;
  return (
    <p role="status" className="-mt-4 text-md text-muted-foreground tabular-nums">
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

/** Pair a screen: open while the URL says `pair`, so ⌘K can open it from any page (#358). */
function PairDialog({ groups }: { groups: GroupView[] }) {
  const { pair } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <Dialog open={pair === true} onOpenChange={(open) => void navigate({ search: (s) => ({ ...s, pair: open ? true : undefined }), replace: true })}>
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

/**
 * The groups with a screen that needs you, each naming those screens; groups that are fine take no
 * room. On a phone each is one line, side by side, so the screens stay in the first view.
 */
function NeedsAttention({ groups, screens, onPick }: { groups: GroupView[]; screens: ScreenView[]; onPick: (id: string) => void }) {
  const needing = needingAttention(groups, screens);
  if (!needing.length) return null;
  return (
    <section aria-labelledby="needs-attention" className="space-y-2">
      <h2 id="needs-attention" className="flex items-center gap-1.5 text-sm font-semibold">
        <TriangleAlertIcon className="size-4 text-status-needs-you-foreground" aria-hidden /> Needs attention
      </h2>
      <ul className="flex gap-2 overflow-x-auto sm:flex-wrap sm:gap-3 sm:overflow-visible">
        {needing.map(({ group: g, needs }) => (
          <li key={g.id} className="shrink-0 sm:min-w-0 sm:flex-[1_1_16rem]">
            {/* A filter, like the toolbar's: it waits for the page to hydrate (#140). */}
            <EditorFields>
              <button
                type="button"
                onClick={() => onPick(g.id)}
                className="flex min-h-10 w-full flex-col gap-1 rounded-xl border bg-card px-3.5 py-2 text-left outline-none hover:border-border-strong focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:px-4 sm:py-3"
              >
                <span className="flex items-baseline gap-2 text-md whitespace-nowrap">
                  <strong className="font-semibold">{g.name}</strong>
                  <span className="font-medium text-status-needs-you-foreground">
                    {needs.length} {needs.length === 1 ? 'needs' : 'need'} you
                  </span>
                </span>
                <span className="hidden truncate text-meta text-muted-foreground sm:block">{needs.map((s) => s.name).join(', ')}</span>
              </button>
            </EditorFields>
          </li>
        ))}
      </ul>
    </section>
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
        const where = groupsOf
          .get(s.id)
          ?.map((g) => g.name)
          .join(', ');
        return (
          <li key={s.id} className="relative flex flex-col overflow-hidden rounded-xl border bg-card focus-within:ring-[3px] focus-within:ring-ring/50">
            <div className="relative">
              <ScreenThumb screen={s} />
              <ScreenStatus screen={s} now={now} className="absolute top-2.5 left-2.5" />
              {/* Only a portrait screen says its ratio: landscape is every other tile's (#374). */}
              {s.orientation === 'portrait' && (
                <Badge variant="stage" className="absolute top-2.5 right-2.5 text-2xs tabular-nums">
                  9:16
                </Badge>
              )}
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
                {s.showing?.spot?.templateName && <span className="truncate text-xs text-muted-foreground">{s.showing.spot.templateName}</span>}
              </div>
              {Object.keys(s.labels).length > 0 && <LabelChips labels={s.labels} max={3} />}
              <p className="text-meta text-muted-foreground tabular-nums">
                {/* Nothing published is said once, by the thumbnail (#374). */}
                {[s.kind === 'browser' && 'Test screen', where, s.state.reason !== 'nothing_published' && d.line].filter(Boolean).join(' · ')}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** A section's heading: "store: 0142 · 3 screens", or "No store · 1 screen". */
const sectionTitle = (by: string, sec: LabelSection<ScreenView>) =>
  `${sec.value === null ? `No ${by}` : `${by}: ${sec.value}`} · ${sec.screens.length} ${sec.screens.length === 1 ? 'screen' : 'screens'}`;

/** One value's screens, when the page is grouped by a label key. */
function Section({ by, section, children }: { by: string; section: LabelSection<ScreenView>; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="text-base font-semibold">
        {sectionTitle(by, section)}
      </h2>
      {children}
    </section>
  );
}

/**
 * The label chips in the URL, each removable, and "+ Filter", which adds one from the keys and values the org's
 * screens have (`list_label_keys`). A chip on a key replaces that key's chip: a screen has one value of a key.
 */
function LabelFilterRow({ terms, keys, onChange }: { terms: LabelTerm[]; keys: LabelKey[]; onChange: (terms: LabelTerm[]) => void }) {
  const open = useAppStore((s) => s.labels.filter);
  const openLabelFilter = useAppStore((s) => s.openLabelFilter);
  const chooseFilterKey = useAppStore((s) => s.chooseFilterKey);
  const tickFilterValue = useAppStore((s) => s.tickFilterValue);
  const close = useAppStore((s) => s.closeLabelFilter);
  const id = useId();
  const values = keys.find((k) => k.key === open?.key)?.values ?? [];
  return (
    // A box of its own: EditorFields draws none, so the page's spacing would fall on nothing.
    <div>
      <EditorFields>
        <div className="flex flex-wrap items-center gap-2">
          {terms.length > 0 && (
            <ul aria-label="Label filters" className="flex flex-wrap gap-2">
              {terms.map((t) => (
                <li key={t.key}>
                  <span className="inline-flex items-center gap-1 rounded-full border border-border-strong bg-card py-0.5 pr-1 pl-3 text-sm">
                    <button
                      type="button"
                      className="rounded outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      onClick={() => openLabelFilter(t.key, t.values)}
                    >
                      <span className="text-muted-foreground">{t.key}:</span> {t.values.join(', ')}
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 rounded-full"
                      aria-label={`Remove filter ${t.key}`}
                      onClick={() => onChange(terms.filter((x) => x.key !== t.key))}
                    >
                      <XIcon aria-hidden />
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Button variant="outline" size="sm" onClick={() => openLabelFilter()} disabled={!keys.length}>
            <PlusIcon aria-hidden /> Filter
          </Button>
          {terms.length > 0 && (
            <Button variant="link" size="sm" onClick={() => onChange([])}>
              Clear filters
            </Button>
          )}
        </div>
        <Dialog open={open !== null} onOpenChange={(o) => !o && close()}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Filter by a label</DialogTitle>
              <DialogDescription>Screens with any of the values you tick. A filter on a key replaces that key&apos;s.</DialogDescription>
            </DialogHeader>
            {open && (
              <form
                className="grid gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!open.key || !open.values.length) return;
                  onChange(withTerm(terms, { key: open.key, values: open.values }));
                  close();
                }}
              >
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-key`}>Label</Label>
                  <NativeSelect id={`${id}-key`} value={open.key} onChange={(e) => chooseFilterKey(e.target.value)}>
                    <option value="">Choose a label</option>
                    {keys.map((k) => (
                      <option key={k.key} value={k.key}>
                        {k.key}
                        {k.system ? ' (from settings)' : ''}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                {values.length > 0 && (
                  <fieldset className="grid max-h-64 gap-2 overflow-y-auto">
                    <legend className="mb-1.5 text-sm font-medium">Values</legend>
                    {values.map((v) => (
                      <label key={v.value} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          checked={open.values.some((x) => x.trim().toLowerCase() === v.value.trim().toLowerCase())}
                          onChange={(e) => tickFilterValue(v.value, e.target.checked)}
                        />
                        {v.value} <span className="text-muted-foreground tabular-nums">({v.screens})</span>
                      </label>
                    ))}
                  </fieldset>
                )}
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={close}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={!open.key || !open.values.length}>
                    Apply
                  </Button>
                </DialogFooter>
              </form>
            )}
          </DialogContent>
        </Dialog>
      </EditorFields>
    </div>
  );
}

/**
 * What to do with the rows ticked: add them to a group or take them out of one, one call each.
 * Only the ticked rows the table shows count, so a filter changed since never acts on hidden ones.
 * The actions wrap, so more fit beside them.
 */
function SelectionBar({ orgId, selected, groups }: { orgId: string; selected: string[]; groups: GroupView[] }) {
  const busy = useAppStore((s) => s.screens.bulkPending);
  const add = useAppStore((s) => s.addScreensToGroup);
  const remove = useAppStore((s) => s.removeScreensFromGroup);
  const clear = useAppStore((s) => s.clearScreenSelection);
  const byNameGroups = [...groups].sort(byName);
  const holding = byNameGroups.filter((g) => g.screenIds.some((id) => selected.includes(id)));
  const menu = (label: string, choices: GroupView[], act: (g: GroupView) => void) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={!choices.length} aria-disabled={busy || undefined} className={cn(busy && 'opacity-60')}>
          {label} <ChevronDownIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {choices.map((g) => (
          <DropdownMenuItem key={g.id} onSelect={() => act(g)}>
            {g.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return (
    <section aria-label="Selected screens" className="flex flex-wrap items-center gap-2 rounded-xl border border-border-strong bg-card px-4 py-2.5">
      <p role="status" className="mr-2 text-sm font-medium tabular-nums">
        {selected.length} selected
      </p>
      <div className="flex flex-wrap gap-2">
        {menu('Add to group', byNameGroups, (g) => void add(orgId, g, selected))}
        {menu(
          'Remove from group',
          holding,
          (g) =>
            void remove(
              orgId,
              g,
              selected.filter((id) => g.screenIds.includes(id)),
            ),
        )}
      </div>
      <Button variant="ghost" size="sm" onClick={clear} className="ml-auto">
        <XIcon aria-hidden /> Clear selection
      </Button>
    </section>
  );
}

/** A column the table sorts by: a link to the sort, the other way when it is the sort already. */
function SortHeader({
  column,
  sort,
  align = 'left',
  children,
}: {
  column: 'name' | 'status' | 'heard';
  sort: ScreenSort;
  align?: 'left' | 'right';
  children: string;
}) {
  const desc: ScreenSort = `-${column}`;
  const on = sort === column ? 'ascending' : sort === desc ? 'descending' : undefined;
  const Arrow = on === 'descending' ? ArrowDownIcon : ArrowUpIcon;
  const next = on === 'ascending' ? desc : column;
  return (
    <th scope="col" aria-sort={on} className={cn('px-3 py-2.5 font-semibold', align === 'right' ? 'text-right' : 'text-left')}>
      <Link
        to="/screens"
        search={(prev) => ({ ...prev, sort: next === 'name' ? undefined : next })}
        replace
        className={cn(
          'inline-flex items-center gap-1 rounded outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
          on && 'text-foreground',
        )}
      >
        {children}
        <Arrow className={cn('size-3.5', !on && 'invisible')} aria-hidden />
      </Link>
    </th>
  );
}

/** A row's actions (#181): the schedule's dialogs, aimed at the screen. */
function RowMenu({ orgId, screen }: { orgId: string; screen: ScreenView }) {
  const canPublish = useCanPublish();
  const openNewEntry = useAppStore((s) => s.openNewEntry);
  const openTakeover = useAppStore((s) => s.openTakeover);
  const preset = { target: 'screen', screenId: screen.id } as const;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="ml-1 size-8" aria-label={`Actions for ${screen.name}`}>
          <MoreHorizontalIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => openNewEntry(orgId, preset)}>Play on this screen…</DropdownMenuItem>
        {canPublish && <DropdownMenuItem onSelect={() => openTakeover(orgId, preset)}>Take over this screen…</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ScreenTable({
  sections,
  by,
  groups,
  groupsOf,
  now,
  canManage,
  sort,
}: {
  /** The screens shown, in sections by a label key's value when `by` names one; one section otherwise. */
  sections: LabelSection<ScreenView>[];
  by: string | undefined;
  groups: GroupView[];
  groupsOf: Map<string, GroupView[]>;
  now: number;
  canManage: boolean;
  sort: ScreenSort;
}) {
  const orgId = useOrgId();
  const ticked = useAppStore((s) => selectedIn(s.screens, orgId));
  const select = useAppStore((s) => s.selectScreens);
  const screens = sections.flatMap((sec) => sec.screens);
  const columns = (canManage ? 1 : 0) + 9;
  const ids = screens.map((s) => s.id);
  const selected = ids.filter((id) => ticked.includes(id));
  const all = selected.length === ids.length;
  return (
    // The checkboxes change the store, so they wait for the page to hydrate (#140).
    <EditorFields>
      <div className="space-y-3">
        {canManage && selected.length > 0 && <SelectionBar orgId={orgId} selected={selected} groups={groups} />}
        <div className="relative overflow-x-auto rounded-xl border bg-card">
          <table className="w-full min-w-[68rem] border-collapse text-sm">
            <thead className="bg-muted text-xs tracking-wide text-muted-foreground uppercase">
              <tr>
                {canManage && (
                  <th scope="col" className="w-10 py-2.5 pl-4">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      aria-label="Select every screen shown"
                      checked={all}
                      ref={(el) => {
                        if (el) el.indeterminate = selected.length > 0 && !all;
                      }}
                      onChange={(e) => select(orgId, ids, e.target.checked)}
                    />
                  </th>
                )}
                <th scope="col" className="px-3 py-2.5 pl-4 text-left font-semibold">
                  Should be showing
                </th>
                <SortHeader column="name" sort={sort}>
                  Screen
                </SortHeader>
                <th scope="col" className="px-3 py-2.5 text-left font-semibold">
                  Labels
                </th>
                <SortHeader column="status" sort={sort}>
                  Status
                </SortHeader>
                <th scope="col" className="px-3 py-2.5 text-left font-semibold">
                  What it is doing
                </th>
                <th scope="col" className="px-3 py-2.5 text-left font-semibold">
                  Display hours
                </th>
                <th scope="col" className="px-3 py-2.5 text-right font-semibold">
                  Version
                </th>
                <SortHeader column="heard" sort={sort} align="right">
                  Last heard
                </SortHeader>
                <th scope="col" className="px-3 py-2.5 pr-4">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            {sections.map((sec) => (
              <tbody key={sec.value ?? ''}>
                {by && (
                  <tr className="border-t bg-muted/40">
                    <th scope="rowgroup" colSpan={columns} className="px-4 py-2 text-left text-sm font-semibold">
                      {sectionTitle(by, sec)}
                    </th>
                  </tr>
                )}
                {sec.screens.map((s) => {
                  const d = describeScreen(s, now);
                  const v = versionText(s);
                  return (
                    <tr key={s.id} className="h-9 border-t hover:bg-muted/50">
                      {canManage && (
                        <td className="py-1.5 pl-4">
                          <input
                            type="checkbox"
                            className="size-4 accent-primary"
                            aria-label={`Select ${s.name}`}
                            checked={selected.includes(s.id)}
                            onChange={(e) => select(orgId, [s.id], e.target.checked)}
                          />
                        </td>
                      )}
                      <td className="py-1.5 pr-3 pl-4">
                        <ScreenThumb screen={s} size="row" className="w-24 rounded" />
                      </td>
                      <th scope="row" className="px-3 py-1.5 text-left font-semibold whitespace-nowrap">
                        <Link to="/screens/$screenId" params={{ screenId: s.id }} className="hover:underline">
                          {s.name}
                        </Link>
                        <div className="text-meta font-normal text-muted-foreground">
                          {s.kind === 'browser' && 'Test screen · '}
                          {groupsOf
                            .get(s.id)
                            ?.map((g) => g.name)
                            .join(', ') || 'No group'}
                        </div>
                      </th>
                      <td className="w-60 min-w-60 px-3 py-1.5">
                        <LabelChips labels={s.labels} max={3} />
                      </td>
                      <td className="px-3 py-1.5">
                        <ScreenStatus screen={s} now={now} />
                      </td>
                      <td className="max-w-[28rem] min-w-48 px-3 py-1.5 leading-snug text-foreground/85 tabular-nums">{d.line}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap text-muted-foreground">{describeHours(s.displayHours)}</td>
                      <td
                        className={cn(
                          'px-3 py-1.5 text-right font-mono text-meta whitespace-nowrap tabular-nums',
                          v.behind ? 'text-status-updating-foreground' : 'text-muted-foreground',
                        )}
                      >
                        {v.text}
                      </td>
                      <td
                        className="px-3 py-1.5 text-right text-meta whitespace-nowrap text-muted-foreground tabular-nums"
                        title={s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString() : undefined}
                      >
                        {s.lastSeenAt ? `${ago(now - s.lastSeenAt)} ago` : 'never'}
                      </td>
                      <td className="px-3 py-1.5 pr-4 text-right whitespace-nowrap">
                        {s.state.kind === 'needs_you' && (
                          <Button asChild variant="outline" size="sm">
                            <Link to="/screens/$screenId" params={{ screenId: s.id }} aria-label={`Troubleshoot ${s.name}`}>
                              Troubleshoot
                            </Link>
                          </Button>
                        )}
                        {canManage && !isRetired(s) && <RowMenu orgId={orgId} screen={s} />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </table>
        </div>
      </div>
    </EditorFields>
  );
}
