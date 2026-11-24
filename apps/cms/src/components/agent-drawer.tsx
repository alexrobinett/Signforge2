/**
 * The agent's drawer (#267, #350, src/state/agent-drawer.ts): a 400 px panel on the right, beside the
 * page rather than over it (not modal), so the page stays usable, from 1024 px, where the page makes
 * room for it; narrower, a sheet over the page, modal (#335). Escape and its close button close it,
 * and focus goes back to what opened it; a window crossing that width keeps focus in it. As a turn
 * runs, each tool call shows as its card, by the tool's title (#380), and the answer's text as it is
 * written; each answer is a card, its tool calls a one-line trace that expands. The turn's progress
 * and its answer reach a live region.
 */
import type { AnswerCard as Card, ToolCard } from '@signforge/api/agent-chat';
import { useQuery } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { CopyIcon, SparklesIcon, XIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { type SubmitEvent, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { Button } from '~/components/ui/button';
import { Label } from '~/components/ui/label';
import { useCanManage, useCanPublish, useOrgId } from '~/lib/live';
import { screenStatusQuery } from '~/queries/screens';
import { useAppStore } from '~/state/provider';

/**
 * A window wide enough for the page and the drawer side by side, where it sits beside the page (the
 * app shell's `lg:pr-[400px]`); narrower, it is a sheet over it, and modal, so Tab never reaches a page it covers (#335).
 */
const WIDE = '(min-width: 1024px)';
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

/**
 * The change summary card (#268): each change the agent drafted, before → after, a link to check
 * marked amber in full, and how many screens it reaches; Save as draft once every change is shown
 * (or why it cannot be, with Try again), then Undo these changes and, for those who may, Publish now….
 * A rename is not a draft: it shows at once. A viewer's are a request to copy, never saved.
 */
function DraftsCard({ index }: { index: number }) {
  const m = useAppStore((s) => s.agentDrawer.messages[index]);
  const save = useAppStore((s) => s.saveDrafts);
  const show = useAppStore((s) => s.showDrafts);
  const undo = useAppStore((s) => s.undoDrafts);
  const confirm = useAppStore((s) => s.confirmPublish);
  const publish = useAppStore((s) => s.publishDrafts);
  const canManage = useCanManage();
  const canPublish = useCanPublish();
  if (m?.role !== 'assistant' || !m.drafts) return null;
  const d = m.drafts;
  const summaries = d.shown.state === 'shown' ? d.shown.summaries : [];
  const savable = summaries.length === m.card.drafts.length;
  // A screen's new name shows at once; the rest wait for a publish.
  const renames = m.card.drafts.filter((c) => c.tool === 'rename_screen').length;
  const drafted = m.card.drafts.length - renames;
  const request = summaries.map((s) => [s.title, ...s.lines.map((l) => `${l.label}: ${l.before} → ${l.after}`), s.reach].join('\n')).join('\n\n');
  return (
    <section aria-label="Changes the agent drafted" className="mt-2 flex flex-col gap-3 rounded-lg border border-actor-agent/40 bg-card p-3 text-sm">
      {d.shown.state === 'working' ? (
        <p className="text-muted-foreground">Working out what the {m.card.drafts.length === 1 ? 'change does' : 'changes do'}…</p>
      ) : d.shown.state === 'failed' ? (
        <div className="flex flex-col gap-2">
          <p className="font-medium text-destructive">{d.shown.reason} Nothing is saved until every change is shown.</p>
          <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => void show(index)}>
            Try again
          </Button>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {summaries.map((s, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: two drafts may change one thing; their place tells them apart.
            <li key={`${i}-${s.title}`} className="flex flex-col gap-1">
              <p className="font-medium">{s.title}</p>
              {s.lines.map((l) => (
                <p key={l.label} data-check={l.check || undefined} className="break-words">
                  {l.label}: <del className="text-muted-foreground">{l.before}</del> → <ins className="no-underline">{l.after}</ins>
                  {l.check && (
                    <span className="ml-1.5 rounded-full bg-status-updating-muted px-2 py-0.5 text-xs font-medium text-status-updating-foreground">Check</span>
                  )}
                </p>
              ))}
              <p className="text-muted-foreground">{s.reach}</p>
            </li>
          ))}
        </ul>
      )}
      <p role="alert" className="font-medium text-destructive empty:hidden">
        {d.error && (d.status === 'refused' ? `Not saved: ${d.error}. Nothing of it was overwritten.` : d.error)}
      </p>
      {!canManage ? (
        <div className="flex flex-col gap-2">
          <p>Not saved: you can view only. Send it to an editor as a request.</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() =>
              void navigator.clipboard.writeText(request).then(
                () => toast.success('Copied'),
                () => toast.error('Could not copy'),
              )
            }
          >
            <CopyIcon aria-hidden />
            Copy as a request
          </Button>
        </div>
      ) : d.status === 'proposed' || d.status === 'saving' ? (
        <Button type="button" size="sm" className="self-start" disabled={d.status === 'saving' || !savable} onClick={() => void save(index)}>
          {d.status === 'saving' ? 'Saving…' : drafted ? 'Save as draft' : 'Save'}
        </Button>
      ) : d.status === 'undone' ? (
        <p>Undone: the drafts are as they were.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {d.status !== 'refused' && (
            <p className="font-medium">
              {d.status === 'published'
                ? 'Published.'
                : !drafted
                  ? 'Saved. The new name shows at once.'
                  : renames
                    ? 'Saved. The new screen name shows at once; the rest is a draft no screen shows until it is published.'
                    : 'Saved as draft. No screen shows it until it is published.'}
            </p>
          )}
          {d.confirming ? (
            <div className="flex flex-wrap items-center gap-2">
              <span>Publish these changes to screens now?</span>
              <Button type="button" size="sm" onClick={() => void publish(index)}>
                Publish
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => confirm(index, false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {d.status !== 'published' && (
                <Button type="button" variant="outline" size="sm" disabled={d.status === 'undoing'} onClick={() => void undo(index)}>
                  {d.status === 'undoing' ? 'Undoing…' : 'Undo these changes'}
                </Button>
              )}
              {d.status === 'saved' &&
                drafted > 0 &&
                (canPublish ? (
                  <Button type="button" size="sm" onClick={() => confirm(index, true)}>
                    Publish now…
                  </Button>
                ) : (
                  <p>Only owners publish in this organization: ask one to publish it.</p>
                ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** A tool call's card: the tool's title, and what the call did. */
function CallCard({ card }: { card: ToolCard }) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-2">
      <span className="font-medium text-foreground">{card.title}</span>
      <span className={card.ok ? undefined : 'text-destructive'}>{card.summary}</span>
    </span>
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
          <ol className="mt-1 flex flex-col gap-1">
            {card.trace.map((t, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: one call may be made twice; its place tells them apart.
              <li key={`${i}-${t.tool}`}>
                <CallCard card={t} />
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
            // Still open: the window crossed the width where it turns modal, which draws it anew. Focus stays in it (#335).
            if (d.open) return;
            // Once the sidebar has unfolded again: the button that opened it is drawn anew by then. One hidden since (the
            // window resized: the top bar's button on a wide screen, the sidebar's on a phone) gives way to the Agent
            // button shown, then the page (review of #402).
            const opener = d.opener;
            requestAnimationFrame(() => {
              const shown = (el: HTMLElement | null) => (el?.checkVisibility() ? el : null);
              const agent = [...document.querySelectorAll<HTMLElement>('[data-agent-opener]')].find((el) => el.checkVisibility());
              (shown(document.querySelector<HTMLElement>(`[data-agent-opener="${opener}"]`)) ?? agent ?? document.getElementById('main'))?.focus();
            });
          }}
        >
          <header className="flex items-start gap-3 border-b bg-actor-agent-muted px-4 py-3">
            <SparklesIcon aria-hidden className="mt-0.5 size-5 shrink-0 text-actor-agent" />
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="font-medium text-actor-agent">Agent</DialogPrimitive.Title>
              <DialogPrimitive.Description id="agent-drawer-about" className="text-sm text-foreground">
                It reads your organization to answer, and drafts changes you see before you save them.
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
                    <>
                      <AnswerCard card={m.card} />
                      {m.drafts && <DraftsCard index={i} />}
                    </>
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
            {d.asking && (
              <div className="flex flex-col gap-2 text-sm text-muted-foreground">
                {d.progress.length > 0 && (
                  <ol aria-label="What the agent is doing" className="flex flex-col gap-1">
                    {d.progress.map((t, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: a turn's calls only grow; a call's place is who it is.
                      <li key={`${i}-${t.tool}`}>
                        <CallCard card={t} />
                      </li>
                    ))}
                  </ol>
                )}
                {/* The text as it is written is not read out: the live region below says the answer once it is whole (review of #402). */}
                {d.streaming ? (
                  <p aria-hidden className="whitespace-pre-wrap text-foreground">
                    {d.streaming}
                  </p>
                ) : (
                  <p>{d.progress.length ? 'Working…' : 'Thinking…'}</p>
                )}
              </div>
            )}
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
