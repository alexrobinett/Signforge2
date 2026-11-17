/**
 * The template SDK on its own: the fixture template in a sandboxed frame, driven by a tiny host
 * that speaks the frame protocol the way the player does and records what the template says.
 * (Protocol 1 has no `done` message: a spot ends when the player moves on.)
 */
import type { Frame, Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@signforge/contract';
import { useHarness } from './harness';

const h = useHarness();

interface Host {
  page: Page;
  frame: Frame;
  /** Message types the template has sent, in order (`error:<message>` for errors). */
  messages(): Promise<string[]>;
  post(type: 'play' | 'stop'): Promise<void>;
}

async function host(data: Record<string, unknown>): Promise<Host> {
  const page = await h.blankPage();
  await page.evaluate(
    ({ html, data, sf }) => {
      const w = window as unknown as { msgs: string[] };
      w.msgs = [];
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      addEventListener('message', (e) => {
        if (e.source !== frame.contentWindow || e.data?.sf !== sf) return;
        w.msgs.push(e.data.type === 'error' ? `error:${e.data.message}` : e.data.type);
        if (e.data.type === 'loaded') {
          const init = { sf, type: 'init', data, assets: {}, durationMs: 5000, orientation: 'landscape', viewport: { width: 960, height: 540 }, timezone: 'UTC', locale: 'en-US' };
          frame.contentWindow!.postMessage(init, '*');
        }
      });
      frame.srcdoc = html;
      document.body.appendChild(frame);
    },
    { html: h.templateHtml, data, sf: PROTOCOL_VERSION },
  );
  await expect.poll(() => page.frames().length).toBe(2);
  const frame = page.frames()[1]!;
  return {
    page,
    frame,
    messages: () => page.evaluate(() => (window as unknown as { msgs: string[] }).msgs),
    post: (type) => page.evaluate(({ type, sf }) => document.querySelector('iframe')!.contentWindow!.postMessage({ sf, type }, '*'), { type, sf: PROTOCOL_VERSION }),
  };
}

const animationStates = (f: Frame) => f.evaluate(() => document.getAnimations().map((a) => a.playState));

describe('template SDK lifecycle', () => {
  it('reports loaded, binds data, reports ready with animations held, and plays on play', async () => {
    const t = await host({ label: 'Hello', mode: 'ok' });

    await expect.poll(t.messages).toEqual(['loaded', 'ready']);
    expect(await t.frame.locator('#label').textContent()).toBe('Hello');
    // Ready means the first frame is complete and nothing has started moving yet.
    expect(await animationStates(t.frame)).toEqual(['paused']);
    expect(await t.frame.evaluate(() => document.body.dataset.playing)).toBeUndefined();

    await t.post('play');
    await expect.poll(() => t.frame.evaluate(() => document.body.dataset.playing)).toBe('1');
    expect(await animationStates(t.frame)).toEqual(['running']);
  });

  it('reports an error, not ready, when prepare throws', async () => {
    const t = await host({ label: 'x', mode: 'throw' });
    await expect.poll(t.messages).toEqual(['loaded', 'error:fixture prepare failed']);
  });

  it('never reports ready while prepare has not finished', async () => {
    const t = await host({ label: 'x', mode: 'hang' });
    await expect.poll(() => t.frame.evaluate(() => document.body.dataset.prepared)).toBe('1');
    await t.page.waitForTimeout(1000);
    expect(await t.messages()).toEqual(['loaded']);
  });
});
