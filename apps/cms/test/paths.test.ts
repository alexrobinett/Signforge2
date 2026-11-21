import { describe, expect, it } from 'vitest';
import { initials, orgHues, safeRedirect, signInBack, slugify } from '../src/lib/paths';

describe('signInBack', () => {
  const fn = 'https://cms.test/_serverFn/abc';
  it('is the page on a page load, and the calling page on a server function call', () => {
    expect(signInBack('https://cms.test/spots?tab=draft', null)).toBe('/spots?tab=draft');
    expect(signInBack(fn, 'https://cms.test/spots/spt_1')).toBe('/spots/spt_1');
    expect(signInBack(fn, null)).toBe('/');
  });

  it("keeps sign-in's own way back for a call made once the address is sign-in's, never nesting it", () => {
    // A read of Spots ending after the address was sign-in's (CI runs 44575937095 and 44575649020).
    expect(signInBack(fn, 'https://cms.test/sign-in?redirect=%2Fspots')).toBe('/spots');
    expect(signInBack(fn, 'https://cms.test/sign-in')).toBe('/');
    expect(signInBack(fn, 'https://cms.test/sign-in?redirect=https%3A%2F%2Fevil.example')).toBe('/');
  });

  it('knows sign-in by every path the router renders it at, or sends to it', () => {
    for (const path of ['/SIGN-IN', '/Sign-In', '/sign%2Din', '/%53IGN-IN', '/sign-in/', '//sign-in', '/x/../sign-in']) {
      expect(signInBack(fn, `https://cms.test${path}?redirect=%2Fspots`)).toBe('/spots');
    }
    expect(signInBack(fn, 'https://cms.test/sign-in?redirect=%2FSIGN-IN%3Fredirect%3D%252Fspots')).toBe('/');
    // A tab, CR or LF the browser would drop, making a host of what follows: refused, not an error.
    expect(signInBack(fn, 'https://cms.test/sign-in?redirect=%2F%09%2F%5B')).toBe('/');
  });

  it('keeps the case of a page to come back to', () => {
    expect(signInBack(fn, 'https://cms.test/spots/spt_AbC?tab=Draft')).toBe('/spots/spt_AbC?tab=Draft');
    expect(signInBack(fn, 'https://cms.test/sign-in/x')).toBe('/sign-in/x');
  });
});

describe('safeRedirect', () => {
  it('keeps a path on this site', () => {
    expect(safeRedirect('/screens')).toBe('/screens');
    expect(safeRedirect('/spots?tab=draft')).toBe('/spots?tab=draft');
  });

  it('refuses anything that could leave the site, and loops back to sign-in', () => {
    for (const bad of [
      'https://evil.example/',
      '//evil.example/',
      '/\\evil.example',
      'javascript:alert(1)',
      '',
      undefined,
      42,
      '/sign-in',
      '/sign-in?redirect=/',
      '/SIGN-IN?redirect=%2Fspots',
      '/Sign-In',
      '/sign%2din',
      '/sign-in/',
      '/x/../sign-in',
      '/sign-in#top',
      '/\t/[',
      '/\t/evil.example',
      '/\n/evil.example',
      '/\r/evil.example',
      '/api/auth/sign-out',
    ]) {
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

describe('orgHues', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `org_${i.toString(36).padStart(24, 'q')}`);
  const gap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

  it('gives every org in the list its own hue, spread evenly round the wheel, past six orgs too (review of #208, 6)', () => {
    for (const n of [2, 6, 7, 13, 40]) {
      const hues = [...orgHues(ids(n)).values()];
      expect(new Set(hues).size, `${n} orgs`).toBe(n);
      for (const [i, a] of hues.entries()) for (const b of hues.slice(i + 1)) expect(gap(a, b), `${n} orgs`).toBeGreaterThanOrEqual(360 / n - 1e-9);
    }
  });

  it("keeps an org's hue whatever order the list comes in", () => {
    const list = ids(9);
    expect(orgHues([...list].reverse())).toEqual(orgHues(list));
  });
});
