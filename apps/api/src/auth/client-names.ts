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
  '9': 'g',
  q: 'g',
  '3': 'e',
  '4': 'a',
  '@': 'a',
  '7': 't',
  '8': 'b',
};

/**
 * A word as it reads: lowercase, `()` as `o`, lookalikes mapped, `(` as `paren` (a `c`, or nothing: it
 * may be either), `rn` as `m`, only a–z kept.
 */
const skeleton = (word: string, paren: string) =>
  [...word.toLowerCase().replace(/\(\)/g, 'o')]
    .map((ch) => (ch === '(' ? paren : (READS_AS[ch] ?? ch)))
    .join('')
    .replace(/rn/g, 'm')
    .replace(/[^a-z]/g, '');

const RESERVED = ['signforge', 'sfcli'].map((word) => skeleton(word, ''));

/**
 * Whether a name reads as SignForge's: a reserved word inside one word, or starting where a word starts
 * (so `SF CL1` and `Sign Forge` do), but not one that runs on from inside a word (`Design Forge`, `Docs FC
 * Lite`). A match that starts inside a trailing `(…)` after a name is the user's own label, and is let be.
 */
function readsAsOurs(name: string): boolean {
  const prefix = LABELLED.exec(name)?.[1];
  return ['c', ''].some((paren) => {
    const words = name
      .split(' ')
      .map((w) => skeleton(w, paren))
      .filter(Boolean);
    const joined = words.join('');
    // Where each word lies in `joined`.
    const spans = words.map((w, i) => {
      const from = words.slice(0, i).join('').length;
      return { from, to: from + w.length };
    });
    // A label counts only after a name that reads as something (not `- (SignForge CLI)`).
    const named = prefix === undefined ? 0 : skeleton(prefix, paren).length;
    const labelAt = named > 0 ? named : joined.length;
    return RESERVED.some((r) => {
      for (let at = joined.indexOf(r); at !== -1 && at < labelAt; at = joined.indexOf(r, at + 1)) {
        if (spans.some(({ from, to }) => at === from || (at > from && at + r.length <= to))) return true;
      }
      return false;
    });
  });
}

/**
 * The name the consent page may show for an unverified client, or undefined when it may show none: the
 * name is plain and does not read as SignForge's. Anything else, international names included, is shown
 * as an unverified app with where its code goes. Also what an app's own redirect scheme and host must be
 * for the page to show them.
 */
export function plainName(name: string): string | undefined {
  if (!PLAIN.test(name)) return undefined;
  return readsAsOurs(name) ? undefined : name;
}
