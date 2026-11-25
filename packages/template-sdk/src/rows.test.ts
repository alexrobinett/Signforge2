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
});
