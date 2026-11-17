/**
 * Where the player's content comes from. The playback loop, slots and frames are the same for
 * both; only the source differs.
 *
 *   device   (the default) A screen. Manifests and files come from the content base (`?content=`),
 *            the device API with the screen's credential or static files beside the player, and
 *            are verified and kept in Cache Storage (store.ts). Data comes from the data loop.
 *   preview  (`?source=preview`) The CMS editor. The CMS page that frames the player posts a draft
 *            manifest, its unsaved files and its data; other files come from the CMS's blob route
 *            with the user's session. Nothing is stored and nothing is reported (preview.ts).
 */
import { getBlob } from './store';

export type ContentSourceKind = 'device' | 'preview';

export const SOURCE: ContentSourceKind = new URLSearchParams(location.search).get('source') === 'preview' ? 'preview' : 'device';

/** Reads a file of the manifest playing, by hash. */
export type FileReader = (sha: string) => Promise<Blob>;

let reader: FileReader = getBlob;

/** A file of the manifest playing, from whichever source is in use. */
export const getFile: FileReader = (sha) => reader(sha);

/** Read files from `next` from now on. The device source keeps the default, the file cache. */
export function readFilesFrom(next: FileReader): void {
  reader = next;
}
