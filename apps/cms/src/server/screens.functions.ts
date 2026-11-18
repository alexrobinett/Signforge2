/**
 * The Screens pages' reads, through the tool registry as the signed-in member: the same tools an
 * agent calls (`list_screens`, `get_screen`, `list_groups`). Writes go from the browser to
 * `/api/tools/:name` (src/lib/tools.ts).
 */
import { createServerFn } from '@tanstack/react-start';
import type { GroupView, ScreenDetail, ScreenView } from '~/lib/screen-types';
import { callApi } from './api.server';

async function tool<T>(name: string, input: unknown): Promise<T> {
  const res = await callApi(`/api/tools/${name}`, input);
  if (!res.ok) throw new Error(`${name} failed: ${res.status}`);
  return (await res.json()) as T;
}

/** Every page of a list tool. */
async function all<T>(name: string, key: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await tool<Record<string, unknown> & { next: string | null }>(name, { limit: 200, ...(cursor ? { cursor } : {}) });
    out.push(...(page[key] as T[]));
    cursor = page.next ?? undefined;
  } while (cursor);
  return out;
}

export const getScreens = createServerFn({ method: 'GET' }).handler(async () => {
  const [screens, groups] = await Promise.all([all<ScreenView>('list_screens', 'screens'), all<GroupView>('list_groups', 'groups')]);
  return { screens, groups, at: Date.now() };
});

export const getScreen = createServerFn({ method: 'GET' })
  .validator((screenId: string) => screenId)
  .handler(async ({ data: screenId }) => {
    const res = await callApi('/api/tools/get_screen', { screenId });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`get_screen failed: ${res.status}`);
    const [detail, groups] = await Promise.all([res.json() as Promise<ScreenDetail>, all<GroupView>('list_groups', 'groups')]);
    return { ...detail, groups, at: Date.now() };
  });
