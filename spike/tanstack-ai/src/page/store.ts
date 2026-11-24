/**
 * The spike page's state (#346, the CMS rule: no useState or useEffect, state in Zustand): a
 * Zustand store that owns `ChatClient` from `@tanstack/ai-client`, rather than `useChat`, which keeps
 * its own React state. The client's snapshot is copied into the store on every change
 * (`subscribeSnapshot`); the page reads the store with selectors and calls its actions.
 */
import { ChatClient, type ChatClientSnapshot, type ConnectionAdapter } from '@tanstack/ai-client';
import { createStore } from 'zustand/vanilla';
import { answerCard } from '../card';

export interface ChatState {
  snapshot: ChatClientSnapshot;
  question: string;
  edit: (question: string) => void;
  ask: () => Promise<void>;
  /**
   * Approve or deny every paused tool call; once each is answered the client resumes the run. The
   * client does not declare the server's tools, so their approvals arrive as generic AG-UI
   * interrupts, answered with the approval's response schema (`{ approved }`).
   */
  decide: (approved: boolean) => void;
  /** Lets the client go: the store is not used again. */
  dispose: () => void;
}

export function chatStore(connection: ConnectionAdapter, threadId: string) {
  const client = new ChatClient({ connection, threadId, outputSchema: answerCard });
  const store = createStore<ChatState>()((set, get) => ({
    snapshot: client.getSnapshot(),
    question: '',
    edit: (question) => set({ question }),
    async ask() {
      const question = get().question.trim();
      if (!question) return;
      set({ question: '' });
      await client.sendMessage(question);
    },
    decide(approved) {
      for (const interrupt of client.getInterrupts()) if (interrupt.kind === 'generic') interrupt.resolveInterrupt({ approved });
    },
    dispose: () => {
      stop();
      client.dispose();
    },
  }));
  const stop = client.subscribeSnapshot(() => store.setState({ snapshot: client.getSnapshot() }));
  return store;
}
