/**
 * The screen's rule for a new snapshot (`snapshotFit` in packages/player-core), which the server
 * runs too, before storing a snapshot (the poller, from published spots) and before sending one
 * (sync, from the screen's manifest): keep it if it fills at least one field bound to its source,
 * or if nothing binds to it; refuse it only when every bound value fails `validateBoundValue`.
 */
import { readPath, validateBoundValue } from '@signforge/contract';

/** One field bound to a source: the template's field definitions, the field, and the path into the snapshot. */
export interface BoundField {
  fields: unknown;
  field: string;
  path: string;
}

export const fitsBoundFields = (bound: readonly BoundField[], data: unknown): boolean =>
  bound.length === 0 || bound.some((b) => validateBoundValue(b.fields, b.field, readPath(data, b.path)).length === 0);
