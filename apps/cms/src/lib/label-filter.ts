/**
 * Finding screens by label on the Screens page (#185): the filter chips, kept in the URL as one `l`
 * (`l=region:north;type:drive-thru,kiosk`: TanStack Router would write a list as JSON), are
 * a selector (`@signforge/compiler/selector`: one value `eq`, several `in`), matched with its own `matches`, so what the
 * page shows is what a smart group saved from it will pick (#186). Group by any label key, with a "no <key>" section.
 */
import { foldValue, matches, type Selector } from '@signforge/compiler/selector';
import type { ScreenView } from './screen-types';

/** One chip: a key and the values any of which a screen may have. */
export interface LabelTerm {
  key: string;
  values: string[];
}

// A value may hold a comma, a semicolon or a percent sign: each is escaped in the URL, so `l=type:a,b` stays two values.
const escapeValue = (v: string) => v.replaceAll('%', '%25').replaceAll(',', '%2C').replaceAll(';', '%3B');
const unescapeValue = (v: string) => v.replaceAll('%3B', ';').replaceAll('%2C', ',').replaceAll('%25', '%');

/** A chip as the URL keeps it. */
const termParam = ({ key, values }: LabelTerm) => `${key}:${values.map(escapeValue).join(',')}`;

/** The chips as the URL's `l`; undefined for none. */
export const termsParam = (terms: readonly LabelTerm[]) => (terms.length ? terms.map(termParam).join(';') : undefined);

/** The chips the URL's `l` holds, `;` between them, each `key:value,value`; one that does not read is left out. */
export function termsOf(l: unknown): LabelTerm[] {
  const params = typeof l === 'string' ? l.split(';') : [];
  return params.flatMap((p) => {
    if (typeof p !== 'string') return [];
    const at = p.indexOf(':');
    const key = p.slice(0, at).trim().toLowerCase();
    const values = p
      .slice(at + 1)
      .split(',')
      .map((v) => unescapeValue(v).trim())
      .filter(Boolean);
    return at > 0 && key && values.length ? [{ key, values }] : [];
  });
}

/** The chips as a selector: one value `eq`, several `in`. */
export const selectorOf = (terms: readonly LabelTerm[]): Selector => ({
  all: terms.map(({ key, values }) => ({ key, op: values.length === 1 ? 'eq' : 'in', values })),
});

/** The chips with `term` in: a chip on the same key is replaced, as a key has one value per screen. */
export const withTerm = (terms: readonly LabelTerm[], term: LabelTerm): LabelTerm[] => [...terms.filter((t) => t.key !== term.key), term];

/** What a screen is matched on: its labels, and its system labels (orientation, kind, timezone, locale). */
export const factsOf = (s: Pick<ScreenView, 'labels' | 'systemLabels'>): Record<string, string> => ({ ...s.systemLabels, ...s.labels });

/** Whether `s` has every chip's key at one of its values. */
export const matchesTerms = (s: Pick<ScreenView, 'labels' | 'systemLabels'>, terms: readonly LabelTerm[]) => matches(selectorOf(terms), factsOf(s));

/** A search typed as `key=value`, which becomes a chip; undefined for any other search. */
export function typedTerm(q: string): LabelTerm | undefined {
  const m = /^\s*([a-zA-Z0-9][a-zA-Z0-9._-]*)\s*=\s*(\S.*?)\s*$/.exec(q);
  return m ? { key: m[1]!.toLowerCase(), values: [m[2]!] } : undefined;
}

/** Whether the search finds `s`: by its name, the spot it shows, a label's value or one of its groups' names. */
export function searchFinds(s: ScreenView, q: string, groupNames: readonly string[]): boolean {
  const needle = foldValue(q);
  if (!needle) return true;
  const hay = [s.name, s.showing?.spot?.name ?? '', ...Object.values(s.labels), ...groupNames];
  return hay.some((h) => foldValue(h).includes(needle));
}

/** One section of the page grouped by a key: the screens with one value of it, or (`value` null) without the key. */
export interface LabelSection<S> {
  value: string | null;
  screens: S[];
}

/**
 * `screens` in sections by their value of `key`, values compared as selectors compare them and named as most of the
 * section spells them, in order; the screens without the key last. Each section keeps the screens' order.
 */
export function sectionsBy<S extends Pick<ScreenView, 'labels' | 'systemLabels'>>(screens: readonly S[], key: string): LabelSection<S>[] {
  const by = new Map<string, { spellings: Map<string, number>; screens: S[] }>();
  const none: S[] = [];
  const named: LabelSection<S>[] = [];
  for (const s of screens) {
    const value = factsOf(s)[key];
    if (value === undefined) {
      none.push(s);
      continue;
    }
    const empty: { spellings: Map<string, number>; screens: S[] } = { spellings: new Map(), screens: [] };
    const section = by.get(foldValue(value)) ?? empty;
    by.set(foldValue(value), section);
    section.spellings.set(value, (section.spellings.get(value) ?? 0) + 1);
    section.screens.push(s);
  }
  for (const [, section] of [...by.entries()].toSorted(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })))
    named.push({ value: [...section.spellings].toSorted(([, n], [, m]) => m - n)[0]![0], screens: section.screens });
  return none.length ? [...named, { value: null, screens: none }] : named;
}
