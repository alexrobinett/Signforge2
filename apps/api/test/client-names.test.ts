// An agent's client's name (#299's reviews): what registration refuses, what the consent page shows,
// and where an app's code goes, as pure functions. agent-grants.test.ts runs a few of each through the API.
import { describe, expect, it } from 'vitest';
import { destinationOf } from '../src/auth/agent-grants';
import { clientNameRefusal, plainName } from '../src/auth/client-names';

/** Each refusal's words, by why the name is refused. */
const REFUSED: Record<string, string> = {
  hides: 'client_name must not contain control, format, bidirectional or invisible characters',
  blank: 'client_name must not be blank',
  long: 'client_name must be at most 80 characters',
};

describe('registration', () => {
  it('refuses only a blank name, one too long for the heading, and characters that hide or reorder text', () => {
    for (const [name, why] of [
      ['Claude‮edoc', 'hides'],
      ['Claude⁦x⁩', 'hides'],
      ['Clau​de', 'hides'],
      ['Claude\nCode', 'hides'],
      ['Claude\u0000', 'hides'],
      ['Claude­Code', 'hides'],
      ['Claude⁠Code', 'hides'],
      ['Claude\u{E0041}Code', 'hides'],
      // The Hangul fillers are letters, but blank (the second re-check of #299).
      ['SignㅤForge', 'hides'],
      ['SignᅟForge', 'hides'],
      ['SignᅠForge', 'hides'],
      ['SignﾠForge', 'hides'],
      ['', 'blank'],
      ['   ', 'blank'],
      [' ', 'blank'],
      ['   ', 'blank'],
      ['　', 'blank'],
      ['ㅤ', 'blank'],
      ['​', 'blank'],
      ['A'.repeat(81), 'long'],
    ] as const) {
      expect(clientNameRefusal(name), JSON.stringify(name)).toBe(REFUSED[why]);
    }
  });

  it("accepts a name that reads as SignForge's, or any other the page will not show: registration is not the place", () => {
    for (const name of ['SignForge CLI', 'Claude Code (signforge)', '🆂🅸🅶🅽🅵🅾🆁🅶🅴', 'Ελληνικός βοηθός', 'Sign\u2800Forge', 'Bot 🤖']) {
      expect(clientNameRefusal(name), name).toBeUndefined();
    }
  });
});

