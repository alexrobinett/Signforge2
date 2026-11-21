// The Schedule page (M3-19): schedule a playlist for a group of screens, see the week, publish it
// to a real test screen; take the screen over and see it cut in, end the takeover, and remove the
// entry. No entry has days or times, and the takeover's end is the page's own "an hour from now",
// so nothing depends on the hour the test runs at. What the screen's page says it plays is what
// was published, not the draft; a takeover's publish offers no Undo, and a removal waits for Publish.
import { expect, test, type Page } from '@playwright/test';
import { axe, createOrg, disabledOnServer, hydrated, shots, signInAs, tool } from './helpers';

/** This spec's own client address, so its sign-in has its own rate limit and leaves the other specs theirs. */
const ADDRESS = '192.0.2.137';

test.describe.configure({ mode: 'serial' });

let page: Page;
/** A test screen in its own tab: the real player, paired to the org. */
let screen: Page;
const playlist: Record<string, string> = {};
let screenId = '';

/** What the player in the tab says it plays (`window.__sf`). */
const playing = (tab: Page) =>
  tab.evaluate(() => {
    const s = (window as Window & { __sf?: { pairing: string; playlist: string } }).__sf;
    return s ? { pairing: s.pairing, playlist: s.playlist } : undefined;
  });
const playlistOn = async () => (await playing(screen))?.playlist ?? '';

