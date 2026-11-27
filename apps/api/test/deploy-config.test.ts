// A deploy of an environment whose D1 database_id is still the placeholder is caught by `check:deploy`
// (scripts/check-deploy-config.ts), which reads only the environment it is given: dev's placeholder is on purpose.
import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_D1_ID, placeholderDatabases } from '../scripts/deploy-config';

describe('placeholderDatabases', () => {
  it('names a D1 binding that still has the placeholder id', () => {
    expect(placeholderDatabases({ d1_databases: [{ binding: 'DB', database_id: PLACEHOLDER_D1_ID }] })).toEqual(['DB']);
    expect(PLACEHOLDER_D1_ID).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('passes an environment whose databases have real ids, or none', () => {
    expect(placeholderDatabases({ d1_databases: [{ binding: 'DB', database_id: 'ba1469f4-9efc-4bea-bb76-9c53c0ae6238' }] })).toEqual([]);
    expect(placeholderDatabases({})).toEqual([]);
  });

  it('names only the bindings that are placeholders', () => {
    expect(
      placeholderDatabases({
        d1_databases: [
          { binding: 'DB', database_id: 'ba1469f4-9efc-4bea-bb76-9c53c0ae6238' },
          { binding: 'OTHER', database_id: PLACEHOLDER_D1_ID },
        ],
      }),
    ).toEqual(['OTHER']);
  });
});
