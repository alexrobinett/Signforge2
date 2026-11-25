/**
 * Overview (#357): the org's status, most urgent first. Screens that need someone, what the awake
 * screens play, drafts not published yet, and the latest publish. A new org also gets a setup
 * checklist (#334), whose steps tick themselves off from its data, until every step is done or the
 * member hides it. What screens are doing stays current while it is open, from the Screens page's
 * own poll, and says when it is not.
 */
import { sessionBlobPath } from '@signforge/contract';
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router';
import { CircleCheckIcon, XIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { PageHeader, ROW_LINK, RowText } from '~/components/page';
import { LatestPublish } from '~/components/publishes/latest-publish';
import { NotCurrent } from '~/components/screens/not-current';
import { StatusGlyph } from '~/components/screens/status';
import { Button } from '~/components/ui/button';
import { withStatus } from '~/lib/fleet-status';
import { useCanManage, useCanPublish, useNow, useOrgId } from '~/lib/live';
import { playingNow, setupSteps, unpublished, type Playing, type SetupStep, type Unpublished } from '~/lib/overview';
import { describeScreen, isRetired, summarise } from '~/lib/screen-status';
import type { ScreenView } from '~/lib/screen-types';
import { templateThumbnail } from '~/lib/template-thumbnail';
import { overviewQuery } from '~/queries/overview';
import { publishQuery } from '~/queries/publishes';
import { screensQuery, screenStatusQuery } from '~/queries/screens';
import { useAppStore } from '~/state/provider';

const app = getRouteApi('/_app');

export const Route = createFileRoute('/_app/')({
  loader: async ({ context: { queryClient }, parentMatchPromise }) => {
    const orgId = (await parentMatchPromise).loaderData?.organization?.id;
    if (!orgId) return;
    await Promise.all([
      queryClient.query({ ...screensQuery(orgId), staleTime: 0 }),
      queryClient.query({ ...overviewQuery(orgId), staleTime: 0 }),
      queryClient.query(publishQuery(orgId, null)),
    ]);
  },
  head: () => ({ meta: [{ title: 'Overview · SignForge' }] }),
  component: Overview,
});

function Overview() {
  const shell = app.useLoaderData();
  const orgId = useOrgId();
  const { data } = useSuspenseQuery(screensQuery(orgId));
  const { data: live, errorUpdatedAt, dataUpdatedAt } = useQuery(screenStatusQuery(orgId));
  const overview = useSuspenseQuery(overviewQuery(orgId)).data;
  const heardAt = Math.max(data.at, live?.at ?? 0);
  const now = useNow(heardAt);
  const screens = withStatus(data.screens, data.at, live).filter((s) => !isRetired(s));

  return (
    <div className="space-y-8">
      <PageHeader title={shell.organization?.name ?? 'Overview'} />
      {/* Not `isError`: a query with no data yet goes back to pending on each retry (as on Screens). */}
      <NotCurrent failing={errorUpdatedAt > dataUpdatedAt} heardAt={heardAt} now={now} />
      <Setup orgId={orgId} steps={setupSteps({ ...overview, screens })} defaultPlaylist={overview.defaultPlaylist} />
      <NeedsYou screens={screens} now={now} />
      <PlayingNow rows={playingNow(screens)} anyScreen={screens.length > 0} />
      <Drafts rows={unpublished(overview)} total={overview.drafts} />
      <LatestPublish orgId={orgId} now={now} />
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

const STEPS: { key: SetupStep; title: string; body: string }[] = [
  { key: 'spot', title: 'Make a spot from a template', body: 'Pick a template and put in your words and pictures.' },
  { key: 'default', title: 'Put it in a playlist and make that the default', body: 'Every screen plays the default playlist when nothing is scheduled.' },
  {
    key: 'screen',
    title: 'Pair a screen, or use the test screen',
    body: 'Pair a display by the code it shows, or open the test screen in this browser, then publish so it plays.',
  },
];

/**
 * The setup checklist, for members who can do its steps. It goes once every step is done, or when
 * the member hides it (per browser, `ui.setupHidden`). Choosing the default needs the right to
 * publish, so where only owners publish an editor sees that step as an owner's, with no button.
 */
function Setup({ orgId, steps, defaultPlaylist }: { orgId: string; steps: Record<SetupStep, boolean>; defaultPlaylist: { id: string; name: string } | null }) {
  const canManage = useCanManage();
  const canPublish = useCanPublish();
  const hidden = useAppStore((s) => s.ui.setupHidden.includes(orgId));
  const hide = useAppStore((s) => s.hideSetup);
  const newSpot = useAppStore((s) => s.openNewSpot);
  const done = STEPS.filter((s) => steps[s.key]).length;
  if (!canManage || hidden || done === STEPS.length) return null;

  const action: Record<SetupStep, ReactNode> = {
    spot: (
      <Link to="/spots" onClick={() => newSpot(true)}>
        New spot
      </Link>
    ),
    default: defaultPlaylist ? (
      <Link to="/playlists/$playlistId" params={{ playlistId: defaultPlaylist.id }}>
        Open {defaultPlaylist.name}
      </Link>
    ) : (
      <Link to="/playlists">Open playlists</Link>
    ),
    screen: <Link to="/screens">Pair a screen</Link>,
  };

  return (
    <section aria-labelledby="setup-title" className="rounded-xl border bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 id="setup-title" className="text-lg font-semibold">
            Get your first spot on a screen
          </h2>
          <p className="text-sm text-muted-foreground">
            {done} of {STEPS.length} done
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={() => hide(orgId)} aria-label="Hide the setup checklist">
          <XIcon aria-hidden />
        </Button>
      </div>
      <ol className="mt-4 divide-y">
        {STEPS.map((s, i) => {
          const owners = s.key === 'default' && !canPublish && !steps[s.key];
          return (
            <li key={s.key} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center">
              <span className="flex min-w-0 flex-1 items-start gap-3">
                {steps[s.key] ? (
                  <CircleCheckIcon className="mt-0.5 size-6 shrink-0 text-status-online" aria-hidden />
                ) : (
                  <span aria-hidden className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border text-sm font-medium">
                    {i + 1}
                  </span>
                )}
                <span className="min-w-0">
                  <span className={steps[s.key] || owners ? 'block font-medium text-muted-foreground' : 'block font-medium'}>
                    {owners ? 'An owner sets the default' : s.title}
                    <span className="sr-only">{steps[s.key] ? ' (done)' : owners ? ' (for an owner)' : ' (to do)'}</span>
                  </span>
                  {!steps[s.key] && (
                    <span className="block text-sm text-muted-foreground">
                      {owners ? 'Only owners publish here, and the default comes with a publish.' : s.body}
                    </span>
                  )}
                </span>
              </span>
              {!steps[s.key] && !owners && (
                // A playlist's name may be 100 letters with no space: the button wraps it rather than widen a phone's page.
                <Button
                  asChild
                  variant="outline"
                  className="ml-9 h-auto min-h-9 max-w-full self-start py-2 text-left whitespace-normal wrap-anywhere sm:ml-0 sm:self-auto"
                >
                  {action[s.key]}
                </Button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const LIST = 'divide-y overflow-hidden rounded-xl border bg-card';

/** The screens that need someone, each with why, in the one red; or a line that none do. */
function NeedsYou({ screens, now }: { screens: ScreenView[]; now: number }) {
  const needing = screens.filter((s) => s.state.kind === 'needs_you');
  return (
    <Section
      id="needs-you"
      title={needing.length ? <span className="text-status-needs-you-foreground tabular-nums">Needs you · {needing.length}</span> : 'Needs you'}
    >
      {needing.length ? (
        <ul className={LIST}>
          {needing.map((s) => (
            <li key={s.id}>
              <Link to="/screens/$screenId" params={{ screenId: s.id }} className={ROW_LINK}>
                <StatusGlyph tone="needs-you" className="size-4" />
                <RowText title={s.name}>{describeScreen(s, now).line}</RowText>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground tabular-nums">
          {screens.length ? `Nothing needs you. ${summarise(screens)}.` : 'Nothing needs you. No screens are paired yet.'}
        </p>
      )}
    </Section>
  );
}

/** What awake screens play now, by their first spot, with its template's thumbnail. */
function PlayingNow({ rows, anyScreen }: { rows: Playing[]; anyScreen: boolean }) {
  return (
    <Section id="playing-now" title="Playing now">
      {rows.length ? (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((r) => (
            <li key={r.spot.id}>
              <Link
                to="/spots/$spotId"
                params={{ spotId: r.spot.id }}
                className="group flex h-full flex-col overflow-hidden rounded-xl border bg-card outline-none hover:border-primary/40 focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <SpotThumb spot={r.spot} />
                <span className="space-y-0.5 px-4 py-3">
                  <span className="block truncate font-medium group-hover:underline">{r.spot.name}</span>
                  <span className="block truncate text-sm text-muted-foreground tabular-nums">
                    On {r.screens === 1 ? '1 screen' : `${r.screens} screens`}
                    {r.playlist && ` · ${r.playlist}`}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">
          {anyScreen ? 'None of the screens is playing its latest publish right now.' : 'No screen is playing anything yet.'}
        </p>
      )}
    </Section>
  );
}

/**
 * The spot's own image, else its template version's thumbnail, else a plain tile: the name is beside it. A
 * manifest names its template by key (`base/clock@1.2.4`): its owner, then its id.
 */
function SpotThumb({ spot }: { spot: Playing['spot'] }) {
  const t = spot.template;
  const src = spot.image ? sessionBlobPath(spot.image) : t && templateThumbnail(t);
  return src ? (
    <img src={src} alt="" width={480} height={270} loading="lazy" className="aspect-video w-full bg-muted object-cover" />
  ) : (
    <span aria-hidden className="aspect-video w-full bg-muted" />
  );
}

const KIND: Record<Unpublished['kind'], string> = { spot: 'Spot', playlist: 'Playlist', entry: 'Schedule' };

/** Drafts whose changes screens do not have yet: the newest edits by name, and how many more. */
function Drafts({ rows, total }: { rows: Unpublished[]; total: number }) {
  return (
    <Section id="unpublished" title="Unpublished drafts">
      {rows.length ? (
        <>
          <ul className={LIST}>
            {rows.map((r) => (
              <li key={`${r.kind}:${r.id}`}>
                <DraftLink row={r}>
                  <RowText title={r.name}>
                    {KIND[r.kind]} · {r.word}
                  </RowText>
                </DraftLink>
              </li>
            ))}
          </ul>
          {total > rows.length && <p className="text-sm text-muted-foreground">And {total - rows.length} more.</p>}
        </>
      ) : (
        <p className="text-muted-foreground">Everything is published.</p>
      )}
    </Section>
  );
}

function DraftLink({ row, children }: { row: Unpublished; children: ReactNode }) {
  switch (row.kind) {
    case 'spot':
      return (
        <Link to="/spots/$spotId" params={{ spotId: row.id }} className={ROW_LINK}>
          {children}
        </Link>
      );
    case 'playlist':
      return (
        <Link to="/playlists/$playlistId" params={{ playlistId: row.id }} className={ROW_LINK}>
          {children}
        </Link>
      );
    case 'entry':
      return (
        <Link to="/schedule" className={ROW_LINK}>
          {children}
        </Link>
      );
  }
}
