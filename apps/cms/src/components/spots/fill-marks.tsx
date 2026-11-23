/**
 * The agent's marks on a spot it just filled (#263): each field's pill, in the agent's colour for
 * filled, amber for one to check, grey for one it did not fill, with why; and the banner with the
 * counts and what to do next. A link the agent read is shown in full and never added.
 */
import type { FieldMark } from '@signforge/api/agent-inline';
import { SparklesIcon } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { cn } from '~/lib/utils';

const MARK: Record<FieldMark['state'], { word: string; className: string }> = {
  filled: { word: 'Filled', className: 'bg-actor-agent-muted text-actor-agent' },
  check: { word: 'Check', className: 'bg-status-updating-muted text-status-updating-foreground' },
  missing: { word: 'Not filled', className: 'bg-status-offline-muted text-status-offline-foreground' },
};

export function MarkPill({ mark }: { mark: FieldMark }) {
  return (
    <span data-mark={mark.state} className={cn('rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', MARK[mark.state].className)}>
      {MARK[mark.state].word}
    </span>
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
