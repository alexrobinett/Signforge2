/**
 * The asset library and the asset picker: images being uploaded, the delete being confirmed, and
 * the picker's search (the page's search is in its URL, `/assets?q=`). Assets themselves come
 * from the route loaders.
 */
import { uploadImage } from '@signforge/media';
import { callTool, toolMessage } from '~/lib/tools';
import type { SliceCreator } from './store';

/** A file on its way up. It leaves the list once it is in the library; a refusal stays until dismissed. */
interface Upload {
  key: string;
  name: string;
  error: string | null;
}

interface AssetsState {
  uploads: Upload[];
  /** The asset whose deletion is being confirmed. */
  deleting: { id: string; name: string } | null;
  deletePending: boolean;
  deleteError: string | null;
  pickerQuery: string;
}

export interface AssetsSlice {
  assets: AssetsState;
  /** Scales each image into its renditions here, uploads them and has the server check them, one file at a time. */
  uploadImages: (files: File[]) => Promise<void>;
  dismissUpload: (key: string) => void;
  /** Opens the confirmation for one asset; null closes it. */
  askToDeleteAsset: (asset: { id: string; name: string } | null) => void;
  deleteAsset: () => Promise<void>;
  searchPicker: (query: string) => void;
}

const initialAssets: AssetsState = { uploads: [], deleting: null, deletePending: false, deleteError: null, pickerQuery: '' };

export const createAssetsSlice: SliceCreator<AssetsSlice> = (set, get, { router }) => {
  const assets = (change: (a: AssetsState) => AssetsState) => set((s) => ({ assets: change(s.assets) }));
  const uploads = (change: (u: Upload[]) => Upload[]) => assets((a) => ({ ...a, uploads: change(a.uploads) }));

  return {
    assets: initialAssets,

    async uploadImages(files) {
      const queued = files.map((file) => ({ file, key: crypto.randomUUID() }));
      uploads((u) => [...u, ...queued.map(({ file, key }) => ({ key, name: file.name, error: null }))]);
      // One at a time: a 4K photo decoded twice is already a lot of memory for a phone.
      for (const { file, key } of queued) {
        try {
          await uploadImage(file, { callTool });
          uploads((u) => u.filter((x) => x.key !== key));
          await router.invalidate();
        } catch (err) {
          uploads((u) => u.map((x) => (x.key === key ? { ...x, error: toolMessage(err) } : x)));
        }
      }
    },
    dismissUpload: (key) => uploads((u) => u.filter((x) => x.key !== key)),

    askToDeleteAsset: (asset) => assets((a) => ({ ...a, deleting: asset, deletePending: false, deleteError: null })),
    async deleteAsset() {
      const target = get().assets.deleting;
      if (!target) return;
      assets((a) => ({ ...a, deletePending: true, deleteError: null }));
      try {
        await callTool('delete_asset', { assetId: target.id });
        await router.invalidate();
        assets((a) => ({ ...a, deleting: null, deletePending: false }));
      } catch (err) {
        assets((a) => ({ ...a, deletePending: false, deleteError: toolMessage(err) }));
      }
    },

    searchPicker: (pickerQuery) => assets((a) => ({ ...a, pickerQuery })),
  };
};
