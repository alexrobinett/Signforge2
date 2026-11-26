// The eval harness's own reading of answers and the tasks' checks (#473, the reviews of #470): usage merged field by
// field, a cut-off tool call not counted, a reply that did not finish or does not read recorded as the model's, the
// evidence merged at the top level only, and a weekday morning however its windows are split. No clock, no model.
import { describe, expect, it } from 'vitest';
import { runTask, scriptedModel, streamed } from './harness';
import { recordsIn, TASKS, weekdayMornings } from './tasks';

const NOON = Date.UTC(2026, 10, 25, 12);

describe("a streamed answer's usage and calls", () => {
  it("keeps message_start's cache fields when message_delta carries input tokens but none of them", () => {
    const used = streamed([
      { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90, output_tokens: 1 } } },
      { type: 'content_block_start', content_block: { type: 'tool_use', name: 'read' } },
      { type: 'message_delta', usage: { input_tokens: 12, output_tokens: 40 }, delta: { stop_reason: 'tool_use' } },
    ]);
    expect(used).toEqual({ toolUses: ['read'], input: 12 + 900 + 90, output: 40 });
  });

  it("takes message_start's usage when message_delta has none", () => {
    expect(streamed([{ type: 'message_start', message: { usage: { input_tokens: 7, output_tokens: 2 } } }, { type: 'message_delta' }])).toEqual({
      toolUses: [],
      input: 7,
      output: 2,
    });
  });

  it('counts no tool call the reply was cut off in', () => {
    const cut = streamed([
      { type: 'content_block_start', content_block: { type: 'tool_use', name: 'read' } },
      { type: 'content_block_start', content_block: { type: 'tool_use', name: 'save_spot' } },
      { type: 'message_delta', usage: { output_tokens: 4096 }, delta: { stop_reason: 'max_tokens' } },
    ]);
    expect(cut.toolUses).toEqual(['read']);
  });
});

describe('a reply over /mcp that is no finished turn', () => {
  const task = TASKS.find((t) => t.id === 'read-screens')!;
  const answering = (body: unknown) => ({ ...scriptedModel(task, 'mcp', NOON), fetchFor: () => async () => Response.json(body) });

  it('records a full context window as the model stopping, not a finished turn', async () => {
    const record = await runTask(
      task,
      'mcp',
      answering({ content: [{ type: 'text', text: '…' }], stop_reason: 'model_context_window_exceeded', usage: { input_tokens: 1, output_tokens: 1 } }),
    );
    expect(record.errors).toEqual(['model_model_context_window_exceeded']);
  });

  it('records a 200 that reads as no message as unreadable, not a harness failure', async () => {
    for (const body of [{}, { type: 'error', error: { type: 'overloaded_error' } }]) {
      const record = await runTask(task, 'mcp', answering(body));
      expect(record.errors, JSON.stringify(body)).toEqual(['model_unreadable']);
      expect(record.modelCalls).toBe(1);
    }
  });
});

describe("the tasks' checks", () => {
  it('merges what a result returns at its top level, not an id inside a row', () => {
    const audit = { items: [{ id: 'aud_1', action: 'save_spot', target: { kind: 'spot', id: 'spt_lunch' }, actor: { kind: 'user', id: 'usr_1' } }] };
    expect(recordsIn(audit).map((r) => r.id)).toEqual([undefined, 'aud_1']);
    expect(recordsIn({ screen: { id: 'scr_1', name: 'Lobby' } }).map((r) => r.id)).toEqual([undefined, 'scr_1']);
  });

  const entry = (more: Record<string, unknown>) => ({ playlistId: 'pls_b', target: 'group', groupId: 'grp_c', days: [1, 2, 3, 4, 5], ...more });
  const mornings = (...entries: Record<string, unknown>[]) => weekdayMornings(entries, 'pls_b', 'grp_c', '2026-11-25');

  it('takes weekday mornings however the window is split, and nothing more', () => {
    expect(mornings(entry({ from: '07:00', to: '10:00' }))).toBe(true);
    expect(mornings(entry({ from: '07:00', to: '08:30' }), entry({ from: '08:30', to: '10:00' }))).toBe(true);
    expect(mornings(entry({ from: '07:00', to: '10:00', days: [1, 2, 3] }), entry({ from: '07:00', to: '10:00', days: [4, 5] }))).toBe(true);
    // Another window of the same playlist on the same group: a Saturday hour, or the afternoons too.
    expect(mornings(entry({ from: '07:00', to: '10:00' }), entry({ from: '08:00', to: '09:00', days: [6] }))).toBe(false);
    expect(mornings(entry({ from: '07:00', to: '10:00' }), entry({ from: '14:00', to: '15:00' }))).toBe(false);
    expect(mornings(entry({ from: '07:00', to: '08:00' }), entry({ from: '08:30', to: '10:00' }))).toBe(false);
    expect(mornings(entry({ from: '07:00', to: '10:00', startDate: '2026-11-26' }))).toBe(false);
  });
});
