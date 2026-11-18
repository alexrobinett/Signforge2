/**
 * The Screens pages' reads, through the tool registry as the signed-in member: the same tools an
 * agent calls (`list_screens`, `get_screen`, `list_groups`). Writes go from the browser to
 * `/api/tools/:name` (src/lib/tools.ts).
 */
import { createServerFn } from '@tanstack/react-start';
import type { GroupView, ScreenDetail, ScreenView } from '~/lib/screen-types';
import { callApi } from './api.server';

/**
 * The one way these loaders reach data: a tool, as the signed-in member. Switching to a client
 * cache later (docs/research/cms-data-layer.md) changes this and the loaders, not the pages.
 */
async function tool<T>(name: string, input: unknown): Promise<T>;
async function tool<T>(name: string, input: unknown, opts: { missing: 'null' }): Promise<T | null>;
async function tool<T>(name: string, input: unknown, opts?: { missing: 'null' }): Promise<T | null> {
  const res = await callApi(`/api/tools/${name}`, input);
  if (res.status === 404 && opts?.missing === 'null') return null;
  if (res.status === 403 && ((await res.clone().json()) as { error?: string }).error === 'no_active_organization') throw new NoActiveOrg();
  if (!res.ok) throw new Error(`${name} failed: ${res.status}`);
  return (await res.json()) as T;
}

/** The member has no active org yet: the app shell asks them to pick or create one instead of showing the page. */
class NoActiveOrg extends Error {}

/** A loader's result, or `empty` while there is no active org to read from. */
async function inOrg<T>(read: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof NoActiveOrg) return empty;
    throw err;
  }
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
  const [screens, groups] = await inOrg(() => Promise.all([all<ScreenView>('list_screens', 'screens'), all<GroupView>('list_groups', 'groups')]), [[], []]);
  return { screens, groups, at: Date.now() };
});

export const getScreen = createServerFn({ method: 'GET' })
  .validator((screenId: string) => screenId)
  .handler(async ({ data: screenId }) => {
    const [detail, groups] = await inOrg(
      () => Promise.all([tool<ScreenDetail>('get_screen', { screenId }, { missing: 'null' }), all<GroupView>('list_groups', 'groups')]),
      [null, []],
    );
    if (!detail) return null;
    return { ...detail, groups, at: Date.now() };
  });
