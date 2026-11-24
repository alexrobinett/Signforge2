/**
 * The spike page (#346): a conversation from the Zustand store (./store.ts), no useState or
 * useEffect. Text parts as paragraphs; each tool call as a card with its state and what it found
 * (its result metadata, which the model never saw); a paused call with Approve and Deny; and the
 * structured answer as the drawer's AnswerCard, filling in from `partial` until `data` arrives.
 */
import type { MessagePart } from '@tanstack/ai-client';
import type { StoreApi } from 'zustand';
import { useStore } from 'zustand';
import { partialCard } from '../card';
import type { z } from 'zod';
import type { ChatState } from './store';

type Part = MessagePart;

/** An input's value; read without the DOM's types, which the Worker's tests compile without. */
const inputValue = (target: unknown) =>
  typeof target === 'object' && target !== null && 'value' in target && typeof target.value === 'string' ? target.value : '';

/** What a registry tool's result names: its rows' names, from its result metadata. */
function found(metadata: unknown): string {
  if (typeof metadata !== 'object' || metadata === null) return '';
  const rows = Object.values(metadata).find(Array.isArray);
  if (!rows) return '';
  const names = rows.flatMap((r: unknown) => (typeof r === 'object' && r !== null && 'name' in r && typeof r.name === 'string' ? [r.name] : []));
  return `${rows.length} found: ${names.join(', ')}`;
}

function Card({ card, done }: { card: z.infer<typeof partialCard>; done: boolean }) {
  return (
    <article aria-label="Answer" data-done={done}>
      <p>{card.text ?? '…'}</p>
      {(card.groups ?? []).map((g, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a streaming group has no title yet; its place is who it is.
        <section key={i}>
          <h3>{g.title}</h3>
          <p>{(g.screens ?? []).join(', ')}</p>
          <p>{g.why}</p>
        </section>
      ))}
      {(card.steps ?? []).map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: as the groups.
        <section key={i} aria-label={s.label}>
          <pre>{s.note}</pre>
        </section>
      ))}
    </article>
  );
}

function PartView({ part, decide }: { part: Part; decide: (approved: boolean) => void }) {
  if (part.type === 'text') return <p>{part.content}</p>;
  if (part.type === 'tool-call')
    return (
      <section aria-label={`Tool ${part.name}`} data-state={part.state}>
        <code>{part.name}</code> {part.state} {found(part.resultMetadata)}
        {part.state === 'approval-requested' && (
          <span>
            <button type="button" onClick={() => decide(true)}>
              Approve
            </button>
            <button type="button" onClick={() => decide(false)}>
              Deny
            </button>
          </span>
        )}
      </section>
    );
  if (part.type === 'structured-output') {
    if (part.status === 'error') return <p role="alert">No answer card: {part.errorMessage}</p>;
    const card = partialCard.safeParse(part.status === 'complete' ? part.data : (part.partial ?? {}));
    return <Card card={card.success ? card.data : {}} done={part.status === 'complete'} />;
  }
  return null;
}

export function ChatPage({ store }: { store: StoreApi<ChatState> }) {
  const messages = useStore(store, (s) => s.snapshot.messages);
  const loading = useStore(store, (s) => s.snapshot.isLoading);
  const error = useStore(store, (s) => s.snapshot.error);
  const question = useStore(store, (s) => s.question);
  const { edit, ask, decide } = store.getState();
  return (
    <main>
      <ol aria-label="Conversation">
        {messages.map((m) => (
          <li key={m.id} data-role={m.role}>
            {m.parts.map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a message's parts only grow; a part's place is who it is.
              <PartView key={i} part={p} decide={decide} />
            ))}
          </li>
        ))}
      </ol>
      {error && <p role="alert">{error.message}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <label htmlFor="question">Ask about your screens</label>
        <input id="question" value={question} onChange={(e) => edit(inputValue(e.target))} />
        <button type="submit" disabled={loading}>
          Ask
        </button>
      </form>
    </main>
  );
}
