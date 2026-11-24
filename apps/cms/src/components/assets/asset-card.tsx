/**
 * An asset as the library and the picker show it: its landscape rendition on the screens' dark
 * frame, its name, what a screen gets, and how many spots use it. An upload that did not pass shows that instead of a
 * picture: its files were never stored.
 */
import { sessionBlobPath } from '@signforge/contract';
import { SearchIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { EditorFields } from '~/components/editor';
import { Input } from '~/components/ui/input';
import { type AssetView, assetFacts, usageText } from '~/lib/assets';
import { cn } from '~/lib/utils';

const STATUS_WORD = { pending: 'Upload not finished', rejected: 'Rejected', verified: null } as const;

function AssetThumb({ asset }: { asset: AssetView }) {
  const word = STATUS_WORD[asset.status];
  const svg = asset.type === 'image/svg+xml';
  return (
    <div className="flex aspect-video items-center justify-center overflow-hidden bg-stage text-stage-foreground">
      {word ? (
        <span className="px-3 text-center text-sm text-stage-muted-foreground">{word}</span>
      ) : (
        <img src={sessionBlobPath(asset.sha256)} alt="" loading="lazy" className={cn('size-full', svg ? 'object-contain p-4' : 'object-cover')} />
      )}
    </div>
  );
}

/** The thumbnail and words; `children` sits beside the name (the library's delete button). */
export function AssetCard({ asset, children }: { asset: AssetView; children?: ReactNode }) {
  return (
    <>
      <AssetThumb asset={asset} />
      <div className="flex flex-col gap-1.5 px-4 pt-3.5 pb-4 text-left">
        <div className="flex min-h-8 items-center justify-between gap-2">
          <span className="truncate text-base font-semibold" title={asset.name}>
            {asset.name}
          </span>
          {children}
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">{assetFacts(asset)}</span>
        <span className={cn('text-meta', asset.usageCount ? 'text-foreground/85' : 'text-muted-foreground')}>{usageText(asset.usageCount)}</span>
      </div>
    </>
  );
}

/** The search box above a grid of assets. */
export function AssetSearch({ id, value, onChange }: { id: string; value: string | undefined; onChange: (query: string) => void }) {
  return (
    <div className="relative max-w-sm min-w-0 flex-[1_1_16rem]">
      <label htmlFor={id} className="sr-only">
        Search images
      </label>
      <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      {/* It filters as it is typed in, so it waits for its page to hydrate (#140). */}
      <EditorFields>
        <Input id={id} type="search" placeholder="Search by name" defaultValue={value} onChange={(e) => onChange(e.target.value)} className="pl-9" />
      </EditorFields>
    </div>
  );
}

export const ASSET_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(min(15rem,100%),1fr))] gap-4';
