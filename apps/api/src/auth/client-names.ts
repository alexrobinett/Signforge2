/**
 * An agent's client's name (#299's reviews). Registration refuses only what no page can show: a blank
 * name, one too long, and characters that hide or reorder text. Whether the consent page shows the name
 * is decided when it is shown (`plainName`): a denylist over all of Unicode keeps losing, and refusing a
 * real client's name (Claude Code registers as `Claude Code (<server name>)`) breaks it.
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

/** Printable ASCII letters, digits, spaces and `.-_()&'+`, and nothing else. */
const PLAIN = /^[A-Za-z0-9 .\-_()&'+]+$/;

/** A user's own label after the app's name, as Claude Code's server name: `Claude Code (signforge)`. */
const LABELLED = /^(.*\S) *\([^()]*\)$/;

/** Digits and signs that read as letters. */
const READS_AS: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  l: 'i',
  '!': 'i',
  '|': 'i',
  '5': 's',
  '6': 'g',
  '3': 'e',
  '4': 'a',
  '@': 'a',
  '7': 't',
  '8': 'b',
};

/** A word as it reads: lowercase, lookalikes mapped, `rn` as `m`, only a–z kept. */
const skeleton = (word: string) =>
  [...word.toLowerCase()]
    .map((ch) => READS_AS[ch] ?? ch)
    .join('')
    .replace(/rn/g, 'm')
    .replace(/[^a-z]/g, '');

const RESERVED = ['signforge', 'sfcli'].map(skeleton);

/**
 * Whether a name reads as SignForge's: a reserved word inside one word, or starting where a word starts
 * (so `SF CL1` and `Sign Forge` do), but not one that runs on from inside a word (`Design Forge`, `Docs FC Lite`).
 */
function readsAsOurs(name: string): boolean {
  const words = name.split(' ').map(skeleton).filter(Boolean);
  const joined = words.join('');
  const starts = words.map((_, i) => words.slice(0, i).join('').length);
  return RESERVED.some((r) => words.some((w) => w.includes(r)) || starts.some((at) => joined.startsWith(r, at)));
}

/**
 * The name the consent page may show for an unverified client, or undefined when it may show none: the
 * name is plain, and, before a trailing `(…)`, does not read as SignForge's. Anything else, international
 * names included, is shown as an unverified app with where its code goes.
 */
export function plainName(name: string): string | undefined {
  if (!PLAIN.test(name)) return undefined;
  return readsAsOurs(LABELLED.exec(name)?.[1] ?? name) ? undefined : name;
}
