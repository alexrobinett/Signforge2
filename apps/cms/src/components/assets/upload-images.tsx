/**
 * Uploading images: a button that opens the file chooser, and the files on their way up. Each
 * image is scaled in the browser into a landscape and a portrait rendition (`@signforge/media`)
 * and checked by the server before any spot can use it. Video is M3-21's.
 */
import { LoaderCircleIcon, UploadIcon, XIcon } from 'lucide-react';
import type { ChangeEvent } from 'react';
import { buttonVariants } from '~/components/ui/button';
import { useAppStore } from '~/state/provider';

export function UploadButton({ id }: { id: string }) {
  const uploadImages = useAppStore((s) => s.uploadImages);
  const chosen = (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.currentTarget.files ?? [])];
    // Cleared so that choosing the same file again (after a refusal) is a change too.
    e.currentTarget.value = '';
    if (files.length) void uploadImages(files);
  };
  return (
    <label htmlFor={id} className={buttonVariants({ size: 'lg', className: 'cursor-pointer has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50' })}>
      <UploadIcon aria-hidden /> Upload images
      <input id={id} type="file" accept="image/*" multiple className="sr-only" onChange={chosen} />
    </label>
  );
}

/** The uploads in progress, and the ones refused with the reason. */
export function UploadProgress() {
  const uploads = useAppStore((s) => s.assets.uploads);
  const dismiss = useAppStore((s) => s.dismissUpload);
  if (!uploads.length) return null;
  return (
    <ul aria-label="Uploads" className="flex flex-col gap-2">
      {uploads.map((u) => (
        <li
          key={u.key}
          role={u.error ? 'alert' : 'status'}
          className="flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5 text-sm data-[failed]:border-status-needs-you/50"
          data-failed={u.error ? '' : undefined}
        >
          {u.error ? (
            <>
              <span className="min-w-0 flex-1">
                <strong className="font-semibold">Could not upload {u.name}.</strong> <span className="text-foreground/85">{sentence(u.error)}</span>
              </span>
              <button
                type="button"
                onClick={() => dismiss(u.key)}
                aria-label={`Dismiss ${u.name}`}
                className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <XIcon className="size-4" aria-hidden />
              </button>
            </>
          ) : (
            <>
              <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">Uploading {u.name}</span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The media package and the tools speak in lowercase clauses; the page shows them as sentences. */
const sentence = (s: string) => {
  const t = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?]$/.test(t) ? t : `${t}.`;
};
