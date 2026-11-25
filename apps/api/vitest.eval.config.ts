import { defineConfig } from 'vitest/config';
import { testOptions, workers } from './vitest.config';

// The agent eval against a live model (test/eval/README.md): `pnpm eval:agents`, by hand, never in CI. The model
// is EVAL_MODEL (default claude-haiku-5-5), its key ANTHROPIC_API_KEY, each task run EVAL_RUNS times (default 3);
// EVAL_TASKS, comma-separated ids, runs only those. The key reaches only the test worker's bindings.
const model = process.env.EVAL_MODEL ?? 'claude-haiku-5-5';

export default defineConfig({
  plugins: [
    workers({
      EVAL_MODEL: model,
      EVAL_KEY: process.env.ANTHROPIC_API_KEY ?? '',
      EVAL_RUNS: process.env.EVAL_RUNS ?? '3',
      EVAL_TASKS: process.env.EVAL_TASKS ?? '',
    }),
  ],
  test: {
    ...testOptions,
    include: ['test/eval/agent-eval.test.ts'],
    // A live run takes as long as the model does: each run's turns are bounded by the drawer's budget and /mcp's 20 turns.
    testTimeout: 600_000,
    reporters: ['default', './test/eval/reporter.ts'],
  },
});
