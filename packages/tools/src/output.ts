/**
 * The output check. Every tool declares its output schema; in tests, `dispatch` parses each
 * output against it and a mismatch fails the test as a bug. Production skips the parse: the
 * schema is the handler's promise, and tests hold it to that.
 *
 * Off unless a test setup file calls `setOutputChecks(true)` (test/setup.ts here and in apps/api).
 */
import { z } from 'zod';
import type { AnyTool } from './tool';

let enabled = false;

/** Turn the output check on or off for this isolate. Tests only. */
export function setOutputChecks(on: boolean): void {
  enabled = on;
}

/** Throws if checks are on and `output` is not what the tool's schema says it returns. */
export function checkOutput(tool: AnyTool<any>, output: unknown): void {
  if (!enabled) return;
  const parsed = tool.output.safeParse(output);
  if (!parsed.success) throw new Error(`${tool.name} returned output its schema refuses:\n${z.prettifyError(parsed.error)}`);
}
