import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spotsPlayed, useHarness, visibleFrame } from './harness';

const h = useHarness();

describe('playback loop', () => {
  it('plays a playlist of two spots in order and loops', async () => {
    const content = h.content([
      { id: 'a', durationMs: 800 },
      { id: 'b', durationMs: 800 },
    ]);
    const p = await h.openPlayer((s) => s.publish(content));

    const s = await p.until((s) => s.log.length >= 5);
    expect(spotsPlayed(s).slice(0, 5)).toEqual(['a', 'b', 'a', 'b', 'a']);
    expect(s.manifestId).toBe(content.manifest.id);
    expect(s.skipped).toBe(0);
    // The spot the player says is on screen is the one drawn on top, and it was told to play.
    await expect
      .poll(async () => {
        const now = (await p.state()).spot;
        const shown = await p.onScreen();
        return shown?.playing && shown.label === now;
      })
      .toBe(true);
  });

  // Turned or resized without a reload (an HDMI mode change, a rotation), the spot on screen is laid out again for the
  // new size at once, not at its next play (#457).
  it('lays the template on screen out again when the screen turns', async () => {
    const p = await h.openPlayer((s) => s.publish(h.content([{ id: 'a', durationMs: 600_000 }])));
    /** The template on screen: the orientation its init gave, its frame's size, and whether it plays. */
    const seen = async () =>
      (await visibleFrame(p.page, 'label'))
        ?.evaluate(() => ({
          orientation: document.documentElement.dataset.orientation,
          size: `${innerWidth}x${innerHeight}`,
          playing: document.body.dataset.playing === '1',
        }))
        .catch(() => undefined);
    await expect.poll(seen, { timeout: 10_000 }).toEqual({ orientation: 'landscape', size: '960x540', playing: true });
    await p.page.setViewportSize({ width: 540, height: 960 });
    await expect.poll(seen, { timeout: 10_000 }).toEqual({ orientation: 'portrait', size: '540x960', playing: true });
    const s = await p.state();
    expect(s.spot).toBe('a');
    expect(s.skipped).toBe(0);
  });

  it('titles a URL spot frame with the spot name (#69)', async () => {
    const content = h.content([{ id: 'lunch-menu', url: 'https://menu.test/', durationMs: 4000 }]);
    const p = await h.openPlayer((s) => s.publish(content));
    await p.page.context().route(/^https:\/\/menu\.test\//, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Menu</title>' }));
    await p.until((s) => s.spot === 'lunch-menu');
    expect(await p.page.locator('.slot iframe[src^="https://menu.test/"]').first().getAttribute('title')).toBe('lunch-menu');
  });

  // Chromium sends a frame that has drawn nothing for more than 3 frames one frame a second, and
  // a frame an opaque one covers completely is never drawn: the next spot, loading underneath,
  // then took over a second to reach ready on the Pi. So the black behind a spot leaves a 1 px
  // column uncovered, at the centre, where the spot itself covers it.
  it('never covers the slot underneath completely with the black behind the spot on top', async () => {
    const content = h.content([
      { id: 'a', durationMs: 4000 },
      { id: 'b', durationMs: 4000 },
    ]);
    const p = await h.openPlayer((s) => s.publish(content));
    await p.until((s) => s.spot === 'a');
    const shown = await p.page.evaluate(() => {
      const slot = [...document.querySelectorAll<HTMLElement>('.slot')].find((s) => s.style.zIndex === '2')!;
      const box = slot.getBoundingClientRect();
      const painted = (st: CSSStyleDeclaration) => st.backgroundColor !== 'rgba(0, 0, 0, 0)';
      // What the black covers, as [from, to) in px: the slot's own background and its pseudo-elements.
      const black: [number, number][] = painted(getComputedStyle(slot)) ? [[box.left, box.right]] : [];
      for (const pseudo of ['::before', '::after']) {
        const st = getComputedStyle(slot, pseudo);
        if (st.content !== 'none' && painted(st)) black.push([box.left + Number.parseFloat(st.left), box.right - Number.parseFloat(st.right)]);
      }
      const covered = (x: number) => black.some(([from, to]) => x >= from && x < to);
      const gaps: number[] = [];
      for (let x = 0; x < box.width; x++) if (!covered(x + 0.5)) gaps.push(x);
      const frame = slot.querySelector('iframe')!.getBoundingClientRect();
      return { width: box.width, gaps, frameCovers: gaps.every((x) => x >= frame.left && x + 1 <= frame.right) };
    });
    expect(shown.gaps).toEqual([shown.width / 2 - 1]);
    expect(shown.frameCovers).toBe(true);
  });

  it('skips a spot whose template throws in prepare and plays the next', async () => {
    const content = h.content([
      { id: 'a', durationMs: 800 },
      { id: 'bad', mode: 'throw', durationMs: 800 },
      { id: 'b', durationMs: 800 },
    ]);
    const p = await h.openPlayer((s) => s.publish(content));

    const s = await p.until((s) => s.log.length >= 4);
    expect(spotsPlayed(s).slice(0, 4)).toEqual(['a', 'b', 'a', 'b']);
    expect(s.skipped).toBeGreaterThanOrEqual(1);
    expect(s.lastError).toBe('bad: template error: fixture prepare failed');
  });

  it('skips a template that never reports ready, after the ready timeout', async () => {
    const content = h.content([
      { id: 'a', durationMs: 500 },
      { id: 'slow', mode: 'hang', durationMs: 500 },
      { id: 'b', durationMs: 500 },
    ]);
    const p = await h.openPlayer((s) => s.publish(content));

    const s = await p.until((s) => s.log.length >= 3);
    expect(spotsPlayed(s).slice(0, 3)).toEqual(['a', 'b', 'a']);
    expect(s.lastError).toBe('slow: not ready within 2000 ms');
    // The player waited out the timeout (READY_TIMEOUT_MS, 2 s) on `slow` before giving up on it.
    const gap = Date.parse(s.log[1]!.startedAt) - Date.parse(s.log[0]!.startedAt);
    expect(gap).toBeGreaterThanOrEqual(1900);
  });

  // A paused video that has never played presents no frame, so a frame callback never came: every
  // video prepare waited out a 600 ms timer (about 950 ms in all on the Pi, against a 500 ms budget).
  // The clock jumps to where `v`'s prepare starts (3 s before `a` ends) and stays paused there: no
  // timer fires after that, so `v` is ready only if canplaythrough alone makes it so.
  it('has a video spot ready once it can play through, without waiting for a frame callback', async () => {
    const video = readFileSync(join(import.meta.dirname, 'fixtures/clip.webm'));
    const content = h.content([
      { id: 'a', durationMs: 60_000 },
      { id: 'v', video, durationMs: 1500 },
    ]);
    const p = await h.openPlayer((s) => s.publish(content), {}, { clockAt: new Date('2026-11-23T12:00:00Z') });
    const playing = await p.until((s) => s.log.length >= 1);
    await p.page.clock.pauseAt(Date.parse(playing.log[0]!.startedAt) + 57_001);
    const s = await p.until((s) => s.prepares.some((x) => x.spot === 'v'));
    expect(s.skipped).toBe(0);
  });
});
