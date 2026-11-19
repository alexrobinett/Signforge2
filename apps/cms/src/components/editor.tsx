/**
 * What the spot and playlist editors share (canvas board Spot editor A): the header with the
 * back link, the name and the save state; the alert for a refused save; the form's sections; Publish.
 */
import { Link } from '@tanstack/react-router';
import { ChevronLeftIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Alert, AlertDescription } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';

/** How the save is going, in the header's words. */
export function saveWord(status: 'saved' | 'unsaved' | 'saving' | 'invalid', savedAt: number | null) {
  if (status === 'saving') return 'Saving…';
  if (status === 'invalid') return 'Not saved: fix the marked field';
  if (status === 'unsaved') return 'Unsaved changes';
  return savedAt ? `Saved ${new Date(savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'No changes yet';
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
        <h1 className="truncate text-[17px] font-semibold">{title}</h1>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {about}
        </p>
      </div>
      {children && <div className="ml-auto flex gap-2">{children}</div>}
    </header>
  );
}

/** A save that failed, under the header; a refused one (`stale`: someone else changed it) offers a reload. */
export function SaveAlert({ error, stale, onReload }: { error: string | null; stale: boolean; onReload: () => void }) {
  if (!stale && !error) return null;
  return (
    <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
      <AlertDescription className="flex flex-wrap items-center gap-3">
        {error}
        {stale && (
          <Button size="sm" variant="outline" onClick={onReload}>
            Reload
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** Saves the draft now; there is nothing to save while it is saved, saving, or refused. */
export function SaveDraftButton({ status, stale, onSave }: { status: Parameters<typeof saveWord>[0]; stale: boolean; onSave: () => void }) {
  return (
    <Button variant="outline" disabled={status === 'saved' || status === 'saving' || stale} onClick={onSave}>
      Save draft
    </Button>
  );
}

/** Publishes what the editor has open; while one is on its way, says so. */
export function PublishButton({ pending, disabled, onPublish }: { pending: boolean; disabled: boolean; onPublish: () => void }) {
  return (
    <Button disabled={pending || disabled} onClick={onPublish}>
      {pending ? 'Publishing…' : 'Publish'}
    </Button>
  );
}
