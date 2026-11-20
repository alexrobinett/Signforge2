/**
 * What the Source section's feed and table pickers share (src/components/spots/source-section.tsx,
 * table-source.tsx): the card a bound source's live data sits in, one of the org's sources to
 * pick, and the way back to the current one.
 */
import { Link2Icon, TriangleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '~/components/ui/button';
import { NativeSelect } from '~/components/ui/select';
import type { DataSourceView } from '~/lib/live-data';
import { cn } from '~/lib/utils';
import { useAppStore } from '~/state/provider';
import { sourceStateOf, type SourceTarget } from '~/state/spot-source';

/** A bound source's data: marked live while screens show it, otherwise with what they show instead. */
export function LiveCard({ fresh, instead, className, children }: { fresh: boolean; instead: string; className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'flex flex-col rounded-[10px] border p-3',
        fresh ? 'border-primary/25 bg-accent' : 'border-status-updating/50 bg-status-updating-muted',
        className,
      )}
    >
      {fresh ? (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-accent-foreground">
          <Link2Icon className="size-3.5" aria-hidden />
          Live data
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-status-updating-foreground">
          <TriangleAlertIcon className="size-3.5" aria-hidden />
          Showing the {instead}
        </span>
      )}
      {children}
    </div>
  );
}

/** One of the org's `sources` to bind, chosen in a list and used with its button. */
export function SourceChoice({
  target,
  sources,
  boundId,
  id,
  label,
  word,
}: {
  target: SourceTarget;
  sources: DataSourceView[];
  boundId: string | undefined;
  id: string;
  label: string;
  word: string;
}) {
  const { spot } = target;
  const st = useAppStore((s) => sourceStateOf(s.spotSource, spot.id));
  const chooseFeed = useAppStore((s) => s.chooseFeed);
  const connect = useAppStore((s) => s.connectSource);
  const choice = st.feedChoice ?? boundId;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      <NativeSelect id={id} value={choice ?? ''} disabled={st.pending} onChange={(e) => chooseFeed(spot.id, e.target.value)}>
        <option value="" disabled>
          Choose a {word}
        </option>
        {sources.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </NativeSelect>
      <Button
        type="button"
        variant="outline"
        className="self-start"
        disabled={st.pending || !choice || choice === boundId}
        onClick={() => choice && void connect(target, choice)}
      >
        Use this {word}
      </Button>
    </div>
  );
}

/** Closes the picker over a bound source. */
export function KeepSource({ spotId }: { spotId: string }) {
  const changeSource = useAppStore((s) => s.changeSource);
  return (
    <Button type="button" variant="ghost" className="self-start" onClick={() => changeSource(spotId, false)}>
      Keep the current source
    </Button>
  );
}
