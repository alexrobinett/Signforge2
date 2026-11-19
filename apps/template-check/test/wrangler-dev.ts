/**
 * Global setup for `test:container`: `wrangler dev` with the container, on a free port. Docker must
 * run. On an Apple Silicon Mac it uses `--env arm64` (wrangler.jsonc): Chromium cannot run as
 * linux/amd64 under Rosetta.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    checkUrl: string;
  }
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

export default async function setup(project: TestProject) {
  const [port, inspector] = [await freePort(), await freePort()];
  const env = process.platform === 'darwin' && process.arch === 'arm64' ? ['--env', 'arm64'] : [];
  const dev = spawn('pnpm', ['exec', 'wrangler', 'dev', ...env, '--port', String(port), '--inspector-port', String(inspector)], {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wrangler dev did not start within 5 minutes:\n${log}`)), 300_000);
    const read = (chunk: Buffer) => {
      log += chunk;
      if (log.includes('Ready on')) {
        clearTimeout(timer);
        resolve();
      }
    };
    dev.stdout.on('data', read);
    dev.stderr.on('data', read);
    dev.on('exit', (code) => reject(new Error(`wrangler dev exited (${code}):\n${log}`)));
  });
  project.provide('checkUrl', `http://127.0.0.1:${port}/check`);
  return () => {
    dev.kill('SIGINT');
  };
}
