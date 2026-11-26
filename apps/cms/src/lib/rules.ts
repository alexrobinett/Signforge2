/**
 * A smart group's rule in the CMS (#186): a selector (`@signforge/compiler/selector`) built a condition at a time, and
 * the screens it matches now, matched in the browser with the same `matches` the publish resolves it with.
 */
import { matches, MAX_TERMS, type Selector } from '@signforge/compiler/selector';
import { factsOf } from './label-filter';
import type { ScreenView } from './screen-types';

/** One condition: a label key, how it is compared, and its values (one for is and is not, any for one of, none for set). */
export type RuleTerm = Selector['all'][number];
export type RuleOp = RuleTerm['op'];

/** Each comparison as the builder offers it. */
export const OP_WORDS: Record<RuleOp, string> = {
  eq: 'is',
  neq: 'is not',
  in: 'is one of',
  notin: 'is none of',
  exists: 'is set',
  missing: 'is not set',
};

/** How many values `op` takes: one, one or more, or none. */
export const valuesOf = (op: RuleOp) => (op === 'eq' || op === 'neq' ? 'one' : op === 'in' || op === 'notin' ? 'some' : 'none');

/**
 * The condition compared another way: its values kept while the new comparison takes the same kind (one value, or a
 * set of them), dropped otherwise, so "NORTH" typed under "is" does not ride into "is one of" unseen (review of #614).
 */
export const withOp = (t: RuleTerm, op: RuleOp): RuleTerm => ({ ...t, op, values: valuesOf(op) === valuesOf(t.op) ? t.values : [] });

/** A condition as words: "region is North", "type is one of kiosk, drive-thru", "store is not set". */
export const termWords = (t: RuleTerm) => [t.key, OP_WORDS[t.op], ...(t.values.length ? [t.values.join(', ')] : [])].join(' ');

/** The conditions as the tools take them: values trimmed, and only the ones their comparison takes. */
export const ruleOf = (terms: readonly RuleTerm[]): Selector => ({
  all: terms.map((t) => {
    const values = t.values.map((v) => v.trim()).filter(Boolean);
    const kind = valuesOf(t.op);
    return { key: t.key, op: t.op, values: kind === 'none' ? [] : kind === 'one' ? values.slice(0, 1) : values };
  }),
});

/** What keeps the rule from being saved, in the builder's words; undefined when it can be. */
export function ruleProblem(terms: readonly RuleTerm[]): string | undefined {
  if (!terms.length) return 'Add a condition: a rule with none would be every screen.';
  if (terms.length > MAX_TERMS) return `A group's rule has at most ${MAX_TERMS} conditions; this one has ${terms.length}.`;
  if (terms.some((t) => !t.key)) return 'Choose a label for each condition.';
  for (const t of ruleOf(terms).all) {
    if (valuesOf(t.op) === 'one' && t.values.length !== 1) return `Give ${t.key} a value.`;
    if (valuesOf(t.op) === 'some' && !t.values.length) return `Choose at least one value of ${t.key}.`;
  }
  return undefined;
}

/** The screens the rule matches now, in the order given; none while it cannot be saved. */
export const matching = <S extends Pick<ScreenView, 'labels' | 'systemLabels'>>(screens: readonly S[], terms: readonly RuleTerm[]): S[] =>
  ruleProblem(terms) === undefined ? screens.filter((s) => matches(ruleOf(terms), factsOf(s))) : [];

/** The conditions no screen meets on its own, so the rule matches nothing while they are in it. */
export const unmet = (screens: readonly Pick<ScreenView, 'labels' | 'systemLabels'>[], terms: readonly RuleTerm[]): RuleTerm[] =>
  ruleProblem(terms) === undefined ? ruleOf(terms).all.filter((t) => !screens.some((s) => matches({ all: [t] }, factsOf(s)))) : [];
