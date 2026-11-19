/**
 * Why a feed could not be normalised. The poller reports these categories to the CMS and never
 * echoes the upstream body.
 */
export type FeedErrorCode = 'too-large' | 'doctype' | 'malformed' | 'unknown-format' | 'not-a-table';

export class FeedError extends Error {
  constructor(
    readonly code: FeedErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'FeedError';
  }
}

/** Defaults from `docs/backend-plan.md`; every one can be overridden per call. */
export const LIMITS = {
  /** Largest feed body accepted, in UTF-8 bytes. */
  maxBytes: 1_000_000,
  /** Occurrences one recurring event may step through from `now` before it is cut off. */
  maxIterations: 500,
  /**
   * Occurrences before `now` one recurring event may step past to reach it. Most series skip
   * straight to near `now`; this bounds the rest (COUNT, monthly and yearly rules).
   */
  maxPastIterations: 5000,
  /** Events in a CalendarFeed. */
  maxEvents: 25,
  /** Items in a NewsFeed. */
  maxItems: 20,
  /** How far ahead a CalendarFeed looks. */
  horizonDays: 30,
} as const;

export function checkSize(text: string, maxBytes: number): void {
  // A UTF-16 code unit is at least one UTF-8 byte, so only long strings need encoding.
  if (text.length > maxBytes || (text.length * 3 > maxBytes && new TextEncoder().encode(text).length > maxBytes)) {
    throw new FeedError('too-large', `feed is larger than ${maxBytes} bytes`);
  }
}
