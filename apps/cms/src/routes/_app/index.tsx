/**
 * Overview (#357): the org's status, most urgent first. Screens that need someone, what the awake
 * screens play, drafts not published yet, and the latest publish. A new org also gets a setup
 * checklist (#334), whose steps tick themselves off from its data, until every step is done or the
 * member hides it. What screens are doing stays current while it is open, as on Screens.
 */
import { sessionBlobPath } from '@signforge/contract';
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router';
import { CircleCheckIcon, XIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { PageHeader, ROW_LINK, RowText } from '~/components/page';
import { LatestPublish } from '~/components/publishes/latest-publish';
import { StatusGlyph } from '~/components/screens/status';
import { Button } from '~/components/ui/button';
import { withStatus } from '~/lib/fleet-status';
import { useCanManage, useNow, useOrgId } from '~/lib/live';
import { playingNow, setupSteps, templateThumbnail, unpublished, type Playing, type SetupStep, type Unpublished } from '~/lib/overview';
import { describeScreen, isRetired, summarise } from '~/lib/screen-status';
import type { ScreenView } from '~/lib/screen-types';
import { playlistsQuery } from '~/queries/playlists';
import { publishQuery } from '~/queries/publishes';
import { scheduleQuery } from '~/queries/schedule';
import { screensQuery, screenStatusQuery } from '~/queries/screens';
import { spotsQuery } from '~/queries/spots';
import { useAppStore } from '~/state/provider';

const app = getRouteApi('/_app');

export const Route = createFileRoute('/_app/')({
  loader: async ({ context: { queryClient }, parentMatchPromise }) => {
    const orgId = (await parentMatchPromise).loaderData?.organization?.id;
    if (!orgId) return;
    await Promise.all([
      queryClient.query({ ...screensQuery(orgId), staleTime: 0 }),
      queryClient.query(spotsQuery(orgId)),
      queryClient.query(playlistsQuery(orgId)),
      queryClient.query(scheduleQuery(orgId)),
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
  const { data: live } = useQuery(screenStatusQuery(orgId));
  const { spots } = useSuspenseQuery(spotsQuery(orgId)).data;
  const { playlists } = useSuspenseQuery(playlistsQuery(orgId)).data;
  const { entries } = useSuspenseQuery(scheduleQuery(orgId)).data;
  const now = useNow(Math.max(data.at, live?.at ?? 0));
  const screens = withStatus(data.screens, data.at, live).filter((s) => !isRetired(s));

  return (
    <div className="space-y-8">
      <PageHeader title={shell.organization?.name ?? 'Overview'} />
      <Setup orgId={orgId} steps={setupSteps({ spots, playlists, screens })} firstPlaylist={playlists.find((p) => p.spotIds.length > 0)} />
      <NeedsYou screens={screens} now={now} />
      <PlayingNow rows={playingNow(screens)} />
      <Drafts rows={unpublished({ spots, playlists, entries })} />
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
  { key: 'screen', title: 'Pair a screen, or use the test screen', body: 'Pair a display by the code it shows, or open the test screen in this browser.' },
];

/**
 * The setup checklist, for members who can do its steps. It goes once every step is done, or when
 * the member hides it (per browser, `ui.setupHidden`).
 */
function Setup({ orgId, steps, firstPlaylist }: { orgId: string; steps: Record<SetupStep, boolean>; firstPlaylist: { id: string; name: string } | undefined }) {
  const canManage = useCanManage();
  const hidden = useAppStore((s) => s.ui.setupHidden.includes(orgId));
  const hide = useAppStore((s) => s.hideSetup);
  const newSpot = useAppStore((s) => s.openNewSpot);
  const newPlaylist = useAppStore((s) => s.openNewPlaylist);
  const done = STEPS.filter((s) => steps[s.key]).length;
  if (!canManage || hidden || done === STEPS.length) return null;

  const action: Record<SetupStep, ReactNode> = {
    spot: (
      <Link to="/spots" onClick={() => newSpot(true)}>
        New spot
      </Link>
    ),
    default: firstPlaylist ? (
      <Link to="/playlists/$playlistId" params={{ playlistId: firstPlaylist.id }}>
        Open {firstPlaylist.name}
      </Link>
    ) : (
      <Link to="/playlists" onClick={() => newPlaylist(true)}>
        New playlist
      </Link>
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
        {STEPS.map((s, i) => (
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
                <span className={steps[s.key] ? 'block font-medium text-muted-foreground' : 'block font-medium'}>
                  {s.title}
                  <span className="sr-only">{steps[s.key] ? ' (done)' : ' (to do)'}</span>
                </span>
                {!steps[s.key] && <span className="block text-sm text-muted-foreground">{s.body}</span>}
              </span>
            </span>
            {!steps[s.key] && (
              <Button asChild variant="outline" className="ml-9 self-start sm:ml-0 sm:self-auto">
                {action[s.key]}
              </Button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

const LIST = 'divide-y overflow-hidden rounded-xl border bg-card';

/** The screens that need someone, each with why, in the one red; or a line that none do. */
function NeedsYou({ screens, now }: { screens: ScreenView[]; now: number }) {
  const needing = screens.filter((s) => s.state.kind === 'needs_you');
  return (
    <Section id="needs-you" title={needing.length ? <span className="text-status-needs-you-foreground">Needs you · {needing.length}</span> : 'Needs you'}>
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
        <p className="text-muted-foreground">
          {screens.length ? `Nothing needs you. ${summarise(screens)}.` : 'Nothing needs you. No screens are paired yet.'}
        </p>
      )}
    </Section>
  );
}

/** What awake screens play now, by their first spot, with its template's thumbnail. */
function PlayingNow({ rows }: { rows: Playing[] }) {
  return (
    <Section id="playing-now" title="Playing now">
      {rows.length ? (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((r) => (
            <li key={r.spot.id}>
              <Link
                to="/spots/$spotId"
                params={{ spotId: r.spot.id }}
                className="group flex h-full flex-col overflow-hidden rounded-xl border bg-card outline-none hover:border-primary/40 focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <SpotThumb spot={r.spot} />
                <span className="space-y-0.5 px-4 py-3">
                  <span className="block truncate font-medium group-hover:underline">{r.spot.name}</span>
                  <span className="block truncate text-sm text-muted-foreground">
                    On {r.screens === 1 ? '1 screen' : `${r.screens} screens`}
                    {r.playlist && ` · ${r.playlist}`}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">No screen is playing anything yet.</p>
      )}
    </Section>
  );
}

/** The spot's own image, else its template's thumbnail, else a plain tile: the name is beside it. */
function SpotThumb({ spot }: { spot: Playing['spot'] }) {
  const src = spot.image ? sessionBlobPath(spot.image) : spot.template && templateThumbnail(spot.template);
  return src ? (
    <img src={src} alt="" width={480} height={270} loading="lazy" className="aspect-video w-full bg-muted object-cover" />
  ) : (
    <span aria-hidden className="aspect-video w-full bg-muted" />
  );
}

const KIND: Record<Unpublished['kind'], string> = { spot: 'Spot', playlist: 'Playlist', entry: 'Schedule' };
/** How many drafts the list names; the rest are counted. */
const SHOWN = 5;

/** Drafts whose changes screens do not have yet, newest edit first. */
function Drafts({ rows }: { rows: Unpublished[] }) {
  return (
    <Section id="unpublished" title="Unpublished drafts">
      {rows.length ? (
        <>
          <ul className={LIST}>
            {rows.slice(0, SHOWN).map((r) => (
              <li key={`${r.kind}:${r.id}`}>
                <DraftLink row={r}>
                  <RowText title={r.name}>
                    {KIND[r.kind]} · {r.word}
                  </RowText>
                </DraftLink>
              </li>
            ))}
          </ul>
          {rows.length > SHOWN && <p className="text-sm text-muted-foreground">And {rows.length - SHOWN} more.</p>}
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
