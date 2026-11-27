/**
 * The sidebar's "N unpublished changes · Publish" (#361): drafts left unpublished stay in sight on
 * every page. For a member who may publish it reads every change now and asks, showing what goes
 * and what it does with no default playlist (`PublishAllDialog`, one in the shell, outside both
 * sidebars, so a phone's drawer does not hide it); the publish is exactly what it showed. For one
 * who may not publish it opens Overview's list.
 */
import { Link } from '@tanstack/react-router';
import { LoaderCircleIcon, SendIcon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog';
import { Button } from '~/components/ui/button';
import { SidebarMenuButton } from '~/components/ui/sidebar';
import { useCanPublish } from '~/lib/live';
import { useOpenerFocus } from '~/lib/opener-focus';
import { cn } from '~/lib/utils';
import { MAX_PINS, type PublishAll, type PublishPreview } from '~/state/publishing';
import { useAppStore } from '~/state/provider';

export interface DraftCounts {
  spots: number;
  playlists: number;
  schedule: number;
}

const count = (n: number, one: string, many: string) => (n ? [`${n} ${n === 1 ? one : many}`] : []);
const changes = (n: number) => `${n} unpublished ${n === 1 ? 'change' : 'changes'}`;

/** "2 spots, 1 playlist and 1 schedule entry". */
function whatGoes(c: DraftCounts): string {
  const parts = [
    ...count(c.spots, 'spot', 'spots'),
    ...count(c.playlists, 'playlist', 'playlists'),
    ...count(c.schedule, 'schedule entry', 'schedule entries'),
  ];
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '');
}

export function UnpublishedChanges({ orgId, counts, folded }: { orgId: string; counts: DraftCounts; folded: boolean }) {
  const canPublish = useCanPublish();
  const ask = useAppStore((s) => s.askPublishAll);
  const total = counts.spots + counts.playlists + counts.schedule;
  if (!total) return null;
  const label = changes(total);

  if (!canPublish)
    return (
      <SidebarMenuButton folded={folded} tooltip={label}>
        <Link to="/" hash="unpublished">
          <SendIcon aria-hidden />
          <span>{label}</span>
        </Link>
      </SidebarMenuButton>
    );

  return (
    // Its words wrap rather than truncate: the sidebar is narrower than "12 unpublished changes · Publish".
    <SidebarMenuButton folded={folded} tooltip={`${label} · Publish`} className={cn('text-foreground', !folded && 'h-auto min-h-10 py-2')}>
      <button type="button" onClick={() => void ask(orgId)}>
        <SendIcon aria-hidden className="text-primary" />
        <span className="text-left">
          {label} · <span className="text-primary">Publish</span>
        </span>
      </button>
    </SidebarMenuButton>
  );
}

const screensWord = (n: number) => `${n} ${n === 1 ? 'screen' : 'screens'}`;

/** "3 screens would change · +2 join North drive-thru · 1 leaves Lobby portrait": what a publish would do on screens (#187). */
function previewLine(p: PublishPreview): string {
  const head = p.screens.length ? `${screensWord(p.screens.length)} would change` : 'No screen would change';
  const groups = p.groups.flatMap((g) => [
    ...(g.joined.length ? [`+${g.joined.length} join ${g.name}`] : []),
    ...(g.left.length ? [`${g.left.length} ${g.left.length === 1 ? 'leaves' : 'leave'} ${g.name}`] : []),
  ]);
  return [head, ...groups].join(' · ');
}

/** The preview, said in a line and then screen by screen with why, in the dialog's scrolling description. */
function PreviewOf({ preview }: { preview: PublishPreview }) {
  return (
    <>
      <span className="block font-medium text-foreground">{previewLine(preview)}</span>
      {preview.screens.length > 0 && (
        <ul aria-label="Screens that would change" className="space-y-1">
          {preview.screens.map((s) => (
            <li key={s.screenId}>
              <span className="text-foreground">{s.name}</span>: {s.reasons.join(', ')}
            </li>
          ))}
        </ul>
      )}
      {preview.failed.length > 0 && (
        <span className="block">
          {screensWord(preview.failed.length)} could not be compiled and keep what they have: {preview.failed.map((f) => f.name).join(', ')}.
        </span>
      )}
    </>
  );
}

