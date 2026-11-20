/**
 * The Schedule page's read, through the tool registry as the signed-in member
 * (`list_schedule_entries`). The query key and options over it are in src/queries/schedule.ts.
 */
import { createServerFn } from '@tanstack/react-start';
import { all, inOrg } from './tools.server';

export const getSchedule = createServerFn({ method: 'GET' }).handler(async () => ({
  entries: await inOrg(() => all('list_schedule_entries', (p) => p.entries), []),
}));
