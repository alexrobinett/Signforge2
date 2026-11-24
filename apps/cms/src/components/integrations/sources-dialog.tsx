/**
 * One kind's data sources, in a dialog: each with its health and the spots that read it, its URL
 * changed, a news feed's photos switched off or on, or the source deleted (editors and owners), and
 * a feed or calendar added by its address.
 */
import { safeUrl } from '@signforge/contract';
import type { SubmitEvent } from 'react';
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { type Clock, failingWords, hasAddress, kindOf, type ListedSource, type SourceKind, sourceState, weatherFixWords } from '~/lib/integrations';
import { SOURCES_DIALOG } from '~/state/integrations';
import { cn } from '~/lib/utils';
import { useAppStore } from '~/state/provider';

const TITLE: Record<SourceKind, string> = {
  rss: 'RSS / Atom feeds',
  json: 'Weather',
  ical: 'iCal calendars',
  table: 'CSV and JSON files',
  provider: 'Sources from accounts',
};

const ABOUT: Record<SourceKind, string> = {
  rss: 'Headlines for the News template. Screens get each new copy with their next sync.',
  json: 'Forecasts for the Weather template, one per place and units.',
  ical: 'Events for the Agenda and Room status templates, from any calendar that publishes an .ics link.',
  table: 'Rows for a Menu Board’s items. Add a file from a Menu Board spot’s Source section, where its columns are matched to the items.',
  provider: 'Data read through an account the organization connected.',
};

/** What the add form makes and calls it. Weather sources come from a place, and tables with their columns mapped, both in the spot editor. */
const ADD = { rss: { noun: 'feed', button: 'Add a feed' }, ical: { noun: 'calendar', button: 'Add a calendar' } } as const;

const isAddable = (k: SourceKind): k is keyof typeof ADD => k in ADD;

