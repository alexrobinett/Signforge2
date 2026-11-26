/**
 * Screen labels (#185): a screen's `key: value` chips, and the editor that types them, on a screen's page and in the
 * pairing form. Suggestions come from the org's keys and values (`list_label_keys`), and a value no other screen has
 * is flagged beside it, so a typo does not split a fleet in two.
 */
import { useQuery } from '@tanstack/react-query';
import { PlusIcon, XIcon } from 'lucide-react';
import { useId } from 'react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { labelProblems, lonelyValue, type LabelKey } from '~/lib/labels';
import { useOrgId } from '~/lib/live';
import { cn } from '~/lib/utils';
import { labelKeysQuery } from '~/queries/screens';
import { labelRowsOf, type LabelTarget } from '~/state/labels';
import { useAppStore } from '~/state/provider';

/** A screen's labels as chips, by key; its system labels after, muted, as set by its settings. At most `max`, then "+N". */
export function LabelChips({
  labels,
  system = {},
  max,
  className,
  name = 'Labels',
}: {
  labels: Readonly<Record<string, string>>;
  /** The list's accessible name: another list of labels on the page needs its own. */
  name?: string;
  system?: Readonly<Record<string, string>>;
  max?: number;
  className?: string;
}) {
  const own = Object.entries(labels).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const shown = max === undefined ? own : own.slice(0, max);
  const more = own.length - shown.length;
  return (
    <ul aria-label={name} className={cn('flex flex-wrap gap-1.5', className)}>
      {shown.map(([key, value]) => (
        <li key={key}>
          <Badge title={`${key}: ${value}`} className="max-w-48 truncate text-foreground">
            <span className="text-muted-foreground">{key}:</span> {value}
          </Badge>
        </li>
      ))}
      {more > 0 && (
        <li>
          <Badge
            title={own
              .slice(shown.length)
              .map(([k, v]) => `${k}: ${v}`)
              .join(', ')}
          >
            +{more}
          </Badge>
        </li>
      )}
      {Object.entries(system).map(([key, value]) => (
        <li key={key}>
          <Badge title={`${key}: ${value}, set by the screen's settings`} className="max-w-48 truncate border-dashed">
            {key}: {value}
            <span className="sr-only">, set by the screen</span>
          </Badge>
        </li>
      ))}
    </ul>
  );
}

/** The org's keys and values, for suggestions; none until read, and none if the read fails (the editor still works). */
function useLabelKeys(): LabelKey[] {
  return useQuery(labelKeysQuery(useOrgId())).data?.keys ?? [];
}

/**
 * Rows of key and value, typed into the store (`target`): suggestions from the org's own keys and values, the typo
 * guard beside each value, and a row to add another. `own` is the screen's labels as saved, so its own value does not
 * count as another screen's.
 */
export function LabelEditor({
  target,
  own = {},
  titled = true,
}: {
  target: LabelTarget;
  own?: Readonly<Record<string, string>>;
  /** Whether it shows its own heading: not in a dialog titled Labels already. */
  titled?: boolean;
}) {
  const id = useId();
  const keys = useLabelKeys();
  const rows = useAppStore((s) => labelRowsOf(s.labels, target));
  const typeLabel = useAppStore((s) => s.typeLabel);
  const addLabelRow = useAppStore((s) => s.addLabelRow);
  const removeLabelRow = useAppStore((s) => s.removeLabelRow);
  const problems = labelProblems(rows);
  const ownKeys = keys.filter((k) => !k.system);
  return (
    <fieldset className="grid gap-2">
      <legend className={titled ? 'mb-1 text-sm font-medium' : 'sr-only'}>Labels</legend>
      <p id={`${id}-help`} className={cn('text-xs text-muted-foreground', titled && '-mt-1')}>
        Facts about the screen, such as region: north or store: 0142, to find it by and, soon, to aim content at. A key is lowercase.
      </p>
      <datalist id={`${id}-keys`}>
        {ownKeys.map((k) => (
          <option key={k.key} value={k.key} />
        ))}
      </datalist>
      {rows.map((row, i) => {
        const values = ownKeys.find((k) => k.key === row.key.trim().toLowerCase())?.values ?? [];
        // A row that cannot be saved says so first; a value only this screen would have is a warning, not a refusal.
        const problem = problems[i];
        const warning = problem ?? lonelyValue(keys, row, own);
        return (
          // Rows have no id of their own: one is its place in the list until it is saved.
          // biome-ignore lint/suspicious/noArrayIndexKey: a row is its place until saved.
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] items-start gap-2">
            <Input
              aria-label={`Label ${i + 1} key`}
              list={`${id}-keys`}
              value={row.key}
              onChange={(e) => typeLabel(target, i, { ...row, key: e.target.value })}
              placeholder="key"
              maxLength={63}
              autoComplete="off"
              aria-describedby={problem ? `${id}-warn-${i}` : `${id}-help`}
              aria-invalid={problem ? true : undefined}
            />
            <div className="grid gap-1">
              <Input
                aria-label={`Label ${i + 1} value`}
                list={`${id}-values-${i}`}
                value={row.value}
                onChange={(e) => typeLabel(target, i, { ...row, value: e.target.value })}
                placeholder="value"
                maxLength={63}
                autoComplete="off"
                aria-describedby={warning ? `${id}-warn-${i}` : undefined}
                aria-invalid={problem ? true : undefined}
              />
              <datalist id={`${id}-values-${i}`}>
                {values.map((v) => (
                  <option key={v.value} value={v.value} />
                ))}
              </datalist>
              {warning && (
                <p id={`${id}-warn-${i}`} className={cn('text-xs', problem ? 'font-medium text-destructive' : 'text-status-needs-you-foreground')}>
                  {warning}
                </p>
              )}
            </div>
            <Button type="button" variant="ghost" size="icon" aria-label={`Remove label ${i + 1}`} onClick={() => removeLabelRow(target, i)}>
              <XIcon aria-hidden />
            </Button>
          </div>
        );
      })}
      <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => addLabelRow(target)}>
        <PlusIcon aria-hidden /> Add a label
      </Button>
    </fieldset>
  );
}
