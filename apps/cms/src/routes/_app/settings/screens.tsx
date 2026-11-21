/**
 * Settings, Screens & groups (canvas board SettingsScreens): the update window, how long a
 * screen may go without a heartbeat before it alerts, and the groups: each with its screens and
 * what targets it (schedule entries, brand kits), renamed, deleted or given its screens here.
 */
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { EllipsisIcon, LoaderCircleIcon, RotateCwIcon, SearchIcon } from 'lucide-react';
import { useId, type ReactNode, type SubmitEvent } from 'react';
import { EditorFields } from '~/components/editor';
import { PageHeader } from '~/components/page';
import { SaveRow, SettingsSection } from '~/components/settings/parts';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '~/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '~/components/ui/dropdown-menu';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { targetsOf } from '~/lib/groups';
import { useCanManage, useNow, useOrgId, useRole } from '~/lib/live';
import { describeWhen, type ScheduleEntryView } from '~/lib/schedule';
import { isRetired } from '~/lib/screen-status';
import type { GroupView, ScreenView } from '~/lib/screen-types';
import { playlistsQuery } from '~/queries/playlists';
import { scheduleQuery } from '~/queries/schedule';
import { screensQuery } from '~/queries/screens';
import { brandKitsQuery } from '~/queries/spots';
import { getOrgSettings } from '~/server/settings.functions';
import { useAppStore } from '~/state/provider';
import { editsIn, type SettingsEdits } from '~/state/settings';

