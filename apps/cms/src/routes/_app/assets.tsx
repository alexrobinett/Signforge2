/**
 * Assets: the org's image library, as a tile wall in the Screens page's language. Search by name
 * (`?q=`), how many spots use each image, upload, and delete for an image no spot uses (the
 * server refuses it otherwise, and for a brand kit's logo).
 */
import { createFileRoute } from '@tanstack/react-router';
import { ImagesIcon, Trash2Icon } from 'lucide-react';
import { ASSET_GRID, AssetCard, AssetSearch } from '~/components/assets/asset-card';
import { UploadButton, UploadProgress } from '~/components/assets/upload-images';
import { EmptyState, PageHeader } from '~/components/page';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog';
import { Button } from '~/components/ui/button';
import { type AssetView, librarySummary, matching } from '~/lib/assets';
import { useCanManage, useOrgId } from '~/lib/live';
import { getAssets } from '~/server/assets.functions';
import { useAppStore } from '~/state/provider';

interface Search {
  q?: string;
}

export const Route = createFileRoute('/_app/assets')({
  validateSearch: (s: Record<string, unknown>): Search => (typeof s.q === 'string' && s.q ? { q: s.q } : {}),
  loader: () => getAssets(),
  head: () => ({ meta: [{ title: 'Assets · SignForge' }] }),
  component: AssetsPage,
});

function AssetsPage() {
  const { assets } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const canManage = useCanManage();
  const shown = matching(assets, search.q);

  return (
    <div className="space-y-6">
      <PageHeader title="Assets" description={assets.length ? librarySummary(assets) : undefined}>
        {canManage && assets.length > 0 && <UploadButton id="asset-upload" />}
      </PageHeader>
      <UploadProgress />

      {!assets.length ? (
        <EmptyState
          icon={ImagesIcon}
          title="No images yet"
          action={canManage ? <UploadButton id="asset-upload" /> : <p className="text-sm text-muted-foreground">Ask an editor or owner to upload images.</p>}
        >
          Photos and logos for your spots. Each one is scaled in your browser for landscape and portrait screens, and checked before a spot can use it.
        </EmptyState>
      ) : (
        <>
          <AssetSearch id="asset-search" value={search.q} onChange={(q) => void navigate({ search: q ? { q } : {}, replace: true })} />
          {shown.length ? (
            <ul className={ASSET_GRID}>
              {shown.map((a) => (
                <li key={a.id} className="flex flex-col overflow-hidden rounded-xl border bg-card">
                  <AssetCard asset={a}>{canManage && a.usageCount === 0 && <DeleteButton asset={a} />}</AssetCard>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-xl border bg-card p-8 text-center text-muted-foreground">No images match. Clear the search to see them all.</p>
          )}
        </>
      )}
      <ConfirmDelete />
    </div>
  );
}

function DeleteButton({ asset }: { asset: AssetView }) {
  const ask = useAppStore((s) => s.askToDeleteAsset);
  return (
    <Button variant="ghost" size="icon" aria-label={`Delete ${asset.name}`} onClick={() => ask({ id: asset.id, name: asset.name })}>
      <Trash2Icon aria-hidden />
    </Button>
  );
}

/** Deleting cannot be undone, so it asks first (the kit's dialog rule). */
function ConfirmDelete() {
  const deleting = useAppStore((s) => s.assets.deleting);
  const pending = useAppStore((s) => s.assets.deletePending);
  const error = useAppStore((s) => s.assets.deleteError);
  const ask = useAppStore((s) => s.askToDeleteAsset);
  const deleteAsset = useAppStore((s) => s.deleteAsset);
  const orgId = useOrgId();
  return (
    <AlertDialog open={!!deleting} onOpenChange={(open) => !open && ask(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">Delete {deleting?.name}?</AlertDialogTitle>
          <AlertDialogDescription>No spot uses it. To use it again, upload it again. This cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-status-needs-you-foreground">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={pending} onClick={() => void deleteAsset(orgId)}>
            {pending ? 'Deleting…' : 'Delete image'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
