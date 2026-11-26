// The store is its slices spread into one object: two slices with a key of one name would leave one of them
// unreachable, with no error (the groups editor's `nameNewGroup` hid the screen settings' own, #186). Every slice in
// src/state, found by its `create…Slice` export, is built here with stubs and its keys compared with the others'.
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

const modules = import.meta.glob<Record<string, unknown>>('../src/state/*.ts', { eager: true });

describe('the store’s slices', () => {
  it('share no key, so no slice’s state or action hides another’s', () => {
    const deps = { router: { state: { matches: [] }, subscribe: () => () => {} }, queryClient: new QueryClient() };
    const owners = new Map<string, string[]>();
    for (const [file, exports] of Object.entries(modules))
      for (const [name, create] of Object.entries(exports)) {
        if (!/^create\w+Slice$/.test(name) || typeof create !== 'function') continue;
        for (const key of Object.keys(
          create(
            () => {},
            () => ({}),
            deps,
          ),
        ))
          owners.set(key, [...(owners.get(key) ?? []), `${file.split('/').at(-1)}`]);
      }
    expect(owners.size).toBeGreaterThan(100);
    expect([...owners].filter(([, by]) => by.length > 1)).toEqual([]);
  });
});
