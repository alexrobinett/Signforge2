/**
 * The sidebar's "N unpublished changes · Publish" (#361): drafts left unpublished stay in sight on
 * every page. For a member who may publish it asks first, saying what goes, then publishes every
 * change (`publishAllDrafts`), with the toast every publish gives; for one who may not, it opens
 * Overview's list of them.
 */
import { Link } from '@tanstack/react-router';
import { SendIcon } from 'lucide-react';
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
import { cn } from '~/lib/utils';
import { useAppStore } from '~/state/provider';

export interface DraftCounts {
  spots: number;
  playlists: number;
  schedule: number;
}

const count = (n: number, one: string, many: string) => (n ? [`${n} ${n === 1 ? one : many}`] : []);

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
  const confirming = useAppStore((s) => s.publishing.confirmingAll);
  const pending = useAppStore((s) => s.publishing.pending);
  const ask = useAppStore((s) => s.askPublishAll);
  const publishAll = useAppStore((s) => s.publishAllDrafts);
  const total = counts.spots + counts.playlists + counts.schedule;
  if (!total) return null;
  const label = `${total} unpublished ${total === 1 ? 'change' : 'changes'}`;

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
    <>
      {/* Its words wrap rather than truncate: the sidebar is narrower than "12 unpublished changes · Publish". */}
      <SidebarMenuButton folded={folded} tooltip={`${label} · Publish`} className={cn('text-foreground', !folded && 'h-auto min-h-10 py-2')}>
        <button type="button" onClick={() => ask(true)}>
          <SendIcon aria-hidden className="text-primary" />
          <span className="text-left">
            {label} · <span className="text-primary">Publish</span>
          </span>
        </button>
      </SidebarMenuButton>
      <AlertDialog open={confirming} onOpenChange={(open) => !pending && ask(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish {label}?</AlertDialogTitle>
            <AlertDialogDescription>
              {whatGoes(counts)}, as drafted now, by everyone in this organization. Screens switch as they hear of it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {/* Not disabled while it runs: focus would leave it (README, React rules). */}
            <Button aria-disabled={pending} className={cn(pending && 'opacity-60')} onClick={() => void publishAll(orgId)}>
              {pending ? 'Publishing…' : 'Publish'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
