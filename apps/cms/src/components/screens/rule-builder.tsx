/**
 * A smart group's rule, a condition at a time (#186): a label, how it compares, and its values, with the screens it
 * matches now beside it, matched in the browser as the publish will (`~/lib/rules`). It warns when the rule matches no
 * screen, naming the conditions no screen meets. The conditions are the open group dialog's, in the store.
 */
import { MAX_TERMS, SELECTOR_OPS } from '@signforge/compiler/selector';
import { PlusIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { useId } from 'react';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { NativeSelect } from '~/components/ui/select';
import type { LabelKey } from '~/lib/labels';
import { matching, OP_WORDS, ruleProblem, termWords, unmet, valuesOf, type RuleTerm } from '~/lib/rules';
import type { ScreenView } from '~/lib/screen-types';
import { byName } from '~/lib/targets';
import { termsOf } from '~/state/groups';
import { useAppStore } from '~/state/provider';

const isOp = (v: string): v is RuleTerm['op'] => SELECTOR_OPS.some((op) => op === v);
const NAMED = 8;

export function RuleBuilder({ screens, keys }: { screens: ScreenView[]; keys: LabelKey[] }) {
  const id = useId();
  const terms = useAppStore((s) => termsOf(s.groups.dialog));
  const pending = useAppStore((s) => s.groups.dialog?.pending ?? false);
  const add = useAppStore((s) => s.addRuleTerm);
  const change = useAppStore((s) => s.changeRuleTerm);
  const remove = useAppStore((s) => s.removeRuleTerm);
  const matched = matching(screens, terms).toSorted(byName);
  const ready = ruleProblem(terms) === undefined;
  const missed = unmet(screens, terms);
  return (
    <div className="grid gap-3">
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Screens whose labels meet every condition</legend>
        {terms.map((t, i) => {
          const known = keys.find((k) => k.key === t.key)?.values ?? [];
          const kind = valuesOf(t.op);
          const at = `${id}-${i}`;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: a condition has no id of its own; its place is what it is.
            <fieldset key={i} className="grid gap-2 rounded-lg border p-2.5 sm:grid-cols-[1fr_1fr_1.4fr_auto] sm:items-start">
              <legend className="sr-only">Condition {i + 1}</legend>
              <NativeSelect
                aria-label="Label"
                value={t.key}
                onChange={(e) => change(i, { ...t, key: e.target.value, values: [] })}
                aria-disabled={pending || undefined}
              >
                <option value="">Choose a label</option>
                {keys.map((k) => (
                  <option key={k.key} value={k.key}>
                    {k.key}
                    {k.system ? ' (system)' : ''}
                  </option>
                ))}
              </NativeSelect>
              <NativeSelect
                aria-label="Compared"
                value={t.op}
                onChange={(e) => isOp(e.target.value) && change(i, { ...t, op: e.target.value })}
                aria-disabled={pending || undefined}
              >
                {SELECTOR_OPS.map((op) => (
                  <option key={op} value={op}>
                    {OP_WORDS[op]}
                  </option>
                ))}
              </NativeSelect>
              {kind === 'one' && (
                <>
                  <Input
                    aria-label="Value"
                    list={`${at}-values`}
                    value={t.values[0] ?? ''}
                    onChange={(e) => change(i, { ...t, values: [e.target.value] })}
                    maxLength={63}
                    placeholder="A value"
                    aria-disabled={pending || undefined}
                  />
                  <datalist id={`${at}-values`}>
                    {known.map((v) => (
                      <option key={v.value} value={v.value} />
                    ))}
                  </datalist>
                </>
              )}
              {kind === 'some' &&
                (known.length ? (
                  <fieldset className="flex flex-wrap gap-x-3 gap-y-1.5 py-1">
                    <legend className="sr-only">Values</legend>
                    {known.map((v) => (
                      <label key={v.value} className="flex items-center gap-1.5 text-sm">
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          checked={t.values.includes(v.value)}
                          onChange={(e) =>
                            change(i, { ...t, values: e.target.checked ? [...t.values, v.value] : t.values.filter((x) => x !== v.value) })
                          }
                          aria-disabled={pending || undefined}
                        />
                        {v.value}
                      </label>
                    ))}
                  </fieldset>
                ) : (
                  <p className="py-2 text-sm text-muted-foreground">{t.key ? `No screen has ${t.key} yet.` : 'Choose a label first.'}</p>
                ))}
              {kind === 'none' && <span className="hidden sm:block" />}
              <Button type="button" variant="ghost" size="icon" aria-label={`Remove condition ${i + 1}`} onClick={() => remove(i)} disabled={terms.length === 1}>
                <XIcon aria-hidden />
              </Button>
            </fieldset>
          );
        })}
        <div>
          <Button type="button" variant="outline" size="sm" onClick={add} disabled={terms.length >= MAX_TERMS}>
            <PlusIcon aria-hidden /> Add a condition
          </Button>
          {terms.length >= MAX_TERMS && <span className="ml-2 text-meta text-muted-foreground">A rule has at most {MAX_TERMS}.</span>}
        </div>
      </fieldset>
      <section aria-label="Matching screens" aria-live="polite" className="grid gap-1.5 rounded-lg bg-muted/50 p-3 text-sm">
        {!ready ? (
          <p className="text-muted-foreground">Finish the conditions to see the screens they match.</p>
        ) : matched.length ? (
          <>
            <p className="font-medium">
              Matches {matched.length} {matched.length === 1 ? 'screen' : 'screens'} now
            </p>
            <p className="text-muted-foreground">
              {matched
                .slice(0, NAMED)
                .map((s) => s.name)
                .join(', ')}
              {matched.length > NAMED && ` and ${matched.length - NAMED} more`}
            </p>
          </>
        ) : (
          <div role="alert" className="flex gap-2 font-medium text-status-updating-foreground">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>
              Matches no screen now.
              {missed.length > 0 && ` No screen meets ${missed.map((t) => `“${termWords(t)}”`).join(' or ')}.`}
            </p>
          </div>
        )}
        <p className="text-meta text-muted-foreground">The group follows its rule: a screen labelled to match joins it at the next publish.</p>
      </section>
    </div>
  );
}
