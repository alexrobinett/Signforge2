/** Making a playlist: a name, then its editor, where spots are added. It starts as a draft. */
import { PlusIcon } from 'lucide-react';
import type { SubmitEvent } from 'react';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { useAppStore } from '~/state/provider';

export function NewPlaylistDialog({ orgId }: { orgId: string }) {
  const d = useAppStore((s) => s.playlistEditor.newPlaylist);
  const open = useAppStore((s) => s.openNewPlaylist);
  const name = useAppStore((s) => s.nameNewPlaylist);
  const create = useAppStore((s) => s.createPlaylist);
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    void create(orgId);
  };

  return (
    <Dialog open={d.open} onOpenChange={open}>
      <DialogTrigger asChild>
        <Button>
          <PlusIcon aria-hidden />
          New playlist
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New playlist</DialogTitle>
          <DialogDescription>It starts as a draft. Add spots and choose a transition in the editor.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-playlist-name">Name</Label>
            <Input id="new-playlist-name" value={d.name} onChange={(e) => name(e.target.value)} maxLength={100} placeholder="Weekend promos" />
          </div>
          <p role="alert" className="text-sm font-medium text-destructive empty:hidden">
            {d.error}
          </p>
          <div className="flex justify-end">
            <Button type="submit" disabled={!d.name.trim() || d.pending}>
              {d.pending ? 'Creating…' : 'Create playlist'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
