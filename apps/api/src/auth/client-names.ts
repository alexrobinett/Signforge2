/**
 * An agent's client's name at registration (#299's reviews): refused only for what no page can show, a
 * blank name, one too long, and characters that hide or reorder text. Whether a page shows the name is
 * decided when it is shown (`plainName` in `@signforge/tools`): a denylist over all of Unicode keeps
 * losing, and refusing a real client's name (Claude Code registers as `Claude Code (<server name>)`) breaks it.
 */

/** As long as a name may be: one heading line on a phone. */
const CLIENT_NAME_MAX = 80;

/** Controls, format and bidi characters, line breaks, and default-ignorable code points (zero-width ones, the Hangul fillers). */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

/** Why a client may not register under `name`, or undefined if it may. */
export function clientNameRefusal(name: string): string | undefined {
  if (!name.replace(/[\s\p{Default_Ignorable_Code_Point}]/gu, '')) return 'client_name must not be blank';
  if (name.length > CLIENT_NAME_MAX) return `client_name must be at most ${CLIENT_NAME_MAX} characters`;
  if (HIDDEN.test(name)) return 'client_name must not contain control, format, bidirectional or invisible characters';
  return undefined;
}
