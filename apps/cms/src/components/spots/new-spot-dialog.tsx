/**
 * Making a spot: a template (its newest approved version), an image from the library, or a web
 * page. It is made as a draft and opens in the editor.
 */
import { safeUrl } from '@signforge/contract';
import { useSuspenseQuery } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import type { SubmitEvent } from 'react';
import { AssetPicker } from '~/components/assets/asset-picker';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { NativeSelect } from '~/components/ui/select';
import { startData, usableVersions, type TemplateView } from '~/lib/spots';
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
  const { assets } = useSuspenseQuery(assetsQuery(orgId)).data;
  const usable = usableVersions(templates);
  const chosen = usable.find((u) => u.version.id === d.templateVersionId) ?? usable[0];
  const image = assets.find((a) => a.id === d.assetId);

  const ready =
    d.name.trim() !== '' && (d.kind === 'template' ? chosen !== undefined : d.kind === 'url' ? safeUrl(d.url.trim()) : image !== undefined) && !d.pending;
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (d.kind === 'template' && chosen && d.templateVersionId !== chosen.version.id) edit({ templateVersionId: chosen.version.id });
    const m = chosen?.version.manifest;
    void create(orgId, d.kind === 'template' && m ? { durationMs: m.duration.defaultMs, data: startData(m.fields) } : undefined);
  };

  return (
    <Dialog open={d.open} onOpenChange={open}>
      <DialogTrigger asChild>
        <Button>
          <PlusIcon aria-hidden />
          New spot
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New spot</DialogTitle>
          <DialogDescription>It starts as a draft. No screen shows it until you publish.</DialogDescription>
        </DialogHeader>
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
          {d.kind === 'template' && (
            <div className="space-y-2">
              <Label htmlFor="new-spot-template">Template</Label>
              {usable.length ? (
                <NativeSelect
                  id="new-spot-template"
                  className="w-full"
                  value={chosen?.version.id}
                  onChange={(e) => edit({ templateVersionId: e.target.value })}
                >
                  {usable.map((u) => (
                    <option key={u.version.id} value={u.version.id}>
                      {u.template.name}
                    </option>
                  ))}
                </NativeSelect>
              ) : (
                <p className="text-sm text-muted-foreground">No templates are approved for use yet.</p>
              )}
            </div>
          )}
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
