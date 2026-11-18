/**
 * One screen (canvas board "Screen detail"): what it should be showing, what it is doing, its
 * cache, display hours with exceptions, versions and recent events; Identify, Restart, wake or
 * sleep now; settings, and revoke behind a confirmation (the one thing here that cannot be undone).
 */
import { createFileRoute, getRouteApi, Link, notFound, useRouter } from '@tanstack/react-router';
import { LoaderCircleIcon, MoonIcon, MoreHorizontalIcon, RotateCwIcon, ScanEyeIcon, SunIcon, UndoIcon } from 'lucide-react';
import { useId, useReducer, type FormEvent, type ReactNode } from 'react';
import { describeHours, DisplayHoursEditor, hoursProblems, WeekBars } from '~/components/screens/display-hours-editor';
import { ScreenThumb } from '~/components/screens/screen-thumb';
import { ScreenStatus } from '~/components/screens/status';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '~/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '~/components/ui/dropdown-menu';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { NativeSelect } from '~/components/ui/select';
import { useCanManage, useNow, useRole } from '~/lib/live';
import { ago, describeScreen, eventText, localClock } from '~/lib/screen-status';
import type { DisplayHours, GroupView, ScreenView } from '~/lib/screen-types';
import { callTool, toolMessage } from '~/lib/tools';
import { getScreen } from '~/server/screens.functions';

export const Route = createFileRoute('/_app/screens/$screenId')({
  loader: async ({ params }) => {
    const detail = await getScreen({ data: params.screenId });
    if (!detail) throw notFound();
    return detail;
  },
  head: ({ loaderData }) => ({ meta: [{ title: `${loaderData?.screen.name ?? 'Screen'} · SignForge` }] }),
  component: ScreenPage,
  notFoundComponent: () => (
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold">Screen not found</h1>
      <p className="text-muted-foreground">
        It may have been removed, or it belongs to another organization.{' '}
        <Link to="/screens" className="font-medium text-primary underline-offset-4 hover:underline">
          Back to Screens
        </Link>
      </p>
    </div>
  ),
});

const app = getRouteApi('/_app');

