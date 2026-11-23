/**
 * What `POST /api/agent/inline` takes and answers (#263), shared with the CMS: a flyer or photo as
 * base64 JPEG, PNG or WebP that the browser scaled down, or the link a person pasted; and the spot
 * it made, with a mark for each field the fill was about. It holds no Worker code, so the CMS can import it.
 */
import type { SpotView } from '@signforge/tools/outputs';
import { z } from 'zod';

/** The image types a fill takes: what the browser's scaling makes, and what both providers read. */
export const FILL_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/**
 * The most a photo may be once decoded. The browser scales it to `FILL_IMAGE_EDGE` first, which
 * leaves a flyer a few hundred kB, so the route reads it without decoding it inside the Free plan's
 * 10 ms of CPU.
 */
export const FILL_IMAGE_MAX_BYTES = 1_500_000;

/** The longest edge the browser scales a photo to: what a model reads in full detail without scaling it again. */
export const FILL_IMAGE_EDGE = 1568;

export const inlineRequest = z.object({
  source: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('image'),
      mediaType: z.enum(FILL_IMAGE_TYPES),
      data: z
        .string()
        .max(Math.ceil(FILL_IMAGE_MAX_BYTES / 3) * 4, `the photo is over ${FILL_IMAGE_MAX_BYTES / 1e6} MB`)
        .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'the photo is not base64'),
    }),
    z.object({ kind: z.literal('link'), url: z.string().trim().max(2048) }),
  ]),
  /** Fill this template version (Try another template); otherwise the model chooses among the approved ones. */
  templateVersionId: z.string().max(100).optional(),
  idempotencyKey: z.string().min(8).max(100),
});
export type InlineRequest = z.infer<typeof inlineRequest>;

/**
 * A field the fill was about: `filled` from the material, `check` a guess or a link to read before
 * use, `missing` not in the material, or a value the template did not take. A link is never
 * written: it is shown, in full, for the person to check and add.
 */
export interface FieldMark {
  state: 'filled' | 'check' | 'missing';
  note?: string;
  links?: string[];
}

/** Why a fill did not run, in a word; `message` says it in a sentence. */
export const INLINE_PROBLEMS = [
  'invalid_input',
  'forbidden',
  'no_model',
  'cannot_fill',
  'out_of_turns',
  'blocked',
  'page_refused',
  'unreachable',
  'unreadable',
  'model_refused',
  'busy',
] as const;
export type InlineProblem = (typeof INLINE_PROBLEMS)[number];

export interface InlineAnswer {
  /** The new spot, as `create_spot` gave it. */
  spot: SpotView;
  marks: Record<string, FieldMark>;
}
