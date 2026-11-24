// Worker bundle sizes for RESULTS.md (#346): each entry bundled as wrangler bundles a Worker (esm,
// the workerd conditions, minified, node: and cloudflare: left to the runtime), raw and gzipped, with
// what of @anthropic-ai/sdk and openai each pulls in. And the page's client bundle, checked for the key.
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const ENTRIES = {
  '@tanstack/ai + ai-anthropic': `
    import { chat, toServerSentEventsResponse } from '@tanstack/ai';
    import { createAnthropicChat } from '@tanstack/ai-anthropic';
    export default { fetch() { return toServerSentEventsResponse(chat({ adapter: createAnthropicChat('claude-sonnet-5-5', 'k'), messages: [], threadId: 't' })); } };`,
  '@tanstack/ai + ai-anthropic + openaiCompatible': `
    import { chat, toServerSentEventsResponse } from '@tanstack/ai';
    import { createAnthropicChat } from '@tanstack/ai-anthropic';
    import { openaiCompatible } from '@tanstack/ai-openai/compatible';
    const e = openaiCompatible({ name: 'e', baseURL: 'https://e.example/v1', apiKey: 'k', models: ['m'] });
    export default { fetch(r) { const adapter = r.url.includes('e') ? e('m') : createAnthropicChat('claude-sonnet-5-5', 'k'); return toServerSentEventsResponse(chat({ adapter, messages: [], threadId: 't' })); } };`,
};

const options = {
  bundle: true,
  format: 'esm',
  minify: true,
  write: false,
  metafile: true,
  platform: 'neutral',
  mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser', 'import'],
  external: ['node:*', 'cloudflare:*'],
  logLevel: 'silent',
};

const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;
function report(name, result) {
  const out = result.outputFiles[0].contents;
  const inputs = Object.keys(result.metafile.inputs);
  const from = (pkg) => inputs.filter((p) => p.includes(`/${pkg}/`)).length;
  console.log(`| ${name} | ${kb(out.length)} | ${kb(gzipSync(out).length)} | ${from('@anthropic-ai/sdk')} | ${from('openai')} |`);
}

console.log('| Entry | Minified | Gzipped | @anthropic-ai/sdk files | openai files |');
console.log('| --- | --- | --- | --- | --- |');
report('today: @anthropic-ai/sdk 1.6.0 (apps/api)', await build({ ...options, entryPoints: ['scripts/entries/anthropic-sdk.ts'] }));
for (const [name, contents] of Object.entries(ENTRIES)) report(name, await build({ ...options, stdin: { contents, resolveDir: process.cwd(), loader: 'ts' } }));
report('the spike Worker (src/worker.ts, with packages/db and the tool registry)', await build({ ...options, entryPoints: ['src/worker.ts'] }));

const page = await build({
  ...options,
  platform: 'browser',
  conditions: ['browser', 'import'],
  entryPoints: ['src/page/main.tsx'],
  define: { 'process.env.NODE_ENV': '"production"' },
});
report('the page (React, Zustand, @tanstack/ai-client)', page);
const text = new TextDecoder().decode(page.outputFiles[0].contents);
for (const leak of ['sk-ant-', 'x-api-key', 'api.anthropic.com', '@tanstack/ai-anthropic'])
  console.log(`page bundle contains ${JSON.stringify(leak)}: ${text.includes(leak)}`);
