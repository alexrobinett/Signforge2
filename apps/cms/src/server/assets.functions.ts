/** The asset library's read: every asset with its usage count, through `list_assets` as the signed-in member. */
import { createServerFn } from '@tanstack/react-start';
import { all, inOrg } from './tools.server';

export const getAssets = createServerFn({ method: 'GET' }).handler(async () => ({
  assets: await inOrg(() => all('list_assets', (p) => p.assets), []),
}));
