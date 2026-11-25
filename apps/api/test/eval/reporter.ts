/**
 * The agent eval's results (README.md): each live run's record, from its test's meta, written as JSON and as a
 * table per task and arm to test/eval/out/, named by model and commit. Runs in Node, in vitest's own process.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Reporter, TestModule } from 'vitest/node';
import type { RunRecord } from './harness';

const OUT = new URL('./out/', import.meta.url).pathname;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fixed = (n: number, digits = 1) => n.toFixed(digits);

/** One row per task and arm: success over runs, and the means of the rest. */
export function table(records: readonly RunRecord[]): string {
  const keys = [...new Set(records.map((r) => `${r.task}\t${r.arm}`))];
  const rows = keys.map((key) => {
    const runs = records.filter((r) => `${r.task}\t${r.arm}` === key);
    const [task, arm] = key.split('\t');
    const failed = runs.filter((r) => !r.success).map((r) => r.why ?? r.errors.join(' '));
    return `| ${task} | ${arm} | ${runs[0]?.role} | ${runs.filter((r) => r.success).length}/${runs.length} | ${fixed(mean(runs.map((r) => r.toolCalls)))} | ${fixed(mean(runs.map((r) => r.refusedCalls)))} | ${Math.round(mean(runs.map((r) => r.inputTokens)))} | ${Math.round(mean(runs.map((r) => r.outputTokens)))} | ${runs[0]?.catalogue.tokens} | ${[...new Set(failed)].join('; ')} |`;
  });
  const total = (arm: string) => {
    const runs = records.filter((r) => r.arm === arm);
    if (!runs.length) return [];
    return [
      `| **all** | ${arm} | | ${runs.filter((r) => r.success).length}/${runs.length} | ${fixed(mean(runs.map((r) => r.toolCalls)))} | ${fixed(mean(runs.map((r) => r.refusedCalls)))} | ${Math.round(mean(runs.map((r) => r.inputTokens)))} | ${Math.round(mean(runs.map((r) => r.outputTokens)))} | | |`,
    ];
  };
  return [
    '| Task | Arm | Role | Success | Tool calls | Refused | Input tokens | Output tokens | Catalogue tokens | Failures |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---|',
    ...rows,
    ...total('mcp'),
    ...total('drawer'),
  ].join('\n');
}

export default class EvalReporter implements Reporter {
  onTestRunEnd(modules: readonly TestModule[]) {
    const records = modules.flatMap((m) => [...m.children.allTests()].flatMap((t) => t.meta().eval ?? []));
    if (!records.length) return;
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const name = `${records[0]?.model}-${commit}`;
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}${name}.json`, `${JSON.stringify({ model: records[0]?.model, commit, records }, null, 1)}\n`);
    writeFileSync(`${OUT}${name}.md`, `# Agent eval: ${records[0]?.model} at ${commit}\n\n${table(records)}\n`);
    console.log(`\nagent eval: test/eval/out/${name}.json and .md\n\n${table(records)}\n`);
  }
}
