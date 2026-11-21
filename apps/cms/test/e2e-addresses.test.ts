// Each e2e spec signs in, and pairs screens, from addresses no other spec uses: Better Auth's rate
// limits count per address, so two specs on one address share a budget (review of #182).
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('../e2e/', import.meta.url);

describe('e2e client addresses', () => {
  it('belong to one spec each', () => {
    const specsOf = new Map<string, string[]>();
    for (const spec of readdirSync(dir).filter((f) => f.endsWith('.spec.ts'))) {
      for (const address of new Set(readFileSync(new URL(spec, dir), 'utf8').match(/192\.0\.2\.\d+/g))) {
        specsOf.set(address, [...(specsOf.get(address) ?? []), spec]);
      }
    }
    expect(specsOf.size).toBeGreaterThan(10);
    expect([...specsOf].filter(([, specs]) => specs.length > 1)).toEqual([]);
  });
});
