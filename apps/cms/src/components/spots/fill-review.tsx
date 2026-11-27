/**
 * Updating a spot from a flyer, photo or link (#264): the editor's Fill from a flyer dialog, and the
 * review of what the agent would change, before anything is kept. The review lists every change
 * Keep would write (src/lib/fill-changes.ts): a field's new value, and a list's rows changed, added
 * and removed. Its actions stay in view at the bottom; on a phone the stage plays the change above it.
 */
import type { FieldDef } from '@signforge/contract';
import { SparklesIcon } from 'lucide-react';
import { MarkNote } from '~/components/spots/fill-marks';
import { FillSource } from '~/components/spots/fill-source';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '~/components/ui/dialog';
import { fillChanges } from '~/lib/fill-changes';
import { useAppStore } from '~/state/provider';

export function FillSpotDialog({ orgId, spotId, fields }: { orgId: string; spotId: string; fields: Record<string, FieldDef> }) {
  const open = useAppStore((s) => s.agent.fillingSpot === spotId);
  const setOpen = useAppStore((s) => s.openSpotFill);
  const review = useAppStore((s) => s.reviewFill);
  return (
    <Dialog open={open} onOpenChange={(o) => setOpen(o ? spotId : null)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Fill from a flyer, photo or link</DialogTitle>
          <DialogDescription>You see what would change before anything is kept.</DialogDescription>
        </DialogHeader>
        <FillSource
          title="What has changed?"
          help="A photo of today's printed menu, a flyer, or the page it is on. The agent reads it and says what it would change here."
          label="Read it"
          onFill={() => void review(orgId, spotId, fields)}
        />
      </DialogContent>
    </Dialog>
  );
}

export function FillReview({ spotId, fields }: { spotId: string; fields: Record<string, FieldDef> }) {
  const r = useAppStore((s) => s.agent.reviews[spotId]);
  const keep = useAppStore((s) => s.keepReview);
  const retake = useAppStore((s) => s.retakeFill);
  const discard = useAppStore((s) => s.discardReview);
  const reload = useAppStore((s) => s.reloadReviewed);
  if (!r) return null;
  const changes = fillChanges(fields, r.before, r.data);
  const notes = Object.entries(r.marks).filter(([, m]) => m.note);
  const from = r.from === 'spot' ? 'the same rows on another spot' : `your ${r.from}`;
  return (
    <section aria-labelledby="fill-review-title" className="flex flex-col gap-4">
      <h2 id="fill-review-title" className="flex items-center gap-2 font-medium text-actor-agent">
        <SparklesIcon aria-hidden className="size-5" />
        What the agent would change, from {from}
      </h2>
      {changes.length ? (
        <ul className="flex flex-col gap-3">
          {changes.map((c) => (
            <li key={c.field} className="rounded-lg border bg-card p-3">
              <p className="font-medium">{c.label}</p>
              {c.kind === 'value' ? (
                <p className="mt-1 text-sm break-words">
                  <del className="text-muted-foreground">{c.before}</del> → <ins className="no-underline">{c.after}</ins>
                </p>
              ) : (
                <ul className="mt-1 flex flex-col gap-1 text-sm">
                  {c.changed.map((row, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: two rows may share a name; with their place, the keys differ.
                    <li key={`c-${i}-${row.name}`} data-row="changed">
                      <span className="font-medium">{row.name}</span>
                      {row.cells.map((cell) => (
                        <span key={cell.label} className="block break-words">
                          {cell.label}: <del className="text-muted-foreground">{cell.before}</del> → <ins className="no-underline">{cell.after}</ins>
                        </span>
                      ))}
                    </li>
                  ))}
                  {c.added.map((row, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: two rows may read the same; with their place, the keys differ.
                    <li key={`a-${i}-${row}`} data-row="added" className="break-words">
                      <span className="font-medium text-status-online-foreground">Added</span> {row}
                    </li>
                  ))}
                  {c.removed.map((row, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: two rows may read the same; with their place, the keys differ.
                    <li key={`r-${i}-${row}`} data-row="removed" className="break-words">
                      <span className="font-medium text-destructive">Removed</span> {row}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm">Nothing the agent read differs from this spot.</p>
      )}
      {notes.map(([field, m]) => (
        <div key={field} className="text-sm">
          <p className="font-medium">{fields[field]?.label ?? field}</p>
          <MarkNote id={`review-${field}-note`} mark={m} />
        </div>
      ))}
      {r.alsoOn.length > 0 && (
        <p className="text-sm">
          {r.alsoOn.map((o) => `${o.items.join(', ')} ${o.items.length > 1 ? 'are' : 'is'} also on ${o.name}.`).join(' ')} Once you keep this, you can review{' '}
          {r.alsoOn.length > 1 ? 'them' : 'it'} there too.
        </p>
      )}
      <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-2 border-t bg-card px-4 py-3 sm:-mx-6 sm:px-6">
        <p role="alert" className="basis-full text-sm font-medium text-destructive empty:hidden">
          {r.error}
        </p>
        {r.stale ? (
          <Button type="button" onClick={() => void reload(spotId)}>
            Reload
          </Button>
        ) : (
          <Button type="button" disabled={r.keeping || !changes.length} onClick={() => void keep(spotId, fields)}>
            {r.keeping ? 'Keeping…' : 'Keep in the draft'}
          </Button>
        )}
        {r.from !== 'spot' && (
          <Button type="button" variant="outline" onClick={() => retake(spotId)}>
            Retake
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={() => discard(spotId)}>
          Discard
        </Button>
      </div>
    </section>
  );
}
