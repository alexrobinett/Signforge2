/**
 * `read_table`'s reader: a CSV or JSON table at a URL, read now as the poller reads a `csv` or
 * `json-table` source (./poller.ts): through the same fetch guards (./fetch.ts), converted by
 * `@signforge/feeds`, within the snapshot limit. What stops it is a ToolError in words, with the
 * poller's category as `details.reason`; the body is never echoed.
 */
import { MAX_SNAPSHOT_BYTES, snapshotBytes } from '@signforge/contract';
import { FeedError, normaliseFeed } from '@signforge/feeds';
import { type TableReader, ToolError } from '@signforge/tools';
import { FetchError, type FetchGuards, guardedFetch } from './fetch';

/** Why a table could not be read, by the category (`PollError` in ./poller.ts, which the CMS words the same way). */
const WHY: Partial<Record<FetchError['code'] | FeedError['code'], string>> = {
  timeout: 'the address took too long to answer',
  'http-status': 'the address answered with an error',
  dns: 'the address could not be reached',
  network: 'the address could not be reached',
  'private-address': 'the address is on a private network',
  'blocked-address': 'the address is on a private network',
  'too-large': 'the file is larger than a screen may hold',
  malformed: 'the file is not a CSV or JSON file SignForge can read',
  'not-a-table': 'the JSON is not a list of objects at that path',
};

export function tableReader(guards: FetchGuards): TableReader {
  return {
    async read({ url, format, rowsPath }) {
      try {
        // No validators, so never a 304.
        const res = await guardedFetch(url, {}, guards);
        const table = normaliseFeed(format, res.status === 'ok' ? res.body : '', rowsPath ? { rowsPath } : {});
        if (snapshotBytes(table) > MAX_SNAPSHOT_BYTES) throw new FeedError('too-large', `the table is over ${MAX_SNAPSHOT_BYTES} bytes as JSON`);
        return table;
      } catch (e) {
        if (!(e instanceof FetchError || e instanceof FeedError)) throw e;
        // biome-ignore lint/style/useErrorCause: the cause is passed, in the options argument; the rule reads only the second argument.
        throw new ToolError('invalid_input', `Could not read the table: ${WHY[e.code] ?? e.message}`, { reason: e.code }, false, { cause: e });
      }
    },
  };
}
