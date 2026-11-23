/**
 * What `POST /api/agent/inline` takes and answers (#263), shared with the CMS: a flyer or photo as
 * base64 JPEG, PNG or WebP that the browser scaled down, or the link a person pasted; and the spot
 * it made, with a mark for each field the fill was about. Types and constants only, so the CMS imports
 * it without the API's code or schemas; the route parses a request with its own (./inline.ts).
 */
import type { SpotView } from '@signforge/tools/outputs';

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

/** A fill's request: the photo or the link, and the template to fill when the person picks it (Try another template). */
export interface InlineRequest {
  source: { kind: 'image'; mediaType: (typeof FILL_IMAGE_TYPES)[number]; data: string } | { kind: 'link'; url: string };
  templateVersionId?: string;
  idempotencyKey: string;
}

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
export type InlineProblem =
  | 'invalid_input'
  | 'forbidden'
  | 'no_model'
  | 'cannot_fill'
  | 'out_of_turns'
  | 'rate_limited'
  | 'conflict'
  | 'blocked'
  | 'page_refused'
  | 'unreachable'
  | 'unreadable'
  | 'model_refused'
  | 'busy';

export interface InlineAnswer {
  /** The new spot, as `create_spot` gave it. */
  spot: SpotView;
  marks: Record<string, FieldMark>;
}
