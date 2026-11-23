/**
 * Names an agent's client may register under (#299's review): the consent page shows the name in its
 * heading, so a client must not pass as SignForge's own app, nor reorder the text around it.
 */

/** As long as a name may be: one heading line on a phone. */
const CLIENT_NAME_MAX = 80;

/**
 * Letters that look like those of "signforge" and "sf-cli" (Cyrillic, Greek, Armenian and Latin
 * lookalikes, and digits read as letters), after NFKC, which already folds full-width, math and
 * ligature forms. Not every confusable in Unicode: enough that the obvious imitations are caught.
 */
const LOOKALIKES: Record<string, string> = {
  ѕ: 's',
  ꜱ: 's',
  ʂ: 's',
  '5': 's',
  $: 's',
  і: 'i',
  ı: 'i',
  ɩ: 'i',
  ι: 'i',
  ӏ: 'i',
  l: 'i',
  '1': 'i',
  '|': 'i',
  '!': 'i',
  ⅼ: 'i',
  ɡ: 'g',
  ց: 'g',
  ɢ: 'g',
  '9': 'g',
  ո: 'n',
  ռ: 'n',
  ɴ: 'n',
  η: 'n',
  ғ: 'f',
  ꞙ: 'f',
  ſ: 'f',
  о: 'o',
  ο: 'o',
  օ: 'o',
  σ: 'o',
  '0': 'o',
  ø: 'o',
  г: 'r',
  ʀ: 'r',
  ꝛ: 'r',
  е: 'e',
  ε: 'e',
  ҽ: 'e',
  '3': 'e',
  с: 'c',
  ϲ: 'c',
  ᴄ: 'c',
  '(': 'c',
};

/** A name folded for comparison: NFKC, lowercase, lookalikes mapped, and everything but letters dropped. */
const folded = (name: string) =>
  [...name.normalize('NFKC').toLowerCase()]
    .map((ch) => LOOKALIKES[ch] ?? ch)
    .join('')
    .replace(/[^\p{L}]/gu, '');

const RESERVED = ['signforge', 'sfcli'].map(folded);

/** Bidi controls, zero-width and other format characters, controls, and line breaks: anything that reorders or hides text. */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Why a client may not register under `name`, or undefined if it may. */
export function clientNameRefusal(name: string): string | undefined {
  if (name.length > CLIENT_NAME_MAX) return `client_name must be at most ${CLIENT_NAME_MAX} characters`;
  if (UNSEEN.test(name)) return 'client_name must not contain control, format or bidirectional characters';
  const plain = folded(name);
  if (RESERVED.some((r) => plain.includes(r))) return 'client_name must not name SignForge or its apps';
  return undefined;
}
