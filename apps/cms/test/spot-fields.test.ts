// A template's fields as a new spot starts them and as the editor checks them, for a url field (#191).
import type { FieldDef } from '@signforge/contract';
import { describe, expect, it } from 'vitest';
import { fieldProblems, startData } from '../src/lib/spots';

const fields: Record<string, FieldDef> = {
  qrUrl: { type: 'url', label: 'QR link', maxLength: 60 },
  links: { type: 'list', label: 'Links', item: { href: { type: 'url', label: 'Link' } } },
};

describe('a url field in the spot editor', () => {
  it('starts a new spot with no address, which the template reads as no QR code', () => {
    expect(startData(fields)).toEqual({ qrUrl: '', links: [] });
  });

  it("puts the contract's message by the field for an address that is not https, and none for one that is", () => {
    expect(fieldProblems(fields, { data: { qrUrl: 'https://example.com/floor-plan', links: [] }, assets: {} })).toEqual(new Map());
    expect(fieldProblems(fields, { data: { qrUrl: 'http://example.com/floor-plan', links: [] }, assets: {} })).toEqual(
      new Map([['qrUrl', ['field "qrUrl" must be an https address']]]),
    );
  });
});
