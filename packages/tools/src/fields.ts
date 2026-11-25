/** Input fields shared by several tools. */
import { MAX_TERMS, SELECTOR_OPS, SYSTEM_KEYS } from '@signforge/compiler/selector';
import { displayHoursProblems, ID_PATTERN, validTimezone } from '@signforge/contract';
import { z } from 'zod';

/** An id of a row in this org. A tool's id fields are named for their kind: `screenId`, `groupIds`. */
export const id = (what: string) => z.string().regex(ID_PATTERN, `not a valid ${what} id`).describe(`The ${what}'s id`);

/**
 * On a creating tool: a key the caller picks for this one creation, such as a UUID. A retry with
 * the same key returns the first call's result and creates nothing more.
 */
export const idempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[\x21-\x7e]+$/, 'printable ASCII, no spaces')
  .optional()
  .describe('A key for this one creation, such as a UUID: a retry with it creates nothing more');

/**
 * On an update tool: the `version` of the row as the caller read it. The dispatcher refuses the
 * call with `conflict`, details `{ id, version }` (the version now), if the row has changed since,
 * and writes nothing. The check runs in the batch that writes the change.
 */
export const ifVersion = z.number().int().positive().optional().describe('The version you read; a conflict means it changed since: read it again');

/** A row's version, on the view of every row an update tool changes. */
export const version = z.number().int().describe('Moves on with every change; pass it as ifVersion to update only what you read');

/** On the view of a draft (a spot, a playlist): whether screens have it, and when it changed. */
export const draftOutput = {
  published: z.boolean().describe('Whether a version of it has been published'),
  draftChanged: z.boolean().describe('Whether the draft differs from what is published (always, before the first publish)'),
  publishedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
};

export const name = (what: string) => z.string().trim().min(1, `the ${what} needs a name`).max(100).describe(`The ${what}'s name, 1 to 100 characters`);

export const timezone = z.string().refine(validTimezone, 'not an IANA time zone').describe('IANA time zone, such as Europe/London');

export const locale = z
  .string()
  .refine((v) => {
    try {
      return Intl.getCanonicalLocales(v).length === 1;
    } catch {
      return false;
    }
  }, 'not a BCP 47 locale tag')
  .describe('BCP 47 locale tag, such as en-GB');

export const orientation = z.enum(['landscape', 'portrait']);

const hhmm = z.string().describe('HH:MM, 24-hour; 24:00 is end of day');
const window = z.object({ from: hhmm, to: hhmm });

/**
 * The contract's `DisplayHours`, checked by the contract's `displayHoursProblems`: the same check
 * the player and `validateManifest` run, so nothing a screen would refuse is ever stored.
 */
export const displayHours = z
  .object({
    weekly: z
      .array(window.extend({ days: z.array(z.number().int()).describe('0 is Sunday') }))
      .describe("Daily windows on the given days, in the screen's time zone; a window whose end is at or before its start crosses midnight"),
    exceptions: z
      .array(z.object({ date: z.string().describe('YYYY-MM-DD'), on: z.array(window) }))
      .optional()
      .describe('Dates whose windows replace the weekly ones; no windows means off all day'),
  })
  .superRefine((hours, ctx) => {
    for (const message of displayHoursProblems(hours)) ctx.addIssue({ code: 'custom', message });
  });

const LABEL_KEY = /^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/;
/** A screen's name, id and live status are not labels, so no label or selector names them; `sf.` keys are SignForge's. */
const REFUSED_KEYS = new Set(['name', 'id', 'status']);
const anyKey = z
  .string()
  .regex(LABEL_KEY, 'a label key is 1 to 63 lowercase letters, digits, - _ or ., starting and ending with a letter or digit')
  .refine((k) => !REFUSED_KEYS.has(k), 'name, id and status are not labels')
  .refine((k) => !k.startsWith('sf.'), 'keys starting sf. are reserved');
const SYSTEM = new Set<string>(SYSTEM_KEYS);

/** A key a label may have: not a system label's, which the screen's settings give. */
export const labelKey = anyKey
  .refine((k) => !SYSTEM.has(k), `${SYSTEM_KEYS.join(', ')} are system labels, from the screen's settings: change them with update_screen_settings`)
  .describe('A label key, such as region or store: lowercase letters, digits, - _ and .');

/** Stored as typed, less the spaces around it; compared case-insensitively. */
const labelValue = z
  .string()
  .trim()
  .min(1, 'a label value cannot be empty')
  .max(63, 'a label value is at most 63 characters')
  // \p{Cs} rejects lone surrogates, which D1 reads back as U+FFFD.
  .regex(/^[^\p{Cc}\p{Zl}\p{Zp}\p{Cs}]*$/u, 'a label value is printable characters, spaces allowed')
  .describe('Up to 63 characters, spaces allowed; matched case-insensitively');

/** Labels to set, by key, as `claim_screen` and `update_screen_labels` take them; the tools check the limits. */
export const labels = z.preprocess(
  (raw, ctx) => {
    // Checked before z.record, which drops `__proto__` silently and whose key refusal says only "Invalid key in record".
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      for (const key of Object.keys(raw)) {
        const checked = labelKey.safeParse(key);
        if (!checked.success) ctx.addIssue({ code: 'custom', path: [key], message: checked.error.issues[0]!.message });
      }
    }
    return raw;
  },
  z.record(z.string(), labelValue),
);

/** How many values each op takes. */
const valueCount = (op: (typeof SELECTOR_OPS)[number], n: number) => (op === 'eq' || op === 'neq' ? n === 1 : op === 'in' || op === 'notin' ? n >= 1 : n === 0);

/** `@signforge/compiler/selector`'s `Selector`, checked. */
export const selector = z
  .object({
    all: z
      .array(
        z
          .object({
            key: anyKey.describe('A label key, or a system label: orientation, kind (device or browser), timezone, locale'),
            op: z.enum(SELECTOR_OPS),
            values: z.array(labelValue).default([]).describe('One for eq and neq, one or more for in and notin, none for exists and missing'),
          })
          .refine((t) => valueCount(t.op, t.values.length), 'eq and neq take one value, in and notin one or more, exists and missing none'),
      )
      .max(MAX_TERMS, `a selector has at most ${MAX_TERMS} terms`),
  })
  .describe(
    'Screens whose labels match every term: { all: [{ key, op, values }] }. Values match case-insensitively; a screen without the key matches only missing, so neq and notin need it. System labels count: { key: "orientation", op: "eq", values: ["portrait"] }',
  );
