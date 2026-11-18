/** Input fields shared by several tools. */
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
  .describe(
    'A key you choose for this one creation, such as a UUID. Retrying with the same key and input returns the first result and creates nothing more; reusing it for another input is refused',
  );

/**
 * On an update tool: the `version` of the row as the caller read it. The dispatcher refuses the
 * call with `conflict`, details `{ id, version }` (the version now), if the row has changed since,
 * and writes nothing. The check runs in the batch that writes the change.
 */
export const ifVersion = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(
    'The version you read. If the row has changed since, nothing is written and the call is refused with conflict, details { id, version }: read it again and redo the change. Omit to change it whatever its version',
  );

/** A row's version, on the view of every row an update tool changes. */
export const version = z.number().int().describe('Moves on with every change; pass it as ifVersion to update only what you read');

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
