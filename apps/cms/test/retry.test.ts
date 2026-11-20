// Query's retries (src/queries/retry.ts): a read that failed is tried again, but not a redirect to
// sign-in, nor the refusal of a tab left on the old org (#129), which holds until the tab reloads.
import { describe, expect, it } from 'vitest';
import { OrgChanged } from '../src/lib/org-changed';
import { retryUnlessRedirect } from '../src/queries/retry';

describe('retryUnlessRedirect', () => {
  const retry = retryUnlessRedirect(3);

  it('retries a failed read up to its tries', () => {
    expect(retry(0, new Error('network'))).toBe(true);
    expect(retry(3, new Error('network'))).toBe(false);
  });

  it('never retries a refusal from a tab on another org', () => {
    expect(retry(0, new OrgChanged('This tab is on Northside; you switched to Southside in another tab. Reload.'))).toBe(false);
  });
});
