// The e2e reads sign-in codes from the dev API's log (`codeFor` in e2e/servers.ts). It waits for
// the log to change, not on a clock: with the clock stopped it still resolves when the code is
// written, and a second sign-in gets its own code, never the first (review of #208, 4).
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codeFor } from '../e2e/servers';

const line = (email: string, code: string) => `[email] to ${email}: Your SignForge code: ${code}\n`;

describe('codeFor', () => {
  let log: string;
  beforeEach(() => {
    log = join(mkdtempSync(join(tmpdir(), 'code-for-')), 'api.log');
    writeFileSync(log, 'ready\n');
    // The clock stopped; immediates are event-loop order, not time.
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] });
  });
  afterEach(() => vi.useRealTimers());

  it('resolves when the code is written, with the clock stopped', async () => {
    const code = codeFor('a@example.com', log);
    appendFileSync(log, line('b@example.com', '111111'));
    appendFileSync(log, line('a@example.com', '222222'));
    await expect(code).resolves.toBe('222222');
  });

  it('gives a second sign-in the code written after the first was read', async () => {
    appendFileSync(log, line('c@example.com', '333333'));
    await expect(codeFor('c@example.com', log)).resolves.toBe('333333');
    let second: string | undefined;
    const next = codeFor('c@example.com', log).then((c) => (second = c));
    appendFileSync(log, 'unrelated\n');
    await new Promise((r) => setImmediate(r));
    expect(second).toBeUndefined();
    appendFileSync(log, line('c@example.com', '444444'));
    await next;
    expect(second).toBe('444444');
  });
});