export const Route = createFileRoute('/_app/settings/screens')({
  loader: async ({ context: { queryClient }, parentMatchPromise }) => {
    const orgId = (await parentMatchPromise).loaderData?.orgId;
    const [settings] = await Promise.all([
      getOrgSettings(),
      orgId &&
        Promise.all([
          queryClient.query(screensQuery(orgId)),
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
  const edit = (change: SettingsEdits) => editSettings(orgId, 'screens', settings.version, change);

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (settings) void saveSettings(orgId, 'screens', settings);
  }

  return (
    <div className="space-y-6">
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
                  disabled={!canEdit}
                  className="w-36"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-to`}>To</Label>
                <Input
                  id={`${id}-to`}
                  name="to"
                  type="time"
                  value={edits.updateTo ?? settings.updateWindow.to}
                  onChange={(e) => edit({ updateTo: e.target.value })}
                  disabled={!canEdit}
                  className="w-36"
                />
              </div>
            </div>
            <p className="text-[13px] text-muted-foreground">Local time at each screen. A window that ends before it starts runs past midnight.</p>
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
                disabled={!canEdit}
                className="w-24"
                aria-describedby={`${id}-minutes-unit`}
              />
              <span id={`${id}-minutes-unit`} className="text-sm">
                minutes without a heartbeat
              </span>
            </div>
            <p className="text-[13px] text-muted-foreground">
              Screens check in every 5 minutes. One email goes out when a screen passes this, and one when it is back.{' '}
              <Link to="/settings/notifications" className="text-primary underline underline-offset-4">
                Choose who gets these alerts
              </Link>
              .
            </p>
          </SettingsSection>

          <SaveRow at="screens" scope={{ page: 'screens', orgId }} canEdit={canEdit} />
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
  const active = screens.filter((s) => !isRetired(s));
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
          , a screen&apos;s settings, or its Members here.
        </>
      }
    >
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">No groups yet. Make one from a screen&apos;s Settings and groups.</p>
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
                {groups.map((g) => {
                  const targets = targetsOf(g.id, entries, brandKits, now);
                  const members = g.screenIds.filter((id) => pickable.includes(id)).length;
                  return (
                    <tr key={g.id} className="border-t">
                      <th scope="row" className="py-2.5 pr-3 text-left font-semibold">
                        <Link to="/screens" search={{ group: g.id }} className="hover:underline">
                          {g.name}
                        </Link>
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
                              <DropdownMenuItem onSelect={() => openGroupMembers(orgId, g, pickable)}>Members…</DropdownMenuItem>
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
    </SettingsSection>
  );
}

/** Why the dialog's last action was refused. */
function Refused({ children }: { children?: ReactNode }) {
  const error = useAppStore((s) => s.groups.error);
  return (
    <div role="alert" className="space-y-2 text-sm font-medium text-destructive empty:hidden">
      {error && <p>{error}</p>}
      {error && children}
    </div>
  );
}

function RenameDialog({ orgId }: { orgId: string }) {
  const id = useId();
  const draft = useAppStore((s) => s.groups.renames.dialog);
  const nameGroup = useAppStore((s) => s.nameGroup);
  const renameGroup = useAppStore((s) => s.renameGroup);
  const reload = useAppStore((s) => s.reloadGroupRename);
  const close = useAppStore((s) => s.closeGroupDialog);
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
            <Input id={id} value={draft.edit.name} onChange={(e) => nameGroup(e.target.value)} maxLength={100} required />
          </div>
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm font-medium text-destructive empty:hidden">
            {draft.error}
            {draft.stale && (
              <Button type="button" variant="outline" size="sm" onClick={() => void reload(orgId)}>
                <RotateCwIcon aria-hidden /> Reload
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
  const pending = useAppStore((s) => s.groups.pending);
  const deleteGroup = useAppStore((s) => s.deleteGroup);
  const close = useAppStore((s) => s.closeGroupDialog);
  const { playlists } = useSuspenseQuery(playlistsQuery(orgId)).data;
  const names = new Map(playlists.map((p) => [p.id, p.name]));
  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {group.name}?</DialogTitle>
          <DialogDescription>Its screens stay; only the group goes. A schedule entry aimed at it must be removed or aimed elsewhere first.</DialogDescription>
        </DialogHeader>
        <Refused>
          {blockedBy.length > 0 && (
            <ul aria-label="Entries aimed at it" className="list-disc space-y-1 pl-5 font-normal text-foreground">
              {blockedBy.map((id) => {
                const e = entries.find((x) => x.id === id);
                return (
                  <li key={id}>
                    <Link to="/schedule" className="underline underline-offset-4">
                      {e ? entryText(e, names) : `Entry ${id}`}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Refused>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={() => void deleteGroup(orgId)} aria-disabled={pending || undefined}>
            {pending && <LoaderCircleIcon className="animate-spin" aria-hidden />} Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A searchable checklist of the screens (retired ones left out): tick those in the group. */
function MembersDialog({ orgId, group, screens }: { orgId: string; group: GroupView; screens: ScreenView[] }) {
  const id = useId();
  const dialog = useAppStore((s) => s.groups.dialog);
  const pending = useAppStore((s) => s.groups.pending);
  const search = useAppStore((s) => s.searchGroupMembers);
  const choose = useAppStore((s) => s.chooseGroupMember);
  const save = useAppStore((s) => s.saveGroupMembers);
  const close = useAppStore((s) => s.closeGroupDialog);
  if (dialog?.kind !== 'members') return null;
  const q = dialog.query.trim().toLowerCase();
  const listed = screens.filter((s) => s.name.toLowerCase().includes(q)).toSorted((a, b) => a.name.localeCompare(b.name));
  const pickable = screens.map((s) => s.id);
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    void save(orgId, group, pickable);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Screens in {group.name}</DialogTitle>
          <DialogDescription>Tick the screens to have in the group. A change reaches screens at the next publish.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3">
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
          <p id={`${id}-count`} className="text-[13px] text-muted-foreground" aria-live="polite">
            {dialog.chosen.length} of {plural(screens.length, 'screen')} chosen{q && ` · ${listed.length} shown`}
          </p>
          <fieldset className="max-h-[50dvh] overflow-y-auto rounded-lg border">
            <legend className="sr-only">Screens</legend>
            {listed.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">No screen matches.</p>
            ) : (
              listed.map((s) => (
                <label key={s.id} className="flex min-h-11 items-center gap-3 border-b px-3 text-sm last:border-b-0 hover:bg-muted/50">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={dialog.chosen.includes(s.id)}
                    onChange={(e) => choose(s.id, e.target.checked)}
                  />
                  {s.name}
                </label>
              ))
            )}
          </fieldset>
          <Refused />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" aria-disabled={pending || undefined}>
              {pending && <LoaderCircleIcon className="animate-spin" aria-hidden />} Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
