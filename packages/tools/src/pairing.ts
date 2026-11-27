/**
 * Claiming a pairing code (docs/backend-plan.md#screens, M3-08). An unpaired screen shows a code
 * from `POST /v1/device/pair/start`; a member types it here, which creates the screen and binds
 * the code to it. The screen's next poll collects its credential. The CMS form is M3-11.
 */
import { z } from 'zod';
import { displayHours, idempotencyKey, labels, locale, name, orientation, timezone } from './fields';
import { overLimit } from './labels';
import { screenView } from './screens';
import { defineTool, ToolError } from './tool';
import { outputs } from './outputs';

/** Codes are 6 of these 32 letters (about a billion codes): no 0/O, 1/I, so a code read off a screen types cleanly. */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_LENGTH = 6;
const CODE = new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`);

const code = z
  .string()
  .transform((v) => v.toUpperCase().replace(/[\s-]/g, ''))
  .refine((v) => CODE.test(v), `a pairing code is ${PAIRING_CODE_LENGTH} letters and digits, as the screen shows it`)
  .describe('The code the screen shows, such as K7M-2QX; case, spaces and dashes do not matter');

const notOpen = (code: string) => new ToolError('not_found', `pairing code ${code} is not open: check it, or restart the screen for a new one`);

const claimScreen = defineTool({
  name: 'claim_screen',
  description:
    'Pair a screen: claim the code it shows, creating the screen in this organization with the given name and settings. The screen collects its credential on its next poll (within seconds) and starts playing what is published to it. A code works once, for 15 minutes. Claims are rate limited, right or wrong, so a code cannot be guessed. Pass an idempotencyKey so a retry cannot pair twice. Returns { screen }.',
  scope: 'screens:manage',
  minRole: 'editor',
  mutates: true,
  // A pairing code can be planted in content an agent reads, and the device it pairs gets every publish (review of #419).
  people: true,
  idempotent: true,
  needs: ['rateLimit'],
  input: z.object({
    code,
    name: name('screen'),
    timezone,
    orientation,
    locale: locale.optional(),
    displayHours: displayHours.optional().describe('Omit for always on'),
    labels: labels.optional().describe('Its first labels, by key, such as { "region": "north" }; as update_screen_labels sets them'),
    idempotencyKey,
  }),
  output: outputs.claim_screen,
  example: { code: 'ABC234', name: 'Lobby', timezone: 'Europe/London', orientation: 'landscape' },
  target: (_input, output) => (output ? { kind: 'screen', id: output.screen.id } : undefined),
  handler: async ({ org, input, write, blobs, services: { rateLimit } }) => {
    // Counted before the code is looked at, so right and wrong guesses cost the same.
    if (!(await rateLimit('pairing_claim'))) throw new ToolError('rate_limited', 'too many pairing claims; wait a minute and try again');
    const now = Date.now();
    // One answer for unknown, expired and already claimed: a claim learns nothing about other orgs' codes.
    const kind = await org.pairing.open(input.code, now);
    if (!kind) throw notOpen(input.code);
    const screen = write(
      org.screens.stage.insert({
        name: input.name,
        kind,
        timezone: input.timezone,
        orientation: input.orientation,
        locale: input.locale ?? null,
        displayHoursJson: input.displayHours ? JSON.stringify(input.displayHours) : null,
      }),
    );
    // After the screen: the code references it. Fails the whole batch if another claim won the code.
    write(org.pairing.stage.claim(input.code, screen.id, now));
    const labels = input.labels ?? {};
    if (Object.keys(labels).length) {
      const change = { set: labels, remove: [] };
      const over = overLimit(await org.screens.labels.list(), [{ screenId: screen.id, ...change }]);
      if (over) throw over;
      write(await org.screens.labels.stage.update([screen.id], change, { newScreen: true }));
    }
    return { screen: await screenView(org, screen, blobs, Date.now(), [], undefined, labels) };
  },
  // A guard failed the batch: another claim took the code (or it expired) since `open`, or another change took the org past its label keys.
  refuseFailedCommit: async ({ org, input }) =>
    (await org.pairing.open(input.code, Date.now()))
      ? // Only the org's keys can have moved: no other change reaches the new screen. Any id not stored stands for it.
        input.labels && overLimit(await org.screens.labels.list(), [{ screenId: 'scr_claimed', set: input.labels, remove: [] }])
      : notOpen(input.code),
});

export const pairingTools = [claimScreen];
