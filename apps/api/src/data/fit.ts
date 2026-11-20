/**
 * The screen's rule for a new snapshot (`snapshotFit` in packages/player-core), which the server
 * runs too, before storing a snapshot (the poller, from published spots) and before sending one
 * (sync, from the screen's manifest): keep it if it fills at least one field bound to its source,
 * or if nothing binds to it; refuse it only when no bound value fits (the contract's `boundValue`).
 */
import { type Binding, boundValue } from '@signforge/contract';

/** One field bound to a source: the template's field definitions, the field, its binding, and the locale numbers are written in. */
export interface BoundField {
  fields: unknown;
  field: string;
  binding: Binding;
  locale: string;
}

export const fitsBoundFields = (bound: readonly BoundField[], data: unknown): boolean =>
  bound.length === 0 || bound.some((b) => boundValue(b.fields, b.field, b.binding, data, b.locale).value !== undefined);
