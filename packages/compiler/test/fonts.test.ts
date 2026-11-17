import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FONTS, isCatalogueFontFile, MAX_FONT_FAMILY_BYTES, fontFilePath } from '../src';

const root = join(__dirname, '../../..');

describe('font catalogue', () => {
  it.each(FONTS.map((f) => [f.id, f] as const))('%s: a WOFF2 per weight, as recorded, within the family budget, with its licence', (_, font) => {
    expect(font.files.map((f) => f.weight)).toEqual(font.weights);
    let total = 0;
    for (const f of font.files) {
      const bytes = readFileSync(join(root, fontFilePath(font, f)));
      expect(bytes.subarray(0, 4).toString('latin1')).toBe('wOF2');
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(f.file);
      expect(bytes.length).toBe(f.size);
      total += f.size;
    }
    expect(total).toBeLessThanOrEqual(MAX_FONT_FAMILY_BYTES);
    const licence = readFileSync(join(root, 'fonts', font.id.split('/')[1]!, 'OFL.txt'), 'utf8');
    expect(licence).toContain('SIL Open Font License, Version 1.1');
    expect(licence.split('\n')[0]).toContain(font.licence.copyright);
  });

  it('knows its own files and nothing else', () => {
    expect(isCatalogueFontFile(FONTS[0]!.files[0]!.file)).toBe(true);
    expect(isCatalogueFontFile('0'.repeat(64))).toBe(false);
    expect(existsSync(join(root, 'fonts/README.md'))).toBe(true);
  });
});