/** The toast saying `title`. */
const toastSays = (title: string | RegExp) => page.locator('[data-sonner-toast]').filter({ hasText: title });

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage();
  await signInAs(page, `e2e-schedule-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Northside Market');
  const { templates } = await tool(page, 'list_templates', { status: 'approved' });
  const clock = templates.find((t: { key: string }) => t.key === 'clock' || t.key.endsWith('/clock')).versions.at(-1).id;
  // A publish shows at the end of the spot on screen; a takeover cuts in. So the default's spot is
  // short, and the others a minute long: a takeover that waited for the spot's end would miss the waits.
  const lengths: Record<string, number> = { 'All day': 10_000, Breakfast: 60_000, 'Flash sale': 60_000 };
  for (const name of Object.keys(lengths)) {
    const { spot } = await tool(page, 'create_spot', { name, kind: 'template', templateVersionId: clock, durationMs: lengths[name], data: { greeting: name } });
    ({
      playlist: { id: playlist[name] },
    } = await tool(page, 'create_playlist', { name, transition: { type: 'cut' }, spotIds: [spot.id] }));
  }
  await tool(page, 'set_default_playlist', { playlistId: playlist['All day'] });

  // A test screen, paired by its code as the Screens page pairs one, put in a new group, Front, from its settings.
  screen = await (await browser.newContext()).newPage();
  await screen.goto('/test-screen/?kind=browser&content=/v1/device');
  await expect.poll(async () => (await playing(screen))?.pairing ?? '', { timeout: 20_000 }).not.toBe('');
  const { screen: paired } = await tool(page, 'claim_screen', {
    code: (await playing(screen))!.pairing,
    name: 'Front window',
    timezone: 'UTC',
    orientation: 'landscape',
  });
  screenId = paired.id;
  await page.goto(`/screens/${paired.id}`);
  await hydrated(page);
  await page.getByRole('button', { name: /More actions/ }).click();
  await page.getByRole('menuitem', { name: 'Settings and groups…' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByLabel('New group').fill('Front');
  await settings.getByRole('button', { name: 'Save' }).click();
  await expect(settings).toBeHidden();
  await expect(page.getByText('group Front')).toBeVisible();
  // A screen gets content at the publish after it is paired.
  await tool(page, 'publish', {});
  await expect.poll(playlistOn, { timeout: 30_000 }).toBe(playlist['All day']);
});

test.afterAll(async () => {
  await screen.context().close();
  await page.context().close();
});

test('schedule a playlist for a group, see its week, and publish it to the screen', async () => {
  test.setTimeout(120_000);
  // The page hydrates after the app (body[data-hydrated]): until then its controls are disabled (#136).
  const names = ['Take over screens', 'Schedule a playlist', 'Publish', 'Screen'];
  expect(await disabledOnServer(page, '/schedule', names)).toEqual(Object.fromEntries(names.map((n) => [n, [true]])));
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Schedule' }).click();
  await hydrated(page);
  await expect(page.getByRole('heading', { name: 'Nothing scheduled' })).toBeVisible();
  await expect(page.getByText('Where no entry applies, every screen plays All day')).toBeVisible();
  await axe(page);
  await shots(page, '50-schedule-empty');

  await page.getByRole('button', { name: 'Schedule a playlist' }).click();
  const dialog = page.getByRole('dialog', { name: 'Schedule a playlist' });
  await dialog.getByLabel('Playlist').selectOption({ label: 'Breakfast' });
  await dialog.getByLabel('Plays on').selectOption('group');
  await dialog.getByLabel('Group').selectOption({ label: 'Front (1 screen)' });
  // A window that ends before it starts runs past midnight; one with an end before the start date is refused.
  await dialog.getByLabel('First date').fill('2030-02-01');
  await dialog.getByLabel('Last date').fill('2030-01-01');
  await expect(dialog.getByRole('alert')).toHaveText('The last date is before the first.');
  await expect(dialog.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  await dialog.getByLabel('First date').fill('');
  await dialog.getByLabel('Last date').fill('');
  await axe(page);
  await shots(page, '51-schedule-entry-dialog');
  await dialog.getByRole('button', { name: 'Save draft' }).click();
  await expect(toastSays('Scheduled, as a draft')).toBeVisible();

  const entries = page.getByRole('region', { name: 'Entries' }).getByRole('listitem');
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toContainText('Breakfast');
  await expect(entries.first()).toContainText('Group Front · Always · Draft, not published');
  // The week, as drafted: Breakfast every hour of every day on the screen of group Front.
  const week = page.getByRole('table', { name: /What Front window plays each hour this week/ });
  await expect(week.getByRole('cell', { name: /Breakfast/ })).toHaveCount(7 * 24);
  // Drafted only: the screen still plays the default, and its page says so.
  expect(await playlistOn()).toBe(playlist['All day']);
  await axe(page);
  await shots(page, '52-schedule');
  await page.goto(`/screens/${screenId}`);
  await expect(page.getByRole('link', { name: 'plays All day now' })).toBeVisible();
  await page.getByRole('link', { name: 'plays All day now' }).click();
  await hydrated(page);

  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(toastSays(/Published v\d+ to 1 screen/)).toBeVisible();
  // A publish of schedule entries alone can be undone from its toast.
  await expect(toastSays(/Published v\d+ to 1 screen/).getByRole('button', { name: 'Undo' })).toBeVisible();
  await expect(entries.first()).toContainText('Published');
  await expect.poll(playlistOn, { timeout: 30_000 }).toBe(playlist.Breakfast);
});

test('take the screens over: the screen cuts in at once, and goes back when it ends', async () => {
  test.setTimeout(120_000);
  await page.getByRole('button', { name: 'Take over screens' }).click();
  const dialog = page.getByRole('dialog', { name: 'Take over screens' });
  await dialog.getByLabel('Playlist').selectOption({ label: 'Flash sale' });
  await axe(page);
  await shots(page, '53-schedule-takeover-dialog');
  await dialog.getByRole('button', { name: 'Take over now' }).click();
  await expect(toastSays(/Published v\d+ to 1 screen/)).toBeVisible();
  // No Undo: a roll back would leave the takeover published, to cut in again at the next publish. End now ends it.
  await expect(toastSays(/Published v\d+ to 1 screen/).getByRole('button', { name: 'Undo' })).toHaveCount(0);

  const takeovers = page.getByRole('region', { name: 'Takeovers' }).getByRole('listitem');
  await expect(takeovers).toHaveCount(1);
  await expect(takeovers.first()).toContainText('Every screen · Playing until');
  // The breakfast spot on screen is a minute long: only a cut shows the takeover within the wait.
  await expect.poll(playlistOn, { timeout: 30_000 }).toBe(playlist['Flash sale']);
  await axe(page);
  await shots(page, '54-schedule-takeover');

  await takeovers.first().getByRole('button', { name: 'End now' }).click();
  await expect(page.getByRole('region', { name: 'Takeovers' })).toHaveCount(0);
  await expect(toastSays(/Published v\d+ to 1 screen/).getByRole('button', { name: 'Undo' })).toHaveCount(0);
  await expect.poll(playlistOn, { timeout: 30_000 }).toBe(playlist.Breakfast);
});

test('remove the entry and publish: the screen goes back to the default; the page at phone width', async () => {
  test.setTimeout(180_000);
  await page.getByRole('button', { name: 'Remove Breakfast on Group Front' }).click();
  await expect(toastSays('Removed')).toContainText('Screens keep it until you publish.');
  // Removed as a draft: listed so until the publish that takes it off screens.
  await expect(page.getByRole('region', { name: 'Entries' }).getByRole('listitem').first()).toContainText('Removed, not published');
  expect(await playlistOn()).toBe(playlist.Breakfast);
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(toastSays(/Published v\d+ to 1 screen/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Nothing scheduled' })).toBeVisible();
  // Not a takeover: the minute-long Breakfast spot on screen plays to its end first.
  await expect.poll(playlistOn, { timeout: 90_000 }).toBe(playlist['All day']);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('table', { name: /What Front window plays each hour this week/ })).toBeVisible();
  await axe(page);
  await shots(page, '55-schedule-phone');
  await page.setViewportSize({ width: 1280, height: 720 });
});

test('a create whose answer was lost, saved again, makes one entry, and a takeover started again makes one takeover (#149)', async () => {
  test.setTimeout(120_000);
  await page.goto('/schedule');
  await hydrated(page);
  /** Lets the first call to `tool` reach SignForge, which makes the row, and loses its answer on the way back. */
  const loseFirstAnswer = async (name: string) => {
    let first = true;
    await page.route(`**/api/tools/${name}`, async (route) => {
      if (!first) return route.continue();
      first = false;
      await route.fetch();
      await route.abort('failed');
    });
  };
  const count = async (kind: 'entries' | 'takeovers') =>
    (await tool(page, 'list_schedule_entries', {})).entries.filter(
      (e: { endsAt: string | null; deleted: boolean }) => !e.deleted && (kind === 'takeovers') === (e.endsAt !== null),
    ).length;
  const entriesBefore = await count('entries');

  await loseFirstAnswer('create_schedule_entry');
  await page.getByRole('button', { name: 'Schedule a playlist' }).click();
  const dialog = page.getByRole('dialog', { name: 'Schedule a playlist' });
  await dialog.getByLabel('Playlist').selectOption({ label: 'Breakfast' });
  await dialog.getByRole('button', { name: 'Save draft' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Could not reach SignForge');
  await dialog.getByRole('button', { name: 'Save draft' }).click();
  await expect(toastSays('Scheduled, as a draft')).toBeVisible();
  await expect(dialog).toBeHidden();
  expect(await count('entries')).toBe(entriesBefore + 1);

  await loseFirstAnswer('start_takeover');
  await page.getByRole('button', { name: 'Take over screens' }).click();
  const takeover = page.getByRole('dialog', { name: 'Take over screens' });
  await takeover.getByLabel('Playlist').selectOption({ label: 'Flash sale' });
  await takeover.getByRole('button', { name: 'Take over now' }).click();
  await expect(takeover.getByRole('alert')).toContainText('Could not reach SignForge');
  await takeover.getByRole('button', { name: 'Take over now' }).click();
  await expect(toastSays(/Published v\d+ to 1 screen/)).toBeVisible();
  expect(await count('takeovers')).toBe(1);
  await expect(page.getByRole('region', { name: 'Takeovers' }).getByRole('listitem')).toHaveCount(1);
  await page.getByRole('region', { name: 'Takeovers' }).getByRole('listitem').first().getByRole('button', { name: 'End now' }).click();
  await expect(page.getByRole('region', { name: 'Takeovers' })).toHaveCount(0);
  await page.unroute('**/api/tools/*');
});
