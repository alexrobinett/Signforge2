/**
 * The Screens pages' reads, through the tool registry as the signed-in member: the same tools an
 * agent calls (`list_screens`, `get_screen`, `list_groups`). Writes go from the browser to
 * `/api/tools/:name` (src/lib/tools.ts).
 */
import { createServerFn } from '@tanstack/react-start';
import type { ScreenDetail } from '~/lib/screen-types';
import { all, inOrg, tool } from './tools.server';

export const getScreens = createServerFn({ method: 'GET' }).handler(async () => {
  const [screens, groups] = await inOrg(() => Promise.all([all('list_screens', (p) => p.screens), all('list_groups', (p) => p.groups)]), [[], []]);
  return { screens, groups, at: Date.now() };
});

export const getScreen = createServerFn({ method: 'GET' })
  .validator((screenId: string) => screenId)
  .handler(async ({ data: screenId }) => {
    const [detail, groups] = await inOrg(
      () => Promise.all([tool<ScreenDetail>('get_screen', { screenId }, { missing: 'null' }), all('list_groups', (p) => p.groups)]),
      [null, []],
    );
    if (!detail) return null;
    return { ...detail, groups, at: Date.now() };
  });
