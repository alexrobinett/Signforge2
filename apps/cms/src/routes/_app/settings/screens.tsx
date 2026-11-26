/**
 * Settings, Screens & groups (canvas board SettingsScreens): the update window, how long a
 * screen may go without a heartbeat before it alerts, and the groups: each with its screens and
 * what targets it (schedule entries, brand kits), renamed, deleted or given its screens here.
 */
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { EllipsisIcon, LoaderCircleIcon, RotateCwIcon, SearchIcon } from 'lucide-react';
import { useId, type SubmitEvent } from 'react';
import { EditorFields } from '~/components/editor';
import { RuleBuilder } from '~/components/screens/rule-builder';
import { Badge } from '~/components/ui/badge';
import { choiceVariants } from '~/components/ui/choice';
import { PageHeader } from '~/components/page';
import { FieldProblem, SaveState, SettingsSection } from '~/components/settings/parts';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '~/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '~/components/ui/dropdown-menu';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { withStatus } from '~/lib/fleet-status';
import { targetsOf } from '~/lib/groups';
import { byName } from '~/lib/targets';
import { useCanManage, useNow, useOrgId, useRole } from '~/lib/live';
import { describeWhen, type ScheduleEntryView } from '~/lib/schedule';
import { isRetired } from '~/lib/screen-status';
import type { GroupView, ScreenView } from '~/lib/screen-types';
import { playlistsQuery } from '~/queries/playlists';
import { scheduleQuery } from '~/queries/schedule';
import { labelKeysQuery, screenRosterQuery, screensQuery } from '~/queries/screens';
import { brandKitsQuery } from '~/queries/spots';
import { cn } from '~/lib/utils';
import { getOrgSettings } from '~/server/settings.functions';
import { termWords } from '~/lib/rules';
import { memberChecked } from '~/state/groups';
import { useAppStore } from '~/state/provider';
import { editsIn, settingsProblems, type SettingsEdits } from '~/state/settings';

export const Route = createFileRoute('/_app/settings/screens')({
  loader: async ({ context: { queryClient }, parentMatchPromise }) => {
    const orgId = (await parentMatchPromise).loaderData?.orgId;
    const [settings] = await Promise.all([
      getOrgSettings(),
      orgId &&
        Promise.all([
          queryClient.query(screensQuery(orgId)),
          queryClient.query(labelKeysQuery(orgId)),
          queryClient.query(scheduleQuery(orgId)),
          queryClient.query(brandKitsQuery(orgId)),
          queryClient.query(playlistsQuery(orgId)),
        ]),
    ]);
    return settings;
  },
  head: () => ({ meta: [{ title: 'Screens & groups settings · SignForge' }] }),
  component: ScreenSettings,
});

