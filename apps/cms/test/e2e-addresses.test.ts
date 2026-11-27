// Each e2e spec signs in, pairs screens and calls tools from addresses no other spec uses: Better Auth's
// and the tools' rate limits count per address, so two specs on one address share a budget (review of
// #182, #333). And each
// names its orgs with names no other spec uses: specs run in parallel, and two creates of one name
// at once race for its slug, so one fails (#249).
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('../e2e/', import.meta.url);

/** The specs each value `pattern` finds (the group that matched, else the whole match) appears in. */
function specsOf(pattern: RegExp): Map<string, string[]> {
  const specs = new Map<string, string[]>();
  for (const spec of readdirSync(dir).filter((f) => f.endsWith('.spec.ts'))) {
    for (const value of new Set(
      [...readFileSync(new URL(spec, dir), 'utf8').matchAll(pattern)].map((m) => (m.slice(1).find((g) => g !== undefined) ?? m[0]).toLowerCase()),
    )) {
      specs.set(value, [...(specs.get(value) ?? []), spec]);
    }
  }
  return specs;
}

describe('e2e client addresses', () => {
  it('belong to one spec each', () => {
    const specs = specsOf(/192\.0\.2\.\d+/g);
    expect(specs.size).toBeGreaterThan(10);
    expect([...specs].filter(([, s]) => s.length > 1)).toEqual([]);
  });
});

describe('e2e tool calls (#333)', () => {
  const specs = readdirSync(dir).filter((f) => f.endsWith('.spec.ts'));
  const read = (spec: string) => readFileSync(new URL(spec, dir), 'utf8');

  it('go through tool() or toolResponse(), which send the page’s own address', () => {
    expect(specs.filter((spec) => /request\.post\(\s*['`"]\/api\/tools\//.test(read(spec)))).toEqual([]);
  });

  it('come from a spec whose pages have an address of their own', () => {
    const calling = specs.filter((spec) => /\b(?:tool|toolResponse)\(/.test(read(spec)));
    expect(calling.length).toBeGreaterThan(10);
    expect(calling.filter((spec) => !/\b(?:signInAs|fromAddress|joinAsEditor)\(/.test(read(spec)))).toEqual([]);
  });
});

describe('e2e org names', () => {
  it('belong to one spec each', () => {
    // As the specs create orgs: the first page's form, the account menu's dialog, or a helper.
    const specs = specsOf(/(?:createOrg|createOrgFromAccountMenu|newOrg)\(\w+, '([^']+)'|'Organization name', '([^']+)'/g);
    expect(specs.size).toBeGreaterThan(10);
    expect([...specs].filter(([, s]) => s.length > 1)).toEqual([]);
  });
});
