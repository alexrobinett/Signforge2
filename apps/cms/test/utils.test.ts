// cn() knows the CMS's own type steps (#372): a size and a colour are two groups, both kept.
import { describe, expect, it } from 'vitest';
import { cn } from '../src/lib/utils';

describe('cn', () => {
  it('keeps a custom type step beside a colour', () => {
    expect(cn('text-meta', 'text-status-offline')).toBe('text-meta text-status-offline');
    expect(cn('text-status-offline-foreground', 'text-2xs')).toBe('text-status-offline-foreground text-2xs');
  });

  it('lets a later size win over a custom step, and the other way', () => {
    expect(cn('text-meta', 'text-lg')).toBe('text-lg');
    expect(cn('text-base', 'text-md')).toBe('text-md');
  });
});