function ScreenSettings() {
  const settings = Route.useLoaderData();
  const canEdit = useRole() === 'owner';
  const id = useId();
  const orgId = useOrgId();
  const edits = useAppStore((s) => editsIn(s.settings, 'screens', orgId, settings?.version ?? null));
  const editSettings = useAppStore((s) => s.editSettings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  if (!settings) return null;
  const problems = settingsProblems(edits, settings);
  const edit = (change: SettingsEdits) => editSettings(orgId, 'screens', settings.version, change);
  // Each typed field saves itself when it is left, or on Enter (#366).
  const save = () => void saveSettings(orgId, 'screens', settings);

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    save();
  }

  return (
    // Space enough that the form's save status reads as the form's, not the Groups list's.
    <div className="space-y-10">
      <form onSubmit={submit} className="space-y-6" noValidate>
        <EditorFields>
          <PageHeader title="Screens & groups" description="When screens update, how long one may be silent before it alerts, and the groups they are in." />
          <SettingsSection
            id={`${id}-window`}
            title="Update window"
            description="Content changes download at once and switch at the end of the loop. Player and system updates wait for this window."
          >
            <div className="flex flex-wrap items-end gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-from`}>From</Label>
                <Input
                  id={`${id}-from`}
                  name="from"
                  type="time"
                  value={edits.updateFrom ?? settings.updateWindow.from}
                  onChange={(e) => edit({ updateFrom: e.target.value })}
                  onBlur={save}
                  disabled={!canEdit}
                  className="w-36"
                  aria-invalid={problems.updateFrom !== undefined || undefined}
                  aria-describedby={problems.updateFrom ? `${id}-from-bad` : undefined}
                />
                <FieldProblem id={`${id}-from-bad`} text={problems.updateFrom} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-to`}>To</Label>
                <Input
                  id={`${id}-to`}
                  name="to"
                  type="time"
                  value={edits.updateTo ?? settings.updateWindow.to}
                  onChange={(e) => edit({ updateTo: e.target.value })}
                  onBlur={save}
                  disabled={!canEdit}
                  className="w-36"
                  aria-invalid={problems.updateTo !== undefined || undefined}
                  aria-describedby={problems.updateTo ? `${id}-to-bad` : undefined}
                />
                <FieldProblem id={`${id}-to-bad`} text={problems.updateTo} />
              </div>
            </div>
            <p className="text-meta text-muted-foreground">Local time at each screen. A window that ends before it starts runs past midnight.</p>
          </SettingsSection>

          <SettingsSection
            id={`${id}-offline`}
            title="Offline alerts"
            description="A screen that misses heartbeats keeps playing from its cache, so a short gap is not worth a message."
          >
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor={`${id}-minutes`}>Alert after</Label>
              <Input
                id={`${id}-minutes`}
                name="minutes"
                type="number"
                min={5}
                max={1440}
                step={1}
                inputMode="numeric"
                value={edits.unreachableAfterMinutes ?? settings.unreachableAfterMinutes}
                onChange={(e) => edit({ unreachableAfterMinutes: e.target.value })}
                onBlur={save}
                disabled={!canEdit}
                className="w-24"
                aria-invalid={problems.unreachableAfterMinutes !== undefined || undefined}
                aria-describedby={problems.unreachableAfterMinutes ? `${id}-minutes-unit ${id}-minutes-bad` : `${id}-minutes-unit`}
              />
              <span id={`${id}-minutes-unit`} className="text-sm">
                minutes without a heartbeat
              </span>
            </div>
            <FieldProblem id={`${id}-minutes-bad`} text={problems.unreachableAfterMinutes} />
            <p className="text-meta text-muted-foreground">
              Screens check in every 5 minutes. One email goes out when a screen passes this, and one when it is back.{' '}
              <Link to="/settings/notifications" className="text-primary underline underline-offset-4">
                Choose who gets these alerts
              </Link>
              .
            </p>
          </SettingsSection>

          <SaveState form="screens" canEdit={canEdit} />
        </EditorFields>
      </form>
      <Groups />
    </div>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Every group, with its screens (retired ones left out) and what targets it. Editors and owners change them. */
function Groups() {
  const orgId = useOrgId();
  const canManage = useCanManage();
  const { screens, groups, at } = useSuspenseQuery(screensQuery(orgId)).data;
  const { entries } = useSuspenseQuery(scheduleQuery(orgId)).data;
  const { brandKits } = useSuspenseQuery(brandKitsQuery(orgId)).data;
  const now = useNow(at);
  const open = useAppStore((s) => s.groups.dialog);
  const openGroupRename = useAppStore((s) => s.openGroupRename);
  const askToDeleteGroup = useAppStore((s) => s.askToDeleteGroup);
  const openGroupMembers = useAppStore((s) => s.openGroupMembers);
  const openGroupRule = useAppStore((s) => s.openGroupRule);
  const openNewGroup = useAppStore((s) => s.openNewGroup);
  // Each screen's state, polled: a screen revoked while this page is open leaves the counts and the
  // picker within a poll. The full list is read again only when a screen comes or goes.
  const { data: live } = useQuery(screenRosterQuery(orgId));
  const active = withStatus(screens, at, live).filter((s) => !isRetired(s));
  const pickable = active.map((s) => s.id);
  const group = open && open.orgId === orgId ? groups.find((g) => g.id === open.groupId) : undefined;

  return (
    <SettingsSection
      id="groups"
      title="Groups"
      description={
        <>
          A group is a set of screens a schedule entry or a brand kit can aim at. Put screens in one from the{' '}
          <Link to="/screens" search={{ view: 'table' }} className="text-primary underline underline-offset-4">
            Screens table
          </Link>
          , a screen&apos;s settings, or its Members here. A smart group&apos;s screens are the ones its rule matches.
        </>
      }
    >
      {canManage && (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => openNewGroup(orgId)}>
            New group…
          </Button>
        </div>
      )}
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">No groups yet. Make one here, or from a screen&apos;s Settings and groups.</p>
      ) : (
        // The actions open dialogs held in the store, so they wait for the page to hydrate (#140).
        <EditorFields>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] border-collapse text-sm">
              <thead className="text-left text-xs tracking-wide text-muted-foreground uppercase">
                <tr>
                  <th scope="col" className="py-2 pr-3 font-semibold">
                    Group
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Screens
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Schedule
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Brand kit
                  </th>
                  {canManage && (
                    <th scope="col" className="py-2 pl-3">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {groups.toSorted(byName).map((g) => {
                  const targets = targetsOf(g.id, entries, brandKits, now);
                  const members = g.screenIds.filter((id) => pickable.includes(id)).length;
                  return (
                    <tr key={g.id} className="border-t">
                      <th scope="row" className="py-2.5 pr-3 text-left font-semibold">
                        <Link to="/screens" search={{ group: g.id }} className="hover:underline">
                          {g.name}
                        </Link>
                        {g.selector && (
                          <Badge className="ml-2 align-middle" title={g.selector.all.map(termWords).join(' and ')}>
                            Rule
                          </Badge>
                        )}
                      </th>
                      <td className="px-3 py-2.5 tabular-nums">{plural(members, 'screen')}</td>
                      <td className="px-3 py-2.5">
                        {targets.entries.length ? (
                          <Link to="/schedule" className="text-primary underline-offset-4 hover:underline">
                            {plural(targets.entries.length, 'entry', 'entries')}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">None</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {targets.kits.length ? targets.kits.map((k) => k.name).join(', ') : <span className="text-muted-foreground">None</span>}
                      </td>
                      {canManage && (
                        <td className="py-1.5 pl-3 text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" aria-label={`Change ${g.name}`}>
                                <EllipsisIcon aria-hidden />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {g.selector ? (
                                <DropdownMenuItem onSelect={() => openGroupRule(orgId, g)}>Rule…</DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem onSelect={() => openGroupMembers(orgId, g)}>Members…</DropdownMenuItem>
                              )}
                              <DropdownMenuItem onSelect={() => openGroupRename(orgId, g)}>Rename…</DropdownMenuItem>
                              <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => askToDeleteGroup(orgId, g.id)}>
                                Delete…
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </EditorFields>
      )}
      {group && open?.kind === 'rename' && <RenameDialog orgId={orgId} />}
      {group && open?.kind === 'delete' && <DeleteDialog orgId={orgId} group={group} blockedBy={open.blockedBy} entries={entries} />}
      {group && open?.kind === 'members' && <MembersDialog orgId={orgId} group={group} screens={active} />}
      {group && open?.kind === 'rule' && <RuleDialog orgId={orgId} group={group} screens={active} />}
      {open?.kind === 'new' && open.orgId === orgId && <NewGroupDialog orgId={orgId} screens={active} />}
    </SettingsSection>
  );
}

/** Why the dialog's last action was refused. */
function Refused() {
  const error = useAppStore((s) => s.groups.dialog?.error);
  return (
    <p role="alert" className="text-sm font-medium text-destructive empty:hidden">
      {error}
    </p>
  );
}

function RenameDialog({ orgId }: { orgId: string }) {
  const id = useId();
  const draft = useAppStore((s) => s.groups.renames.dialog);
  const nameGroup = useAppStore((s) => s.nameGroup);
  const renameGroup = useAppStore((s) => s.renameGroup);
  const reload = useAppStore((s) => s.reloadGroupRename);
  const reloading = useAppStore((s) => s.groups.dialog?.kind === 'rename' && s.groups.dialog.reloading);
  const close = useAppStore((s) => s.cancelGroupDialog);
  if (!draft) return null;
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    void renameGroup(orgId);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename the group</DialogTitle>
          <DialogDescription>Schedule entries and brand kits aimed at it stay aimed at it.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor={id}>Name</Label>
            {/* While Reload reads the group again, the name takes no typing: what it reopens on replaces it. */}
            <Input
              id={id}
              value={draft.edit.name}
              onChange={(e) => nameGroup(e.target.value)}
              maxLength={100}
              required
              readOnly={reloading}
              aria-busy={reloading || undefined}
            />
          </div>
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm font-medium text-destructive empty:hidden">
            {draft.error}
            {draft.stale && (
              <Button type="button" variant="outline" size="sm" onClick={() => void reload(orgId)} aria-disabled={reloading || undefined}>
                {reloading ? <LoaderCircleIcon className="animate-spin" aria-hidden /> : <RotateCwIcon aria-hidden />} {reloading ? 'Reloading…' : 'Reload'}
              </Button>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!draft.edit.name.trim()} aria-disabled={draft.pending || undefined}>
              {draft.pending && <LoaderCircleIcon className="animate-spin" aria-hidden />} Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Breakfast · Mon–Fri, 06:00–10:30", or a takeover's end. */
function entryText(e: ScheduleEntryView, names: Map<string, string>) {
  const when =
    e.takeover && e.endsAt ? `takeover until ${new Date(e.endsAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : describeWhen(e);
  return `${names.get(e.playlistId) ?? 'A removed playlist'} · ${when}`;
}

function DeleteDialog({ orgId, group, blockedBy, entries }: { orgId: string; group: GroupView; blockedBy: string[]; entries: ScheduleEntryView[] }) {
  const pending = useAppStore((s) => s.groups.dialog?.pending ?? false);
  const deleteGroup = useAppStore((s) => s.deleteGroup);
  const close = useAppStore((s) => s.cancelGroupDialog);
  const { playlists } = useSuspenseQuery(playlistsQuery(orgId)).data;
  const names = new Map(playlists.map((p) => [p.id, p.name]));
  const blocked = blockedBy.length > 0;
  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {group.name}?</DialogTitle>
          <DialogDescription>Its screens stay; only the group goes. A schedule entry aimed at it must be removed or aimed elsewhere first.</DialogDescription>
        </DialogHeader>
        {blocked ? (
          // The refusal's own words name the group by id: the dialog says it in the page's.
          <div role="alert" className="space-y-2 text-sm">
            <p className="font-medium text-destructive">
              {blockedBy.length === 1 ? '1 schedule entry is' : `${blockedBy.length} schedule entries are`} aimed at {group.name}. Remove{' '}
              {blockedBy.length === 1 ? 'it' : 'them'} or aim {blockedBy.length === 1 ? 'it' : 'them'} elsewhere, then delete the group.
            </p>
            <ul aria-label="Entries aimed at it" className="list-disc space-y-1 pl-5">
              {blockedBy.map((id) => {
                const e = entries.find((x) => x.id === id);
                return <li key={id}>{e ? entryText(e, names) : `Entry ${id}`}</li>;
              })}
            </ul>
          </div>
        ) : (
          <Refused />
        )}
        <DialogFooter>
          {/* While its delete runs, Cancel waits for it (the store ignores it), and says so. */}
          <Button type="button" variant="outline" onClick={close} aria-disabled={pending || undefined} className={cn(pending && 'opacity-60')}>
            Cancel
          </Button>
          {blocked ? (
            <Button asChild>
              {/* The refusal goes with the dialog: back here, a delete asks again what blocks it. */}
              <Link to="/schedule" onClick={close}>
                Open the schedule
              </Link>
            </Button>
          ) : (
            <Button type="button" variant="destructive" onClick={() => void deleteGroup(orgId)} aria-disabled={pending || undefined}>
              {pending && <LoaderCircleIcon className="animate-spin" aria-hidden />} Delete
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A searchable checklist of the screens (retired ones left out): tick those in the group. */
function MembersDialog({ orgId, group, screens }: { orgId: string; group: GroupView; screens: ScreenView[] }) {
  const save = useAppStore((s) => s.saveGroupMembers);
  const close = useAppStore((s) => s.cancelGroupDialog);
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    void save(orgId, group);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Screens in {group.name}</DialogTitle>
          <DialogDescription>Tick the screens to have in the group. A change reaches screens at the next publish.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3">
          <ScreenChecklist group={group} screens={screens} />
          <Refused />
          <SaveButtons action="Save" />
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Cancel and the dialog's action: while it runs, Cancel waits for it (the store ignores it), so a save is all or nothing. */
function SaveButtons({ action }: { action: string }) {
  const pending = useAppStore((s) => s.groups.dialog?.pending ?? false);
  const close = useAppStore((s) => s.cancelGroupDialog);
  return (
    <DialogFooter>
      <Button type="button" variant="outline" onClick={close} aria-disabled={pending || undefined} className={cn(pending && 'opacity-60')}>
        Cancel
      </Button>
      <Button type="submit" aria-disabled={pending || undefined}>
        {pending && <LoaderCircleIcon className="animate-spin" aria-hidden />} {action}
      </Button>
    </DialogFooter>
  );
}

/** A smart group's rule: its conditions, and the screens they match now. */
function RuleDialog({ orgId, group, screens }: { orgId: string; group: GroupView; screens: ScreenView[] }) {
  const { keys } = useSuspenseQuery(labelKeysQuery(orgId)).data;
  const save = useAppStore((s) => s.saveGroupRule);
  const close = useAppStore((s) => s.cancelGroupDialog);
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    void save(orgId, group);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{group.name}’s rule</DialogTitle>
          <DialogDescription>Its screens are the ones whose labels meet every condition, as they are at each publish.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3">
          <RuleBuilder screens={screens} keys={keys} />
          <Refused />
          <SaveButtons action="Save" />
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A group made here: named, then its screens ticked or a rule that matches them. */
function NewGroupDialog({ orgId, screens }: { orgId: string; screens: ScreenView[] }) {
  const id = useId();
  const dialog = useAppStore((s) => s.groups.dialog);
  const { keys } = useSuspenseQuery(labelKeysQuery(orgId)).data;
  const name = useAppStore((s) => s.typeNewGroupName);
  const choose = useAppStore((s) => s.chooseNewGroupKind);
  const create = useAppStore((s) => s.createGroup);
  const close = useAppStore((s) => s.cancelGroupDialog);
  if (dialog?.kind !== 'new') return null;
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    void create(orgId);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New group</DialogTitle>
          <DialogDescription>A set of screens a schedule entry or a brand kit can aim at. It reaches them at the next publish.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input id={`${id}-name`} value={dialog.name} onChange={(e) => name(e.target.value)} maxLength={100} placeholder="North drive-thru" />
          </div>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Which screens</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ['list', 'These screens', 'Tick them: the group keeps them until you change it.'],
                  ['rule', 'Screens that match…', 'A rule on their labels: screens labelled to match join it.'],
                ] as const
              ).map(([how, title, words]) => (
                <label key={how} className={choiceVariants({ className: 'flex cursor-pointer items-start gap-2.5 rounded-lg p-3 text-sm' })}>
                  <input type="radio" name={`${id}-how`} checked={dialog.how === how} onChange={() => choose(how)} className="mt-1 accent-primary" />
                  <span className="grid gap-0.5">
                    <span className="font-semibold">{title}</span>
                    <span className="text-meta text-muted-foreground">{words}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {dialog.how === 'list' ? <ScreenChecklist group={{ screenIds: [] }} screens={screens} /> : <RuleBuilder screens={screens} keys={keys} />}
          <Refused />
          <SaveButtons action="Create group" />
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The screens, searchable, each ticked as the open dialog has it: a group's members, or a new group's. */
function ScreenChecklist({ group, screens }: { group: Pick<GroupView, 'screenIds'>; screens: ScreenView[] }) {
  const id = useId();
  const dialog = useAppStore((s) => s.groups.dialog);
  const pending = useAppStore((s) => s.groups.dialog?.pending ?? false);
  const search = useAppStore((s) => s.searchGroupMembers);
  const choose = useAppStore((s) => s.chooseGroupMember);
  if (dialog?.kind !== 'members' && dialog?.kind !== 'new') return null;
  const q = dialog.query.trim().toLowerCase();
  const listed = screens.filter((s) => s.name.toLowerCase().includes(q)).toSorted(byName);
  return (
    <>
      <div className="relative">
        <Label htmlFor={id} className="sr-only">
          Search screens
        </Label>
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          id={id}
          type="search"
          placeholder="Search by name"
          value={dialog.query}
          onChange={(e) => search(e.target.value)}
          className="pl-9"
          aria-describedby={`${id}-count`}
        />
      </div>
      <p id={`${id}-count`} className="text-meta text-muted-foreground" aria-live="polite">
        {screens.filter((s) => memberChecked(dialog, group, s.id)).length} of {plural(screens.length, 'screen')} chosen{q && ` · ${listed.length} shown`}
      </p>
      <fieldset className={cn('max-h-[50dvh] overflow-y-auto rounded-lg border', pending && 'opacity-60')}>
        <legend className="sr-only">Screens</legend>
        {listed.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">No screen matches.</p>
        ) : (
          listed.map((s) => (
            <label key={s.id} className="flex min-h-11 items-center gap-3 border-b px-3 text-sm last:border-b-0 hover:bg-muted/50">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={memberChecked(dialog, group, s.id)}
                onChange={(e) => choose(s.id, e.target.checked)}
                // While Save runs the store takes no change; the boxes say so.
                aria-disabled={pending || undefined}
              />
              {s.name}
            </label>
          ))
        )}
      </fieldset>
    </>
  );
}
