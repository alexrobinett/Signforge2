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

/** The scripted runs' clock: the drawer's turn budget never depends on how fast the machine is. */
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
    const record = await runTask(
      task,
      arm,
      scriptedModel(task, arm, () => NOON),
    );
    expect(record.why).toBeUndefined();
    expect(record.errors).toEqual([]);
    expect(record.refusedCalls).toBe(0);
    expect(record.catalogue.tokens).toBeGreaterThan(0);
  });

  it.for(RUNS.filter((r) => !r.task.id.startsWith('refused-')).map((r) => [`${r.task.id} (${r.arm})`, r] as const))(
    '%s: a model that does nothing fails it',
    async ([, { task, arm }]) => {
      const record = await runTask(
        task,
        arm,
        scriptedModel(
          task,
          arm,
          () => NOON,
          () => [],
        ),
      );
      expect(record.success).toBe(false);
      expect(record.toolCalls).toBe(0);
    },
  );
});

describe.runIf(MODEL)(`the eval with ${MODEL}`, () => {
  const runs = Number(env.EVAL_RUNS);
  const only = env.EVAL_TASKS ? new Set(env.EVAL_TASKS.split(',')) : undefined;
  const chosen = MODEL ? RUNS.filter((r) => !only || only.has(r.task.id)) : [];
  it.for(chosen.flatMap((r) => Array.from({ length: runs }, (_, i) => [`${r.task.id} (${r.arm}) run ${i + 1}`, { ...r, n: i + 1 }] as const)))(
    '%s',
    async ([, { task, arm, n }], { task: test }) => {
      if (MODEL !== 'scripted' && !env.EVAL_KEY) throw new Error('set ANTHROPIC_API_KEY for a live run (test/eval/README.md)');
      const model = MODEL === 'scripted' ? scriptedModel(task, arm, () => NOON) : liveModel(MODEL, env.EVAL_KEY ?? '');
      test.meta.eval = await runTask(task, arm, model, n);
    },
  );
});
