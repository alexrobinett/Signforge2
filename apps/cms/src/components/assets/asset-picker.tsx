/**
 * `AssetPicker` (docs/proposals/cms-ui.md): the library in a dialog, for a spot's image field.
 * The host route loads the assets (`getAssets`) and passes them; an upload here refreshes them
 * like the library page does. Only verified images are offered. A click picks.
 *
 * The spot editor (M3-16) is its first user, so knip.jsonc lists this file as an entry until then.
 * The focal point for portrait crops is M3-16's too (see docs/tickets/M3-16-spot-editor.md).
 */
import { useId } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '~/components/ui/dialog';
import { type AssetView, matching } from '~/lib/assets';
import { useCanManage } from '~/lib/live';
import { useAppStore } from '~/state/provider';
import { ASSET_GRID, AssetCard, AssetSearch } from './asset-card';
import { UploadButton, UploadProgress } from './upload-images';

export function AssetPicker({
  assets,
  open,
  onOpenChange,
  onPick,
}: {
  assets: AssetView[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (asset: AssetView) => void;
}) {
  const id = useId();
  const canManage = useCanManage();
  const query = useAppStore((s) => s.assets.pickerQuery);
  const search = useAppStore((s) => s.searchPicker);
  const usable = assets.filter((a) => a.status === 'verified' && a.kind === 'image');
  const shown = matching(usable, query);
  const openChanged = (next: boolean) => {
    if (!next) search('');
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={openChanged}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Choose an image</DialogTitle>
          <DialogDescription>Each image has a landscape and a portrait version, made when it was uploaded.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-3">
          <AssetSearch id={`${id}-search`} value={query} onChange={search} />
          {canManage && (
            <div className="sm:ml-auto">
              <UploadButton id={`${id}-upload`} />
            </div>
          )}
        </div>
        <UploadProgress />
        {shown.length ? (
          <ul className={ASSET_GRID}>
            {shown.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(a);
                    openChanged(false);
                  }}
                  className="flex w-full flex-col overflow-hidden rounded-xl border bg-card outline-none hover:border-border-strong focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <AssetCard asset={a} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-xl border bg-card p-8 text-center text-muted-foreground">
            {usable.length ? 'No images match. Clear the search to see them all.' : 'No images yet. Upload one to use it here.'}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
