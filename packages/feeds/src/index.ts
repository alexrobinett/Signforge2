/**
 * Feed normalisers: the iCalendar, RSS and Atom feeds and the CSV and JSON tables a data source
 * polls, converted to the contract's CalendarFeed, NewsFeed and TableFeed. `parseNews` also finds
 * each story's image, for the server alone. Pure functions of the body text (and, for calendars,
 * the time), so they run the same in the poller and in tests.
 */
import type { CalendarFeed, NewsFeed, TableFeed } from '@signforge/contract';
import { parseCalendar, type CalendarOptions } from './ical';
import { type FeedImage, type NewsOptions, type ParsedNews, parseNews, parseNewsFeed } from './news';
import { parseCsv, parseJsonTable, type TableOptions } from './table';

export { FeedError, LIMITS, type FeedErrorCode } from './errors';
export { FEED_URL_PROBLEMS, feedUrlProblem, type FeedUrlProblem } from './url';
export { parseCalendar, parseCsv, parseJsonTable, parseNews, type CalendarOptions, type FeedImage, type NewsOptions, type ParsedNews, type TableOptions };

export type FeedFormat = 'ical' | 'rss' | 'csv' | 'json-table';

/** Converts a feed body by its data source's format. `rss` covers RSS 2.0 and Atom. */
export function normaliseFeed(format: 'ical', body: string, options: CalendarOptions): CalendarFeed;
export function normaliseFeed(format: 'rss', body: string, options?: NewsOptions): NewsFeed;
export function normaliseFeed(format: 'csv' | 'json-table', body: string, options?: TableOptions): TableFeed;
export function normaliseFeed(format: FeedFormat, body: string, options: CalendarOptions | NewsOptions | TableOptions = {}) {
  switch (format) {
    case 'ical':
      return parseCalendar(body, options as CalendarOptions);
    case 'rss':
      // Image and logo URLs are a third party's: what a snapshot carries holds none, and none is looked for.
      return parseNewsFeed(body, options);
    case 'csv':
      return parseCsv(body, options);
    case 'json-table':
      return parseJsonTable(body, options);
  }
}
