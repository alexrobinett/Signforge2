// List-row binding (`bindRow`, `rowImage`, `rowAsset`) in Chromium (#196).
import { build } from 'esbuild';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

declare const sfRows: typeof import('./rows');

let browser: Browser;
let page: Page;

beforeAll(async () => {
  const bundle = await build({
    entryPoints: [new URL('./rows.ts', import.meta.url).pathname],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'sfRows',
    logLevel: 'silent',
  });
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.setContent('<!doctype html><body></body>');
  await page.addScriptTag({ content: bundle.outputFiles[0]?.text ?? '' });
}, 120_000);

afterAll(() => browser?.close());

describe('@signforge/template-sdk/rows', { timeout: 30_000 }, () => {
  it('fills [data-sf] and [data-sf-src] on list rows (lead and thumb), and hides images whose blob is missing, though a top-level image has the same name', async () => {
    const res = await page.evaluate(() => {
      const ctx = {
        data: {
          items: [
            { title: 'With photo', source: 'NPR' },
            { title: 'Missing photo', source: 'BBC' },
          ],
        },
        assets: {
          [sfRows.rowAsset('items', 0, 'image')]: 'blob:lead-0',
          [sfRows.rowAsset('items', 0, 'image', 'thumb')]: 'blob:thumb-0',
          // A top-level image field of the same name as the row's prop: never a row's image.
          image: 'blob:top-level',
          'image:thumb': 'blob:top-level-thumb',
        },
      };

      const makeRow = () => {
        const li = document.createElement('li');
        li.innerHTML =
          '<span data-sf="title"></span><em data-sf="source"></em>' +
          '<img class="lead" data-sf-src="image">' +
          '<img class="thumb" data-sf-src="image:thumb">';
        return li;
      };

      const r0 = makeRow();
      sfRows.bindRow(r0, ctx, 'items', 0);

      const r1 = makeRow();
      r1.querySelector<HTMLImageElement>('.lead')!.src = 'blob:stale';
      sfRows.bindRow(r1, ctx, 'items', 1);

      const directImg = document.createElement('img');
      directImg.dataset.sfSrc = 'image:thumb';
      sfRows.bindRow(directImg, ctx, 'items', 0);

      const read = (li: HTMLElement) => ({
        title: li.querySelector('[data-sf="title"]')?.textContent,
        source: li.querySelector('[data-sf="source"]')?.textContent,
        leadSrc: li.querySelector<HTMLImageElement>('.lead')?.getAttribute('src'),
        leadHidden: li.querySelector<HTMLImageElement>('.lead')?.hidden,
        thumbSrc: li.querySelector<HTMLImageElement>('.thumb')?.getAttribute('src'),
        thumbHidden: li.querySelector<HTMLImageElement>('.thumb')?.hidden,
      });

      return {
        rowImageLead: sfRows.rowImage(ctx, 'items', 0, 'image'),
        rowImageThumb: sfRows.rowImage(ctx, 'items', 0, 'image', 'thumb'),
        rowImageMissing: sfRows.rowImage(ctx, 'items', 1, 'image'),
        r0: read(r0),
        r1: read(r1),
        directSrc: directImg.getAttribute('src'),
        directHidden: directImg.hidden,
      };
    });

    expect(res.rowImageLead).toBe('blob:lead-0');
    expect(res.rowImageThumb).toBe('blob:thumb-0');
    expect(res.rowImageMissing).toBeUndefined();
    expect(res.r0).toEqual({
      title: 'With photo',
      source: 'NPR',
      leadSrc: 'blob:lead-0',
      leadHidden: false,
      thumbSrc: 'blob:thumb-0',
      thumbHidden: false,
    });
    expect(res.r1).toEqual({
      title: 'Missing photo',
      source: 'BBC',
      leadSrc: null,
      leadHidden: true,
      thumbSrc: null,
      thumbHidden: true,
    });
    expect(res.directSrc).toBe('blob:thumb-0');
    expect(res.directHidden).toBe(false);
  });

  // A photo the browser cannot decode leaves its row text only; the same image bound again to a good one shows it, whether
  // the bad one's decode has failed by then or not (review of #240, round 2).
  it('shows a good photo bound after a bad one on the same image, before or after the bad one fails', async () => {
    const res = await page.evaluate(async () => {
      const canvas = new OffscreenCanvas(4, 3);
      canvas.getContext('2d')!.fillRect(0, 0, 4, 3);
      const good = URL.createObjectURL(await canvas.convertToBlob({ type: 'image/png' }));
      const bad = URL.createObjectURL(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], { type: 'image/jpeg' }));
      const ctxOf = (url: string) => ({ data: { items: [{ title: 'Story' }] }, assets: { [sfRows.rowAsset('items', 0, 'image')]: url } });
      const settled = (img: HTMLImageElement) =>
        img.decode().then(
          () => undefined,
          () => undefined,
        );
      const view = (img: HTMLImageElement) => ({ src: img.getAttribute('src'), hidden: img.hidden, width: img.naturalWidth });
      const row = () => {
        const li = document.createElement('li');
        li.innerHTML = '<img data-sf-src="image">';
        return [li, li.querySelector('img')!] as const;
      };
      // Bound again at once, while the bad one's decode is still under way.
      const [a, imgA] = row();
      sfRows.bindRow(a, ctxOf(bad), 'items', 0);
      sfRows.bindRow(a, ctxOf(good), 'items', 0);
      await settled(imgA);
      await new Promise((r) => setTimeout(r, 50));
      // Bound again after the bad one failed and hid the image.
      const [b, imgB] = row();
      sfRows.bindRow(b, ctxOf(bad), 'items', 0);
      await settled(imgB);
      await new Promise((r) => setTimeout(r, 50));
      const failed = view(imgB);
      sfRows.bindRow(b, ctxOf(good), 'items', 0);
      await settled(imgB);
      return { good, at: view(imgA), failed, after: view(imgB) };
    });
    expect(res.failed).toEqual({ src: null, hidden: true, width: 0 });
    expect(res.at).toEqual({ src: res.good, hidden: false, width: 4 });
    expect(res.after).toEqual({ src: res.good, hidden: false, width: 4 });
  });
});
