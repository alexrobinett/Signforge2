/**
 * The schedule entry and takeover dialogs, for every page (#181): the Schedule page, a screen's page,
 * the Screens table, a playlist's page and ⌘K open them with the schedule slice's `openNewEntry` and
 * `openTakeover`. They read the playlists, screens and schedule they need once one is open.
 */
import { useQuery } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '~/components/ui/dialog';
import { useNow, useOrgId } from '~/lib/live';
import { playlistsQuery } from '~/queries/playlists';
import { scheduleQuery } from '~/queries/schedule';
import { screensQuery } from '~/queries/screens';
import { useAppStore } from '~/state/provider';
import { DIALOG } from '~/state/schedule';
import { EntryDialog } from './entry-dialog';
import { TakeoverDialog } from './takeover-dialog';

export function ScheduleDialogs() {
  const orgId = useOrgId();
  // A dialog opened in another org is not this page's.
  const open = useAppStore((s) => s.schedule.entries[DIALOG]?.orgId === orgId || s.schedule.takeovers[DIALOG]?.orgId === orgId);
  return orgId && open ? <OpenDialog orgId={orgId} /> : null;
}

function OpenDialog({ orgId }: { orgId: string }) {
  const playlists = useQuery(playlistsQuery(orgId)).data?.playlists;
  const fleet = useQuery(screensQuery(orgId)).data;
  const entries = useQuery(scheduleQuery(orgId)).data?.entries;
  const close = useAppStore((s) => s.closeScheduleDialog);
  const now = useNow(fleet?.at ?? 0);
  if (!playlists || !fleet || !entries)
    return (
      <Dialog open onOpenChange={(o) => !o && close()}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Schedule</DialogTitle>
            <DialogDescription className="flex items-center gap-2">
              <LoaderCircleIcon className="size-4 animate-spin" aria-hidden /> Reading the playlists and screens…
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  const { screens, groups } = fleet;
  return (
    <>
      <EntryDialog orgId={orgId} playlists={playlists} screens={screens} groups={groups} entries={entries} now={now} />
      <TakeoverDialog orgId={orgId} playlists={playlists} screens={screens} groups={groups} now={now} />
    </>
  );
}
