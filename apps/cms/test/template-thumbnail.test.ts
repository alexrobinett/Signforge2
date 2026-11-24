// A template version's thumbnail is the player's drawing of that very version (#362): an older
// spot never shows a newer version's artwork, and an org's own template has none.
import { describe, expect, it } from 'vitest';
import { templateThumbnail } from '../src/lib/template-thumbnail';
import drawn from '../src/lib/template-thumbnails.json';

describe('templateThumbnail', () => {
  it('is the drawing of the version the player drew', () => {
    expect(templateThumbnail(`base/clock@${drawn.clock}`)).toBe('/template-thumbnails/clock.webp');
  });

  it('is none for another version of it, or for an org template', () => {
    expect(templateThumbnail('base/clock@0.0.1')).toBeUndefined();
    expect(templateThumbnail(`org_1/clock@${drawn.clock}`)).toBeUndefined();
  });
});