export function SourcesDialog({ orgId, sources, clock, canManage }: { orgId: string; sources: ListedSource[]; clock: Clock; canManage: boolean }) {
  const s = useAppStore((st) => st.integrations);
  const openSources = useAppStore((st) => st.openSources);
  const focusBack = useAppStore((st) => st.focusBack);
  const format = s.dialog;
  const mine = format ? sources.filter((x) => kindOf(x.format) === format) : [];

  return (
    <Dialog open={format !== null} onOpenChange={(open) => !open && openSources(null)}>
      <DialogContent id={SOURCES_DIALOG} className="max-h-[90dvh] overflow-y-auto sm:max-w-xl" onCloseAutoFocus={(e) => focusBack('sources', e)}>
        {format && (
          <>
            <DialogHeader>
              <DialogTitle>{TITLE[format]}</DialogTitle>
              <DialogDescription>{ABOUT[format]}</DialogDescription>
            </DialogHeader>
            {mine.length ? (
              <ul className="divide-y rounded-lg border">
                {mine.map((source) => (
                  <SourceItem key={source.id} orgId={orgId} source={source} clock={clock} canManage={canManage} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">None yet.</p>
            )}
            {canManage && isAddable(format) && s.editing === null && <AddSource orgId={orgId} format={format} />}
            <p role="alert" className="text-sm font-medium text-destructive empty:hidden">
              {s.deleting ? null : s.error}
            </p>
            <ConfirmDelete orgId={orgId} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SourceItem({ orgId, source, clock, canManage }: { orgId: string; source: ListedSource; clock: Clock; canManage: boolean }) {
  const editing = useAppStore((st) => st.integrations.editing === source.id);
  const feedUrl = useAppStore((st) => st.integrations.feedUrl);
  const pending = useAppStore((st) => st.integrations.pending);
  const editSourceUrl = useAppStore((st) => st.editSourceUrl);
  const typeSourceUrl = useAppStore((st) => st.typeSourceUrl);
  const changeSourceUrl = useAppStore((st) => st.changeSourceUrl);
  const askToDeleteSource = useAppStore((st) => st.askToDeleteSource);
  const setSourcePhotos = useAppStore((st) => st.setSourcePhotos);
  const settingPhotos = useAppStore((st) => st.integrations.settingPhotos);
  const photos = settingPhotos?.id === source.id ? settingPhotos.photos : source.photos;
  const state = sourceState(source, clock);
  const inputId = `source-url-${source.id}`;
  const photosId = `source-photos-${source.id}`;
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    void changeSourceUrl(orgId, source);
  };

  return (
    <li className="space-y-3 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <strong className="font-semibold">{source.name}</strong>
        <span className={cn('font-mono text-meta', state.tone === 'failing' ? 'font-semibold text-destructive' : 'text-muted-foreground')}>
          {state.tone === 'ok' ? `checked ${state.word}` : state.word}
        </span>
      </div>
      {state.tone === 'failing' && <p className="text-sm">{failingWords(source, clock)}</p>}
      {state.tone === 'waiting' && <p className="text-sm text-muted-foreground">Its first check of this address runs within a minute.</p>}
      <p className="text-sm text-muted-foreground">{source.spots.length ? `Used by ${source.spots.map((x) => x.name).join(', ')}.` : 'No spot uses it yet.'}</p>
      {source.format === 'json' && state.tone === 'failing' && <p className="text-sm text-muted-foreground">{weatherFixWords(source)}</p>}
      {source.format === 'rss' && (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <input
              id={photosId}
              type="checkbox"
              className="size-4 accent-primary"
              checked={photos}
              disabled={!canManage || pending}
              onChange={(e) => void setSourcePhotos(orgId, source, e.target.checked)}
            />
            <Label htmlFor={photosId}>Show story photos</Label>
          </div>
          <p className="text-sm text-muted-foreground">
            {photos
              ? 'SignForge fetches and checks each story’s photo, and screens show its copy. Turn this off to show headlines only.'
              : 'Screens show headlines only.'}
          </p>
        </div>
      )}
      {canManage &&
        source.format !== 'provider' &&
        (editing && hasAddress(source) ? (
          <form onSubmit={submit} className="space-y-2">
            <Label htmlFor={inputId}>New address for {source.name}</Label>
            <Input
              id={inputId}
              type="url"
              inputMode="url"
              placeholder="https://"
              value={feedUrl}
              onChange={(e) => typeSourceUrl(e.target.value)}
              ref={focusOnMount}
            />
            <p className="text-sm text-muted-foreground">Addresses are stored encrypted and never shown again, so type it in full.</p>
            <div className="flex gap-2">
              <Button type="submit" disabled={!safeUrl(feedUrl.trim()) || pending}>
                {pending ? 'Saving…' : 'Save URL'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => editSourceUrl(null)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap gap-2">
            {hasAddress(source) && (
              <Button type="button" variant="outline" size="sm" onClick={() => editSourceUrl(source.id)} aria-label={`Change the URL of ${source.name}`}>
                Change URL
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => askToDeleteSource(source)}
              aria-label={`Delete ${source.name}`}
              className="text-destructive"
            >
              Delete
            </Button>
          </div>
        ))}
    </li>
  );
}

function AddSource({ orgId, format }: { orgId: string; format: keyof typeof ADD }) {
  const adding = useAppStore((st) => st.integrations.adding);
  const d = useAppStore((st) => st.integrations.newSource);
  const pending = useAppStore((st) => st.integrations.pending);
  const openAddSource = useAppStore((st) => st.openAddSource);
  const edit = useAppStore((st) => st.editNewSource);
  const addSource = useAppStore((st) => st.addSource);
  const { noun, button } = ADD[format];
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    void addSource(orgId, format);
  };

  if (!adding)
    return (
      <Button type="button" variant="outline" className="justify-self-start" onClick={() => openAddSource(true)}>
        {button}
      </Button>
    );
  return (
    <form onSubmit={submit} aria-label={button} className="space-y-3 rounded-lg border p-3">
      <div className="space-y-2">
        <Label htmlFor="new-source-url">Address</Label>
        <Input
          id="new-source-url"
          type="url"
          inputMode="url"
          placeholder="https://"
          value={d.feedUrl}
          onChange={(e) => edit({ feedUrl: e.target.value })}
          ref={focusOnMount}
        />
        <p className="text-sm text-muted-foreground">An https link to the {noun}. It is stored encrypted and never shown again.</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="new-source-name">Name</Label>
        <Input id="new-source-name" value={d.name} maxLength={100} onChange={(e) => edit({ name: e.target.value })} />
      </div>
      {format === 'ical' && (
        <div className="space-y-2">
          <Label htmlFor="new-source-days">Days ahead</Label>
          <Input
            id="new-source-days"
            type="number"
            min={1}
            max={366}
            value={d.horizonDays ?? ''}
            onChange={(e) => edit({ horizonDays: Number.isNaN(e.target.valueAsNumber) ? null : e.target.valueAsNumber })}
            className="w-28"
          />
        </div>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={!safeUrl(d.feedUrl.trim()) || (format === 'ical' && d.horizonDays === null) || pending}>
          {pending ? 'Adding…' : `Add ${noun}`}
        </Button>
        <Button type="button" variant="ghost" onClick={() => openAddSource(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Deleting cannot be undone, and the address is never shown again, so it asks first (as Assets does). */
function ConfirmDelete({ orgId }: { orgId: string }) {
  const deleting = useAppStore((st) => st.integrations.deleting);
  const pending = useAppStore((st) => st.integrations.pending);
  const error = useAppStore((st) => st.integrations.error);
  const ask = useAppStore((st) => st.askToDeleteSource);
  const deleteSource = useAppStore((st) => st.deleteSource);
  const focusBack = useAppStore((st) => st.focusBack);
  return (
    <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && ask(null)}>
      <AlertDialogContent onCloseAutoFocus={(e) => focusBack('delete', e)}>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">Delete {deleting?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {deleting && !hasAddress(deleting)
              ? 'A weather source is made from a place: to use it again, choose the place again in a weather spot. This cannot be undone.'
              : "SignForge never shows a source's address, so to use it again you must type its address again. This cannot be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p role="alert" className="text-sm font-medium text-destructive empty:hidden">
          {error}
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={pending} onClick={() => void deleteSource(orgId)}>
            {pending ? 'Deleting…' : 'Delete source'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Focus the field a form opens on. Stable, so it runs once per mount. */
const focusOnMount = (el: HTMLInputElement | null) => el?.focus();
