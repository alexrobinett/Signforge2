// A schedule entry as the Schedule page reads it: every screen, all day every day, a draft, unless `over` says otherwise.
import type { ScheduleEntryView } from '../src/lib/schedule';

export const scheduleEntry = (id: string, over: Partial<ScheduleEntryView> = {}): ScheduleEntryView => ({
  id,
  playlistId: 'pls_main',
  target: 'org',
  groupId: null,
  screenId: null,
  priority: 0,
  startDate: null,
  endDate: null,
  days: null,
  from: null,
  to: null,
  startsAt: null,
  endsAt: null,
  takeover: false,
  deleted: false,
  live: null,
  version: 1,
  published: false,
  draftChanged: true,
  publishedAt: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});
