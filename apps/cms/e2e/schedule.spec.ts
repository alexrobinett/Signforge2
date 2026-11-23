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
  await createOrg(page, 'Northside School');
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
  // Whom it plays on: found by typing part of a group's name, picked with Enter; it says whom the group reaches.
  await dialog.getByRole('combobox', { name: 'Plays on' }).click();
  const picker = page.getByRole('dialog', { name: 'Plays on' });
  await expect(picker.getByRole('combobox', { name: 'Search screens and groups' })).toBeFocused();
  await page.keyboard.type('fro');
  await expect(picker.getByRole('option', { name: /Front window/ })).toBeVisible();
  await expect(picker.getByRole('option', { name: /^Every screen/ })).toHaveCount(0);
  await expect(picker.getByRole('option', { selected: true })).toHaveText(/^Front\s*1 screen/);
  await axe(page);
  await shots(page, '50-schedule-target-picker');
  await page.keyboard.press('Enter');
  await expect(picker).toBeHidden();
  await expect(dialog.getByRole('combobox', { name: 'Plays on' })).toHaveText('Front');
  await expect(dialog.getByRole('combobox', { name: 'Plays on' })).toHaveAccessibleDescription('1 screen: Front window');
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

test('pick one screen by typing part of its name, keyboard only; the picker fills a phone (#180)', async () => {
  await page.goto('/schedule');
  await hydrated(page);
  await page.getByRole('button', { name: 'Schedule a playlist' }).click();
  const dialog = page.getByRole('dialog', { name: 'Schedule a playlist' });
  await dialog.getByLabel('Playlist').selectOption({ label: 'Breakfast' });
  await dialog.getByRole('combobox', { name: 'Plays on' }).focus();
  await page.keyboard.press('Enter');
  const picker = page.getByRole('dialog', { name: 'Plays on' });
  // Every screen, the groups and the screens, the current choice marked.
  await expect(picker.getByRole('option', { name: /^Every screen.*chosen/ })).toBeVisible();
  await expect(picker.getByRole('group', { name: 'Groups' }).getByRole('option')).toHaveCount(1);
  await expect(picker.getByRole('combobox', { name: 'Search screens and groups' })).toBeFocused();
  await page.keyboard.type('WIN');
  await expect(picker.getByRole('option')).toHaveCount(1);
  await expect(picker.getByRole('option', { selected: true })).toContainText('Front window');
  await page.keyboard.press('Enter');
  await expect(picker).toBeHidden();
  const plays = dialog.getByRole('combobox', { name: 'Plays on' });
  await expect(plays).toHaveText('Front window');
  await expect(plays).toBeFocused();
  // Escape leaves the picker, not the dialog, and keeps the choice.
  await page.keyboard.press('Enter');
  await expect(picker.getByRole('combobox', { name: 'Search screens and groups' })).toBeFocused();
  await page.keyboard.type('nothing like it');
  await expect(picker.getByText('No screens and groups match “nothing like it”.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(plays).toHaveText('Front window');

  await page.setViewportSize({ width: 390, height: 844 });
  await plays.click();
  await expect.poll(async () => (await picker.boundingBox())?.width).toBe(390);
  await expect(picker.getByRole('combobox', { name: 'Search screens and groups' })).toHaveValue('');
  await axe(page);
  await shots(page, '56-schedule-target-picker-phone');
  // Enter on Cancel cancels: it does not pick the result selected meanwhile.
  await expect(picker.getByRole('combobox', { name: 'Search screens and groups' })).toBeFocused();
  await page.keyboard.type('every');
  await expect(picker.getByRole('option', { selected: true })).toHaveText(/^Every screen/);
  await picker.getByRole('button', { name: 'Cancel' }).focus();
  await page.keyboard.press('Enter');
  await expect(picker).toBeHidden();
  await expect(plays).toHaveText('Front window');
  // The dialog is taller than a phone: its actions stay in view as its fields scroll (#253).
  for (const name of ['Cancel', 'Save draft']) await expect(dialog.getByRole('button', { name })).toBeInViewport({ ratio: 1 });
  await shots(page, '57-schedule-dialog-phone');
  await page.setViewportSize({ width: 1280, height: 720 });

  await dialog.getByRole('button', { name: 'Save draft' }).click();
  await expect(toastSays('Scheduled, as a draft')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Entries' }).getByRole('listitem').filter({ hasText: 'Front window · Always' })).toHaveCount(1);
});

test('play a new playlist on this screen from its page, see what it will play, raise its priority, save and publish it alone; Where it plays (#181)', async () => {
  test.setTimeout(150_000);
  // The tests before leave drafts: an entry never published is gone once deleted.
  for (const e of (await tool(page, 'list_schedule_entries', {})).entries as { id: string; published: boolean; takeover: boolean }[])
    if (!e.published && !e.takeover) await tool(page, 'delete_schedule_entry', { scheduleEntryId: e.id });
  const { templates } = await tool(page, 'list_templates', { status: 'approved' });
  const clock = templates.find((t: { key: string }) => t.key === 'clock' || t.key.endsWith('/clock')).versions.at(-1).id;
  // A playlist and spot never published: Save and publish takes them along with the entry.
  const { spot } = await tool(page, 'create_spot', {
    name: 'Holiday',
    kind: 'template',
    templateVersionId: clock,
    durationMs: 10_000,
    data: { greeting: 'Holiday' },
  });
  const {
    playlist: { id: holiday },
  } = await tool(page, 'create_playlist', { name: 'Holiday promo', transition: { type: 'cut' }, spotIds: [spot.id] });
  // On screens: the screen's group plays Breakfast every morning at priority 10, which outranks a new entry.
  const { groups } = await tool(page, 'list_groups', {});
  const front = groups.find((g: { name: string }) => g.name === 'Front').id;
  const { entry: breakfast } = await tool(page, 'create_schedule_entry', {
    playlistId: playlist.Breakfast,
    target: 'group',
    groupId: front,
    priority: 10,
    from: '06:00',
    to: '10:30',
  });
  await tool(page, 'publish', { drafts: [{ kind: 'schedule_entry', id: breakfast.id, version: breakfast.version }] });
  // Someone else's draft, never published, for the screen at noon at priority 20: as drafted it outranks the new entry too,
  // though Save and publish leaves it off screens, a draft.
  const { entry: flash } = await tool(page, 'create_schedule_entry', {
    playlistId: playlist['Flash sale'],
    target: 'screen',
    screenId,
    priority: 20,
    from: '12:00',
    to: '13:00',
  });

  await page.goto(`/screens/${screenId}`);
  await hydrated(page);
  // Take over this screen opens the takeover dialog aimed at it.
  await page.getByRole('button', { name: 'Take over this screen…' }).click();
  const takeover = page.getByRole('dialog', { name: 'Take over screens' });
  await expect(takeover.getByRole('combobox', { name: 'Plays on' })).toHaveText('Front window');
  await takeover.getByRole('button', { name: 'Cancel' }).click();
  // Focus goes back to what opened it.
  await expect(page.getByRole('button', { name: 'Take over this screen…' })).toBeFocused();

  await page.getByRole('button', { name: 'Play on this screen…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Schedule a playlist' });
  await expect(dialog.getByRole('combobox', { name: 'Plays on' })).toHaveText('Front window');
  await dialog.getByLabel('Playlist').selectOption({ label: 'Holiday promo' });
  // As drafted, Flash sale's noon wins too; after Save and publish, with screens' schedule, only Breakfast's morning does.
  const will = dialog.getByRole('region', { name: 'What this screen will play' });
  await expect(will.getByRole('status')).toHaveText([
    'This week, Front window: Plays Holiday promo all day, except 06:00–10:30 when Breakfast on Front wins (priority 10); 12:00–13:00 when Flash sale on this screen wins (priority 20).',
    'After Save and publish, as screens have the rest (other drafts stay drafts): Plays Holiday promo all day, except 06:00–10:30 when Breakfast on Front wins (priority 10).',
  ]);
  await expect(dialog.getByText('Save and publish sends Holiday promo, its spot Holiday and this entry: none has been published.')).toBeVisible();
  await axe(page);
  await shots(page, '57-play-on-this-screen');
  // The priority that wins where Save and publish is offered is the one over what screens have: above Breakfast, not Flash sale.
  await will.getByRole('button', { name: 'Raise priority above Breakfast' }).click();
  await expect(dialog.getByLabel('Priority')).toHaveValue('11');
  await expect(will.getByRole('status')).toHaveText([
    'This week, Front window: Plays Holiday promo all day, except 12:00–13:00 when Flash sale on this screen wins (priority 20).',
    'After Save and publish, as screens have the rest (other drafts stay drafts): Plays Holiday promo all day.',
  ]);
  await dialog.getByRole('button', { name: 'Save and publish' }).click();
  await expect(toastSays(/Published v\d+ to 1 screen/)).toBeVisible();
  await expect(dialog).toBeHidden();

  // Pinned: the entry, its playlist and its spot were published; the other draft was not.
  const { entries } = await tool(page, 'list_schedule_entries', {});
  const mine = entries.find((e: { playlistId: string }) => e.playlistId === holiday);
  expect(mine).toMatchObject({ target: 'screen', screenId, priority: 11, published: true, draftChanged: false });
  expect(entries.find((e: { id: string }) => e.id === flash.id)).toMatchObject({ published: false });
  // The screen's manifest has it: the test screen plays it, once the spot on screen ends.
  await expect.poll(playlistOn, { timeout: 90_000 }).toBe(holiday);

  // Scheduled here, on the screen's page.
  await page.reload();
  await hydrated(page);
  const here = page.getByRole('region', { name: 'Scheduled here' });
  await expect(here.getByRole('listitem').filter({ hasText: 'Holiday promo' })).toContainText('This screen · Always');
  await expect(here.getByRole('listitem').filter({ hasText: 'Holiday promo' })).toContainText('Published');
  await expect(here.getByRole('listitem').filter({ hasText: 'Breakfast' })).toContainText('Via group Front · Every day, 06:00–10:30');
  await expect(here.getByRole('listitem').filter({ hasText: 'Flash sale' })).toContainText('This screen · Every day, 12:00–13:00');
  await axe(page);
  await shots(page, '58-scheduled-here');

  // Where it plays, on the playlist's page: the screen, the entry, and Schedule on screens with the playlist chosen.
  await page.goto(`/playlists/${holiday}`);
  await hydrated(page);
  await expect(page.getByText('On 1 screen now')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Entries that play it' }).getByRole('listitem')).toHaveText([/^Front window · Always\s*Published$/]);
  await page.getByRole('button', { name: 'Schedule on screens…' }).click();
  await expect(page.getByRole('dialog', { name: 'Schedule a playlist' }).getByLabel('Playlist')).toHaveValue(holiday);
  await axe(page);
  await shots(page, '59-where-it-plays');
  await page.getByRole('dialog', { name: 'Schedule a playlist' }).getByRole('button', { name: 'Cancel' }).click();
});
