// A data source's address and settings need the right to publish (owner decision on #424): screens
// follow them with no publish. An editor where only owners publish sees a feed's Change URL and
// photos switch unavailable, with why, and the API refuses the change too; its name stays theirs.
// Light and dark, desktop and phone, with axe at each.
import { expect, test } from '@playwright/test';
import { axe, createOrg, hydrated, joinAsEditor, shots, signInAs, tool } from './helpers';

const ADDRESS = { owner: '192.0.2.242', editor: '192.0.2.243' };

test("an editor where only owners publish sees a feed's address and photos unavailable, with why, and the API refuses them (#424)", async ({
  page,
  browser,
}) => {
  await signInAs(page, `e2e-source-rights-${Date.now()}@example.com`, ADDRESS.owner);
  await createOrg(page, 'Quayside Bakery', ADDRESS.owner);
  const { dataSource } = await tool(page, 'create_data_source', {
    name: 'Bakery news',
    format: 'rss',
    feedUrl: 'https://news.example.com/bakery.xml',
    idempotencyKey: `source-rights-${Date.now()}`,
  });
  await tool(page, 'update_org_settings', { editorsPublish: false });

  const editor = await (await browser.newContext()).newPage();
  await joinAsEditor(page, editor, `e2e-source-rights-editor-${Date.now()}@example.com`, ADDRESS.editor);
  await editor.goto('/integrations');
  await hydrated(editor);
  await editor.getByRole('button', { name: 'Manage RSS / Atom' }).click();
  const feeds = editor.getByRole('dialog', { name: 'RSS / Atom feeds' });
  const why = 'Only owners publish in this organization, so only they change this source’s address or photos';
  await expect(feeds.getByText(why)).toBeVisible();
  const change = feeds.getByRole('button', { name: 'Change URL of Bakery news' });
  await expect(change).toBeDisabled();
  await expect(change).toHaveAccessibleDescription(new RegExp(why));
  await expect(feeds.getByRole('checkbox', { name: 'Show story photos' })).toBeDisabled();
  // Deleting a source no spot uses reaches no screen: still theirs.
  await expect(feeds.getByRole('button', { name: 'Delete Bakery news' })).toBeEnabled();
  await editor.setViewportSize({ width: 1440, height: 900 });
  await axe(editor);
  await shots(editor, '107-source-rights');
  await editor.setViewportSize({ width: 390, height: 844 });
  await axe(editor);
  await shots(editor, '107-source-rights-phone');

  // The API refuses it as well, and a name alone it allows.
  const refused = await editor.request.post('/api/tools/update_data_source', { data: { dataSourceId: dataSource.id, photos: false } });
  expect(refused.status()).toBe(403);
  expect(await refused.text()).toContain('needs the right to publish');
  await tool(editor, 'update_data_source', { dataSourceId: dataSource.id, name: 'Bakery blog' });
  await editor.context().close();
});
