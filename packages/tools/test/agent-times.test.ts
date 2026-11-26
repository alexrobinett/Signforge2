// Times as agents read them (#345): ISO 8601 at the agents' doors, durations and other numbers as they are.
import { describe, expect, it } from 'vitest';
import { agentTimes } from '../src';
import { agentTimeProperties } from '../src/agent-times';

const T = Date.UTC(2026, 10, 26, 9, 30);

describe('agentTimes', () => {
  it('makes every time ISO 8601, at any depth, and leaves durations, versions and strings as they are', () => {
    expect(
      agentTimes({
        spot: { createdAt: T, updatedAt: T, publishedAt: null, durationMs: 10_000, version: 3 },
        entries: [{ at: T, endsAt: '2026-11-26T10:00:00.000Z' }],
        since: T,
        next: null,
      }),
    ).toEqual({
      spot: { createdAt: '2026-11-26T09:30:00.000Z', updatedAt: '2026-11-26T09:30:00.000Z', publishedAt: null, durationMs: 10_000, version: 3 },
      entries: [{ at: '2026-11-26T09:30:00.000Z', endsAt: '2026-11-26T10:00:00.000Z' }],
      since: '2026-11-26T09:30:00.000Z',
      next: null,
    });
  });

  it('describes a time field as a date-time string, nullable or not, and nothing else', () => {
    expect(
      agentTimeProperties({
        createdAt: { type: 'number' },
        publishedAt: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'When' },
        durationMs: { type: 'number' },
        lastSeenAt: { type: ['number', 'null'] },
        items: { type: 'array', items: { type: 'object', properties: { at: { type: 'number' } } } },
      }),
    ).toEqual({
      createdAt: { type: 'string', format: 'date-time' },
      publishedAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }], description: 'When' },
      durationMs: { type: 'number' },
      lastSeenAt: { type: ['string', 'null'], format: 'date-time' },
      items: { type: 'array', items: { type: 'object', properties: { at: { type: 'string', format: 'date-time' } } } },
    });
  });
});
