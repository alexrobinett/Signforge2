/** Making a playlist: a name, then its editor, where spots are added. It starts as a draft. */
import { NameDialog } from '~/components/name-dialog';
import { useAppStore } from '~/state/provider';

export function NewPlaylistDialog({ orgId }: { orgId: string }) {
  const draft = useAppStore((s) => s.playlistEditor.newPlaylist);
  const open = useAppStore((s) => s.openNewPlaylist);
  const name = useAppStore((s) => s.nameNewPlaylist);
  const create = useAppStore((s) => s.createPlaylist);
  return (
    <NameDialog
      id="new-playlist-name"
      thing="playlist"
      title="New playlist"
      description="It starts as a draft. Add spots and choose a transition in the editor."
      placeholder="Weekend promos"
      draft={draft}
      onOpenChange={open}
      onName={name}
      onCreate={() => void create(orgId)}
    />
  );
}
