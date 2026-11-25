/**
 * A publish's rollout (canvas boards Screens A and Ideas 5-6, kit RolloutBar): a bar of where its
 * screens stand, and a legend that says why each waiting screen waits, never colour alone.
 */
import { ORDER, OUTCOME_COLOR, rolloutLabel, segments, type PublishView, type RolloutScreen } from '~/lib/publishes';
import { cn } from '~/lib/utils';

/**
 * The bar, one part per outcome, each as wide as its share of the screens. Every part stays drawn, an empty one at no
 * width, so as screens take a publish each eases to its new width (#385), down to none and up to the whole bar; under
 * reduced motion it is set at once (styles.css). The gap between parts is an inset edge, which an empty part does not take.
 */
export function RolloutBar({ publish, screens, now, className }: { publish: PublishView; screens: RolloutScreen[]; now: number; className?: string }) {
  const segs = segments(publish, screens, now);
  const counts = new Map(segs.map((s) => [s.outcome, s.count]));
  return (
    <div role="img" aria-label={rolloutLabel(publish, segs, screens.length)} className={cn('flex h-2.5 overflow-hidden rounded-full bg-muted', className)}>
      {ORDER.map((outcome) => (
        <span
          key={outcome}
          className="basis-0 shadow-[inset_2px_0_0_var(--muted)] transition-[flex-grow] duration-300 ease-out first:shadow-none"
          style={{ flexGrow: counts.get(outcome) ?? 0, background: OUTCOME_COLOR[outcome] }}
        />
      ))}
    </div>
  );
}

/** The legend: count and words for each part; with `reasons`, why they wait and which screens. */
export function RolloutLegend({ publish, screens, now, reasons }: { publish: PublishView; screens: RolloutScreen[]; now: number; reasons?: boolean }) {
  const segs = segments(publish, screens, now);
  if (!reasons) {
    return (
      <ul className="flex flex-wrap gap-x-6 gap-y-2 text-meta text-foreground/80 tabular-nums">
        {segs.map((s) => (
          <li key={s.outcome} className="flex items-center gap-2">
            <span aria-hidden className="size-2.5 shrink-0 rounded-xs" style={{ background: OUTCOME_COLOR[s.outcome] }} />
            {s.count} {s.label}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className="flex flex-col divide-y">
      {segs.map((s) => (
        <li key={s.outcome} className="flex gap-3 py-3 first:pt-0 last:pb-0">
          <span aria-hidden className="mt-1.5 size-2.5 shrink-0 rounded-xs" style={{ background: OUTCOME_COLOR[s.outcome] }} />
          <span className="flex min-w-0 flex-col gap-0.5">
            <strong className="font-semibold tabular-nums">
              {s.count} {s.label}
            </strong>
            <span className="text-sm text-muted-foreground tabular-nums">{s.why}</span>
            <span className="text-sm">{s.names.join(', ')}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
