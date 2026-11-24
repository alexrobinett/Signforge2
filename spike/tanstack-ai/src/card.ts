/**
 * The model's part of the drawer's `AnswerCard` (apps/api/src/agent/chat-shapes.ts), as the
 * required structured output of a turn (#346): `text`, `groups` and `steps`, every one required, so a
 * reply that is only prose fails instead of becoming a card. `trace` and `drafts` are the route's.
 */
import type { AnswerCard } from '@signforge/api/agent-chat';
import { z } from 'zod';

export const answerCard = z.object({
  text: z.string().max(4000).describe('The answer, in plain words, briefly'),
  groups: z
    .array(z.object({ title: z.string().max(200), screens: z.array(z.string().max(200)).max(100), why: z.string().max(800) }))
    .max(12)
    .describe('Groups of screens with one cause; [] when none'),
  steps: z
    .array(z.object({ label: z.string().max(80), note: z.string().max(2000) }))
    .max(3)
    .describe('At most 3 notes the person could copy and send; [] when none'),
});

/**
 * The card as far as it has streamed: `ChatClient`'s snapshot does not carry the schema's type
 * (only `useChat` threads it through), so the page parses each part's `partial` and `data`.
 */
export const partialCard = z.object({
  text: z.string().optional(),
  groups: z.array(z.object({ title: z.string().optional(), screens: z.array(z.string()).optional(), why: z.string().optional() })).optional(),
  steps: z.array(z.object({ label: z.string().optional(), note: z.string().optional() })).optional(),
});

// The schema stays the current card's shape, what the drawer renders today: it fails to compile if they part.
answerCard satisfies z.ZodType<Omit<AnswerCard, 'trace' | 'drafts'>>;
