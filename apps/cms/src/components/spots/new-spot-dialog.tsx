/**
 * Making a spot: from a flyer, a photo or a link, which the agent reads to fill a template (#263,
 * src/state/agent.ts); or a template (its newest approved version), an image from the library, or
 * a web page. It is made as a draft and opens in the editor. Templates are chosen from thumbnails the
 * player drew ahead of time (scripts/template-thumbnails.ts); an org's own template is a named tile.
 */
import { startData } from '@signforge/compiler/draft';
import { safeUrl } from '@signforge/contract';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PlusIcon, SparklesIcon } from 'lucide-react';
import type { KeyboardEvent, SubmitEvent } from 'react';
import { AssetPicker } from '~/components/assets/asset-picker';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { usableVersions, type TemplateView } from '~/lib/spots';
import thumbnails from '~/lib/template-thumbnails.json';
import { assetsQuery } from '~/queries/spots';
import { useAppStore } from '~/state/provider';

const KINDS = [
  { kind: 'template', label: 'Template' },
  { kind: 'image', label: 'Image' },
  { kind: 'url', label: 'Web page' },
] as const;

export function NewSpotDialog({ orgId, templates }: { orgId: string; templates: TemplateView[] }) {
  const d = useAppStore((s) => s.spotEditor.newSpot);
  const picking = useAppStore((s) => s.spotEditor.picking === 'new');
  const open = useAppStore((s) => s.openNewSpot);
  const edit = useAppStore((s) => s.editNewSpot);
  const pick = useAppStore((s) => s.pickImageFor);
  const create = useAppStore((s) => s.createSpot);
  const fill = useAppStore((s) => s.agent.fill);
  const editFill = useAppStore((s) => s.editFill);
  const fillSpot = useAppStore((s) => s.fillNewSpot);
  const forgetFill = useAppStore((s) => s.forgetFill);
  const { assets } = useSuspenseQuery(assetsQuery(orgId)).data;
  const usable = usableVersions(templates);
  const chosen = usable.find((u) => u.version.id === d.templateVersionId) ?? usable[0];
  const image = assets.find((a) => a.id === d.assetId);
  // Try another template fills the template picked below; a first fill lets the agent choose.
  const pinned = fill.again ? chosen : undefined;
  const fillReady = (fill.photo !== null || safeUrl(fill.link.trim())) && !fill.pending && (!fill.again || pinned !== undefined);

  const ready =
    d.name.trim() !== '' && (d.kind === 'template' ? chosen !== undefined : d.kind === 'url' ? safeUrl(d.url.trim()) : image !== undefined) && !d.pending;
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (d.kind === 'template' && chosen && d.templateVersionId !== chosen.version.id) edit({ templateVersionId: chosen.version.id });
    const m = chosen?.version.manifest;
    void create(orgId, d.kind === 'template' && m ? { durationMs: m.duration.defaultMs, data: startData(m.fields) } : undefined);
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
      open={d.open}
      onOpenChange={(o) => {
        open(o);
        if (!o) forgetFill();
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <PlusIcon aria-hidden />
          New spot
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New spot</DialogTitle>
          <DialogDescription>It starts as a draft. No screen shows it until you publish.</DialogDescription>
        </DialogHeader>
        <section aria-labelledby="fill-title" className="space-y-3 rounded-lg border bg-actor-agent-muted p-3">
          <h3 id="fill-title" className="flex items-center gap-2 text-sm font-medium text-actor-agent">
            <SparklesIcon aria-hidden className="size-4" />
            Start from a flyer, photo or link
          </h3>
          <p id="fill-help" className="text-sm text-foreground">
            The agent reads it and fills a template for you to check. A photo is not kept unless you use it.
          </p>
          <label className="relative flex min-h-16 cursor-pointer items-center justify-center rounded-md border border-dashed border-input bg-card px-3 py-2 text-center text-sm has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50">
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              aria-describedby="fill-help"
              onChange={(e) => editFill({ photo: e.target.files?.[0] ?? null })}
              className="absolute inset-0 size-full cursor-pointer opacity-0"
            />
            {fill.photo ? fill.photo.name : 'Drop a flyer or a photo here, or take or choose one'}
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="fill-link">Or a link</Label>
            <Input id="fill-link" type="url" inputMode="url" placeholder="https://" value={fill.link} onChange={(e) => editFill({ link: e.target.value })} />
          </div>
          <p role="alert" className="text-sm font-medium text-destructive empty:hidden">
            {fill.error}
            {fill.error && fill.inSettings && (
              <>
                {' '}
                <Link to="/settings/ai" className="underline underline-offset-4">
                  Open Settings, AI & agents
                </Link>
              </>
            )}
          </p>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {fill.again && (
              <span className="text-sm text-foreground">{pinned ? `Fills ${pinned.template.name}, picked below.` : 'Pick a template below.'}</span>
            )}
            <Button type="button" disabled={!fillReady} onClick={() => void fillSpot(orgId, pinned?.version.id)}>
              {fill.pending ? 'Reading…' : pinned ? `Fill ${pinned.template.name}` : 'Fill a new spot'}
            </Button>
          </div>
        </section>
        <form onSubmit={submit} className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">What it shows</legend>
            <div className="flex flex-wrap gap-2">
              {KINDS.map((k) => (
                <label key={k.kind} className="flex h-10 items-center gap-2 rounded-lg border px-3 text-sm has-checked:border-primary has-checked:bg-accent">
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
                      className="relative flex cursor-pointer flex-col gap-1.5 rounded-lg border p-1.5 text-sm has-checked:border-primary has-checked:bg-accent has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50"
                    >
                      <input
                        type="radio"
                        name="new-spot-template"
                        value={u.version.id}
                        checked={chosen?.version.id === u.version.id}
                        onChange={() => edit({ templateVersionId: u.version.id })}
                        className="absolute inset-0 size-full cursor-pointer appearance-none opacity-0"
                      />
                      <Thumbnail template={u.template} />
                      <span className="line-clamp-2 px-0.5">{u.template.name}</span>
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
            <Input id="new-spot-name" value={d.name} onChange={(e) => edit({ name: e.target.value })} maxLength={100} />
          </div>
          <p role="alert" className="text-sm font-medium text-destructive empty:hidden">
            {d.error}
          </p>
          <div className="flex justify-end">
            <Button type="submit" disabled={!ready}>
              {d.pending ? 'Creating…' : 'Create spot'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const THUMBNAILS: Record<string, string> = thumbnails;

/** A base template's thumbnail, drawn by the player; an org's template, or one not drawn yet, is its name on a tile. */
function Thumbnail({ template }: { template: TemplateView }) {
  const drawn = template.owner === 'base' && template.key in THUMBNAILS;
  return drawn ? (
    <img src={`/template-thumbnails/${template.key}.webp`} alt="" width={480} height={270} className="aspect-video w-full rounded-md bg-muted object-cover" />
  ) : (
    <span aria-hidden className="grid aspect-video w-full place-items-center rounded-md bg-muted px-2 text-center text-xs font-medium text-muted-foreground">
      {template.name}
    </span>
  );
}
