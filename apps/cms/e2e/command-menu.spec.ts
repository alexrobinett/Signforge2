import { expect, test, type Request } from '@playwright/test';
import { axe, createOrg, hydrated, screenshot, signInAs, tool } from './helpers';
import { API_PORT } from './servers';

/** This spec's own client address, for its own sign-in rate limit. */
const ADDRESS = '192.0.2.13';

test('the command menu, keyboard only: open, filter, run a tool with and without a form, see a refusal, go to a page, close', async ({ page, request }) => {
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

  // Open with Ctrl+K: focus is in the search, every tool an owner may use is listed.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search).toBeFocused();
  await expect(menu.getByRole('option', { name: /claim_screen/ })).toBeVisible();
  await expect(menu.getByRole('option', { name: /revoke_screen_credential/ })).toHaveCount(1);
  await axe(page);
  await screenshot(page, '30-command-menu');

  // Filter to a tool that needs input, run it from its form: pair a screen a player started.
  const start = await request.post(`http://127.0.0.1:${API_PORT}/v1/device/pair/start`, { headers: { 'cf-connecting-ip': '192.0.2.14' } });
  const { code, pollToken } = (await start.json()) as { code: string; pollToken: string };
  await page.keyboard.type('pair a screen');
  await expect(menu.getByRole('option', { selected: true })).toContainText('Pair a screen');
  await page.keyboard.press('Enter');
  await expect(menu.getByLabel('code')).toBeFocused();
  await page.keyboard.type(code);
  await page.keyboard.press('Tab');
  await page.keyboard.type('Deli counter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Europe/London');
  await axe(page);
  await screenshot(page, '31-command-form');
  await page.keyboard.press('Enter');
  await expect(toast('Deli counter')).toBeVisible();
  await expect(menu).toBeHidden();

  // A tool that needs no input runs at once.
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('list_screens');
  await page.keyboard.press('Enter');
  await expect(toast('1 screens')).toBeVisible();

  // A refusal is a toast with the tool's own message, and the form stays open to fix.
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('rename_screen');
  await page.keyboard.press('Enter');
  await page.keyboard.type('scr_missing');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Nowhere');
  await page.keyboard.press('Enter');
  await expect(toast(/not found/)).toBeVisible();
  await expect(menu.getByLabel('name')).toBeVisible();

  // A field the menu cannot read is refused before anything is sent: focus leaves Run for that
  // field, which reads out the error as its description.
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('pair a screen');
  await page.keyboard.press('Enter');
  await expect(menu.getByLabel('code')).toBeFocused();
  await page.keyboard.type('ABC234');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Back office');
  await page.keyboard.press('Tab');
  await page.keyboard.type('UTC');
  const hours = menu.getByLabel('displayHours');
  await hours.fill('{"mon": [');
  const run = menu.getByRole('button', { name: 'Run' });
  await run.focus();
  await page.keyboard.press('Enter');
  await expect(hours).toBeFocused();
  await expect(hours).toHaveAttribute('aria-invalid', 'true');
  await expect(hours).toHaveAccessibleDescription(/must be JSON/);
  // Refused again after a move back to Run: focus returns to the field.
  await run.focus();
  await page.keyboard.press('Enter');
  await expect(hours).toBeFocused();

  // Escape closes it; Ctrl+K again, a page by name, Enter goes there.
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
  // Neither is the member choosing: a pointer over the search or the footer selects nothing, and cmdk ignores PageDown.
  const centre = async (target: ReturnType<typeof menu.getByText>) => {
    const box = (await target.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  };
  await centre(search);
  await centre(menu.getByText(/These actions are the tool registry/));
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
  await pointsAtSelected('Go to Overview');
  // Moved by key onto a row, then typing filters that row out: the pointer follows the selection to a row still listed.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await pointsAtSelected('Go to Spots');
  await page.keyboard.type('playl');
  await pointsAtSelected('Go to Playlists');
  await axe(page);
  // Cleared, the first row is selected again, and named.
  await search.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await pointsAtSelected('Go to Overview');
  await page.keyboard.press('End');
  await page.keyboard.type('spots');
  await pointsAtSelected('Go to Spots');
  await axe(page);
});
