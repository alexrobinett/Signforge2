/**
 * An agent's OAuth client as a page may show it (#299's reviews, M4-07): `/connect` and Settings › API &
 * agents both name a client through `shownClient`. A client registers its own name and redirect, so an
 * unverified one's are shown only when plain, never read as SignForge's; anything else is shown as an
 * unverified app at where its code goes.
 */
import { FIRST_PARTY_CLIENT_IDS } from '@signforge/db';

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

/** A letter of a name as it reads, whether a word starts at it, and whether the lookalike map made it. */
interface Letter {
  letter: string;
  starts: boolean;
  mapped: boolean;
}

/**
 * A name as it reads, letter by letter: lowercase, `()` as `o`, `rn` as `m`, lookalikes mapped, `(` as
 * `paren` (a `c`, or nothing: it may be either), and only a–z kept. A word starts after anything dropped
 * (a space, `.`, `-`, `_`, `&`, `'`…), at a capital after a small letter or a lookalike sign (`MySign`, `My7Sign`), and at a capital
 * before a small letter after another capital (`GETSign`).
 */
function lettersOf(name: string, paren: string): Letter[] {
  const letters: Letter[] = [];
  let dropped = true;
  let last = '';
  for (const match of name.matchAll(/\(\)|rn|[\s\S]/giu)) {
    const token = match[0];
    const next = name.charAt(match.index + token.length);
    const lower = token.toLowerCase();
    const letter = lower === '()' ? 'o' : lower === 'rn' ? 'm' : lower === '(' ? paren : (READS_AS[lower] ?? lower);
    const first = token.charAt(0);
    const capital = /[A-Z]/.test(first);
    const camel = capital && (/[a-z0-9!|@]/.test(last) || (/[A-Z]/.test(last) && /[a-z]/.test(next)));
    last = token.charAt(token.length - 1);
    if (!/^[a-z]$/.test(letter)) {
      dropped = true;
      continue;
    }
    letters.push({ letter, starts: dropped || camel, mapped: letter !== lower });
    dropped = false;
  }
  return letters;
}

/** The reserved words as they read (`sfcli` as `sfcii`). */
const RESERVED = ['signforge', 'sfcli'].map((word) =>
  lettersOf(word, '')
    .map(({ letter }) => letter)
    .join(''),
);

/**
 * Whether a name reads as SignForge's: a reserved word inside one word, or starting where a word starts,
 * or one letter after it when the lookalike map made that letter (`7Sign Forge`); so `SF CL1`, `Sign Forge`,
 * `Docs-Sign Forge` and `MySign Forge` do, but not one that runs on from inside a word (`Design Forge`,
 * `Docs FC Lite`). A match that starts inside a trailing `(…)` after a name is the user's own label, and
 * is let be.
 */
function readsAsOurs(name: string): boolean {
  const prefix = LABELLED.exec(name)?.[1];
  return ['c', ''].some((paren) => {
    const letters = lettersOf(name, paren);
    const joined = letters.map(({ letter }) => letter).join('');
    // A label counts only after a name that reads as something (not `- (SignForge CLI)`).
    const named = prefix === undefined ? 0 : lettersOf(prefix, paren).length;
    const labelAt = named > 0 ? named : joined.length;
    return RESERVED.some((r) => {
      for (let at = joined.indexOf(r); at !== -1 && at < labelAt; at = joined.indexOf(r, at + 1)) {
        const inside = letters.slice(at + 1, at + r.length).every(({ starts }) => !starts);
        const before = letters[at - 1];
        if (letters[at]?.starts || inside || (before?.starts && before.mapped)) return true;
      }
      return false;
    });
  });
}

/**
 * The name a page may show for an unverified client, or undefined when it may show none: the
 * name is plain and does not read as SignForge's. Anything else, international names included, is shown
 * as an unverified app with where its code goes. Also what an app's own redirect scheme and host must be
 * for the page to show them.
 */
export function plainName(name: string): string | undefined {
  if (!PLAIN.test(name)) return undefined;
  return readsAsOurs(name) ? undefined : name;
}

/**
 * Where a client's code goes, as a page names it: a web callback's host, or for an app's
 * own scheme (`com.example.app:/cb`, `cursor://anysphere.cursor-retrieval/...`) the scheme and what follows it up to the path.
 * An unverified app's scheme and host are a name it chose, so they are shown only when plain (`plainName`):
 * `signforge://SignForge-CLI/cb` is not (target null: the page says an app on this device).
 */
export function destinationOf(redirectUri: string, verified: boolean): { kind: 'web'; host: string } | { kind: 'app'; target: string | null } {
  const url = new URL(redirectUri);
  if (url.protocol === 'http:' || url.protocol === 'https:') return { kind: 'web', host: url.host };
  const scheme = url.protocol.slice(0, -1);
  // Each alone, and together, as they read in the heading (`sign://forge`).
  const chosen = url.host ? [scheme, url.host, `${scheme} ${url.host}`] : [scheme];
  if (!verified && chosen.some((part) => plainName(part) === undefined)) return { kind: 'app', target: null };
  return { kind: 'app', target: url.host ? `${url.protocol}//${url.host}` : url.protocol };
}

/** Where a client's code goes, as a page names it. */
export type ClientRedirect = ReturnType<typeof destinationOf>;

/**
 * A client as a page names it: SignForge's own by its registered name; another by its name only when
 * plain (else `name: null`), and where its code goes (`redirectUri`, as registered or asked for).
 */
export function shownClient(clientId: string, name: string | null, redirectUri: string) {
  const verified = isFirstParty(clientId);
  return { id: clientId, name: shownClientName(clientId, name), verified, redirect: destinationOf(redirectUri, verified) };
}

const isFirstParty = (clientId: string) => FIRST_PARTY_CLIENT_IDS.some((id) => id === clientId);

/**
 * A client's name as a page or the audit log may show it: SignForge's own as registered; another's
 * only when plain (`plainName`), else null. What the audit log records, and how it reads rows written
 * before it did (M4-07's review).
 */
export function shownClientName(clientId: string, name: string | null): string | null {
  return isFirstParty(clientId) ? (name ?? clientId) : (plainName(name ?? '') ?? null);
}
