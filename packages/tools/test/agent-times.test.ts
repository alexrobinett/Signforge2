// Times as agents read them (#345): each time a tool's output schema declares, as ISO 8601, and nothing else.
import { describe, expect, it } from 'vitest';
import { agentOutput } from '../src';
import { agentTimeProperties } from '../src/agent-times';

const T = Date.UTC(2026, 10, 26, 9, 30);
const ISO = '2026-11-26T09:30:00.000Z';

describe('agentOutput', () => {
  it('makes each declared time ISO 8601, at any depth, and leaves durations, versions and strings as they are', () => {
    expect(agentOutput('save_playlist', {}, { playlist: { id: 'pls_1', createdAt: T, updatedAt: T, publishedAt: null, version: 3 } })).toMatchObject({
      playlist: { createdAt: ISO, updatedAt: ISO, publishedAt: null, version: 3 },
    });
    expect(agentOutput('list_publishes', {}, { publishes: [{ id: 'pub_1', createdAt: T, rollBackUntil: T }], next: null })).toMatchObject({
      publishes: [{ createdAt: ISO, rollBackUntil: ISO }],
    });
  });

  it("never walks into a value the schema leaves opaque: an audit entry's detail, a snapshot's data (review of #538)", () => {
    const entry = { at: T, action: 'save_spot', detail: { input: { since: 1987, updatedAt: 1e20, data: { lastAt: T } } } };
    expect(agentOutput('read', { type: 'audit_entry' }, { type: 'audit_entry', items: [entry], next: null })).toEqual({
      type: 'audit_entry',
      items: [{ ...entry, at: ISO }],
      next: null,
    });
    const snapshot = { id: 'weather', version: T, fetchedAt: ISO, checkedAt: ISO, data: { since: 1987, current: { observedAt: 1e20 } } };
    expect(agentOutput('read', { type: 'data_source', ids: ['weather'] }, { type: 'data_source', items: [{ id: 'weather', createdAt: T, snapshot }] })).toEqual(
      {
        type: 'data_source',
        items: [{ id: 'weather', createdAt: ISO, snapshot }],
      },
    );
  });

  it('keeps a number no date can hold as it is, and never throws', () => {
    expect(agentOutput('save_playlist', {}, { playlist: { createdAt: 1e20, updatedAt: Number.NaN } })).toEqual({
      playlist: { createdAt: 1e20, updatedAt: Number.NaN },
    });
  });

  it('leaves the output of a name no tool has, or a read of no type, as it is', () => {
    expect(agentOutput('no_such_tool', {}, { createdAt: T })).toEqual({ createdAt: T });
    expect(agentOutput('read', { type: 'nothing' }, { items: [{ createdAt: T }] })).toEqual({ items: [{ createdAt: T }] });
  });
});

describe('agentTimeProperties', () => {
  it('describes a time field as a date-time string, nullable or not, and says ISO 8601 where it said ms', () => {
    expect(
      agentTimeProperties({
        createdAt: { type: 'number' },
        at: { type: 'number', description: 'When, in ms since the epoch' },
        lastSeenAt: { type: ['number', 'null'] },
        durationMs: { type: 'number' },
        items: { type: 'array', items: { type: 'object', properties: { at: { type: 'number' } } } },
      }),
    ).toEqual({
      createdAt: { type: 'string', format: 'date-time' },
      at: { type: 'string', format: 'date-time', description: 'When, ISO 8601' },
      lastSeenAt: { type: ['string', 'null'], format: 'date-time' },
      durationMs: { type: 'number' },
      items: { type: 'array', items: { type: 'object', properties: { at: { type: 'string', format: 'date-time' } } } },
    });
  });
});
