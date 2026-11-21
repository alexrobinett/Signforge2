/**
 * One screen (canvas board "Screen detail"): what it should be showing, what it is doing, its
 * cache, display hours with exceptions, versions and recent events; Identify, Restart, wake or
 * sleep now; settings, and revoke behind a confirmation (the one thing here that cannot be undone).
 */
import { createFileRoute, getRouteApi, Link, notFound } from '@tanstack/react-router';
import { LoaderCircleIcon, MoonIcon, MoreHorizontalIcon, RotateCwIcon, ScanEyeIcon, SunIcon, UndoIcon } from 'lucide-react';
import { useId, type SubmitEvent, type ReactNode } from 'react';
import { EditorFields } from '~/components/editor';
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
import { useCanManage, useNow, useOrgId, useRole } from '~/lib/live';
import { eventText } from '~/lib/audit';
import { ago, describeScreen, localClock } from '~/lib/screen-status';
import { isOrientation, type GroupView, type ScreenView } from '~/lib/screen-types';
import { getScreen } from '~/server/screens.functions';
import { useAppStore } from '~/state/provider';
import { editorDraft, hoursDraftOf, settingsDraftOf, type ScreenAction } from '~/state/screens';

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
  const orgId = useOrgId();
  const canManage = useCanManage();
  const owner = useRole() === 'owner';
  const now = useNow(at);
  const chooseWeekScreen = useAppStore((s) => s.chooseWeekScreen);
  // What it plays now (M3-19), from its published manifest: what was published, not what is drafted.
  const plays = screen.showing;
  const pageState = useAppStore((s) => s.screens.page);
  const actOnScreen = useAppStore((s) => s.actOnScreen);
  const openScreenSettings = useAppStore((s) => s.openScreenSettings);
  const openDisplayHours = useAppStore((s) => s.openDisplayHours);
  const askToRevoke = useAppStore((s) => s.askToRevoke);
  const revokeScreen = useAppStore((s) => s.revokeScreen);
  // Page state belongs to one screen: another screen's notice or editor is not shown here.
  const ours = pageState.screenId === screen.id;
  const busy = ours ? pageState.busy : null;
  const notice = ours ? pageState.notice : null;
  const editing = ours ? pageState.editing : null;
  const revoking = pageState.revoking;
  const d = describeScreen(screen, now);
  const inGroups = groups.filter((g) => groupIds.includes(g.id));
  const revoked = screen.status === 'revoked';
  const run = (label: string, tool: ScreenAction['tool'], input: Record<string, unknown>, done: string) =>
    void actOnScreen(screen.id, { label, tool, input, done });

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
            {screen.kind === 'browser' && (
              <span className="rounded-md border px-1.5 py-0.5 text-xs font-medium text-muted-foreground" title="The player in a browser tab">
                Test screen
              </span>
            )}
            {screen.lastSeenAt && <span className="text-[13px] text-muted-foreground">last heard {ago(now - screen.lastSeenAt)} ago</span>}
          </span>
          {canManage && !revoked && (
            <div className="flex flex-wrap gap-2 sm:ml-auto">
              <EditorFields>
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
                {/* A browser tab has no panel to power: it ignores wake and sleep. */}
                {screen.kind === 'browser' ? null : override ? (
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
                    <DropdownMenuItem onSelect={() => openScreenSettings(orgId, screen, groupIds)}>Settings and groups…</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openDisplayHours(orgId, screen)}>Display hours…</DropdownMenuItem>
                    {owner && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => askToRevoke(true)}>
                          Revoke…
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </EditorFields>
            </div>
          )}
        </div>
        <p className="text-[15px] text-muted-foreground">
          {screen.orientation === 'portrait' ? 'Portrait 1080 × 1920' : 'Landscape 1920 × 1080'} ·{' '}
          {inGroups.length ? `group ${inGroups.map((g) => g.name).join(', ')}` : 'No group'} · {screen.timezone.replaceAll('_', ' ')}
          {plays?.playlist && (
            <>
              {' · '}
              <Link to="/schedule" onClick={() => chooseWeekScreen(screen.id)} className="underline underline-offset-4">
                {plays.takeover ? 'takeover: ' : 'plays '}
                {plays.playlist.name} now
              </Link>
            </>
          )}
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
            {screen.showing ? (
              <p className="text-[13px] text-muted-foreground">
                {d.line}. Worked out from its published manifest, schedule and display hours, as the screen does; not a screenshot.
              </p>
            ) : (
              screen.state.reason !== 'nothing_published' && <p className="text-[13px] text-muted-foreground">{d.line}.</p>
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
                <Button variant="link" size="sm" className="h-auto px-0 underline" onClick={() => openDisplayHours(orgId, screen)}>
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

      {editing === 'settings' && <SettingsDialog screen={screen} groups={groups} />}
      {editing === 'hours' && <HoursDialog screen={screen} />}
      <AlertDialog open={revoking} onOpenChange={askToRevoke}>
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
                void revokeScreen(
                  screen.id,
                  credentials.filter((c) => c.revokedAt == null).map((c) => c.id),
                )
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

function SettingsDialog({ screen, groups }: { screen: ScreenView; groups: GroupView[] }) {
  const id = useId();
  const draft = useAppStore((s) => settingsDraftOf(s.screens, screen.id));
  const saving = useAppStore((s) => editorDraft(s.screens)?.pending ?? false);
  const renameDraft = useAppStore((s) => s.renameDraft);
  const chooseDraftZone = useAppStore((s) => s.chooseDraftZone);
  const chooseDraftOrientation = useAppStore((s) => s.chooseDraftOrientation);
  const toggleDraftGroup = useAppStore((s) => s.toggleDraftGroup);
  const nameNewGroup = useAppStore((s) => s.nameNewGroup);
  const saveScreenSettings = useAppStore((s) => s.saveScreenSettings);
  const close = useAppStore((s) => s.closeScreenEditor);
  const zones = Intl.supportedValuesOf('timeZone');
  if (!draft) return null;

  function save(e: SubmitEvent) {
    e.preventDefault();
    void saveScreenSettings(screen, groups);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Time zone and orientation reach the screen with the next publish.</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-n`}>Name</Label>
            <Input id={`${id}-n`} value={draft.name} onChange={(e) => renameDraft(e.target.value)} maxLength={100} required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-tz`}>Time zone</Label>
            <NativeSelect id={`${id}-tz`} value={draft.timezone} onChange={(e) => chooseDraftZone(e.target.value)}>
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
              value={draft.orientation}
              onChange={(e) => {
                if (isOrientation(e.target.value)) chooseDraftOrientation(e.target.value);
              }}
            >
              <option value="landscape">Landscape (16:9)</option>
              <option value="portrait">Portrait (9:16)</option>
            </NativeSelect>
          </div>
          <fieldset className="grid gap-2">
            <legend className="mb-1.5 text-sm font-medium">Groups</legend>
            {groups.length > 0 && (
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {groups.map((g) => (
                  <label key={g.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={draft.groupIds.includes(g.id)}
                      onChange={(e) => toggleDraftGroup(g.id, e.target.checked)}
                    />
                    {g.name}
                  </label>
                ))}
              </div>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-g`}>New group</Label>
              <Input
                id={`${id}-g`}
                value={draft.newGroup}
                onChange={(e) => nameNewGroup(e.target.value)}
                maxLength={100}
                placeholder="Front of house"
                aria-describedby={`${id}-g-help`}
              />
              <p id={`${id}-g-help`} className="text-xs text-muted-foreground">
                Made with this screen in it. Schedule a playlist for a group on the Schedule page.
              </p>
            </div>
          </fieldset>
          <SaveError />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !draft.name.trim()}>
              {saving && <LoaderCircleIcon className="animate-spin" aria-hidden />} Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Why a save was refused; when the screen changed since the editor opened, a reload to start again from what is there now. */
function SaveError() {
  const error = useAppStore((s) => editorDraft(s.screens)?.error ?? null);
  const stale = useAppStore((s) => editorDraft(s.screens)?.stale ?? false);
  const reload = useAppStore((s) => s.reloadScreenEditor);
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 text-sm font-medium text-destructive empty:hidden">
      {error}
      {stale && (
        <Button type="button" variant="outline" size="sm" onClick={() => void reload()}>
          <RotateCwIcon aria-hidden /> Reload
        </Button>
      )}
    </div>
  );
}

function HoursDialog({ screen }: { screen: ScreenView }) {
  const hours = useAppStore((s) => hoursDraftOf(s.screens, screen.id));
  const saving = useAppStore((s) => editorDraft(s.screens)?.pending ?? false);
  const editDraftHours = useAppStore((s) => s.editDraftHours);
  const saveDisplayHours = useAppStore((s) => s.saveDisplayHours);
  const close = useAppStore((s) => s.closeScreenEditor);
  const ok = hoursProblems(hours).length === 0;

  function save(e: SubmitEvent) {
    e.preventDefault();
    if (ok) void saveDisplayHours(screen);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Display hours for {screen.name}</DialogTitle>
          <DialogDescription>
            In the screen's time zone, {screen.timezone.replaceAll('_', ' ')}. The change reaches the screen with the next publish.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="grid gap-4">
          <DisplayHoursEditor value={hours} onChange={editDraftHours} />
          <SaveError />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !ok}>
              {saving && <LoaderCircleIcon className="animate-spin" aria-hidden />} Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
