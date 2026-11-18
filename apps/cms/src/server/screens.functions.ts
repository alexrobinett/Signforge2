/**
 * The Screens pages' reads, through the tool registry as the signed-in member: the same tools an
 * agent calls (`list_screens`, `list_screen_status`, `get_screen`, `list_groups`). Writes go from
 * the browser to `/api/tools/:name` (src/lib/tools.ts).
 */
import { createServerFn } from '@tanstack/react-start';
import type { ScreenDetail, ScreenStatus } from '~/lib/screen-types';
import { all, inOrg, tool } from './tools.server';

export const getScreens = createServerFn({ method: 'GET' }).handler(async () => {
  const [screens, groups] = await inOrg(() => Promise.all([all('list_screens', (p) => p.screens), all('list_groups', (p) => p.groups)]), [[], []]);
  return { screens, groups, at: Date.now() };
});

/** What each screen is doing, for the Screens page's poll: no settings or manifests, about three D1 rows a screen (packages/tools README, `list_screen_status`). */
export const getScreenStatus = createServerFn({ method: 'GET' }).handler(async () => {
  const screens = await inOrg(() => all('list_screen_status', (p: { screens: ScreenStatus[]; next: string | null }) => p.screens), []);
  return { screens, at: Date.now() };
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
