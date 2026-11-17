import { describe, expect, it } from 'vitest';
import { baseTemplateHtml, isBaseTemplateKey, templateKey } from './index';

describe('template keys', () => {
  it('tell a base template from an org template', () => {
    expect(isBaseTemplateKey(templateKey({ id: 'clock', version: '1.0.0' }))).toBe(true);
    expect(isBaseTemplateKey(templateKey({ id: 'clock', version: '1.0.0' }, 'org-a'))).toBe(false);
    // An org whose id starts with "base" is still an org.
    expect(isBaseTemplateKey(templateKey({ id: 'clock', version: '1.0.0' }, 'baseline'))).toBe(false);
  });

  it("give a manifest's base template bundles", () => {
    const t = (html: string) => ({ manifest: {} as never, html });
    expect(baseTemplateHtml({ templates: { 'base/clock@1.0.0': t('a'), 'org-a/menu@1.0.0': t('b'), 'base/news@2.0.0': t('c') } })).toEqual(new Set(['a', 'c']));
    expect(baseTemplateHtml({})).toEqual(new Set());
  });
});
