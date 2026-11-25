import { expect, test, type Request, type Route } from '@playwright/test';
import { accountMenu, axe, createOrg, hydrated, screenshot, signInAs, tool } from './helpers';
import { API_PORT } from './servers';

/** This spec's own client address, for its own sign-in rate limit. */
const ADDRESS = '192.0.2.13';

test("the command menu, keyboard only: the page's own actions, each its page's dialog; pages and actions when typed; close", async ({ page, request }) => {
  // 34-39 s on CI at 3 workers (runs 45146239608, 45147142350, 45147984299), over half the 60 s default.
  test.setTimeout(90_000);
  await page.goto('/sign-in');
  await hydrated(page);
  await signInAs(page, `e2e-command-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Riverside Deli', ADDRESS);
  await hydrated(page);

  const menu = page.getByRole('dialog', { name: 'Command menu' });
  const search = menu.getByRole('combobox', { name: 'Search pages, screens and actions' });
  const toast = (text: string | RegExp) => page.locator('[data-sonner-toast]').filter({ hasText: text });
  /** The screens list's read (`getScreens`), which a test holds or fails by its route. */
  const listRead = (url: URL) => url.pathname.startsWith('/_serverFn/getScreens_');
  // An opening joins a list read already on its way (begun leaving Screens, say), so a test that routes the next read
  // first waits for those to finish, by their own events.
  const reading = new Set<Request>();
  page.on('request', (r) => void (listRead(new URL(r.url())) && reading.add(r)));
  page.on('requestfinished', (r) => void reading.delete(r));
  page.on('requestfailed', (r) => void reading.delete(r));
  const listReadsDone = () => expect.poll(() => reading.size).toBe(0);
  const forThisPage = menu.getByRole('group', { name: 'For this page' });

  // A new org has no screen: the Screens page is its own pairing form, so Pair a screen focuses its code there,
  // with no dialog to open, and leaves no pair in the URL (#358).
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search).toBeFocused();
  await page.keyboard.type('pair a screen');
  await expect(menu.getByRole('option', { selected: true })).toHaveText('Pair a screen…');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Character 1 of 6')).toBeFocused();
  await expect(page).toHaveURL(/\/screens$/);

  // A screen to pair, and one paired by a player's code, so the Screens page has its Pair dialog.
  const start = await request.post(`http://127.0.0.1:${API_PORT}/v1/device/pair/start`, { headers: { 'cf-connecting-ip': '192.0.2.14' } });
  const { code, pollToken } = (await start.json()) as { code: string; pollToken: string };
  await tool(page, 'claim_screen', { code, name: 'Deli counter', timezone: 'Europe/London', orientation: 'landscape' });

  // Opened on Screens: its own actions, then the questions for the agent; no page the sidebar lists, no tool by its API name (#358).
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Screens' }).click();
  await hydrated(page);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search).toBeFocused();
  await expect(forThisPage.getByRole('option')).toHaveText(['Pair a screen…', 'Take over screens now…']);
  await expect(menu.getByRole('group', { name: 'Go to' })).toHaveCount(0);
  await expect(menu.getByRole('option', { name: /_screen|list_|tool registry/ })).toHaveCount(0);
  await axe(page);
  await screenshot(page, '30-command-menu');
  await page.setViewportSize({ width: 390, height: 844 });
  await axe(page);
  await page.setViewportSize({ width: 1280, height: 720 });

  // Pair a screen opens the Screens page's own dialog, not a form of the tool's fields.
  await page.keyboard.press('Enter');
  const pair = page.getByRole('dialog', { name: 'Pair a screen' });
  await expect(pair.getByLabel('Name it')).toBeVisible();
  await expect(page).toHaveURL(/[?&]pair=true/);
  await page.keyboard.press('Escape');
  await expect(pair).toBeHidden();
  await expect(page).not.toHaveURL(/pair=/);

  // Typed on another page: every action the role allows, found by its words; New spot opens the Spots page's dialog.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Overview' }).click();
  await hydrated(page);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search).toBeFocused();
  await page.keyboard.type('new spot');
  await expect(menu.getByRole('option', { selected: true })).toHaveText('New spot…');
  await axe(page);
  await screenshot(page, '31-command-menu-typed');
  await page.keyboard.press('Enter');
  const newSpot = page.getByRole('dialog', { name: 'New spot' });
  await expect(newSpot).toBeVisible();
  await expect(page).toHaveURL(/\/spots$/);
  await page.keyboard.press('Escape');
  await expect(newSpot).toBeHidden();

  // With a change unpublished, every page offers Publish all, which asks with the sidebar's own question (#361).
  const { templates } = await tool(page, 'list_templates', { status: 'approved' });
  const clock = templates.find((t: { key: string }) => t.key === 'clock' || t.key.endsWith('/clock')).versions.at(-1).id;
  await tool(page, 'create_spot', { name: 'Lobby clock', kind: 'template', templateVersionId: clock });
  await page.reload();
  await hydrated(page);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(forThisPage.getByRole('option')).toHaveText(['New spot…', 'Publish all changes…']);
  await page.keyboard.type('publish all');
  await expect(menu.getByRole('option', { selected: true })).toHaveText('Publish all changes…');
  await page.keyboard.press('Enter');
  const publishAll = page.getByRole('alertdialog');
  await expect(publishAll).toContainText('Publish 1 unpublished change?');
  await publishAll.getByRole('button', { name: 'Cancel' }).click();
  await expect(publishAll).toBeHidden();

  // The count read again on opening fails: Publish all is not offered from the count read before, which said 1.
  // The sidebar read it already and reads again only each minute, so the reads refused here are the menu's: its read and its retry.
  let refused = 0;
  const countsRead = (url: URL) => url.pathname.startsWith('/_serverFn/getNavCounts');
  await page.route(countsRead, (route) => {
    refused += 1;
    return route.abort('connectionrefused');
  });
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search).toBeFocused();
  await expect.poll(() => refused).toBeGreaterThanOrEqual(2);
  await expect(menu.getByRole('option', { name: 'Publish all changes…' })).toHaveCount(0);
  await page.keyboard.type('publish all');
  await expect(menu.getByRole('option', { name: 'Publish all changes…' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.unroute(countsRead);

  // Nor while this opening's read is on its way, though the count cached before says 1 and was written at the
  // same instant as the opening (the clock fixed): only this opening's own read, come back, offers it.
  await page.clock.setFixedTime(new Date());
  await page.keyboard.press('ControlOrMeta+k');
  await expect(menu.getByRole('option', { name: 'Publish all changes…' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  const held: Route[] = [];
  await page.route(countsRead, (route) => void held.push(route));
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search).toBeFocused();
  await expect.poll(() => held.length).toBe(1);
  await expect(menu.getByRole('option', { name: 'Publish all changes…' })).toHaveCount(0);
  await held[0]!.continue();
  await page.unroute(countsRead);
  await expect(menu.getByRole('option', { name: 'Publish all changes…' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Escape closes it; Ctrl+K again, a page by name, Enter goes there.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('go to screens');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/screens$/);
  await expect(page.getByRole('link', { name: 'Deli counter' })).toBeVisible();
  await expect(menu).toBeHidden();

  // Ctrl+K toggles it closed too.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search).toBeFocused();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(menu).toBeHidden();

  // Typing part of a screen's name finds it (#180); Enter shows its actions, Open first. Each Enter waits for focus and
  // for the option it means to be selected: cmdk moves the selection in a step of its own after each keystroke.
  const { screens } = await tool(page, 'list_screens', {});
  const deli = screens.find((s: { name: string }) => s.name === 'Deli counter').id;
  const { group } = await tool(page, 'create_group', { name: 'Front of house', screenIds: [deli] });
  const actions = menu.getByRole('option');
  const selected = menu.getByRole('option', { selected: true });
  const actionsSearch = menu.getByRole('combobox', { name: 'Actions for Deli counter' });
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search).toBeFocused();
  await page.keyboard.type('deli');
  await expect(selected).toContainText('Deli counter');
  await expect(menu.getByRole('option', { name: /Front of house/ })).toHaveCount(0);
  await axe(page);
  await screenshot(page, '32-command-menu-screen');
  await page.keyboard.press('Enter');
  await expect(actionsSearch).toBeFocused();
  // Paired and not heard from yet: no restart could reach it, so it offers none, and says why (#253).
  await expect(actions).toHaveText(['Open', 'Play a playlist here…', 'Take over…', 'Identify (10 s)']);
  await expect(menu.getByRole('status')).toHaveText('Restart is off: Deli counter cannot be reached now, and a restart only reaches a screen in touch.');
  await axe(page);
  await screenshot(page, '33-command-menu-screen-actions');
  await page.keyboard.type('identify');
  await expect(selected).toHaveText('Identify (10 s)');
  await page.keyboard.press('Enter');
  await expect(toast('Identify (10 s): Deli counter')).toBeVisible();
  await expect(menu).toBeHidden();

  // Play a playlist here… and Take over… open the schedule's dialogs aimed at the screen (#181).
  for (const [action, title] of [
    ['Play a playlist here…', 'Schedule a playlist'],
    ['Take over…', 'Take over screens'],
  ] as const) {
    await page.keyboard.press('ControlOrMeta+k');
    await expect(search).toBeFocused();
    await page.keyboard.type('deli');
    await expect(selected).toContainText('Deli counter');
    await page.keyboard.press('Enter');
    await expect(actionsSearch).toBeFocused();
    await page.keyboard.type(action.slice(0, 6));
    await expect(selected).toHaveText(action);
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: title });
    await expect(dialog.getByRole('combobox', { name: 'Plays on' })).toHaveText('Deli counter');
    await expect(menu).toBeHidden();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    // ⌘K closed as it opened: focus goes to the page's main region, not nowhere.
    await expect(page.locator('#main')).toBeFocused();
  }

  // The takeover tool opens the same dialog, which sends it at once: ⌘K never calls a takeover a draft (#253).
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search).toBeFocused();
  await page.keyboard.type('take over screens now');
  await expect(selected).toContainText('Take over screens now…');
  await page.keyboard.press('Enter');
  const takeover = page.getByRole('dialog', { name: 'Take over screens' });
  await expect(takeover.getByText(/^Sent now:/)).toBeVisible();
  await takeover.getByRole('button', { name: 'Cancel' }).click();
  await expect(takeover).toBeHidden();
  // Its focus goes back a task after it closes: a ⌘K before that has the next keys typed into the page (#310).
  await expect(page.locator('#main')).toBeFocused();

  // Enter on Back goes back, to what was found, and does not run the selected action; Open goes to the screen's page.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search).toBeFocused();
  await page.keyboard.type('counter');
  await expect(selected).toContainText('Deli counter');
  await page.keyboard.press('Enter');
  await expect(actionsSearch).toBeFocused();
  await expect(selected).toHaveText('Open');
  await menu.getByRole('button', { name: 'Back to commands' }).focus();
  await page.keyboard.press('Enter');
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('counter');
  await expect(page).not.toHaveURL(new RegExp(`/screens/${deli}$`));
  await expect(selected).toContainText('Deli counter');
  await page.keyboard.press('Enter');
  await expect(actionsSearch).toBeFocused();
  await expect(selected).toHaveText('Open');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/screens/${deli}$`));
  await expect(page.getByRole('heading', { name: 'Deli counter', level: 1 })).toBeVisible();

  // A group by its name, or a screen by its group's: the group's action shows its screens on the Screens page.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search).toBeFocused();
  await page.keyboard.type('house');
  await expect(menu.getByRole('option', { name: /Deli counter/ })).toBeVisible();
  await menu.getByRole('option', { name: /Front of house/ }).click();
  await expect(actions).toHaveText(['Show its screens']);
  await expect(selected).toHaveText('Show its screens');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/screens\\?group=${group.id}$`));
  await expect(page.getByLabel('Group', { exact: true })).toHaveValue(group.id);
  await expect(menu).toBeHidden();

  // The list's read failing, with no retry left: a cached screen's commands are off, and the list and the screen
  // say so and how to try again. Off Screens, whose poll reads the list; in the app, as a page load empties the cache.
  const listStatus = menu.getByRole('status');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Playlists' }).click();
  await expect(page).toHaveURL(/\/playlists$/);
  await listReadsDone();
  await page.route(listRead, (route) => route.abort());
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search).toBeFocused();
  await page.keyboard.type('deli');
  await expect(listStatus).toHaveText(
    'Couldn’t check the screens: they are as last read, and Identify and Restart are off. Close ⌘K and open it again to retry.',
  );
  await expect(selected).toContainText('Deli counter');
  await page.keyboard.press('Enter');
  await expect(actionsSearch).toBeFocused();
  await expect(listStatus).toHaveText('Couldn’t check Deli counter, so Identify and Restart are off. Close ⌘K and open it again to retry.');
  await expect(actions).toHaveText(['Open', 'Play a playlist here…', 'Take over…']);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await page.unroute(listRead);

  // A screen revoked since the menu last read the list: while this opening's read is held, the cached screen is only
  // opened, and a name the cache lacks is being looked for.
  await request.post(`http://127.0.0.1:${API_PORT}/v1/device/pair/poll`, { data: { pollToken }, headers: { 'cf-connecting-ip': '192.0.2.14' } });
  const { credentials } = await tool(page, 'get_screen', { screenId: deli });
  await tool(page, 'revoke_screen_credential', { screenId: deli, credentialId: credentials[0].id });
  await tool(page, 'create_group', { name: 'Kiosk 9' });
  // The server refuses a command to a revoked screen too.
  expect((await page.request.post('/api/tools/identify_screen', { data: { screenId: deli } })).status()).toBe(409);
  /** Holds the list's reads until `release`. */
  const holdListRead = async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(listRead, async (route) => {
      await held;
      await route.continue();
    });
    return release;
  };
  await listReadsDone();
  let release = await holdListRead();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search).toBeFocused();
  await page.keyboard.type('kiosk 9');
  await expect(menu.getByText('Looking for screens…')).toBeVisible();
  await search.fill('deli');
  await expect(selected).toContainText('Deli counter');
  await page.keyboard.press('Enter');
  await expect(actionsSearch).toBeFocused();
  await expect(listStatus).toHaveText('Checking Deli counter before Identify and Restart…');
  await expect(actions).toHaveText(['Open', 'Play a playlist here…', 'Take over…']);
  release();
  await expect(listStatus).toHaveText('');
  await expect(menu.getByRole('heading', { name: 'Deli counter' })).toBeVisible();
  await expect(actions).toHaveText(['Open']);
  await page.unroute(listRead);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // After a page load the cache is empty: typed before the list lands, the screen it finds is selected once it does,
  // over the tool cmdk selected meanwhile, so Enter opens the screen.
  await page.reload();
  await hydrated(page);
  release = await holdListRead();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search).toBeFocused();
  await page.keyboard.type('deli');
  await expect(listStatus).toHaveText('Looking for screens…');
  // Neither is the member choosing: a pointer over the search or the status line selects nothing, and cmdk ignores PageDown.
  const centre = async (target: ReturnType<typeof menu.getByRole>) => {
    const box = (await target.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  };
  await centre(search);
  await centre(listStatus);
  await page.keyboard.press('PageDown');
  release();
  await expect(selected).toContainText('Deli counter');
  await page.keyboard.press('Enter');
  await expect(actionsSearch).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await page.unroute(listRead);

  // An empty cache and a read that fails: the list says no screens could be read, and how to try again.
  await page.route(listRead, (route) => route.abort());
  await page.reload();
  await hydrated(page);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search).toBeFocused();
  await page.keyboard.type('deli');
  await expect(listStatus).toHaveText('Couldn’t read the screens, so none are listed. Close ⌘K and open it again to retry.');
  await expect(menu.getByRole('option', { name: /Deli counter/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.unroute(listRead);
});

test('the command menu tells a screen reader the row that is selected, after each key that moves or filters (#209)', async ({ page }) => {
  await page.goto('/sign-in');
  await hydrated(page);
  await signInAs(page, `e2e-command-pointer-${Date.now()}@example.com`, '192.0.2.19');
  await createOrg(page, 'Lantern Lane Pointer', '192.0.2.19');

  const menu = page.getByRole('dialog', { name: 'Command menu' });
  const search = menu.getByRole('combobox', { name: 'Search pages, screens and actions' });
  const selected = menu.getByRole('option', { selected: true });
  /** The row the search's `aria-activedescendant` names, as "<selected>:<disabled>:<text>", or why there is none. */
  const pointedAt = () =>
    search.evaluate((input) => {
      const id = input.getAttribute('aria-activedescendant');
      const row = id ? document.getElementById(id) : null;
      if (!row) return `no row for ${id}`;
      return `${row.getAttribute('aria-selected')}:${row.getAttribute('aria-disabled')}:${row.textContent}`;
    });
  /** The pointer names the selected row, rendered and enabled: what Enter would run. */
  const pointsAtSelected = async (text: string) => {
    await expect(selected).toHaveText(text);
    await expect.poll(pointedAt).toBe(`true:false:${text}`);
  };

  await page.keyboard.press('ControlOrMeta+k');
  await expect(search).toBeFocused();
  // Empty, the page's questions for the agent come first (#270, #358).
  await pointsAtSelected('Which screens need me, and why?');
  // Moved by key onto a row, then typing filters that row out: the pointer follows the selection to a row still listed.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await pointsAtSelected('What is on screen now?');
  await page.keyboard.type('go to playl');
  await pointsAtSelected('Go to Playlists');
  await axe(page);
  // Cleared, the first row is selected again, and named.
  await search.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await pointsAtSelected('Which screens need me, and why?');
  await page.keyboard.press('End');
  await page.keyboard.type('go to spots');
  await pointsAtSelected('Go to Spots');
  await axe(page);
});

test('closing it gives focus back to what had it, while that is shown; else to the main region (#358)', async ({ page }) => {
  await page.goto('/sign-in');
  await hydrated(page);
  await signInAs(page, `e2e-command-focus-${Date.now()}@example.com`, '192.0.2.20');
  await createOrg(page, 'Lantern Lane Focus', '192.0.2.20');
  await hydrated(page);
  const menu = page.getByRole('dialog', { name: 'Command menu' });
  const search = menu.getByRole('combobox', { name: 'Search pages, screens and actions' });

  // The account button, its menu closed (`data-state="closed"`): focus goes back to it.
  await accountMenu(page).focus();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(accountMenu(page)).toBeFocused();

  // Hidden while the menu was open (the sidebar, at a phone's width): to the main region, not the page's body.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(page.locator('#main')).toBeFocused();
});
