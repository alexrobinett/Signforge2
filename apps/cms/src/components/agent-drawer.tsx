/**
 * The agent's drawer (#267, src/state/agent-drawer.ts): a 400 px panel on the right, beside the page
 * rather than over it (not modal), so the page stays usable; on a phone a full sheet over it, modal. It reads only.
 * Escape and its close button close it, and focus goes back to what opened it. Each answer is a card,
 * its tool calls a one-line trace that expands; the turn's progress and its answer reach a live region.
 */
import type { AnswerCard as Card } from '@signforge/api/agent-chat';
import { useQuery } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { CopyIcon, SparklesIcon, XIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { type SubmitEvent, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { Button } from '~/components/ui/button';
import { Label } from '~/components/ui/label';
import { useOrgId } from '~/lib/live';
import { screenStatusQuery } from '~/queries/screens';
import { useAppStore } from '~/state/provider';

/** A window wider than a phone, where the drawer sits beside the page; on a phone it is a sheet over it, and modal. */
const WIDE = '(min-width: 640px)';
const onResize = (change: () => void) => {
  const media = matchMedia(WIDE);
  media.addEventListener('change', change);
  return () => media.removeEventListener('change', change);
};
const useWide = () =>
  useSyncExternalStore(
    onResize,
    () => matchMedia(WIDE).matches,
    () => true,
  );

/** "Why are N screens behind?" on Screens, when N are: the question the drawer starts with there. */
function Suggestions({ path, onAsk }: { path: string; onAsk: (q: string) => void }) {
  const orgId = useOrgId();
  const status = useQuery({ ...screenStatusQuery(orgId), enabled: path === '/screens' && orgId !== '' });
  const behind = (status.data?.screens ?? []).filter((s) => s.state.kind === 'needs_you' && s.state.reason === 'behind').length;
  const questions = [
    ...(path === '/screens' && behind > 0 ? [`Why ${behind === 1 ? 'is 1 screen' : `are ${behind} screens`} behind?`] : []),
    'Which screens need me, and why?',
    'What is on screen now?',
  ];
  return (
    <ul aria-label="Questions to start with" className="flex flex-col gap-2">
      {questions.map((q) => (
        <li key={q}>
          <Button type="button" variant="outline" className="h-auto w-full justify-start py-2 text-left whitespace-normal" onClick={() => onAsk(q)}>
            {q}
          </Button>
        </li>
      ))}
    </ul>
  );
}

function AnswerCard({ card }: { card: Card }) {
  return (
    <article className="flex flex-col gap-3 rounded-lg border bg-card p-3 text-sm">
      <p className="whitespace-pre-wrap">{card.text}</p>
      {card.groups.length > 0 && (
        <ul className="flex flex-col gap-2">
          {card.groups.map((g) => (
            <li key={g.title} className="rounded-md bg-muted p-2">
              <p className="font-medium">{g.title}</p>
              <p className="text-muted-foreground">{g.screens.join(', ')}</p>
              <p>{g.why}</p>
            </li>
          ))}
        </ul>
      )}
      {card.steps.map((step) => (
        <div key={step.label} className="flex flex-col gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() =>
              void navigator.clipboard.writeText(step.note).then(
                () => toast.success('Copied'),
                () => toast.error('Could not copy', { description: 'Select the note and copy it.' }),
              )
            }
          >
            <CopyIcon aria-hidden />
            {step.label}
          </Button>
          <p className="rounded-md border bg-background p-2 whitespace-pre-wrap">{step.note}</p>
        </div>
      ))}
      {card.trace.length > 0 && (
        <details className="text-muted-foreground">
          <summary className="cursor-pointer rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            {card.trace.map((t) => t.summary).join(' · ')}
          </summary>
          <ol className="mt-1 list-decimal pl-5">
            {card.trace.map((t, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: one call may be made twice; its place tells them apart.
              <li key={`${i}-${t.name}`}>
                {t.summary} <code className="font-mono text-xs">{t.name}</code>
              </li>
            ))}
          </ol>
        </details>
      )}
    </article>
  );
}

export function AgentDrawer() {
  const d = useAppStore((s) => s.agentDrawer);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const wide = useWide();
  const close = useAppStore((s) => s.closeAgentDrawer);
  const ask = useAppStore((s) => s.askAgent);
  const edit = useAppStore((s) => s.editQuestion);
  const last = d.messages.at(-1);
  // What a screen reader hears: each call as it runs, then the answer, or why there is none.
  const heard = d.asking
    ? d.progress.length
      ? `${d.progress.map((p) => p.summary).join(' · ')}…`
      : 'Thinking…'
    : last?.role === 'assistant'
      ? last.card.text
      : last?.role === 'error'
        ? last.text
        : '';
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    void ask();
  };

  return (
    // Beside the page on a wide screen, not modal, so the page stays usable; a sheet over it on a phone, modal, so Tab
    // stays in it rather than reaching the page it hides.
    <DialogPrimitive.Root open={d.open} modal={!wide} onOpenChange={(open) => !open && close()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          aria-describedby="agent-drawer-about"
          className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l bg-background shadow-lg sm:w-[400px]"
          // The page beside it stays usable: a click there does not close it.
          onInteractOutside={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            // Once the sidebar has unfolded again: the button that opened it is drawn anew by then.
            const opener = d.opener;
            requestAnimationFrame(() => (document.querySelector<HTMLElement>(`[data-agent-opener="${opener}"]`) ?? document.getElementById('main'))?.focus());
          }}
        >
          <header className="flex items-start gap-3 border-b bg-actor-agent-muted px-4 py-3">
            <SparklesIcon aria-hidden className="mt-0.5 size-5 shrink-0 text-actor-agent" />
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="font-medium text-actor-agent">Agent</DialogPrimitive.Title>
              <DialogPrimitive.Description id="agent-drawer-about" className="text-sm text-foreground">
                It reads your organization to answer, and changes nothing.
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close the agent">
                <XIcon aria-hidden />
              </Button>
            </DialogPrimitive.Close>
          </header>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
            {d.messages.length === 0 && !d.asking && <Suggestions path={path} onAsk={(q) => void ask(q)} />}
            <ol aria-label="Conversation" className="flex flex-col gap-3 empty:hidden">
              {d.messages.map((m, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a conversation only grows; a message's place is who it is.
                <li key={i}>
                  {m.role === 'user' ? (
                    <p className="ml-8 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">{m.text}</p>
                  ) : m.role === 'assistant' ? (
                    <AnswerCard card={m.card} />
                  ) : (
                    <p className="text-sm font-medium text-destructive">
                      {m.text}
                      {m.inSettings && (
                        <>
                          {' '}
                          <Link to="/settings/ai" className="underline underline-offset-4">
                            Open Settings, AI & agents
                          </Link>
                        </>
                      )}
                    </p>
                  )}
                </li>
              ))}
            </ol>
            {d.asking && <p className="text-sm text-muted-foreground">{d.progress.length ? `${d.progress.at(-1)?.summary}…` : 'Thinking…'}</p>}
            <p role="status" aria-live="polite" className="sr-only">
              {heard}
            </p>
          </div>
          <form onSubmit={submit} className="flex flex-col gap-2 border-t p-4">
            <Label htmlFor="agent-question">Ask about your screens and content</Label>
            <textarea
              id="agent-question"
              rows={2}
              value={d.question}
              maxLength={4000}
              onChange={(e) => edit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              className="w-full resize-none rounded-lg border border-input bg-card px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
            <Button type="submit" className="self-end" disabled={d.asking || !d.question.trim()}>
              {d.asking ? 'Asking…' : 'Ask'}
            </Button>
          </form>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
