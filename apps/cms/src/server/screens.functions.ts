/**
 * The Screens pages' reads, through the tool registry as the signed-in member: the same tools an
 * agent calls (`list_screens`, `list_screen_status`, `get_screen`, `list_groups`, `list_label_keys`). Writes go from
 * the browser to `/api/tools/:name` (src/lib/tools.ts).
 */
import { createServerFn } from '@tanstack/react-start';
import { all, inOrg, tool } from './tools.server';

export const getScreens = createServerFn({ method: 'GET' }).handler(async () => {
  const [screens, groups] = await inOrg(() => Promise.all([all('list_screens', (p) => p.screens), all('list_groups', (p) => p.groups)]), [[], []]);
  return { screens, groups, at: Date.now() };
});

/** The org's label keys, each with its values and how many screens have each: the label editors' suggestions (#185). */
export const getLabelKeys = createServerFn({ method: 'GET' }).handler(async () => ({ keys: await inOrg(() => all('list_label_keys', (p) => p.keys), []) }));

/** What each screen is doing, for the Screens page's poll: no settings or manifests, about three D1 rows a screen (packages/tools README, `list_screen_status`). */
export const getScreenStatus = createServerFn({ method: 'GET' }).handler(async () => {
  const screens = await inOrg(() => all('list_screen_status', (p) => p.screens), []);
  return { screens, at: Date.now() };
});

/** A JSON value: what Start's type check can prove a server function's answer serializes. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * A value read from the API's JSON, typed as JSON: an event's input is typed `unknown` by its
 * tool (whatever the tool was given), which Start's check cannot prove serializes.
 */
function json(v: unknown): Json {
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map(json);
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, json(x)]));
  // Nothing else comes out of JSON.parse; the return is for the type.
  return null;
}

export const getScreen = createServerFn({ method: 'GET' })
  .validator((screenId: string) => screenId)
  .handler(async ({ data: screenId }) => {
    const [detail, groups] = await inOrg(
      () => Promise.all([tool('get_screen', { screenId }, { missing: 'null' }), all('list_groups', (p) => p.groups)]),
      [null, []],
    );
    if (!detail) return null;
    const events = detail.events.map((e) => ({ ...e, input: Object.fromEntries(Object.entries(e.input).map(([k, x]) => [k, json(x)])) }));
    return { ...detail, events, groups, at: Date.now() };
  });
