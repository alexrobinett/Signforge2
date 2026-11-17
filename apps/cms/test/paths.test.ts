import { describe, expect, it } from 'vitest';
import { initials, safeRedirect, slugify } from '../src/lib/paths';

describe('safeRedirect', () => {
  it('keeps a path on this site', () => {
    expect(safeRedirect('/screens')).toBe('/screens');
    expect(safeRedirect('/spots?tab=draft')).toBe('/spots?tab=draft');
  });

  it('refuses anything that could leave the site, and loops back to sign-in', () => {
    for (const bad of ['https://evil.example/', '//evil.example/', '/\\evil.example', 'javascript:alert(1)', '', undefined, 42, '/sign-in', '/sign-in?redirect=/', '/api/auth/sign-out']) {
      expect(safeRedirect(bad)).toBe('/');
    }
  });
});

describe('slugify', () => {
  it('makes a lowercase hyphenated slug', () => {
    expect(slugify('Acme Coffee')).toBe('acme-coffee');
    expect(slugify('  Café & Bar — Downtown!  ')).toBe('cafe-bar-downtown');
  });

  it('never returns an empty slug', () => {
    expect(slugify('!!!')).toBe('org');
    expect(slugify('東京')).toBe('org');
  });

  it('caps the length without a trailing hyphen', () => {
    const slug = slugify('a'.repeat(47) + ' b');
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('initials', () => {
  it('takes two letters from a name or an email', () => {
    expect(initials('Acme Coffee')).toBe('AC');
    expect(initials('jane.doe@example.com')).toBe('JD');
    expect(initials('sam@example.com')).toBe('SA');
  });
});
