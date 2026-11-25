import { expect, test, type Frame, type Page } from '@playwright/test';
import { axe, createOrg, disabledOnServer, hydrated, shots, signInAs, stageShows, tool } from './helpers';

/** This spec's own client address, so its sign-in has its own rate limit and leaves the other specs theirs. */
const ADDRESS = '192.0.2.44';

test.describe.configure({ mode: 'serial' });

let page: Page;
/** Spot ids by name. */
const spots: Record<string, string> = {};
let playlistId = '';

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage();
  await signInAs(page, `e2e-playlists-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Northside Cinema', ADDRESS);
  // Spots to put in order: three short clocks, and a photo promo with no photo yet.
  const { templates } = await tool(page, 'list_templates', { status: 'approved' });
  const version = (key: string) => templates.find((t: { key: string }) => t.key.endsWith(`/${key}`) || t.key === key).versions.at(-1).id;
  const clocks: [string, string][] = [
    ['Opening', 'Good morning, Northside'],
    ['Lunch', 'Lunch is served'],
    ['Closing', 'See you tomorrow'],
  ];
  for (const [name, greeting] of clocks) {
    const { spot } = await tool(page, 'create_spot', { name, kind: 'template', templateVersionId: version('clock'), durationMs: 4000, data: { greeting } });
    spots[name] = spot.id;
  }
  const { spot } = await tool(page, 'create_spot', { name: 'Berries', kind: 'template', templateVersionId: version('photo-promo') });
  spots.Berries = spot.id;
});

test.afterAll(() => page.context().close());

test('make a playlist, add spots, and see the real player play the loop', async () => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Playlists' }).click();
  await hydrated(page);
  await expect(page.getByRole('heading', { name: 'Put your spots in a playlist' })).toBeVisible();
  await axe(page);
  await shots(page, '40-playlists-empty');

  await page.getByRole('button', { name: 'New playlist' }).click();
  await page.getByLabel('Name').fill('Lunch loop');
  await page.getByRole('button', { name: 'Create playlist' }).click();
  await expect(page).toHaveURL(/\/playlists\/[^/?]+$/);
  playlistId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  await expect(page.getByRole('heading', { name: 'Lunch loop', level: 1 })).toBeVisible();
  await hydrated(page);
  await expect(page.getByText('Add spots and the player plays the loop here.')).toBeVisible();

  await page.getByRole('button', { name: 'Add spots' }).click();
  const picker = page.getByRole('dialog', { name: 'Add spots' });
  for (const name of ['Opening', 'Lunch', 'Closing', 'Berries']) await picker.getByRole('button', { name: `Add ${name}` }).click();
  await axe(page);
  await shots(page, '41-playlist-add-spots');
  await page.keyboard.press('Escape');

  const list = page.getByRole('list', { name: 'Spots in play order' });
  await expect(list.getByRole('listitem')).toHaveCount(4);
  // The photo promo has no photo: the stage plays the rest, and says why it left it out, in words (#359).
  await expect(list.getByRole('listitem').nth(3)).toContainText('Not in the preview yet. No image for Background photo: choose one.');
  // Three 4 s clocks, and the promo's 8 s default: 20 s.
  await expect(page.getByText('4 spots · 20 s loop', { exact: false })).toBeVisible();

  const stage = page.getByRole('region', { name: 'Live preview' });
  await expect(stage.getByRole('status')).toHaveText('Preview ready', { timeout: 30_000 });
  await expect.poll(() => stageShows(page, 'Good morning, Northside'), { timeout: 10_000 }).toBe(true);
  // The loop moves on to the next spot after 4 s.
  await expect.poll(() => stageShows(page, 'Lunch is served'), { timeout: 15_000 }).toBe(true);
  await expect(page.getByText(/Saved \d/)).toBeVisible();
  await axe(page);
  await shots(page, '42-playlist-editor');
});

test('reorder by dragging and with the move buttons, remove and undo, and choose the transition', async () => {
  const list = page.getByRole('list', { name: 'Spots in play order' });
  const names = () => list.getByRole('listitem').evaluateAll((items) => items.map((li) => li.querySelector('.font-medium')?.textContent));

  // Drag Closing onto the first row.
  await list.getByRole('listitem').nth(2).dragTo(list.getByRole('listitem').nth(0));
  await expect.poll(names).toEqual(['Closing', 'Opening', 'Lunch', 'Berries']);
  await page.getByRole('button', { name: 'Move Berries up' }).click();
  await expect.poll(names).toEqual(['Closing', 'Opening', 'Berries', 'Lunch']);
  await page.getByRole('button', { name: 'Move Closing down' }).click();
  await expect.poll(names).toEqual(['Opening', 'Closing', 'Berries', 'Lunch']);

  // Removed, and put back from its toast's Undo at once: the toast goes on its own after a few
  // seconds, so nothing is checked in between. Then removed for good.
  await page.getByRole('button', { name: 'Remove Berries' }).click();
  await page.locator('[data-sonner-toast]').filter({ hasText: 'Removed Berries' }).getByRole('button', { name: 'Undo' }).click();
  await expect.poll(names).toEqual(['Opening', 'Closing', 'Berries', 'Lunch']);
  await page.getByRole('button', { name: 'Remove Berries' }).click();
  await expect.poll(names).toEqual(['Opening', 'Closing', 'Lunch']);
  await expect(page.getByText('3 spots · 12 s loop', { exact: false })).toBeVisible();

  // Undo pressed after the removal has autosaved (re-check of #153): the spot comes back once, on the
  // version that save made. With the pointer held down on the toast its timer stays paused, even if
  // sonner's toast list changes meanwhile, so it waits for the save.
  const removalSaved = page.waitForResponse((r) => r.url().endsWith('/api/tools/update_playlist') && r.ok());
  await page.getByRole('button', { name: 'Remove Lunch' }).click();
  const removed = page.locator('[data-sonner-toast]').filter({ hasText: 'Removed Lunch' });
  await removed.hover();
  await page.mouse.down();
  await removalSaved;
  await page.mouse.up();
  const undoSaved = page.waitForResponse((r) => r.url().endsWith('/api/tools/update_playlist'));
  await removed.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(names).toEqual(['Opening', 'Closing', 'Lunch']);
  expect((await undoSaved).status()).toBe(200);
  await expect(page.getByText('This changed since you opened it.')).toHaveCount(0);

  await page.getByRole('radio', { name: /^Crossfade/ }).check();
  await expect(page.getByText('a Raspberry Pi 4 drops about 1 frame in 10 while it runs')).toBeVisible();
  await page.getByRole('spinbutton', { name: 'Length' }).fill('0.8');
  await expect(page.getByText(/Saved \d/)).toBeVisible();
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);

  // What the editor saved is what the tools hold: the order, the transition.
  const { playlist } = await tool(page, 'get_playlist', { playlistId });
  expect(playlist).toMatchObject({
    name: 'Lunch loop',
    transition: { type: 'crossfade', ms: 800 },
    spotIds: [spots.Opening, spots.Closing, spots.Lunch],
    published: false,
  });
  await axe(page);
  await shots(page, '43-playlist-crossfade');

  // By keyboard alone: focus stays on the moved spot's buttons, so two Enters move it two places,
  // and where it went is said politely.
  await page.getByRole('button', { name: 'Move Lunch up' }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(names).toEqual(['Opening', 'Lunch', 'Closing']);
  await expect(page.getByRole('button', { name: 'Move Lunch up' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(names).toEqual(['Lunch', 'Opening', 'Closing']);
  // At the top its up button is disabled: focus is on its down button instead.
  await expect(page.getByRole('button', { name: 'Move Lunch down' })).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: 'Lunch, 1 of 3' })).toBeAttached();

  // At phone width the form and the stage stack, and the move buttons reorder without a drag.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('region', { name: 'Live preview' })).toBeVisible();
  await page.getByRole('button', { name: 'Move Closing up' }).click();
  await expect.poll(names).toEqual(['Lunch', 'Closing', 'Opening']);
  await axe(page);
  await shots(page, '44-playlist-editor-phone');
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByText(/Saved \d/)).toBeVisible();
});

test('a change someone else made while the editor was open is not overwritten', async () => {
  const { playlist } = await tool(page, 'get_playlist', { playlistId });
  // Stands in for an agent: a reorder lands after the page read the playlist.
  await tool(page, 'update_playlist', { playlistId, spotIds: [spots.Closing], ifVersion: playlist.version });
  await page.getByRole('radio', { name: /^Cut/ }).check();
  await expect(page.getByText('This changed since you opened it.')).toBeVisible();
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByRole('list', { name: 'Spots in play order' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('radio', { name: /^Crossfade/ })).toBeChecked();
});

test('the list shows each playlist, and a playlist can be deleted', async () => {
  await page.getByRole('link', { name: 'Playlists' }).first().click();
  await hydrated(page);
  const row = page.getByRole('link', { name: /Lunch loop/ });
  await expect(row).toContainText('1 spot · 4 s loop · Crossfade 0.8 s · Draft, never published');
  // Its first spot, small: the clock the player drew, and in words (#362).
  await expect(row.locator('img')).toHaveAttribute('src', '/template-thumbnails/clock.webp');
  await expect(row).toContainText(/ · starts with \S/);
  await axe(page);
  await shots(page, '45-playlists');
  await page.setViewportSize({ width: 390, height: 844 });
  await shots(page, '46-playlists-phone');
  await page.setViewportSize({ width: 1280, height: 720 });

  await row.click();
  await hydrated(page);
  // From the editor's ⋯ menu (#378), not between Save draft and Publish.
  await page.getByRole('button', { name: 'More actions: delete' }).click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Delete Lunch loop?');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page).toHaveURL(/\/playlists$/);
  await expect(page.getByRole('heading', { name: 'Put your spots in a playlist' })).toBeVisible();
});

test('axe reads the stage only once a fade between spots is over (#95)', async () => {
  // A loop of its own: a 4 s clock, then a 4 s fade into a 60 s one. After the fade the stage is
  // still for most of a minute, however slow the machine: no play, fade or prepare comes sooner.
  const { templates } = await tool(page, 'list_templates', { status: 'approved' });
  const clock = templates.find((t: { key: string }) => t.key.endsWith('/clock') || t.key === 'clock').versions.at(-1).id;
  const spotIds: string[] = [];
  const loop: [greeting: string, durationMs: number][] = [
    ['Doors open', 4000],
    ['Doors close', 60_000],
  ];
  for (const [greeting, durationMs] of loop)
    spotIds.push((await tool(page, 'create_spot', { name: greeting, kind: 'template', templateVersionId: clock, durationMs, data: { greeting } })).spot.id);
  const { playlist } = await tool(page, 'create_playlist', {
    name: 'Fade check',
    transition: { type: 'fade', ms: 4000 },
    spotIds,
    idempotencyKey: `fade-check-${Date.now()}`,
  });
  await page.goto(`/playlists/${playlist.id}`);
  await hydrated(page);
  await expect(page.getByRole('region', { name: 'Live preview' }).getByRole('status')).toHaveText('Preview ready', { timeout: 30_000 });
  // The player's own document on the stage: the frame that holds the slots.
  let stage: Frame | undefined;
  await expect
    .poll(async () => {
      for (const f of page.frames()) if (await f.evaluate(() => document.querySelectorAll('.slot').length > 0).catch(() => false)) stage = f;
      return stage !== undefined;
    })
    .toBe(true);
  // Each time axe scans the player's document, note every slot's opacity then.
  await stage!.evaluate(() => {
    const root = document.documentElement;
    root.dataset.scans = '';
    // axe-core sets `runPartial` after `window.axe`: wrap whatever `runPartial` is when axe is read.
    type Run = (...args: unknown[]) => unknown;
    type Axe = { runPartial?: Run };
    let real: Axe | undefined;
    const wrappers = new WeakSet<Run>();
    Object.defineProperty(window, 'axe', {
      configurable: true,
      get() {
        const run = real?.runPartial;
        if (real && run && !wrappers.has(run)) {
          const probe: Run = function (this: unknown, ...args: unknown[]) {
            const opacities = [...document.querySelectorAll('.slot')].map((el) => getComputedStyle(el).opacity).join('/');
            root.dataset.scans = `${root.dataset.scans} ${opacities}`.trim();
            return run.apply(this, args);
          };
          wrappers.add(probe);
          real.runPartial = probe;
        }
        return real;
      },
      set(v: Axe) {
        real = v;
      },
    });
  });
  // The fade into the 60 s clock, caught as it starts: axe must wait until it is over. If the steps
  // above outlast the first fade, the next comes a whole loop (64 s and its fades) later.
  await expect
    .poll(
      () =>
        stage!.evaluate(() =>
          document
            .getAnimations()
            .some(
              (a) => a.playState === 'running' && a.effect instanceof KeyframeEffect && a.effect.target instanceof Element && a.effect.target.matches('.slot'),
            ),
        ),
      { intervals: [20], timeout: 75_000 },
    )
    .toBe(true);
  await axe(page);
  // The light pass reads the stage; the dark leaves the player's frames out.
  const scans = (await stage!.evaluate(() => document.documentElement.dataset.scans ?? '')).split(' ').filter(Boolean);
  expect(scans.length).toBeGreaterThanOrEqual(1);
  // Every scan saw each slot fully shown or fully hidden, and one shown.
  for (const scan of scans) {
    const opacities = scan.split('/').map(Number);
    expect(
      opacities.every((o) => o === 0 || o === 1),
      `slot opacities during a scan: ${scan}`,
    ).toBe(true);
    expect(opacities, `slot opacities during a scan: ${scan}`).toContain(1);
  }
});

test("the editor's fields and actions are disabled in the server's HTML, until the editor has hydrated (#136)", async () => {
  // The editor hydrates after the page (body[data-hydrated]): a field changed in between was set
  // back by React, and the old value autosaved.
  const { playlist } = await tool(page, 'create_playlist', { name: 'Server loop', spotIds: [spots.Opening], idempotencyKey: `server-loop-${Date.now()}` });
  const path = `/playlists/${playlist.id}`;
  const names = ['Name', 'Remove Opening', 'Add spots', 'Play on every screen', 'Save draft', 'Publish', 'More actions: delete'];
  expect(await disabledOnServer(page, path, names)).toEqual(Object.fromEntries(names.map((n) => [n, [true]])));
  // Rendered by the server, they are enabled once the editor has hydrated (Save draft waits for a change).
  await page.goto(path);
  await hydrated(page);
  await expect(page.getByLabel('Name', { exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeEnabled();
});
