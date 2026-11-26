/**
 * What the spot and playlist editors share (canvas board Spot editor A): the header with the
 * back link, the name and the save state; the alert for a refused save; the form's sections; Publish;
 * and EditorFields, which the brand kit, screen, settings, audit log and assets pages and the pairing form use too.
 */
import { Link } from '@tanstack/react-router';
import { ChevronLeftIcon, MoreHorizontalIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Alert, AlertDescription } from '~/components/ui/alert';
import { AlertDialog, AlertDialogContent } from '~/components/ui/alert-dialog';
import { Button } from '~/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '~/components/ui/dropdown-menu';
import { useHydrated } from '~/lib/hydrated';

/** How the save is going, in the header's words. */
export function saveWord(status: 'saved' | 'unsaved' | 'saving' | 'invalid', savedAt: number | null) {
  if (status === 'saving') return 'Saving…';
  if (status === 'invalid') return 'Not saved: fix the marked field';
  if (status === 'unsaved') return 'Unsaved changes';
  return savedAt ? `Saved ${new Date(savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'No changes yet';
}

/**
 * Controls that stay disabled until they have hydrated, and while `disabled`. A page's own part
 * hydrates after the app's (`body[data-hydrated]`); a control changed in between is still the
 * server's HTML, and React sets it back when it takes it over, so the change is lost and the old
 * value saved (#135, #136). A click there would go nowhere.
 */
export function EditorFields({ disabled = false, children }: { disabled?: boolean; children: ReactNode }) {
  const hydrated = useHydrated();
  return (
    <fieldset disabled={disabled || !hydrated} className="contents">
      {children}
    </fieldset>
  );
}

export function EditorSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-3.5">
      <legend className="mb-3 text-xs font-semibold tracking-[0.06em] text-muted-foreground uppercase">{title}</legend>
      {children}
    </fieldset>
  );
}

/** The editor's header: back to the list, the name, a line about it (`about`), and the actions. */
export function EditorHeader({
  back,
  title,
  about,
  children,
}: {
  back: { to: '/spots' | '/playlists'; label: string };
  title: string;
  about: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b bg-card px-4 py-2.5 sm:px-6">
      <Link to={back.to} className="flex items-center gap-1.5 py-2.5 text-muted-foreground hover:text-foreground">
        <ChevronLeftIcon className="size-4" aria-hidden />
        {back.label}
      </Link>
      <div className="flex min-w-0 flex-col gap-0.5">
        <h1 className="line-clamp-2 text-lg font-semibold wrap-anywhere">{title}</h1>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {about}
        </p>
      </div>
      {children && (
        // Wraps, right-aligned: on a phone four actions are wider than the editor, whose frame clips what overflows.
        <div className="ml-auto flex flex-wrap justify-end gap-2">
          <EditorFields>{children}</EditorFields>
        </div>
      )}
    </header>
  );
}

/** A save that failed, under the header; a refused one (`stale`: someone else changed it) offers a reload. */
export function SaveAlert({ error, stale, onReload, onRetry }: { error: string | null; stale: boolean; onReload: () => void; onRetry: () => void }) {
  if (!stale && !error) return null;
  return (
    // Announced as it appears (#479), and kept in view under a phone's top bar while the form below it scrolls: a failure
    // there was off screen while the field that failed was being edited.
    <Alert variant="destructive" role="alert" className="sticky top-14 z-20 rounded-none border-x-0 border-t-0 lg:top-0">
      <AlertDescription className="flex flex-wrap items-center gap-3">
        {error}
        {stale ? (
          <Button size="sm" variant="outline" onClick={onReload}>
            Reload
          </Button>
        ) : (
          // Not a conflict (no answer, a refusal): the edit is still here, and saves when tried again (review of #461).
          <Button size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

const MORE_ID = 'editor-more';

/**
 * The editor's ⋯ menu (#378), after Publish: Delete is in it, away from Publish, where
 * a slip would hit it. It asks first (`EditorDeleteQuestion`), which gives focus back to ⋯.
 */
export function EditorMoreMenu({ onDelete }: { onDelete: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button id={MORE_ID} variant="outline" size="icon" aria-label="More actions: delete">
          <MoreHorizontalIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}>
          Delete…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The question Delete… asks. Closed (Escape, Cancel), it gives focus to ⋯ at once. Radix gives it back
 * once the closing has played, to what had it as the question opened: the menu's Delete… item, gone by
 * then, so focus was on the page's body.
 */
export function EditorDeleteQuestion({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        // Once React has closed it: until then its focus trap takes focus back.
        if (!next) queueMicrotask(() => document.getElementById(MORE_ID)?.focus());
      }}
    >
      <AlertDialogContent onCloseAutoFocus={(e) => e.preventDefault()}>{children}</AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Publishes what the editor has open; while one is on its way, says so. Not disabled then (README,
 * React rules): focus stays on it, so a question the publish asks (#360) gives focus back to it.
 */
export function PublishButton({ pending, disabled, onPublish }: { pending: boolean; disabled: boolean; onPublish: () => void }) {
  return (
    <Button disabled={disabled} aria-disabled={pending || undefined} className={pending ? 'opacity-60' : undefined} onClick={() => !pending && onPublish()}>
      {pending ? 'Publishing…' : 'Publish'}
    </Button>
  );
}
