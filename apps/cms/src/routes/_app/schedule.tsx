/**
 * Schedule (M3-19): which playlist plays on which screens and when. Takeovers running or to come,
 * each with End now; the schedule entries, each with Edit and Remove; and the week of one screen,
 * hour by hour, as drafted (canvas board Idea 9, the time scrubber, as a week). Entries are drafts
 * until Publish; a takeover is sent at once. Where no entry applies, screens play the default
 * playlist, chosen from a playlist (Play on every screen).
 */
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { LoaderCircleIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import type { ReactNode } from 'react';
import { EditorFields } from '~/components/editor';
import { EmptyState, PageHeader } from '~/components/page';
import { WeekView } from '~/components/schedule/week-view';
import { Button } from '~/components/ui/button';
import { useCanManage, useCanPublish, useNow, useOrgId } from '~/lib/live';
import { aimedAt, describeWhen, runsAfter, stateWord, timeWord } from '~/lib/schedule';
import { sectionFor } from '~/lib/sections';
import { playlistsQuery } from '~/queries/playlists';
import { scheduleQuery } from '~/queries/schedule';
import { screensQuery } from '~/queries/screens';
import { useAppStore } from '~/state/provider';

const section = sectionFor('/schedule');

export const Route = createFileRoute('/_app/schedule')({
  loader: async ({ context: { queryClient }, parentMatchPromise }) => {
    const orgId = (await parentMatchPromise).loaderData?.organization?.id;
    if (!orgId) return;
    await Promise.all([queryClient.query(scheduleQuery(orgId)), queryClient.query(playlistsQuery(orgId)), queryClient.query(screensQuery(orgId))]);
  },
  head: () => ({ meta: [{ title: `${section.label} · SignForge` }] }),
  component: SchedulePage,
});

function SchedulePage() {
  const orgId = useOrgId();
  const canManage = useCanManage();
  const canPublish = useCanPublish();
  const { entries } = useSuspenseQuery(scheduleQuery(orgId)).data;
  const { playlists } = useSuspenseQuery(playlistsQuery(orgId)).data;
  const { screens, groups, at } = useSuspenseQuery(screensQuery(orgId)).data;
  const now = useNow(at);
  const publishing = useAppStore((s) => s.publishing.pending);
  const openNewEntry = useAppStore((s) => s.openNewEntry);
  const openEditEntry = useAppStore((s) => s.openEditEntry);
  const removeEntry = useAppStore((s) => s.removeEntry);
  const openTakeover = useAppStore((s) => s.openTakeover);
  const endTakeover = useAppStore((s) => s.endTakeover);
  const publishSchedule = useAppStore((s) => s.publishSchedule);

  const names = new Map(playlists.map((p) => [p.id, p.name]));
  const fallback = playlists.find((p) => p.isDefault);
  // Running or to come, as drafted or as screens have it.
  const takeovers = entries.filter((e) => e.takeover && (runsAfter(e, now) || runsAfter(e.live, now)));
  const scheduled = entries.filter((e) => !e.takeover);

  return (
    // Until the page hydrates, a click on its controls would go nowhere (#136).
    <EditorFields>
      <div className="space-y-8">
        <PageHeader title={section.label} description={section.description}>
          <div className="flex flex-wrap gap-2">
            {canPublish && (
              <Button variant="outline" onClick={() => openTakeover(orgId)} disabled={!playlists.length}>
                Take over screens
              </Button>
            )}
            {canManage && (
              <Button variant="outline" onClick={() => openNewEntry(orgId)} disabled={!playlists.length}>
                Schedule a playlist
              </Button>
            )}
            {canPublish && (
              <Button onClick={() => void publishSchedule(orgId)} disabled={publishing}>
                {publishing && <LoaderCircleIcon className="animate-spin" aria-hidden />} Publish
              </Button>
            )}
          </div>
        </PageHeader>

        <p className="text-sm">
          {fallback ? (
            <>
              Where no entry applies, every screen plays{' '}
              <Link to="/playlists/$playlistId" params={{ playlistId: fallback.id }} className="font-medium underline underline-offset-4">
                {fallback.name}
              </Link>
              , the default playlist.
            </>
          ) : (
            <>No default playlist yet: open a playlist and choose Play on every screen, or no screen can be published to.</>
          )}
        </p>

        {takeovers.length > 0 && (
          <Part title="Takeovers">
            <ul className="divide-y overflow-hidden rounded-xl border bg-card">
              {takeovers.map((e) => {
                // What screens have, else the draft: only a published takeover is playing.
                const shown = e.live ?? e;
                const playing = e.live !== null && Date.parse(e.live.startsAt ?? '') <= now && runsAfter(e.live, now);
                return (
                  <li key={e.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{names.get(e.playlistId) ?? 'A removed playlist'}</p>
                      <p className="text-sm text-muted-foreground">
                        {aimedAt(e, screens, groups)} · {playing ? 'Playing' : `From ${timeWord(shown.startsAt ?? '')}`} until {timeWord(shown.endsAt ?? '')}{' '}
                        your time · {stateWord(e)}
                      </p>
                    </div>
                    {canPublish && (
                      <Button variant="outline" size="sm" onClick={() => void endTakeover(orgId, e.id)} disabled={publishing}>
                        End now
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </Part>
        )}

        <Part title="Entries">
          {scheduled.length ? (
            <ul className="divide-y overflow-hidden rounded-xl border bg-card">
              {scheduled.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{names.get(e.playlistId) ?? 'A removed playlist'}</p>
                    <p className="text-sm text-muted-foreground">
                      {aimedAt(e, screens, groups)} · {describeWhen(e)}
                      {e.priority > 0 && ` · priority ${e.priority}`} · {stateWord(e)}
                    </p>
                  </div>
                  {/* Removing what screens play needs the right to publish; a removal waits for the next publish. */}
                  {canManage && !e.deleted && (
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Change ${names.get(e.playlistId) ?? 'entry'} on ${aimedAt(e, screens, groups)}`}
                        onClick={() => openEditEntry(orgId, e)}
                      >
                        <PencilIcon aria-hidden />
                      </Button>
                      {(!e.published || canPublish) && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove ${names.get(e.playlistId) ?? 'entry'} on ${aimedAt(e, screens, groups)}`}
                          onClick={() => void removeEntry(orgId, e)}
                        >
                          <Trash2Icon aria-hidden />
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={section.icon} title={section.empty.title}>
              {section.empty.body}
            </EmptyState>
          )}
        </Part>

        {fallback && (
          <Part title="Week">
            <WeekView screens={screens} groups={groups} entries={entries} playlists={playlists} defaultPlaylistId={fallback.id} now={now} />
          </Part>
        )}
      </div>
    </EditorFields>
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3" aria-label={title}>
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}
