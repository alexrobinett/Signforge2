// The one rule for whether a player can play a manifest (#156): a manifest's schema and its templates' protocols,
// against what a player reports.
import { describe, expect, it } from 'vitest';
import { canPlay, manifestNeeds, playsProtocol, playsSchema, THIS_PLAYER } from './playable.ts';
import { MANIFEST_SCHEMA, SUPPORTED_MANIFEST_SCHEMAS, SUPPORTED_PROTOCOLS } from './shapes.ts';

const template = (protocol?: number) => ({ manifest: { ...(protocol === undefined ? {} : { protocol }) } }) as never;

describe('whether a player can play a manifest', () => {
  it("reads what a manifest needs: its schema, and each template's protocol once, 1 where a bundle names none", () => {
    expect(manifestNeeds({ schema: 8, templates: { a: template(2), b: template(), c: template(2) } })).toEqual({ schema: 8, protocols: [2, 1] });
    expect(manifestNeeds({ schema: 8, templates: {} })).toEqual({ schema: 8, protocols: [] });
  });

  it('plays a manifest whose schema and every protocol the player reports, and no other', () => {
    const player = { manifestSchemas: [7, 8], protocols: [1, 2] };
    expect(canPlay(player, { schema: 8, protocols: [1, 2] })).toBe(true);
    expect(canPlay(player, { schema: 9, protocols: [1] })).toBe(false);
    expect(canPlay(player, { schema: 8, protocols: [3] })).toBe(false);
    // Stored before schemas were numbered: judged by its protocols alone.
    expect(canPlay(player, { schema: Number.NaN, protocols: [1] })).toBe(true);
  });

  it("is this build's own: the schema it makes and the one before, and its protocols", () => {
    expect(THIS_PLAYER).toEqual({ manifestSchemas: SUPPORTED_MANIFEST_SCHEMAS, protocols: SUPPORTED_PROTOCOLS });
    expect(playsSchema(THIS_PLAYER, MANIFEST_SCHEMA)).toBe(true);
    expect(playsSchema(THIS_PLAYER, MANIFEST_SCHEMA - 2)).toBe(false);
    expect(playsSchema(THIS_PLAYER, String(MANIFEST_SCHEMA))).toBe(false);
    expect(playsProtocol(THIS_PLAYER, Math.max(...SUPPORTED_PROTOCOLS) + 1)).toBe(false);
  });
});
