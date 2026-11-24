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
import { MAX_PINS, type PublishAll } from '~/state/publishing';
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
  return (
    <AlertDialog open onOpenChange={(open) => !open && cancel()}>
      <AlertDialogContent onCloseAutoFocus={returnFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{all.pins ? `Publish ${changes(total)}?` : 'Publish every unpublished change?'}</AlertDialogTitle>
          <AlertDialogDescription className="max-h-60 space-y-2 overflow-y-auto">
            {!all.pins ? (
              <span className="flex items-center gap-2">
                <LoaderCircleIcon className="size-4 animate-spin" aria-hidden /> Reading what is not published…
              </span>
            ) : all.tooMany ? (
              <span className="block">
                {total} changes are not published, more than one publish takes ({MAX_PINS}). Publish them from their own pages, or from Overview's list.
              </span>
            ) : (
              <>
                <span className="block">
                  {whatGoes(all.counts)}, as drafted now, by everyone in this organization. Screens switch as they hear of it. A change made after this was read
                  is not published with it.
                </span>
                {all.defaultWords && <span className="block">{all.defaultWords}</span>}
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {all.tooMany ? (
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
