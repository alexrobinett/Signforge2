import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const API_PORT = 8797;
export const CMS_PORT = 3997;
export const CMS_URL = `http://localhost:${CMS_PORT}`;

/** Scratch space for one run: the API's log, local D1 state and the dev registry. */
export const RUN_DIR = fileURLToPath(new URL('../.e2e/', import.meta.url));
export const API_LOG = `${RUN_DIR}api.log`;

/** The newest sign-in code the dev API printed for `email`, as a developer would read it. */
export async function codeFor(email: string, timeoutMs = 10_000): Promise<string> {
  const pattern = new RegExp(`\\[email\\] to ${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: Your SignForge code: (\\d{6})`, 'g');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = [...readFileSync(API_LOG, 'utf8').matchAll(pattern)];
    const last = matches.at(-1)?.[1];
    if (last) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no code for ${email} in ${API_LOG}`);
}