/** The sidebar's question, in the shell: open while the store holds one (`publishing.all`). */
export function PublishAllDialog() {
  const all = useAppStore((s) => s.publishing.all);
  return all ? <OpenPublishAll all={all} /> : null;
}

function OpenPublishAll({ all }: { all: PublishAll }) {
  const pending = useAppStore((s) => s.publishing.pending);
  const confirm = useAppStore((s) => s.confirmPublishAll);
  const cancel = useAppStore((s) => s.cancelPublishAll);
  const returnFocus = useOpenerFocus();
  const total = all.pins?.length ?? 0;
  // No draft waiting, yet screens would change (#187): labels moved a smart group's members, or a screen was paired, or
  // something else compiles differently. Said as group changes only when the preview names a group (review of #621).
  const moved = total === 0 && Boolean(all.preview?.screens.length);
  const groupsMoved = moved && Boolean(all.preview?.groups.length);
  const nothing = total === 0 && !moved;
  return (
    <AlertDialog open onOpenChange={(open) => !open && cancel()}>
      <AlertDialogContent onCloseAutoFocus={returnFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {!all.pins
              ? 'Publish every unpublished change?'
              : moved
                ? groupsMoved
                  ? 'Publish the group changes?'
                  : `Publish to ${screensWord(all.preview?.screens.length ?? 0)}?`
                : nothing
                  ? 'Everything is already published'
                  : `Publish ${changes(total)}?`}
          </AlertDialogTitle>
          {/* A div, not the default paragraph: the preview holds a list (#187). */}
          <AlertDialogDescription asChild className="max-h-60 space-y-2 overflow-y-auto">
            <div>
              {!all.pins ? (
                <span className="flex items-center gap-2">
                  <LoaderCircleIcon className="size-4 animate-spin" aria-hidden /> Reading what is not published…
                </span>
              ) : nothing ? (
                <span className="block">Every change in this organization is on its screens already. There is nothing to publish.</span>
              ) : moved && all.preview ? (
                <>
                  <span className="block">
                    {groupsMoved
                      ? 'No draft is waiting, but labels moved screens in or out of smart groups since the last publish.'
                      : 'No draft is waiting, but these screens would get something new from a publish.'}
                  </span>
                  <PreviewOf preview={all.preview} />
                </>
              ) : all.tooMany ? (
                <span className="block">
                  {total} changes are not published, more than one publish takes ({MAX_PINS}). Publish them from their own pages, or from Overview's list.
                </span>
              ) : (
                <>
                  <span className="block">
                    {whatGoes(all.counts)}, as drafted now, by everyone in this organization. Screens switch as they hear of it. A change made after this was
                    read is not published with it.
                  </span>
                  {all.noDefault?.makes && (
                    <span className="block">
                      There is no default playlist yet: this publish makes {all.noDefault.makes} the default, which every screen plays when nothing else is
                      scheduled.
                    </span>
                  )}
                  {all.noDefault && !all.noDefault.makes && (
                    <span className="block">
                      No screen will change until there's a default playlist.{' '}
                      <Link to="/playlists" onClick={cancel} className="font-medium text-foreground underline underline-offset-4">
                        Choose a default playlist
                      </Link>
                    </span>
                  )}
                  {all.preview && <PreviewOf preview={all.preview} />}
                </>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{all.pins && nothing ? 'Close' : 'Cancel'}</AlertDialogCancel>
          {all.pins && nothing ? null : all.tooMany ? (
            <Button asChild>
              <Link to="/" hash="unpublished" onClick={cancel}>
                Open Overview
              </Link>
            </Button>
          ) : (
            // Not disabled while it reads or runs: focus would leave it (README, React rules).
            <Button
              aria-disabled={!all.pins || pending}
              className={cn((!all.pins || pending) && 'opacity-60')}
              onClick={() => all.pins && !pending && void confirm()}
            >
              Publish
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
