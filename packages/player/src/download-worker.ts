/// <reference lib="webworker" />
/**
 * Runs one download (see `download`) off the page's main thread. Receives `{ cache, req }`, answers
 * with a `DownloadResult`.
 */
import { UnauthorisedError, download, type DownloadRequest, type DownloadResult } from './download';

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async (e: MessageEvent<{ cache: string; req: DownloadRequest }>) => {
  let result: DownloadResult;
  try {
    await download(await caches.open(e.data.cache), e.data.req);
    result = { ok: true };
  } catch (err) {
    result = { ok: false, unauthorised: err instanceof UnauthorisedError, message: err instanceof Error ? err.message : String(err) };
  }
  scope.postMessage(result);
};