describe("the consent page's name", () => {
  /** What the page gets for each of `names`: undefined where it gets none, and shows an unverified app. */
  const shownAs = (names: string[]) => Object.fromEntries(names.map((name) => [name, plainName(name)]));

  it('withholds every name from the reviews of #299 that reads as SignForge, so the page shows an unverified app', () => {
    const names = [
      // The first review, and the tests written for it.
      'SignForge CLI',
      'signforge',
      'SIGNFORGE',
      'My SignForge helper',
      'TheSignForge',
      'Sign Forge',
      'S-I-G-N-F-O-R-G-E',
      'ＳｉｇｎＦｏｒｇｅ',
      'S1gnF0rge',
      'SIGNF0RGE',
      '5ignForge',
      'ѕignforge',
      'Ѕіgnfоrgе',
      'sf-cli',
      'SF CLI',
      'SF-CL1',
      'sf_cli tools',
      '(SignForge)',
      'SignForge CLI (helper)',
      // The second: accents, small capitals, Greek, Cyrillic and Cherokee letters.
      'SIGΝFORGE',
      'SIԌNFORGE',
      'SIGNϜORGE',
      'SígnForge',
      'SignForgé',
      'ꜱɪɢɴꜰᴏʀɢᴇ',
      'ᏚᎥᏀΝFᎾᏒᏀᎬ',
      '𝐒𝐢𝐠𝐧𝐅𝐨𝐫𝐠𝐞',
      'ˢⁱᵍⁿᶠᵒʳᵍᵉ',
      'ꜱғ-ᴄʟɪ',
      'ΣignForge',
      'ᏚIGNFORGE',
      'SᎥgnForge',
      'Signհorge',
      // The third: enclosed letters and regional indicators, Hangul and Han letters, CJK dashes,
      // modifier letters, digits and signs, letters with strokes, and spaced and dotted forms.
      '🆂🅸🅶🅽🅵🅾🆁🅶🅴',
      '🅢🅘🅖🅝🅕🅞🅡🅖🅔',
      '🇸🇮🇬🇳🇫🇴🇷🇬🇪',
      '🆂🅵 🅲🅻🅸',
      'SㅣGNFORGE',
      'S丨GNFORGE',
      'SIGNF口RGE',
      'SIGNFロRGE',
      'Sign一Forge',
      'SignーForge',
      'SignㅡForge',
      'SF一CLI',
      'SignʼForge',
      'SignˈForge',
      'SignˌForge',
      'SignˍForge',
      'S!gnForge',
      'SI6NFOR6E',
      'SignForg€',
      'Sign Forg£',
      'SF CL!',
      'SignFørge',
      'SIGNFØRGE',
      'SigƞForge',
      'SiǥnForǥe',
      'SignForɠe',
      'S.i.g.n Forge',
      'Sign-Forge',
      'Sign_Forge',
      'S·F CLI',
      'Sign\u2800Forge',
      // The final re-check: a label that is not after a name, or that a reserved word starts before,
      // and 9, q, () and ( read as letters.
      'SignForg(e)',
      'Sign(Forge)',
      'S(ignForge)',
      'SF (CLI)',
      'SF(CLI)',
      'SF CL(I)',
      '- (SignForge CLI)',
      '. (SignForge)',
      "' (SignForge CLI)",
      'Si9nForge',
      'SI9NFOR9E',
      'SiqnForqe',
      'SignF()rge',
      'SF (LI',
      // The fifth: a word starting after a dropped sign or at a capital, or after a lookalike letter.
      'Docs-Sign Forge',
      'My.Sign Forge',
      'A&Sign Forge',
      "It's.Sign Forge",
      'Get_SF CLI',
      'Use.SF CLI',
      'MySign Forge',
      'OpenSign Forge',
      'GetSF CLI',
      'GETSign Forge',
      '7Sign Forge',
      '1Sign Forge',
      'lSign Forge',
      '5Sign Forge',
      'qSign Forge',
      '0SF CLI',
      // The sixth: a capital after a lookalike digit or sign starts a word too.
      'Go4Sign Forge',
      'Get1Sign Forge',
      'My7Sign Forge',
      'Pro8Sign Forge',
      'a1Sign Forge',
      'Go4SignForge',
      'Use1SF CLI',
      'x0SF CLI',
      'A1SF CLI',
      'Ab4SF CLI',
      'v7SF CLI',
    ];
    expect(shownAs(names)).toEqual(Object.fromEntries(names.map((name) => [name, undefined])));
  });

  it('withholds a name that is not plain ASCII, international ones and a non-plain label included', () => {
    const names = ['Café Assistant', 'Ελληνικός βοηθός', '東京 Screens', 'Bot 🤖', 'Claude Code (сервер)', 'Agent #1', 'Agent: two'];
    expect(shownAs(names)).toEqual(Object.fromEntries(names.map((name) => [name, undefined])));
  });

  it("shows the major clients' names, a label after them, and names that only run into a reserved word", () => {
    const names = [
      'Claude Code (signforge)',
      'Claude Code (SignForge)',
      'Claude Code (screens)',
      'Cursor',
      'Visual Studio Code',
      'Visual Studio Code - Insiders',
      'ChatGPT',
      'Windsurf',
      'Codex',
      'MCP Inspector',
      'Gemini CLI MCP Client',
      'Zed',
      'Goose',
      'Cline',
      'mcp-remote',
      'VS Code',
      'Design Forge',
      'DesignForge',
      'Docs FC Lite',
      'Mrs F. Clive',
      "O'Brien's helper",
      'Signs & forms',
      'W'.repeat(80),
    ];
    expect(shownAs(names)).toEqual(Object.fromEntries(names.map((name) => [name, name])));
  });
});

describe("where an app's code goes", () => {
  it("names an app's own scheme, not as a web host", () => {
    for (const [redirect, target] of [
      ['com.example.app:/oauth/callback', 'com.example.app:'],
      ['cursor://anysphere.cursor-retrieval/oauth/callback', 'cursor://anysphere.cursor-retrieval'],
    ] as const) {
      expect(destinationOf(redirect, false), redirect).toEqual({ kind: 'app', target });
    }
  });

  it("withholds an unverified app's scheme and host that read as SignForge's, alone or together: the page says an app on this device", () => {
    for (const redirect of [
      'signforge://SignForge-CLI/callback',
      'com.signforge.cli:/callback',
      'com.example.app://SignForge/callback',
      // Scheme and host as they read together (the provider wants a path after a custom scheme's host).
      'sign://forge/cb',
      'sf://cli/cb',
      'sign://Forge-CLI/cb',
    ]) {
      expect(destinationOf(redirect, false), redirect).toEqual({ kind: 'app', target: null });
    }
  });

  it("keeps a first-party app's own, and names a web callback's host", () => {
    expect(destinationOf('signforge://SignForge-CLI/callback', true)).toEqual({ kind: 'app', target: 'signforge://SignForge-CLI' });
    expect(destinationOf('http://127.0.0.1:33418/callback', false)).toEqual({ kind: 'web', host: '127.0.0.1:33418' });
  });
});
