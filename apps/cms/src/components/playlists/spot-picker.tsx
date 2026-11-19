/**
 * `SpotPicker`: the organization's spots in a dialog, to add to a playlist. Each Add puts the
 * spot at the end; the dialog stays open to add more. A spot may be added more than once.
 */
import { PlusIcon, SearchIcon } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { seconds, spotWhat, type SpotView, type TemplateVersionView } from '~/lib/spots';
import { useAppStore } from '~/state/provider';

export function SpotPicker({
  spots,
  versions,
  counts,
  onAdd,
}: {
  spots: SpotView[];
  versions: Map<string, TemplateVersionView>;
  /** How many times each spot is in the playlist already. */
  counts: Map<string, number>;
  onAdd: (spot: SpotView) => void;
}) {
  const open = useAppStore((s) => s.playlistEditor.adding);
  const query = useAppStore((s) => s.playlistEditor.addQuery);
  const openAdd = useAppStore((s) => s.openAddSpots);
  const search = useAppStore((s) => s.searchAddSpots);
  const words = query.trim().toLowerCase();
  const shown = words ? spots.filter((s) => `${s.name} ${spotWhat(s, versions)}`.toLowerCase().includes(words)) : spots;

  return (
    <Dialog open={open} onOpenChange={openAdd}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add spots</DialogTitle>
          <DialogDescription>Each one goes at the end of the playlist. A spot can be in a playlist more than once.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input type="search" aria-label="Search spots" placeholder="Search spots" value={query} onChange={(e) => search(e.target.value)} className="pl-9" />
        </div>
        {shown.length ? (
          <ul className="divide-y rounded-xl border">
            {shown.map((s) => {
              const n = counts.get(s.id) ?? 0;
              return (
                <li key={s.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{s.name}</span>
                    <span className="block truncate text-sm text-muted-foreground">
                      {spotWhat(s, versions)} · {seconds(s.durationMs)} s{n ? ` · in this playlist${n > 1 ? ` ${n} times` : ''}` : ''}
                    </span>
                  </span>
                  <Button variant="outline" size="sm" onClick={() => onAdd(s)} aria-label={`Add ${s.name}`}>
                    <PlusIcon aria-hidden />
                    Add
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="rounded-xl border p-8 text-center text-muted-foreground">
            {spots.length ? 'No spots match. Clear the search to see them all.' : 'No spots yet. Make one on the Spots page first.'}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
