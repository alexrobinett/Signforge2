/**
 * Label selectors: which screens a selector picks, from their labels and system labels. The tools
 * (`list_screens`), the CMS's live preview and the publish (smart groups) all call this, so they
 * never disagree. The tools check a selector's shape and limits where it comes in.
 *
 * Values compare case-insensitively and trimmed. A key a screen lacks equals nothing, so
 * `region!=north` and `region notin (north)` pick only screens that have a region.
 */
import type { Orientation, ScreenKind } from '@signforge/contract';

export const SELECTOR_OPS = ['eq', 'neq', 'in', 'notin', 'exists', 'missing'] as const;
type Op = (typeof SELECTOR_OPS)[number];

/** Every term must hold. `values` has one value for eq and neq, one or more for in and notin, none for exists and missing. */
export interface Selector {
  all: readonly { key: string; op: Op; values: readonly string[] }[];
}

/** The most terms a selector has. */
export const MAX_TERMS = 10;

/** A screen's labels and system labels, by key. */
type Facts = Readonly<Record<string, string>>;

/** What two values are compared as. */
export const foldValue = (v: string) => v.trim().toLowerCase();

/** The keys of `systemLabels`: no label may have one. */
export const SYSTEM_KEYS = ['orientation', 'kind', 'timezone', 'locale'] as const;

/** Labels every screen has from its settings, never stored: no `locale` on a screen set to none. */
export const systemLabels = (s: { orientation: Orientation; kind: ScreenKind; timezone: string; locale: string | null }): Record<string, string> => ({
  orientation: s.orientation,
  kind: s.kind,
  timezone: s.timezone,
  ...(s.locale === null ? {} : { locale: s.locale }),
});

/** Whether a screen with these facts (its labels and `systemLabels`) is picked. */
export function matches(selector: Selector, facts: Facts): boolean {
  return selector.all.every(({ key, op, values }) => {
    const v = Object.hasOwn(facts, key) ? foldValue(facts[key]!) : undefined;
    if (op === 'exists') return v !== undefined;
    if (op === 'missing') return v === undefined;
    if (v === undefined) return false;
    const listed = values.some((w) => foldValue(w) === v);
    return op === 'eq' || op === 'in' ? listed : !listed;
  });
}

/** Quote a value when it could collide with selector syntax (separators, parens, quotes, escapes, or edge spaces). */
const formatValue = (v: string) => (v.length === 0 || /^\s|\s$|[,()"\\\p{Cc}\p{Zl}\p{Zp}]/u.test(v) ? JSON.stringify(v) : v);

/** A selector as people read it: `region=north, type in (drive-thru, kiosk), !legacy`. */
export function format(selector: Selector): string {
  return selector.all
    .map(({ key, op, values }) => {
      switch (op) {
        case 'eq':
          return `${key}=${formatValue(values[0] ?? '')}`;
        case 'neq':
          return `${key}!=${formatValue(values[0] ?? '')}`;
        case 'in':
        case 'notin':
          return `${key} ${op} (${values.map(formatValue).join(', ')})`;
        case 'exists':
          return key;
        case 'missing':
          return `!${key}`;
      }
    })
    .join(', ');
}
