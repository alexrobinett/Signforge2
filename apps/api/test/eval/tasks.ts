/**
 * The agent eval's fixed tasks (#345, README.md): reads across the types, the common writes, publishing, a
 * confirmation card, refusals and multi-step work, on the org `seed` makes (harness.ts). Each check reads
 * the org after the run, or what the tools gave the model, never the model's own words. Each script is the
 * calls a model that knows the tools makes: the scripted model's, and so the fewest calls a task takes.
 */
import type { Outcome, Step, Task, World } from './harness';

const WEEKDAYS = [1, 2, 3, 4, 5];

/** The same script in both arms. */
const both = (script: (w: World) => Step[]) => ({ mcp: script, drawer: script });

/** A successful tool result as JSON: the drawer's comes fenced as data, and one cut short reads as nothing. */
function parsed(text: string): unknown {
  const fenced = /^<data>\n([\s\S]*)\n<\/data>$/.exec(text);
  try {
    return JSON.parse(fenced ? (fenced[1] ?? '').replace(/&lt;(\s*\/?\s*data)/gi, '<$1') : text);
  } catch {
    return undefined;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every object in `v`, however deep. */
const objectsIn = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.flatMap(objectsIn) : isObject(v) ? [v, ...Object.values(v).flatMap(objectsIn)] : [];

/** What the model read about each record, by id: the fields of every successful result that showed it, merged. */
function records(o: Outcome): Map<string, Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const r of o.results) if (r.ok) for (const x of objectsIn(parsed(r.text))) if (typeof x.id === 'string') byId.set(x.id, { ...byId.get(x.id), ...x });
  return byId;
}

/**
 * A read passed when what the model read, across all its results, shows each record `wanted` names with the fields it
 * asks for: a value to match, or `true` for any value.
 */
const read =
  (wanted: (w: World) => Record<string, Record<string, unknown>>) =>
  (o: Outcome): string | undefined => {
    const seen = records(o);
    for (const [id, fields] of Object.entries(wanted(o.world))) {
      const got = seen.get(id);
      for (const [field, value] of Object.entries(fields))
        if (got === undefined || !(field in got) || (value !== true && !same(got[field], value)))
          return `the tools never showed ${id}'s ${field}${value === true ? '' : ` as ${JSON.stringify(value)}`}`;
    }
    return undefined;
  };

const draftOf = (o: Outcome, tool: string, id?: string) => o.drafts.find((d) => d.tool === tool && (id === undefined || d.target?.id === id));

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether `entries`, a schedule entry's fields as the drafting tool takes them, play `playlistId` on `groupId` from
 * 07:00 to 10:00 on exactly the five weekdays, together: every entry in that window counts, with no end date and none
 * starting after `today`, and the union of their days must be Monday to Friday, no more and no less. An entry with no
 * days plays every day.
 */
function weekdayMornings(entries: readonly Record<string, unknown>[], playlistId: string, groupId: string, today: string) {
  const mine = entries.filter((e) => e.playlistId === playlistId && e.target === 'group' && e.groupId === groupId && e.from === '07:00' && e.to === '10:00');
  if (!mine.length) return false;
  if (mine.some((e) => (e.endDate ?? null) !== null || (typeof e.startDate === 'string' && e.startDate > today))) return false;
  const days = new Set(mine.flatMap((e) => (Array.isArray(e.days) ? e.days : [0, 1, 2, 3, 4, 5, 6])));
  return days.size === WEEKDAYS.length && WEEKDAYS.every((d) => days.has(d));
}

/** The org's schedule for `playlistId` on `groupId` on weekday mornings, read from D1. */
async function scheduled(o: Outcome, playlistId: string, groupId: string) {
  const entries = (await o.scope.scheduleEntries.list()).map((e) => ({
    playlistId: e.playlistId,
    target: e.target,
    groupId: e.groupId,
    days: e.daysJson === null ? null : JSON.parse(e.daysJson),
    from: e.fromTime,
    to: e.toTime,
    startDate: e.startDate,
    endDate: e.endDate,
  }));
  return weekdayMornings(entries, playlistId, groupId, o.today)
    ? undefined
    : `the schedule does not play ${playlistId} on ${groupId} on exactly the weekdays 07:00-10:00, open-ended`;
}

/** A schedule entry playing Breakfast on the Cafe group on `days`, 07:00 to 10:00. */
const breakfastOnCafe = (w: World, days: number[]) => ({
  name: 'save_schedule_entry',
  input: { playlistId: w.playlists.breakfast, target: 'group', groupId: w.groups.cafe, days, from: '07:00', to: '10:00' },
});

