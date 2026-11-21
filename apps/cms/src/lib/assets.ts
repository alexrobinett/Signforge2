/** The asset library's words for `list_assets`' rows. */
import type { ToolOutput } from '@signforge/tools/outputs';

/** One row of `list_assets`. `sha256`, `type`, `size`, `width` and `height` are the landscape rendition's. */
export type AssetView = ToolOutput<'list_assets'>['assets'][number];

const TYPE_WORD: Record<string, string> = { 'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/webp': 'WebP', 'image/svg+xml': 'SVG' };

const bytes = (n: number) => (n < 1000 ? `${n} B` : n < 1e6 ? `${Math.round(n / 1000)} KB` : `${(n / 1e6).toFixed(1)} MB`);

/** What a landscape screen gets: pixel size, type and weight. */
export function assetFacts(a: AssetView): string {
  const size = a.width && a.height ? `${a.width}×${a.height}` : null;
  return [size, TYPE_WORD[a.type] ?? a.type, bytes(a.size)].filter(Boolean).join(' · ');
}

export const usageText = (n: number) => (n === 0 ? 'Not used' : `Used by ${n} ${n === 1 ? 'spot' : 'spots'}`);

/** The facts under the heading. */
export function librarySummary(assets: AssetView[]): string {
  const used = assets.filter((a) => a.usageCount > 0).length;
  const unusable = assets.filter((a) => a.status !== 'verified').length;
  return [`${assets.length} ${assets.length === 1 ? 'image' : 'images'}`, used ? `${used} in use` : 'none in use', unusable ? `${unusable} not usable` : null]
    .filter(Boolean)
    .join(' · ');
}

/** The assets whose name contains the search, in any case. */
export function matching(assets: AssetView[], query: string | undefined): AssetView[] {
  const q = query?.trim().toLowerCase();
  return q ? assets.filter((a) => a.name.toLowerCase().includes(q)) : assets;
}
