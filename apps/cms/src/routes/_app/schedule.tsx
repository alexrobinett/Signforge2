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
import { EntryDialog } from '~/components/schedule/entry-dialog';
import { TakeoverDialog } from '~/components/schedule/takeover-dialog';
import { WeekView } from '~/components/schedule/week-view';
import { Button } from '~/components/ui/button';
import { useCanManage, useCanPublish, useNow, useOrgId } from '~/lib/live';
import { describeWhen, type ScheduleEntryView } from '~/lib/schedule';
import type { GroupView, ScreenView } from '~/lib/screen-types';
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

/** "Every screen", "Group Front", or the screen's name. */
function aimedAt(e: ScheduleEntryView, screens: ScreenView[], groups: GroupView[]): string {
  if (e.target === 'group') return `Group ${groups.find((g) => g.id === e.groupId)?.name ?? 'removed'}`;
  if (e.target === 'screen') return screens.find((s) => s.id === e.screenId)?.name ?? 'A removed screen';
  return 'Every screen';
}

const stateWord = (e: ScheduleEntryView) => (!e.published ? 'Draft, not published' : e.draftChanged ? 'Changes not published' : 'Published');

const timeWord = (iso: string) => new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

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
  const takeovers = entries.filter((e) => e.takeover && e.endsAt && Date.parse(e.endsAt) > now);
  const scheduled = entries.filter((e) => !e.takeover);

  return (
    // Until the page hydrates, a click on its controls would go nowhere (#136).
    <EditorFields>
      <div className="space-y-8">
        <PageHeader title={section.label} description={section.description}>
          {canPublish && (
            <Button variant="outline" onClick={() => openTakeover()} disabled={!playlists.length}>
              Take over screens
            </Button>
          )}
          {canManage && (
            <Button variant="outline" onClick={() => openNewEntry()} disabled={!playlists.length}>
              Schedule a playlist
            </Button>
          )}
          {canPublish && (
            <Button onClick={() => void publishSchedule(orgId)} disabled={publishing}>
              {publishing && <LoaderCircleIcon className="animate-spin" aria-hidden />} Publish
            </Button>
          )}
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
                const started = e.startsAt !== null && Date.parse(e.startsAt) <= now;
                return (
                  <li key={e.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{names.get(e.playlistId) ?? 'A removed playlist'}</p>
                      <p className="text-sm text-muted-foreground">
                        {aimedAt(e, screens, groups)} · {started ? 'Playing' : `From ${timeWord(e.startsAt ?? '')}`} until {timeWord(e.endsAt ?? '')} ·{' '}
                        {stateWord(e)}
                      </p>
                    </div>
                    {canPublish && (
                      <Button variant="outline" size="sm" onClick={() => void endTakeover(orgId, e)} disabled={publishing}>
                        End now
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </Part>
        )}

        <Part title="Schedule">
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
                  {canManage && (
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Change ${names.get(e.playlistId) ?? 'entry'} on ${aimedAt(e, screens, groups)}`}
                        onClick={() => openEditEntry(e)}
                      >
                        <PencilIcon aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${names.get(e.playlistId) ?? 'entry'} on ${aimedAt(e, screens, groups)}`}
                        onClick={() => void removeEntry(orgId, e)}
                      >
                        <Trash2Icon aria-hidden />
                      </Button>
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

        <EntryDialog orgId={orgId} playlists={playlists} screens={screens} groups={groups} />
        <TakeoverDialog orgId={orgId} playlists={playlists} screens={screens} groups={groups} now={now} />
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
