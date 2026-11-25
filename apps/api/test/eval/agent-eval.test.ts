// The agent eval (#345, README.md): every task in each of its arms. In CI the model is scripted: each task's
// script passes its check, and a model that does nothing fails it, so every check, seed and arm is proven to
// work without a model. `pnpm eval:agents` (vitest.eval.config.ts) runs the same tasks against a live model,
// or the scripted one with EVAL_MODEL=scripted, recording each run for reporter.ts; it never runs in CI.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { type Arm, liveModel, type RunRecord, runTask, scriptedModel } from './harness';
import { TASKS } from './tasks';

declare module 'vitest' {
  interface TaskMeta {
    eval?: RunRecord;
  }
}

/** The scripted runs' clock, the tools' and the drawer's: nothing they see depends on when or how fast they run. */
const NOON = Date.UTC(2026, 10, 25, 12);

const RUNS = TASKS.flatMap((task) => (Object.keys(task.script) as Arm[]).map((arm) => ({ task, arm })));
/** Set only by `pnpm eval:agents`. */
const MODEL = env.EVAL_MODEL ?? '';

describe.runIf(!MODEL)('the eval with a scripted model', () => {
  it('has about 20 tasks, each in an arm, covering both arms', () => {
    expect(TASKS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length);
    expect(RUNS.filter((r) => r.arm === 'mcp').length).toBeGreaterThan(0);
    expect(RUNS.filter((r) => r.arm === 'drawer').length).toBeGreaterThan(0);
  });

  it.for(RUNS.map((r) => [`${r.task.id} (${r.arm})`, r] as const))('%s: its script passes', async ([, { task, arm }]) => {
    const record = await runTask(task, arm, scriptedModel(task, arm, NOON));
    expect(record.why).toBeUndefined();
    expect(record.errors).toEqual([]);
    expect(record.success).toBe(true);
    expect(record.refusedCalls).toBe(task.refusals?.[arm] ?? 0);
    expect(record.catalogue.tokens).toBeGreaterThan(0);
  });

  const variants = TASKS.flatMap((task) => (task.variants ?? []).map((v) => ({ task, ...v })));
  it.for(variants.map((v) => [`${v.task.id} (${v.arm}), ${v.name}`, v] as const))('%s: checked as it should be', async ([, v]) => {
    const record = await runTask(v.task, v.arm, scriptedModel(v.task, v.arm, NOON), 1, v.script);
    expect(record.errors).toEqual([]);
    expect(record.success, record.why).toBe(v.passes);
  });

  it.for(RUNS.filter((r) => !r.task.id.startsWith('refused-')).map((r) => [`${r.task.id} (${r.arm})`, r] as const))(
    '%s: a model that does nothing fails it',
    async ([, { task, arm }]) => {
      const record = await runTask(task, arm, scriptedModel(task, arm, NOON), 1, () => []);
      expect(record.success).toBe(false);
      expect(record.toolCalls).toBe(0);
    },
  );

  // A run whose model fails is recorded as a failure with why, never dropped and never a success: even a read
  // whose tools already answered counts only when the turn completed.
  const reads = TASKS.find((t) => t.id === 'read-screens');
  const failing: [string, typeof fetch, string[]][] = [
    ['answers 503', async () => new Response('{"type":"error"}', { status: 503 }), ['model_503']],
    ['cannot be reached', () => Promise.reject(new Error('connection reset')), ['model_unreachable']],
  ];
  it.for(failing)('/mcp, a model that %s: a recorded failure', async ([, answer, errors]) => {
    if (!reads) throw new Error('no read-screens task');
    const record = await runTask(reads, 'mcp', { ...scriptedModel(reads, 'mcp', NOON), fetchFor: () => answer });
    expect(record).toMatchObject({ success: false, errors });
  });

  // After list_screens has answered, the model's second reply is one of these: the check passes, the run does not.
  const afterTools: [string, Response, string][] = [
    ['answers 503', new Response('{}', { status: 503 }), 'model_503'],
    [
      'is cut off at max_tokens',
      Response.json({ content: [{ type: 'text', text: 'The screens are' }], stop_reason: 'max_tokens', usage: {} }),
      'model_max_tokens',
    ],
    ['refuses', Response.json({ content: [], stop_reason: 'refusal', usage: {} }), 'model_refusal'],
    ['answers 200 with a body that is not JSON', new Response('<html>gateway</html>', { status: 200 }), 'model_unreadable'],
  ];
  it.for(afterTools)('/mcp, a model that %s after the tools answered: checked, but no success', async ([, reply, error]) => {
    if (!reads) throw new Error('no read-screens task');
    const model = scriptedModel(reads, 'mcp', NOON);
    const record = await runTask(reads, 'mcp', {
      ...model,
      fetchFor: (w) => {
        const script = model.fetchFor(w);
        let asked = 0;
        return (input, init) => (++asked === 1 ? script(input, init) : Promise.resolve(reply.clone()));
      },
    });
    expect(record).toMatchObject({ checked: true, success: false, errors: [error], toolCalls: 1 });
  });

  it('the drawer, a model that answers 503: a recorded failure', async () => {
    if (!reads) throw new Error('no read-screens task');
    const record = await runTask(reads, 'drawer', { ...scriptedModel(reads, 'drawer', NOON), fetchFor: () => failing[0]![1] });
    expect(record.success).toBe(false);
    expect(record.errors.length).toBeGreaterThan(0);
  });
});

describe.runIf(MODEL)(`the eval with ${MODEL}`, () => {
  const runs = Number(env.EVAL_RUNS);
  const only = env.EVAL_TASKS ? new Set(env.EVAL_TASKS.split(',')) : undefined;
  const chosen = MODEL ? RUNS.filter((r) => !only || only.has(r.task.id)) : [];
  it.for(chosen.flatMap((r) => Array.from({ length: runs }, (_, i) => [`${r.task.id} (${r.arm}) run ${i + 1}`, { ...r, n: i + 1 }] as const)))(
    '%s',
    async ([, { task, arm, n }], { task: test }) => {
      if (MODEL !== 'scripted' && !env.EVAL_KEY) throw new Error('set ANTHROPIC_API_KEY for a live run (test/eval/README.md)');
      const model = MODEL === 'scripted' ? scriptedModel(task, arm, NOON) : liveModel(MODEL, env.EVAL_KEY ?? '');
      test.meta.eval = await runTask(task, arm, model, n);
    },
  );
});
