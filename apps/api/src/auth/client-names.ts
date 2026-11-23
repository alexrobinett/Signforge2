/**
 * Names an agent's client may register under (#299's reviews): the consent page shows the name in its
 * heading, so a client must not pass as SignForge's own app, hide characters, or reorder the text around it.
 * The comparison is UTS #39's: a skeleton for lookalikes, and single-script detection for mixed names.
 */
import { CONFUSABLE_WITH } from './confusables';

/** As long as a name may be: one heading line on a phone. */
const CLIENT_NAME_MAX = 80;

/** Each confusable character's prototype, from Unicode's table. */
const PROTOTYPE = new Map(Object.entries(CONFUSABLE_WITH).flatMap(([to, from]) => [...from].map((ch): [string, string] => [ch, to])));

/**
 * What Unicode's table leaves out but a heading shows the same: Latin small capitals (it keeps ꜰ apart
 * from F; there is no small capital X), and digits and signs read as letters.
 */
const READ_AS: Record<string, string> = {
  ...Object.fromEntries([...'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘꞯʀꜱᴛᴜᴠᴡʏᴢ'].map((ch, i) => [ch, 'abcdefghijklmnopqrstuvwyz'.charAt(i)])),
  '5': 's',
  $: 's',
  '9': 'g',
  '3': 'e',
};

const mapped = (s: string) => [...s].map((ch) => READ_AS[ch] ?? PROTOTYPE.get(ch) ?? ch).join('');

/** NFKD without its combining marks: full-width, math and accented letters as their plain letters. */
const plain = (name: string) => name.normalize('NFKD').replace(/\p{M}/gu, '');

/**
 * A name as it reads, for comparison: lookalikes mapped before lowercasing (a capital's lookalike is a
 * capital: Greek Ν is N, not ν) and again after, I and l as one (the table makes I an l, lowercasing an i),
 * and only letters kept.
 */
const skeleton = (name: string) =>
  mapped(mapped(plain(name)).toLowerCase())
    .toLowerCase()
    .replace(/l/g, 'i')
    .replace(/\P{L}/gu, '');

const RESERVED = ['signforge', 'sfcli'].map(skeleton);

/**
 * The scripts a letter is told apart by (its Script_Extensions): those confusable with Latin, and the
 * major ones. A script not listed counts as one more, `Other`.
 */
const SCRIPTS = [
  'Latin',
  'Greek',
  'Cyrillic',
  'Armenian',
  'Georgian',
  'Cherokee',
  'Coptic',
  'Canadian_Aboriginal',
  'Lisu',
  'Vai',
  'Tifinagh',
  'Runic',
  'Ogham',
  'Gothic',
  'Old_Italic',
  'Deseret',
  'Osage',
  'Adlam',
  'Nko',
  'Ethiopic',
  'Mongolian',
  'Hebrew',
  'Arabic',
  'Syriac',
  'Thaana',
  'Devanagari',
  'Bengali',
  'Gurmukhi',
  'Gujarati',
  'Oriya',
  'Tamil',
  'Telugu',
  'Kannada',
  'Malayalam',
  'Sinhala',
  'Thai',
  'Lao',
  'Tibetan',
  'Myanmar',
  'Khmer',
  'Yi',
  'Han',
  'Hiragana',
  'Katakana',
  'Bopomofo',
  'Hangul',
].map((script) => ({ script, test: new RegExp(`\\p{scx=${script}}`, 'u') }));

/** Characters any script uses: digits, punctuation, spaces. */
const ANY_SCRIPT = /[\p{scx=Common}\p{scx=Inherited}]/u;

/** A character's scripts, with UTS #39's Jpan, Hanb and Kore added for Han and the scripts written with it. */
function scriptsOf(ch: string): string[] {
  const scripts = SCRIPTS.filter(({ test }) => test.test(ch)).map(({ script }) => script);
  if (!scripts.length) return ['Other'];
  const han = scripts.includes('Han');
  return [
    ...scripts,
    ...(han || scripts.includes('Hiragana') || scripts.includes('Katakana') ? ['Jpan'] : []),
    ...(han || scripts.includes('Bopomofo') ? ['Hanb'] : []),
    ...(han || scripts.includes('Hangul') ? ['Kore'] : []),
  ];
}

/** The scripts every one of `sets` shares (UTS #39's resolved script set). */
const shared = (sets: string[][]) => sets.reduce((all, s) => all.filter((x) => s.includes(x)));

/**
 * UTS #39's Highly Restrictive: the name's letters share a script, or it is Latin with Japanese, with
 * Chinese and Bopomofo, or with Korean. So Latin with Greek, Cyrillic or Cherokee is mixed.
 */
function mixesScripts(name: string): boolean {
  const sets = [...plain(name)].filter((ch) => !ANY_SCRIPT.test(ch)).map(scriptsOf);
  if (!sets.length || shared(sets).length) return false;
  const others = sets.filter((s) => !s.includes('Latin'));
  return !['Jpan', 'Hanb', 'Kore'].some((x) => shared(others).includes(x));
}

/**
 * What a heading cannot show: controls, format and bidi characters, private use and unassigned code
 * points, line breaks, default-ignorable code points (zero-width ones, and the Hangul fillers, which are
 * blank letters), the blank Braille pattern, and any space but U+0020.
 */
const HIDDEN = /[\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}⠀]|[^\S ]/u;

/** Why a client may not register under `name`, or undefined if it may. */
export function clientNameRefusal(name: string): string | undefined {
  if (!name.replace(/[\s\p{Default_Ignorable_Code_Point}⠀]/gu, '')) return 'client_name must not be blank';
  if (name.length > CLIENT_NAME_MAX) return `client_name must be at most ${CLIENT_NAME_MAX} characters`;
  if (HIDDEN.test(name)) return 'client_name must not contain control, format, bidirectional or invisible characters, or spaces other than U+0020';
  if (mixesScripts(name)) return 'client_name must be written in one script (Latin may go with Chinese, Japanese or Korean)';
  const reads = skeleton(name);
  if (RESERVED.some((r) => reads.includes(r))) return 'client_name must not name SignForge or its apps';
  return undefined;
}
