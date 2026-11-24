/**
 * The agent's marks on a spot it just filled (#263): each field's pill, in the agent's colour for
 * filled, amber for one to check, grey for one it did not fill, with why; and the banner with the
 * counts and what to do next. A link the agent read is shown in full and never added.
 */
import { Badge } from '~/components/ui/badge';
import type { FieldMark } from '@signforge/api/agent-inline';
import { SparklesIcon } from 'lucide-react';
import { Button } from '~/components/ui/button';

const MARK: Record<FieldMark['state'], { word: string; variant: 'agent' | 'updating' | 'offline' }> = {
  filled: { word: 'Filled', variant: 'agent' },
  check: { word: 'Check', variant: 'updating' },
  missing: { word: 'Not filled', variant: 'offline' },
};

export function MarkPill({ mark }: { mark: FieldMark }) {
  return (
    <Badge data-mark={mark.state} variant={MARK[mark.state].variant}>
      {MARK[mark.state].word}
    </Badge>
  );
}

/** Why a field is marked, and the links read for it, each in full. */
export function MarkNote({ id, mark }: { id: string; mark: FieldMark }) {
  if (!mark.note && !mark.links?.length) return null;
  return (
    <div id={id} className="text-sm text-muted-foreground">
      {mark.note && <p>{mark.note}.</p>}
      {mark.links?.map((link) => (
        <code key={link} className="mt-1 block rounded bg-muted px-2 py-1 font-mono text-xs break-all text-foreground">
          {link}
        </code>
      ))}
    </div>
  );
}

export function FillBanner({
  marks,
  from,
  onUndo,
  onAnother,
  onDone,
}: {
  marks: Record<string, FieldMark>;
  from: 'photo' | 'link';
  onUndo: () => void;
  onAnother: () => void;
  onDone: () => void;
}) {
  const count = (state: FieldMark['state']) => Object.values(marks).filter((m) => m.state === state).length;
  return (
    <section aria-labelledby="fill-banner-title" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-actor-agent-muted px-4 py-3 sm:px-6">
      <SparklesIcon aria-hidden className="size-5 shrink-0 text-actor-agent" />
      <div className="min-w-0 flex-1">
        <h2 id="fill-banner-title" className="font-medium text-actor-agent">
          Filled by the agent from your {from}
        </h2>
        <p className="text-sm text-foreground">
          {count('filled')} filled · {count('check')} to check · {count('missing')} not filled. It is a draft: check each field before you publish.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onUndo}>
          Undo the fill
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onAnother}>
          Try another template
        </Button>
        <Button type="button" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </section>
  );
}

/** After Keep (#264): how many fields the update changed, the other spots with the same rows, and Undo. */
export function UpdateBanner({
  changed,
  undoable,
  alsoOn,
  onReview,
  onUndo,
  onDone,
}: {
  changed: number;
  /** False once every field the update changed has been edited since: there is nothing of it to undo. */
  undoable: boolean;
  alsoOn: { spotId: string; name: string; items: string[] }[];
  onReview: (spotId: string) => void;
  onUndo: () => void;
  onDone: () => void;
}) {
  return (
    <section aria-labelledby="update-banner-title" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-actor-agent-muted px-4 py-3 sm:px-6">
      <SparklesIcon aria-hidden className="size-5 shrink-0 text-actor-agent" />
      <div className="min-w-0 flex-1">
        <h2 id="update-banner-title" className="font-medium text-actor-agent">
          Updated by the agent
        </h2>
        <p className="text-sm text-foreground">
          {changed} {changed === 1 ? 'field' : 'fields'} changed, in the draft. No screen shows it until you publish.
        </p>
        {alsoOn.map((o) => (
          <p key={o.spotId} className="text-sm text-foreground">
            {o.items.join(', ')} {o.items.length > 1 ? 'are' : 'is'} also on {o.name}.{' '}
            <Button type="button" variant="link" className="h-auto p-0" onClick={() => onReview(o.spotId)}>
              Review {o.name}
            </Button>
          </p>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {undoable && (
          <Button type="button" variant="outline" size="sm" onClick={onUndo}>
            Undo the update
          </Button>
        )}
        <Button type="button" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </section>
  );
}
