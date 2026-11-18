/**
 * Feed normalisers: the iCalendar, RSS and Atom feeds a data source polls, converted to the
 * contract's CalendarFeed and NewsFeed. Pure functions of the body text (and, for calendars,
 * the time), so they run the same in the poller and in tests.
 */
import type { CalendarFeed, NewsFeed } from '@signforge/contract';
import { parseCalendar, type CalendarOptions } from './ical';
import { parseNews, type NewsOptions } from './news';

export { FeedError, LIMITS, type FeedErrorCode } from './errors';
export { FEED_URL_PROBLEMS, feedUrlProblem, type FeedUrlProblem } from './url';
export { parseCalendar, parseNews, type CalendarOptions, type NewsOptions };

export type FeedFormat = 'ical' | 'rss';

/** Converts a feed body by its data source's format. `rss` covers RSS 2.0 and Atom. */
export function normaliseFeed(format: 'ical', body: string, options: CalendarOptions): CalendarFeed;
export function normaliseFeed(format: 'rss', body: string, options?: NewsOptions): NewsFeed;
export function normaliseFeed(format: FeedFormat, body: string, options: CalendarOptions | NewsOptions = {}) {
  return format === 'ical' ? parseCalendar(body, options as CalendarOptions) : parseNews(body, options);
}