function ScreenPage() {
  const { screen, groupIds, credentials, events, groups, at } = Route.useLoaderData();
  const me = app.useLoaderData().user.id;
  const canManage = useCanManage();
  const owner = useRole() === 'owner';
  const now = useNow(at);
  const router = useRouter();
  const [{ busy, notice, editing, revoking }, dispatch] = useReducer(page, { busy: null, notice: null, editing: null, revoking: false });
  const d = describeScreen(screen, now);
  const inGroups = groups.filter((g) => groupIds.includes(g.id));
  const revoked = screen.status === 'revoked';

  async function run(label: string, tool: string, input: Record<string, unknown>, done: string) {
    dispatch({ type: 'actionStarted', label });
    try {
      await callTool(tool, { screenId: screen.id, ...input });
      dispatch({ type: 'actionDone', text: done });
      await router.invalidate();
    } catch (err) {
      dispatch({ type: 'actionFailed', text: toolMessage(err) });
    }
  }

  const spinner = (label: string, icon: ReactNode) => (busy === label ? <LoaderCircleIcon className="animate-spin" aria-hidden /> : icon);
  const override = screen.displayOverride;

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <nav aria-label="Breadcrumb" className="flex gap-1.5 text-sm">
          <Link to="/screens" className="text-primary underline-offset-4 hover:underline">
            Screens
          </Link>
          <span aria-hidden className="text-muted-foreground">
            /
          </span>
          <span aria-current="page" className="text-muted-foreground">
            {screen.name}
          </span>
        </nav>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
          <h1 className="text-[28px] leading-tight font-semibold tracking-tight">{screen.name}</h1>
          <span className="flex items-center gap-2">
            <ScreenStatus screen={screen} now={now} />
            {screen.lastSeenAt && <span className="text-[13px] text-muted-foreground">last heard {ago(now - screen.lastSeenAt)} ago</span>}
          </span>
          {canManage && !revoked && (
            <div className="flex flex-wrap gap-2 sm:ml-auto">
              <Button
                variant="outline"
                disabled={!!busy}
                onClick={() => run('identify', 'identify_screen', {}, 'Sent. The screen shows its name for 10 seconds, if it is connected.')}
              >
                {spinner('identify', <ScanEyeIcon aria-hidden />)} Identify (10 s)
              </Button>
              <Button
                variant="outline"
                disabled={!!busy}
                onClick={() => run('restart', 'restart_screen', {}, 'Sent. The player restarts and plays from its cache at once.')}
              >
                {spinner('restart', <RotateCwIcon aria-hidden />)} Restart player
              </Button>
              {override ? (
                <Button
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => run('display', 'set_display_override', { state: null }, 'Back to its display hours.')}
                >
                  {spinner('display', <UndoIcon aria-hidden />)} Back to display hours
                </Button>
              ) : screen.heartbeat?.displayOn === false || screen.state.kind === 'asleep' ? (
                <Button
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => run('display', 'set_display_override', { state: 'on' }, 'Waking it until its next scheduled change.')}
                >
                  {spinner('display', <SunIcon aria-hidden />)} Wake now
                </Button>
              ) : (
                <Button
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => run('display', 'set_display_override', { state: 'off' }, 'Sleeping it until its next scheduled change.')}
                >
                  {spinner('display', <MoonIcon aria-hidden />)} Sleep now
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" aria-label="More actions: settings, display hours, revoke">
                    <MoreHorizontalIcon aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => dispatch({ type: 'editOpened', what: 'settings' })}>Settings and groups…</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => dispatch({ type: 'editOpened', what: 'hours' })}>Display hours…</DropdownMenuItem>
                  {owner && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => dispatch({ type: 'revokeAsked', open: true })}>
                        Revoke…
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
        <p className="text-[15px] text-muted-foreground">
          {screen.orientation === 'portrait' ? 'Portrait 1080 × 1920' : 'Landscape 1920 × 1080'} ·{' '}
          {inGroups.length ? `group ${inGroups.map((g) => g.name).join(', ')}` : 'No group'} · {screen.timezone.replaceAll('_', ' ')}
        </p>
        <p role="status" className={notice?.ok === false ? 'text-sm font-medium text-destructive' : 'text-sm text-muted-foreground'}>
          {notice?.text}
        </p>
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-[2_1_34rem] flex-col gap-4">
          <figure className="m-0 flex flex-col gap-3 rounded-xl border bg-card p-3.5">
            <div className="overflow-hidden rounded-lg bg-[#0b0c0e] p-2">
              <ScreenThumb screen={screen} className="rounded" />
            </div>
            <figcaption className="flex flex-wrap justify-between gap-2 text-[15px]">
              <span>
                {screen.showing?.spot ? (
                  <>
                    Should be showing <strong className="font-semibold">{screen.showing.spot.name}</strong>
                    {screen.showing.spot.template && <span className="font-mono text-[13px] text-muted-foreground"> · {screen.showing.spot.template}</span>}
                  </>
                ) : screen.showing?.asleep ? (
                  <>Should be asleep{screen.showing.wakesAt && ` until ${localClock(screen.showing.wakesAt, screen.timezone, now)}`}</>
                ) : (
                  'Nothing published to it yet'
                )}
              </span>
              {screen.showing?.playlist && (
                <span className="text-muted-foreground">
                  First of {screen.showing.spots} in {screen.showing.playlist.name}
                </span>
              )}
            </figcaption>
            {screen.showing && (
              <p className="text-[13px] text-muted-foreground">
                {d.line}. Worked out from its published manifest, schedule and display hours, as the screen does; not a screenshot.
              </p>
            )}
          </figure>

          <Section title="Recent events">
            {events.length ? (
              <ol className="text-[15px]">
                {events.map((e) => (
                  <li key={`${e.at}-${e.action}-${e.actor.id}`} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 border-t py-2 first:border-t-0">
                    <span className="font-mono text-[13px] text-muted-foreground" title={new Date(e.at).toLocaleString()}>
                      {ago(now - e.at)} ago
                    </span>
                    <span>
                      {eventText(e)}{' '}
                      <span className="text-muted-foreground">{e.actor.id === me ? 'by you' : e.actor.kind === 'agent' ? 'by an agent' : 'by a member'}</span>
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing has been done to this screen yet.</p>
            )}
          </Section>
        </div>

        <div className="flex min-w-0 flex-[1_1_20rem] flex-col gap-4">
          <Section title="Offline cache">
            <CacheState screen={screen} />
          </Section>

          <Section
            title="Display hours"
            action={
              canManage && !revoked ? (
                <Button variant="link" size="sm" className="h-auto px-0 underline" onClick={() => dispatch({ type: 'editOpened', what: 'hours' })}>
                  Edit
                </Button>
              ) : undefined
            }
          >
            <p className="text-[15px]">
              <strong className="font-semibold">{describeHours(screen.displayHours)}</strong>
            </p>
            <WeekBars hours={screen.displayHours} />
            {screen.displayHours?.exceptions?.length ? (
              <ul className="text-sm text-muted-foreground">
                {screen.displayHours.exceptions.map((e) => (
                  <li key={e.date}>
                    <span className="font-mono">{e.date}</span>: {e.on.length ? e.on.map((w) => `${w.from}–${w.to}`).join(', ') : 'off all day'}
                  </li>
                ))}
              </ul>
            ) : null}
            {override && (
              <p className="text-sm">
                {override.state === 'on' ? 'Woken' : 'Put to sleep'} from the CMS until {localClock(override.until, screen.timezone, now)}.
              </p>
            )}
            <p className="text-[13px] text-muted-foreground">The panel powers off outside these hours. A change reaches the screen with the next publish.</p>
          </Section>

          <Section title="Versions">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[15px]">
              <dt className="text-muted-foreground">Published</dt>
              <dd className="font-mono text-[13px]">{short(screen.desiredManifestId)}</dd>
              <dt className="text-muted-foreground">Playing</dt>
              <dd className="font-mono text-[13px]">{short(screen.reportedManifestId ?? screen.heartbeat?.activeManifestId ?? null)}</dd>
              <dt className="text-muted-foreground">Kept</dt>
              <dd className="font-mono text-[13px]">{short(screen.previousManifestId)}</dd>
              <dt className="text-muted-foreground">Player</dt>
              <dd className="font-mono text-[13px]">{screen.heartbeat?.playerVersion ?? screen.playerVersion ?? 'none'}</dd>
              <dt className="text-muted-foreground">Clock</dt>
              <dd>
                {screen.heartbeat
                  ? screen.heartbeat.clockTrusted
                    ? `trusted, ${Math.round(Math.abs(screen.heartbeat.driftMs) / 1000)} s from server`
                    : 'not trusted'
                  : 'none'}
              </dd>
            </dl>
          </Section>
        </div>
      </div>

      {editing === 'settings' && <SettingsDialog screen={screen} groups={groups} groupIds={groupIds} onClose={() => dispatch({ type: 'editClosed' })} />}
      {editing === 'hours' && <HoursDialog screen={screen} onClose={() => dispatch({ type: 'editClosed' })} />}
      <AlertDialog open={revoking} onOpenChange={(open) => dispatch({ type: 'revokeAsked', open })}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {screen.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The screen loses its credential at once: it wipes its content, stops playing and shows a new pairing code. This cannot be undone; to use the
              screen again, pair it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                void (async () => {
                  for (const c of credentials.filter((c) => c.revokedAt == null)) {
                    await run(
                      'revoke',
                      'revoke_screen_credential',
                      { credentialId: c.id },
                      'Revoked. The screen has stopped playing and shows a pairing code.',
                    );
                  }
                })()
              }
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface PageState {
  /** The action being sent (identify, restart, display, revoke), or null. */
  busy: string | null;
  notice: { ok: boolean; text: string } | null;
  editing: 'settings' | 'hours' | null;
  revoking: boolean;
}
type PageAction =
  | { type: 'actionStarted'; label: string }
  | { type: 'actionDone'; text: string }
  | { type: 'actionFailed'; text: string }
  | { type: 'editOpened'; what: 'settings' | 'hours' }
  | { type: 'editClosed' }
  | { type: 'revokeAsked'; open: boolean };

function page(s: PageState, a: PageAction): PageState {
  switch (a.type) {
    case 'actionStarted':
      return { ...s, busy: a.label, notice: null };
    case 'actionDone':
      return { ...s, busy: null, notice: { ok: true, text: a.text } };
    case 'actionFailed':
      return { ...s, busy: null, notice: { ok: false, text: a.text } };
    case 'editOpened':
      return { ...s, editing: a.what };
    case 'editClosed':
      return { ...s, editing: null };
    case 'revokeAsked':
      return { ...s, revoking: a.open };
  }
}

interface SettingsState {
  name: string;
  timezone: string;
  orientation: ScreenView['orientation'];
  chosen: string[];
  pending: boolean;
  error: string | null;
}
type SettingsAction =
  | { type: 'nameEntered'; name: string }
  | { type: 'zoneChosen'; timezone: string }
  | { type: 'orientationChosen'; orientation: ScreenView['orientation'] }
  | { type: 'groupToggled'; groupId: string; member: boolean }
  | { type: 'saveStarted' }
  | { type: 'saveFailed'; error: string };

function settings(s: SettingsState, a: SettingsAction): SettingsState {
  switch (a.type) {
    case 'nameEntered':
      return { ...s, name: a.name };
    case 'zoneChosen':
      return { ...s, timezone: a.timezone };
    case 'orientationChosen':
      return { ...s, orientation: a.orientation };
    case 'groupToggled':
      return { ...s, chosen: a.member ? [...s.chosen, a.groupId] : s.chosen.filter((g) => g !== a.groupId) };
    case 'saveStarted':
      return { ...s, pending: true, error: null };
    case 'saveFailed':
      return { ...s, pending: false, error: a.error };
  }
}

interface HoursState {
  hours: DisplayHours | null;
  pending: boolean;
  error: string | null;
}
type HoursAction = { type: 'hoursChanged'; hours: DisplayHours | null } | { type: 'saveStarted' } | { type: 'saveFailed'; error: string };

function hoursEdit(s: HoursState, a: HoursAction): HoursState {
  switch (a.type) {
    case 'hoursChanged':
      return { ...s, hours: a.hours };
    case 'saveStarted':
      return { ...s, pending: true, error: null };
    case 'saveFailed':
      return { ...s, pending: false, error: a.error };
  }
}

const short = (id: string | null) => (id ? <span title={id}>{id.slice(0, 7)}</span> : 'none');

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2.5 rounded-xl border bg-card px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function CacheState({ screen }: { screen: ScreenView }) {
  const hb = screen.heartbeat;
  if (!hb) return <p className="text-sm text-muted-foreground">Not heard from yet.</p>;
  if (!screen.desiredManifestId) return <p className="text-sm text-muted-foreground">Nothing to cache yet: nothing is published to it.</p>;
  const missing = hb.filesMissing;
  const onLatest = (screen.reportedManifestId ?? hb.activeManifestId) === screen.desiredManifestId;
  return (
    <>
      <div className="flex items-baseline gap-2.5">
        <strong className="text-lg font-semibold">
          {missing ? `${missing} ${missing === 1 ? 'file' : 'files'} to fetch` : onLatest ? 'Complete' : 'Switching'}
        </strong>
        <span className="text-sm text-muted-foreground">{missing ? 'plays the last version meanwhile' : 'can play offline'}</span>
      </div>
      {hb.fallbackFrom && <p className="text-sm text-status-needs-you-foreground">The latest version played nothing, so it went back to the one before.</p>}
    </>
  );
}

function SettingsDialog({ screen, groups, groupIds, onClose }: { screen: ScreenView; groups: GroupView[]; groupIds: string[]; onClose: () => void }) {
  const router = useRouter();
  const id = useId();
  const [{ name, timezone, orientation, chosen, pending, error }, dispatch] = useReducer(settings, {
    name: screen.name,
    timezone: screen.timezone,
    orientation: screen.orientation,
    chosen: groupIds,
    pending: false,
    error: null,
  });
  const zones = Intl.supportedValuesOf('timeZone');

  async function save(e: FormEvent) {
    e.preventDefault();
    dispatch({ type: 'saveStarted' });
    try {
      if (name.trim() !== screen.name) await callTool('rename_screen', { screenId: screen.id, name: name.trim() });
      if (timezone !== screen.timezone || orientation !== screen.orientation)
        await callTool('update_screen_settings', { screenId: screen.id, timezone, orientation });
      for (const g of groups) {
        const was = g.screenIds.includes(screen.id);
        const now = chosen.includes(g.id);
        if (was !== now)
          await callTool('set_group_members', { groupId: g.id, screenIds: now ? [...g.screenIds, screen.id] : g.screenIds.filter((x) => x !== screen.id) });
      }
      await router.invalidate();
      onClose();
    } catch (err) {
      dispatch({ type: 'saveFailed', error: toolMessage(err) });
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Time zone and orientation reach the screen with the next publish.</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-n`}>Name</Label>
            <Input id={`${id}-n`} value={name} onChange={(e) => dispatch({ type: 'nameEntered', name: e.target.value })} maxLength={100} required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-tz`}>Time zone</Label>
            <NativeSelect id={`${id}-tz`} value={timezone} onChange={(e) => dispatch({ type: 'zoneChosen', timezone: e.target.value })}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replaceAll('_', ' ')}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-o`}>Orientation</Label>
            <NativeSelect
              id={`${id}-o`}
              value={orientation}
              onChange={(e) => dispatch({ type: 'orientationChosen', orientation: e.target.value as ScreenView['orientation'] })}
            >
              <option value="landscape">Landscape (16:9)</option>
              <option value="portrait">Portrait (9:16)</option>
            </NativeSelect>
          </div>
          {groups.length > 0 && (
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium">Groups</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {groups.map((g) => (
                  <label key={g.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={chosen.includes(g.id)}
                      onChange={(e) => dispatch({ type: 'groupToggled', groupId: g.id, member: e.target.checked })}
                    />
                    {g.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <p role="alert" className="text-sm font-medium text-destructive empty:hidden">
            {error}
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending && <LoaderCircleIcon className="animate-spin" aria-hidden />} Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function HoursDialog({ screen, onClose }: { screen: ScreenView; onClose: () => void }) {
  const router = useRouter();
  const [{ hours, pending, error }, dispatch] = useReducer(hoursEdit, { hours: screen.displayHours, pending: false, error: null });
  const ok = hoursProblems(hours).length === 0;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!ok) return;
    dispatch({ type: 'saveStarted' });
    try {
      await callTool('update_screen_settings', { screenId: screen.id, displayHours: hours });
      await router.invalidate();
      onClose();
    } catch (err) {
      dispatch({ type: 'saveFailed', error: toolMessage(err) });
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Display hours for {screen.name}</DialogTitle>
          <DialogDescription>
            In the screen's time zone, {screen.timezone.replaceAll('_', ' ')}. The change reaches the screen with the next publish.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="grid gap-4">
          <DisplayHoursEditor value={hours} onChange={(hours) => dispatch({ type: 'hoursChanged', hours })} />
          <p role="alert" className="text-sm font-medium text-destructive empty:hidden">
            {error}
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !ok}>
              {pending && <LoaderCircleIcon className="animate-spin" aria-hidden />} Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
