/**
 * What the agent reads (#263, #264): a flyer or a photo, dropped, taken or chosen, or a link; the
 * fill's error, with the way to Settings when an owner mends it; and the button that starts it. The
 * New spot dialog and the editor's Fill from a flyer share it, and the store's `agent.fill`.
 */
import { safeUrl } from '@signforge/contract';
import { Link } from '@tanstack/react-router';
import { SparklesIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { useAppStore } from '~/state/provider';

export function FillSource({
  title,
  help,
  label,
  blocked = false,
  secondary = false,
  note,
  onFill,
}: {
  title: string;
  help: string;
  label: string;
  /** Set while something else the fill needs is missing (a template to pick). */
  blocked?: boolean;
  /** Beside the view's own primary action (Create spot), so its button is outlined: one filled button per view (#364). */
  secondary?: boolean;
  note?: ReactNode;
  onFill: () => void;
}) {
  const fill = useAppStore((s) => s.agent.fill);
  const editFill = useAppStore((s) => s.editFill);
  const ready = (fill.photo !== null || safeUrl(fill.link.trim())) && !fill.pending && !blocked;
  // Its heading and space group it, not a box in the dialog or the editor (#377).
  return (
    <section aria-labelledby="fill-title" className="space-y-3">
      <h3 id="fill-title" className="flex items-center gap-2 text-sm font-medium text-actor-agent">
        <SparklesIcon aria-hidden className="size-4" />
        {title}
      </h3>
      <p id="fill-help" className="text-sm text-foreground">
        {help}
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
              Open Settings, AI model
            </Link>
          </>
        )}
      </p>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {note}
        <Button type="button" variant={secondary ? 'outline' : 'default'} disabled={!ready} onClick={onFill}>
          {fill.pending ? 'Reading…' : label}
        </Button>
      </div>
    </section>
  );
}