/** The org's playlist named `name`, and the spots it plays. */
async function playlistNamed(o: Outcome, name: string) {
  const row = (await o.scope.playlists.list()).find((p) => p.name === name);
  return row ? { row, spotIds: await o.scope.playlists.items(row.id) } : undefined;
}

/** What a spot's published version holds. */
async function publishedOf(o: Outcome, spotId: string): Promise<{ durationMs?: number } | undefined> {
  const json = (await o.scope.spots.get(spotId))?.publishedJson;
  return json ? JSON.parse(json) : undefined;
}

export const TASKS: Task[] = [
  // ------------------------------------------------------------------ reads
  {
    id: 'read-screens',
    prompt: 'What screens do we have?',
    role: 'viewer',
    script: both(() => [[{ name: 'read', input: { type: 'screen' } }]]),
    check: read((w) => ({
      [w.screens.baysideDoor]: { name: 'Bayside door' },
      [w.screens.baysideTill]: { name: 'Bayside till' },
      [w.screens.harbor]: { name: 'Harbor lobby' },
      [w.screens.cafe]: { name: 'Cafe counter' },
    })),
  },
  {
    id: 'read-screen-timezone',
    prompt: 'What time zone is the Harbor lobby screen set to?',
    role: 'viewer',
    script: both(() => [[{ name: 'read', input: { type: 'screen' } }]]),
    variants: [
      {
        name: 'each screen by get_screen, called by name (#345: still answers)',
        arm: 'mcp',
        passes: true,
        script: (w) => [[{ name: 'get_screen', input: { screenId: w.screens.cafe } }], [{ name: 'get_screen', input: { screenId: w.screens.harbor } }]],
      },
    ],
    check: read((w) => ({ [w.screens.harbor]: { name: 'Harbor lobby', timezone: 'Europe/London' } })),
  },
  {
    id: 'read-screen-status',
    prompt: 'Which of our screens are offline right now?',
    role: 'viewer',
    // Every screen's name and state: list_screens has both; list_screen_status has states alone.
    script: both(() => [[{ name: 'read', input: { type: 'screen' } }]]),
    variants: [
      {
        name: 'each screen by read with ids, in separate responses',
        arm: 'mcp',
        passes: true,
        script: (w) => Object.values(w.screens).map((id) => [{ name: 'read', input: { type: 'screen', ids: [id] } }]),
      },
      {
        name: 'states, then names, in separate responses',
        arm: 'drawer',
        passes: true,
        script: () => [[{ name: 'read', input: { type: 'screen_status' } }], [{ name: 'read', input: { type: 'screen' } }]],
      },
      { name: 'states without names', arm: 'mcp', passes: false, script: () => [[{ name: 'read', input: { type: 'screen_status' } }]] },
      {
        name: 'two of the four screens',
        arm: 'mcp',
        passes: false,
        script: (w) => [
          [{ name: 'read', input: { type: 'screen', ids: [w.screens.baysideDoor] } }],
          [{ name: 'read', input: { type: 'screen', ids: [w.screens.baysideTill] } }],
        ],
      },
    ],
    check: read((w) => Object.fromEntries(Object.values(w.screens).map((id) => [id, { name: true, state: true }]))),
  },
  {
    id: 'read-default-playlist',
    prompt: 'Which playlist plays on our screens when nothing is scheduled?',
    role: 'viewer',
    script: both(() => [[{ name: 'read', input: { type: 'playlist', filter: { isDefault: true } } }]]),
    check: read((w) => ({ [w.playlists.lobby]: { name: 'Lobby loop', isDefault: true } })),
  },
  {
    id: 'read-playlist-spots',
    prompt: 'Which spots does the Lobby loop playlist play, in order?',
    role: 'viewer',
    // Its play order, and the names of the spots in it: a playlist lists its spots by id.
    script: both(() => [[{ name: 'read', input: { type: 'playlist' } }], [{ name: 'read', input: { type: 'spot' } }]]),
    variants: [{ name: 'the play order without the spots’ names', arm: 'mcp', passes: false, script: () => [[{ name: 'read', input: { type: 'playlist' } }]] }],
    check: read((w) => ({
      [w.playlists.lobby]: { name: 'Lobby loop', spotIds: [w.spots.breakfast, w.spots.weather] },
      [w.spots.breakfast]: { name: 'Breakfast menu' },
      [w.spots.weather]: { name: 'Weather' },
    })),
  },
  {
    id: 'read-menu-template',
    prompt: 'Which template should I use to put a menu on a screen?',
    role: 'editor',
    script: both(() => [[{ name: 'read', input: { type: 'template' } }]]),
    check: read((w) => ({ [w.templates.menu]: { name: true } })),
  },
  {
    id: 'read-unpublished',
    prompt: 'What changes have not been published yet?',
    role: 'editor',
    script: both(() => [[{ name: 'read', input: { type: 'spot', filter: { unpublished: true } } }]]),
    variants: [{ name: 'a count of drafts, naming none', arm: 'drawer', passes: false, script: () => [[{ name: 'read', input: { type: 'draft_count' } }]] }],
    check: read((w) => ({ [w.spots.lunch]: { name: 'Lunch specials', draftChanged: true } })),
  },
  {
    id: 'read-audit',
    prompt: 'Who last changed the Lunch specials spot, and what did they change?',
    role: 'owner',
    script: both((w) => [[{ name: 'read', input: { type: 'audit_entry', filter: { target: { kind: 'spot', id: w.spots.lunch } } } }]]),
    check(o) {
      const entries = o.results.flatMap((r) => (r.ok ? objectsIn(parsed(r.text)) : []));
      const hit = entries.some(
        (e) => e.action === 'save_spot' && same(e.target, { kind: 'spot', id: o.world.spots.lunch }) && isObject(e.actor) && typeof e.actor.id === 'string',
      );
      return hit ? undefined : "the tools never showed who made Lunch specials' save_spot";
    },
  },
  {
    id: 'read-schedule',
    prompt: 'What is scheduled on the Bayside screens?',
    role: 'viewer',
    script: both(() => [[{ name: 'read', input: { type: 'schedule_entry' } }]]),
    check: read((w) => ({ [w.entry]: { playlistId: w.playlists.breakfast, groupId: w.groups.bayside, days: true, from: true, to: true } })),
  },

  // ------------------------------------------------------------------ writes
  {
    id: 'write-rename-screen',
    prompt: 'Rename the Harbor lobby screen to "Harbor entrance".',
    role: 'owner',
    script: both((w) => [
      [{ name: 'read', input: { type: 'screen' } }],
      [{ name: 'update_screen', input: { screenId: w.screens.harbor, name: 'Harbor entrance' } }],
    ]),
    async check(o) {
      if (o.arm === 'drawer')
        return draftOf(o, 'update_screen', o.world.screens.harbor)?.input.name === 'Harbor entrance' ? undefined : 'no draft renaming Harbor lobby';
      const name = (await o.scope.screens.get(o.world.screens.harbor))?.name;
      return name === 'Harbor entrance' ? undefined : `Harbor lobby is named ${name}`;
    },
  },
  {
    id: 'write-spot-duration',
    prompt: 'Make the Weather spot show for 15 seconds.',
    role: 'editor',
    script: both((w) => [[{ name: 'read', input: { type: 'spot' } }], [{ name: 'save_spot', input: { spotId: w.spots.weather, durationMs: 15_000 } }]]),
    async check(o) {
      if (o.arm === 'drawer') return draftOf(o, 'save_spot', o.world.spots.weather)?.input.durationMs === 15_000 ? undefined : 'no draft of Weather at 15 s';
      const ms = (await o.scope.spots.get(o.world.spots.weather))?.durationMs;
      return ms === 15_000 ? undefined : `Weather lasts ${ms} ms`;
    },
  },
  {
    id: 'write-create-spot',
    prompt: 'Create a web page spot called "Store hours" that shows https://example.com/hours for 10 seconds.',
    role: 'editor',
    script: { mcp: () => [[{ name: 'save_spot', input: { name: 'Store hours', kind: 'url', url: 'https://example.com/hours', durationMs: 10_000 } }]] },
    async check(o) {
      const spot = (await o.scope.spots.list()).find((s) => s.name === 'Store hours');
      if (!spot) return 'no spot named Store hours';
      return spot.kind === 'url' && spot.url === 'https://example.com/hours' && spot.durationMs === 10_000
        ? undefined
        : `Store hours is ${JSON.stringify(spot)}`;
    },
  },
  {
    id: 'write-playlist-append',
    prompt: 'Add the Weather spot to the end of the Breakfast playlist.',
    role: 'editor',
    script: both((w) => [
      [{ name: 'read', input: { type: 'playlist' } }],
      [{ name: 'save_playlist', input: { playlistId: w.playlists.breakfast, spotIds: [w.spots.breakfast, w.spots.weather] } }],
    ]),
    async check(o) {
      const want = [o.world.spots.breakfast, o.world.spots.weather];
      if (o.arm === 'drawer')
        return same(draftOf(o, 'save_playlist', o.world.playlists.breakfast)?.input.spotIds, want) ? undefined : 'no draft of Breakfast ending with Weather';
      const got = await o.scope.playlists.items(o.world.playlists.breakfast);
      return same(got, want) ? undefined : `Breakfast plays ${got.join(', ')}`;
    },
  },
  {
    id: 'write-create-playlist',
    prompt: 'Create a playlist called "Lunch" that plays Lunch specials, then Weather.',
    role: 'editor',
    script: {
      mcp: (w) => [
        [{ name: 'read', input: { type: 'spot' } }],
        [{ name: 'save_playlist', input: { name: 'Lunch', spotIds: [w.spots.lunch, w.spots.weather] } }],
      ],
    },
    async check(o) {
      const made = await playlistNamed(o, 'Lunch');
      return same(made?.spotIds, [o.world.spots.lunch, o.world.spots.weather]) ? undefined : `Lunch is ${JSON.stringify(made?.spotIds)}`;
    },
  },
  {
    id: 'write-schedule',
    prompt: 'Schedule the Breakfast playlist on the Cafe group on weekdays from 07:00 to 10:00.',
    role: 'editor',
    script: both((w) => [
      [
        { name: 'read', input: { type: 'playlist' } },
        { name: 'read', input: { type: 'group' } },
      ],
      [
        {
          name: 'save_schedule_entry',
          input: { playlistId: w.playlists.breakfast, target: 'group', groupId: w.groups.cafe, days: WEEKDAYS, from: '07:00', to: '10:00' },
        },
      ],
    ]),
    variants: [
      {
        name: 'the weekdays in another order',
        arm: 'drawer',
        passes: true,
        script: (w) => [
          [
            {
              name: 'save_schedule_entry',
              input: { playlistId: w.playlists.breakfast, target: 'group', groupId: w.groups.cafe, days: [5, 4, 3, 2, 1], from: '07:00', to: '10:00' },
            },
          ],
        ],
      },
      ...(['drawer', 'mcp'] as const).map((arm) => ({
        name: 'Monday to Wednesday, then Thursday and Friday',
        arm,
        passes: true,
        script: (w: World) => [[breakfastOnCafe(w, [1, 2, 3]), breakfastOnCafe(w, [4, 5])]],
      })),
      {
        name: 'the weekdays, and the weekend too',
        arm: 'mcp',
        passes: false,
        script: (w) => [[breakfastOnCafe(w, WEEKDAYS), breakfastOnCafe(w, [0, 6])]],
      },
      {
        name: 'only in January 2000',
        arm: 'mcp',
        passes: false,
        script: (w) => [
          [
            {
              name: 'save_schedule_entry',
              input: {
                playlistId: w.playlists.breakfast,
                target: 'group',
                groupId: w.groups.cafe,
                days: WEEKDAYS,
                from: '07:00',
                to: '10:00',
                startDate: '2000-01-01',
                endDate: '2000-01-31',
              },
            },
          ],
        ],
      },
    ],
    async check(o) {
      if (o.arm === 'drawer') {
        const drafted = o.drafts.filter((d) => d.tool === 'save_schedule_entry').map((d) => d.input);
        return weekdayMornings(drafted, o.world.playlists.breakfast, o.world.groups.cafe, o.today) ? undefined : `drafted ${JSON.stringify(drafted)}`;
      }
      return scheduled(o, o.world.playlists.breakfast, o.world.groups.cafe);
    },
  },
  {
    id: 'write-publish',
    prompt: 'Publish everything that is waiting to go out.',
    role: 'owner',
    script: { mcp: () => [[{ name: 'publish', input: {} }]] },
    async check(o) {
      const published = await publishedOf(o, o.world.spots.lunch);
      return published?.durationMs === 15_000 ? undefined : `Lunch specials' published version lasts ${published?.durationMs} ms`;
    },
  },

  // ------------------------------------------------------------------ several steps
  {
    id: 'multi-playlist-and-schedule',
    prompt: 'Make a playlist called "Morning" with Breakfast menu then Weather, and schedule it on the Cafe group on weekdays from 07:00 to 10:00.',
    role: 'editor',
    script: {
      mcp: (w) => [
        [
          { name: 'read', input: { type: 'spot' } },
          { name: 'read', input: { type: 'group' } },
        ],
        [{ name: 'save_playlist', input: { name: 'Morning', spotIds: [w.spots.breakfast, w.spots.weather] } }],
        ([made = '']) => [
          {
            name: 'save_schedule_entry',
            input: { playlistId: /"id":"(pls_[^"]+)"/.exec(made)?.[1], target: 'group', groupId: w.groups.cafe, days: WEEKDAYS, from: '07:00', to: '10:00' },
          },
        ],
      ],
    },
    async check(o) {
      const made = await playlistNamed(o, 'Morning');
      if (!same(made?.spotIds, [o.world.spots.breakfast, o.world.spots.weather])) return `Morning is ${JSON.stringify(made?.spotIds)}`;
      return made ? scheduled(o, made.row.id, o.world.groups.cafe) : undefined;
    },
  },
  {
    id: 'multi-edit-and-publish',
    prompt: 'Change the Weather spot to show for 20 seconds, and publish it.',
    role: 'owner',
    script: {
      mcp: (w) => [
        [{ name: 'read', input: { type: 'spot' } }],
        [{ name: 'save_spot', input: { spotId: w.spots.weather, durationMs: 20_000 } }],
        [{ name: 'publish', input: {} }],
      ],
    },
    async check(o) {
      const published = await publishedOf(o, o.world.spots.weather);
      return published?.durationMs === 20_000 ? undefined : `Weather's published version lasts ${published?.durationMs} ms`;
    },
  },
  {
    id: 'multi-drawer-drafts',
    prompt: 'Rename the Harbor lobby screen to "Harbor entrance", and make the Weather spot show for 15 seconds.',
    role: 'editor',
    script: {
      drawer: (w) => [
        [
          { name: 'read', input: { type: 'screen' } },
          { name: 'read', input: { type: 'spot' } },
        ],
        [
          { name: 'update_screen', input: { screenId: w.screens.harbor, name: 'Harbor entrance' } },
          { name: 'save_spot', input: { spotId: w.spots.weather, durationMs: 15_000 } },
        ],
      ],
    },
    check(o) {
      if (draftOf(o, 'update_screen', o.world.screens.harbor)?.input.name !== 'Harbor entrance') return 'no draft renaming Harbor lobby';
      return draftOf(o, 'save_spot', o.world.spots.weather)?.input.durationMs === 15_000 ? undefined : 'no draft of Weather at 15 s';
    },
  },

  // ------------------------------------------------------------------ confirmation cards
  {
    id: 'card-delete-playlist',
    prompt: 'Delete the Winter promo playlist.',
    role: 'owner',
    press: true,
    script: both((w) => [[{ name: 'read', input: { type: 'playlist' } }], [{ name: 'delete_playlist', input: { playlistId: w.playlists.winter } }]]),
    async check(o) {
      return (await o.scope.playlists.get(o.world.playlists.winter)) ? 'Winter promo is still there' : undefined;
    },
  },
  {
    id: 'card-publish',
    prompt: 'Publish the changes that are waiting.',
    role: 'owner',
    press: true,
    script: {
      drawer: (w) => [
        [{ name: 'read', input: { type: 'spot', filter: { unpublished: true } } }],
        [{ name: 'publish', input: { drafts: [{ kind: 'spot', id: w.spots.lunch, version: w.lunchVersion }] } }],
      ],
    },
    async check(o) {
      const published = await publishedOf(o, o.world.spots.lunch);
      return published?.durationMs === 15_000 ? undefined : `Lunch specials' published version lasts ${published?.durationMs} ms`;
    },
  },

  // ------------------------------------------------------------------ refused
  {
    id: 'refused-viewer-publish',
    prompt: 'Publish everything that is waiting to go out.',
    role: 'viewer',
    // Neither arm offers a viewer a publish: the model can only say so, and who may.
    script: { mcp: () => [], drawer: () => [] },
    async check(o) {
      const publishes = (await o.scope.publishes.list()).length;
      if (publishes !== o.world.publishes) return `the org has ${publishes} publishes`;
      return o.cards.some((c) => c.token !== null) ? 'the viewer was given a card to press' : undefined;
    },
  },
  {
    id: 'refused-viewer-rename',
    prompt: 'Rename the Harbor lobby screen to "Harbor entrance".',
    role: 'viewer',
    script: { mcp: () => [] },
    async check(o) {
      const name = (await o.scope.screens.get(o.world.screens.harbor))?.name;
      return name === 'Harbor lobby' ? undefined : `Harbor lobby is named ${name}`;
    },
  },
];
