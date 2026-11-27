/**
 * Making a spot: from a flyer, a photo or a link, which the agent reads to fill a template (#263,
 * src/state/agent.ts); or a template (its newest approved version), an image from the library, or
 * a web page. It is made as a draft and opens in the editor. Templates are chosen from thumbnails the
 * player drew ahead of time (scripts/template-thumbnails.ts); an org's own template is a named tile.
 * A template spot is named after the template version picked, as its tile is labelled, until the person types a name, and starts with its
 * sample copy (`save_spot`'s `sample`, #360), which the server records and the editor marks until it is replaced. While Create is
 * off, the dialog says why.
 */
import { choiceVariants } from '~/components/ui/choice';
import { safeUrl } from '@signforge/contract';
import { useSuspenseQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import type { KeyboardEvent, SubmitEvent } from 'react';
import { AssetPicker } from '~/components/assets/asset-picker';
import { FillSource } from '~/components/spots/fill-source';
import { TemplateThumb } from '~/components/spots/template-thumb';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { nextName, usableVersions, type TemplateView } from '~/lib/spots';
import { assetsQuery, spotsQuery } from '~/queries/spots';
import { useAppStore } from '~/state/provider';

const KINDS = [
  { kind: 'template', label: 'Template' },
  { kind: 'image', label: 'Image' },
  { kind: 'url', label: 'Web page' },
] as const;

/** New spot. `asked`: the page's URL asks for it open (`/spots?new=true`), as another page's New spot link does (#403). */
export function NewSpotDialog({ orgId, templates, asked = false }: { orgId: string; templates: TemplateView[]; asked?: boolean }) {
  const d = useAppStore((s) => s.spotEditor.newSpot);
  const picking = useAppStore((s) => s.spotEditor.picking === 'new');
  const open = useAppStore((s) => s.openNewSpot);
  const focusBack = useAppStore((s) => s.newSpotFocusBack);
  const navigate = useNavigate();
  const edit = useAppStore((s) => s.editNewSpot);
  const pick = useAppStore((s) => s.pickImageFor);
  const create = useAppStore((s) => s.createSpot);
  const fill = useAppStore((s) => s.agent.fill);
  const fillSpot = useAppStore((s) => s.fillNewSpot);
  const forgetFill = useAppStore((s) => s.forgetFill);
  const { assets } = useSuspenseQuery(assetsQuery(orgId)).data;
  const { spots } = useSuspenseQuery(spotsQuery(orgId)).data;
  const usable = usableVersions(templates);
  const chosen = usable.find((u) => u.version.id === d.templateVersionId) ?? usable[0];
  const image = assets.find((a) => a.id === d.assetId);
  // Try another template fills the template picked below; a first fill lets the agent choose.
  const pinned = fill.again ? chosen : undefined;

  const name = d.name ?? (d.kind === 'template' && chosen ? nextName(chosen.version.manifest.name, spots) : '');
  const why =
    d.kind === 'template' && !chosen
      ? 'No template is approved for use yet.'
      : d.kind === 'image' && !image
        ? 'Choose an image first.'
        : d.kind === 'url' && !safeUrl(d.url.trim())
          ? 'Enter the page’s https address first.'
          : name.trim() === ''
            ? 'Give the spot a name first.'
            : null;
  const ready = why === null && !d.pending;
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (d.kind === 'template' && chosen && d.templateVersionId !== chosen.version.id) edit({ templateVersionId: chosen.version.id });
    void create(orgId, name, d.kind === 'template' || undefined);
  };

  /** Enter on a template creates the spot, or goes to its name while it has none. */
  const createOnEnter = (e: KeyboardEvent<HTMLFieldSetElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (ready) e.currentTarget.form?.requestSubmit();
    else document.getElementById('new-spot-name')?.focus();
  };

  return (
    <Dialog
      open={d.open || asked}
      onOpenChange={(o) => {
        open(o);
        if (!o) forgetFill();
        if (!o && asked) void navigate({ to: '/spots', search: {}, replace: true });
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <PlusIcon aria-hidden />
          New spot
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl" onCloseAutoFocus={focusBack}>
        <DialogHeader>
          <DialogTitle>New spot</DialogTitle>
          <DialogDescription>It starts as a draft. No screen shows it until you publish.</DialogDescription>
        </DialogHeader>
        <FillSource
          title="Start from a flyer, photo or link"
          help="The agent reads it and fills a template for you to check. A photo is not kept unless you use it."
          label={pinned ? `Fill ${pinned.template.name}` : 'Fill a new spot'}
          blocked={fill.again && pinned === undefined}
          secondary
          note={
            fill.again && <span className="text-sm text-foreground">{pinned ? `Fills ${pinned.template.name}, picked below.` : 'Pick a template below.'}</span>
          }
          onFill={() => void fillSpot(orgId, pinned?.version.id)}
        />
        <form onSubmit={submit} className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">What it shows</legend>
            <div className="flex flex-wrap gap-2">
              {KINDS.map((k) => (
                <label key={k.kind} className={choiceVariants({ className: 'flex h-10 items-center gap-2 rounded-lg px-3 text-sm' })}>
                  <input type="radio" name="new-spot-kind" checked={d.kind === k.kind} onChange={() => edit({ kind: k.kind })} className="accent-primary" />
                  {k.label}
                </label>
              ))}
            </div>
          </fieldset>
          {d.kind === 'template' &&
            (usable.length ? (
              <fieldset className="space-y-2" onKeyDown={createOnEnter}>
                <legend className="text-sm font-medium">Template</legend>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {usable.map((u) => (
                    <label
                      key={u.version.id}
                      className={choiceVariants({ className: 'relative flex cursor-pointer flex-col gap-1.5 rounded-lg p-1.5 text-sm' })}
                    >
                      <input
                        type="radio"
                        name="new-spot-template"
                        value={u.version.id}
                        checked={chosen?.version.id === u.version.id}
                        onChange={() => edit({ templateVersionId: u.version.id })}
                        className="absolute inset-0 size-full cursor-pointer appearance-none opacity-0"
                      />
                      {/* Its corner inside the tile's (#383): the tile's radius less its padding. */}
                      <TemplateThumb version={u.version} className="rounded-[calc(var(--radius-lg)-(--spacing(1.5)))]" />
                      <span className="line-clamp-2 px-0.5">{u.version.manifest.name}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : (
              <p className="text-sm text-muted-foreground">No templates are approved for use yet.</p>
            ))}
          {d.kind === 'image' && (
            <div className="flex items-center gap-3">
              <span className="min-w-0 flex-1 truncate text-sm">{image ? image.name : 'No image chosen'}</span>
              <Button type="button" variant="outline" onClick={() => pick('new')}>
                {image ? 'Replace' : 'Choose image'}
              </Button>
              <AssetPicker assets={assets} open={picking} onOpenChange={(o) => pick(o ? 'new' : null)} onPick={(a) => edit({ assetId: a.id })} />
            </div>
          )}
          {d.kind === 'url' && (
            <div className="space-y-2">
              <Label htmlFor="new-spot-url">Address</Label>
              <Input id="new-spot-url" type="url" inputMode="url" placeholder="https://" value={d.url} onChange={(e) => edit({ url: e.target.value })} />
              <p className="text-sm text-muted-foreground">An https page. Screens show it full screen.</p>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="new-spot-name">Name</Label>
            <Input id="new-spot-name" value={name} onChange={(e) => edit({ name: e.target.value })} maxLength={100} />
          </div>
          <p role="alert" className="text-sm font-medium text-destructive empty:hidden">
            {d.error}
          </p>
          <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
            <p id="new-spot-why" className="text-sm text-muted-foreground empty:hidden">
              {why}
            </p>
            <Button type="submit" disabled={!ready} aria-describedby={why ? 'new-spot-why' : undefined}>
              {d.pending ? 'Creating…' : 'Create spot'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
