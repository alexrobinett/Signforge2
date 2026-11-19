import { TOOLS } from '@signforge/tools';
import { describe, expect, it } from 'vitest';
import { ACTIONS } from '../../src/lib/audit';

describe('the audit log’s words', () => {
  it('words every tool that changes something, so none shows as its bare name', () => {
    const changes = TOOLS.filter((t) => t.mutates).map((t) => t.name);
    expect(changes.filter((name) => !ACTIONS[name])).toEqual([]);
  });
});
