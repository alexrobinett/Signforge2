// Scratch: render the announcement in each look/orientation and screenshot.
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { buildTemplate } from '@signforge/cli/template';
import { PROTOCOL_VERSION } from '@signforge/contract';
const out = process.argv[2]!;
const extra = JSON.parse(process.argv[3] ?? '{}');
const tag = process.argv[4] ?? '';
const t = await buildTemplate(resolve('../../templates/announcement'));
console.log('bytes', t.html.length);
const browser = await chromium.launch();
const defaults: Record<string, unknown> = {};
for (const [k, f] of Object.entries(t.manifest.fields) as any) if (f.default !== undefined) defaults[k] = f.default;
for (const orientation of ['landscape', 'portrait'] as const)
  for (const look of ['pop', 'poster', 'night', 'corporate']) {
    const size = orientation === 'landscape' ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };
    const page = await browser.newPage({ viewport: size });
    await page.goto('about:blank');
    await page.evaluate(async ({ html, size, sf, data, orientation }) => {
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts');
      f.style.cssText = `position:absolute;left:0;top:0;width:${size.width}px;height:${size.height}px;border:0`;
      document.body.style.margin = '0';
      (window as any).msgs = [];
      addEventListener('message', (e) => (window as any).msgs.push(e.data?.type === 'error' ? 'error:' + e.data.message : e.data?.type));
      f.srcdoc = html;
      document.body.append(f);
      await new Promise((r) => f.addEventListener('load', r));
      const c = document.createElement('canvas'); c.width = 1600; c.height = 1000;
      const g = c.getContext('2d')!; const gr = g.createLinearGradient(0,0,1600,1000); gr.addColorStop(0,'#4a7'); gr.addColorStop(1,'#246'); g.fillStyle = gr; g.fillRect(0,0,1600,1000);
      const photo = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
      f.contentWindow!.postMessage({ sf, type: 'init', data, assets: data.__nophoto ? {} : { photo }, durationMs: 10000, orientation, viewport: size, timezone: 'UTC', locale: 'en-US', clock: { now: Date.now(), offsetMs: 0 } }, '*');
    }, { html: t.html, size, sf: PROTOCOL_VERSION, data: { ...defaults, qrUrl: 'https://example.com/floor-plan', look, ...extra }, orientation });
    await page.waitForFunction(() => (window as any).msgs.some((m: string) => m === 'ready' || m.startsWith('error')));
    console.log(look, orientation, await page.evaluate(() => (window as any).msgs.join(',')));
    await page.frames()[1]!.evaluate(() => { for (const a of document.getAnimations()) a.currentTime = 3000; });
    await page.screenshot({ path: `${out}/${look}-${orientation}${tag}.png` });
    await page.close();
  }
import { readFileSync } from 'node:fs';
for (const o of ['landscape', 'portrait']) {
  const m = await browser.newPage({ viewport: o === 'landscape' ? { width: 1940, height: 1100 } : { width: 2200, height: 960 } });
  const imgs = ['pop', 'poster', 'night', 'corporate'].map((l) => `<img style="width:${o === 'landscape' ? 960 : 540}px;margin:2px" src="data:image/png;base64,${readFileSync(`${out}/${l}-${o}${tag}.png`).toString('base64')}">`).join('');
  await m.setContent(`<body style="margin:0;background:#888;line-height:0">${imgs}</body>`);
  await m.screenshot({ path: `${out}/M-${o}${tag}.png` });
}
await browser.close();
