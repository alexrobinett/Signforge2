/**
 * Settings, Members & roles (canvas board SettingsMembers): invite by email, invites waiting for
 * a reply, each member's role, and removing someone. Roles are owner, editor and viewer (M3-09);
 * the canvas's "admin" and per-location access are not in v1. Owners also choose whether editors
 * publish (Q7). Only owners change any of it, and Better Auth and the tools check that again on
 * every call.
 */
import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import { CheckIcon, LoaderCircleIcon, MinusIcon } from 'lucide-react';
import { useId, type SubmitEvent } from 'react';
import { EditorFields } from '~/components/editor';
import { PageHeader } from '~/components/page';
import { ActionError, SaveRow, SettingsSection, useRunning } from '~/components/settings/parts';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { NativeSelect } from '~/components/ui/select';
import { useOrgId, useRole } from '~/lib/live';
import { isRole, roleTable, ROLES, type Invitation, type Member, type OrgSettings } from '~/lib/settings';
import { backToPage } from '~/server/form-post.server';
import { getMembers, getOrgSettings } from '~/server/settings.functions';
import type { Role } from '~/server/shell.functions';
import { useAppStore } from '~/state/provider';
import { editsIn, type SettingsScope } from '~/state/settings';

export const Route = createFileRoute('/_app/settings/members')({
  server: { handlers: backToPage },
  loader: async () => {
    const [people, settings] = await Promise.all([getMembers(), getOrgSettings()]);
    return { ...people, settings };
  },
  head: () => ({ meta: [{ title: 'Members & roles · SignForge' }] }),
  component: MembersSettings,
});

const app = getRouteApi('/_app');
const roleLabel = (role: Role) => ROLES.find((r) => r.value === role)?.label ?? role;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** What runs on this page in `orgId`: one action at a time. */
const pageOf = (orgId: string): SettingsScope => ({ page: 'members', orgId });

function MembersSettings() {
  const { members, invitations, settings } = Route.useLoaderData();
  const isOwner = useRole() === 'owner';
  const id = useId();

  return (
    <>
      <PageHeader
        title="Members & roles"
        description={`${plural(members.length, 'person', 'people')}${isOwner ? ` · ${plural(invitations.length, 'invite', 'invites')} waiting` : ''}.`}
      />
      {isOwner && <InviteForm />}
      <SettingsSection id={`${id}-people`} title="People">
        <ul className="divide-y">
          {members.map((m) => (
            <MemberRow key={m.id} member={m} canEdit={isOwner} />
          ))}
        </ul>
      </SettingsSection>
      {invitations.length > 0 && (
        <SettingsSection id={`${id}-waiting`} title="Waiting for a reply">
          <ul className="divide-y">
            {invitations.map((i) => (
              <InvitationRow key={i.id} invitation={i} canEdit={isOwner} />
            ))}
          </ul>
        </SettingsSection>
      )}
      {settings && (
        <>
          <PublishingForm settings={settings} canEdit={isOwner} />
          <RoleTable editorsPublish={settings.editorsPublish} />
        </>
      )}
      <RemoveDialog />
    </>
  );
}

function InviteForm() {
  const id = useId();
  const orgId = useOrgId();
  const busy = useRunning(pageOf(orgId)) !== undefined;
  const inviteMembers = useAppStore((s) => s.inviteMembers);

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const raw = form.get('emails');
    const role = form.get('role');
    const emails = (typeof raw === 'string' ? raw : '')
      .split(/[\s,;]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (!isRole(role)) return;
    const field = e.currentTarget.elements.namedItem('emails');
    // Cleared once sent, unless other addresses were typed while it ran.
    void inviteMembers(orgId, emails, role).then((sent) => {
      if (sent && field instanceof HTMLInputElement && field.value === raw) field.value = '';
    });
  }

  return (
    <SettingsSection id={`${id}-invite`} title="Invite" description="Each address gets an email with a link to join.">
      <form method="post" onSubmit={submit} className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-end" noValidate>
        <EditorFields>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-emails`}>Emails, separated by commas</Label>
            <Input id={`${id}-emails`} name="emails" type="text" inputMode="email" autoComplete="off" placeholder="sam@example.com, alex@example.com" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-role`}>Role</Label>
            <NativeSelect id={`${id}-role`} name="role" defaultValue="editor">
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Button type="submit" aria-disabled={busy || undefined}>
            Send invites
          </Button>
          <div className="sm:col-span-3">
            <ActionError at="invite" />
          </div>
        </EditorFields>
      </form>
    </SettingsSection>
  );
}

function MemberRow({ member, canEdit }: { member: Member; canEdit: boolean }) {
  const me = app.useLoaderData().user.id;
  const orgId = useOrgId();
  const running = useRunning(pageOf(orgId));
  const busy = running !== undefined;
  const removing = running === `remove:${member.id}`;
  const role = useAppStore((s) => (s.settings.roleChange?.memberId === member.id ? s.settings.roleChange.role : member.role));
  const changeMemberRole = useAppStore((s) => s.changeMemberRole);
  const askToRemoveMember = useAppStore((s) => s.askToRemoveMember);
  const display = member.user.name || member.user.email;
  const self = member.userId === me;

  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">
            {display}
            {self && <span className="ml-2 text-sm font-normal text-muted-foreground">(you)</span>}
          </p>
          {member.user.name && <p className="truncate text-sm text-muted-foreground">{member.user.email}</p>}
        </div>
        {canEdit ? (
          <div className="flex items-center gap-2">
            <EditorFields>
              <NativeSelect
                aria-label={`Role for ${display}`}
                value={role}
                // Not disabled while an action runs: a disabled select loses keyboard focus. A change then is ignored.
                aria-disabled={busy || undefined}
                onChange={(e) => {
                  if (isRole(e.target.value)) void changeMemberRole(orgId, member.id, e.target.value);
                }}
                className="w-36"
              >
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </NativeSelect>
              {!self && (
                <Button variant="ghost" className="text-destructive" aria-disabled={busy || undefined} onClick={() => askToRemoveMember(orgId, member)}>
                  {removing && <LoaderCircleIcon className="animate-spin" aria-hidden />} {removing ? 'Removing…' : 'Remove'}
                </Button>
              )}
            </EditorFields>
          </div>
        ) : (
          <span className="text-sm">{roleLabel(member.role)}</span>
        )}
      </div>
      <ActionError at={`role:${member.id}`} />
      {/* A removal goes on with its dialog closed: how it went shows here too. */}
      <ActionError at={`remove:${member.id}`} />
    </li>
  );
}

function InvitationRow({ invitation, canEdit }: { invitation: Invitation; canEdit: boolean }) {
  const orgId = useOrgId();
  const busy = useRunning(pageOf(orgId)) !== undefined;
  const resendInvitation = useAppStore((s) => s.resendInvitation);
  const cancelInvitation = useAppStore((s) => s.cancelInvitation);
  const expires = new Date(invitation.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{invitation.email}</p>
          <p className="text-sm text-muted-foreground">
            {roleLabel(invitation.role)} · link works until {expires}
          </p>
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              aria-disabled={busy || undefined}
              onClick={() => void resendInvitation(orgId, invitation.email, invitation.role)}
            >
              Resend
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              aria-disabled={busy || undefined}
              onClick={() => void cancelInvitation(orgId, invitation.id)}
            >
              Revoke
            </Button>
          </div>
        )}
      </div>
      <ActionError at={`cancel:${invitation.id}`} />
      <ActionError at={`resend:${invitation.email}`} />
    </li>
  );
}

function PublishingForm({ settings, canEdit }: { settings: OrgSettings; canEdit: boolean }) {
  const id = useId();
  const orgId = useOrgId();
  const edited = useAppStore((s) => editsIn(s.settings, 'publishing', orgId, settings.version).editorsPublish);
  const editSettings = useAppStore((s) => s.editSettings);
  const saveSettings = useAppStore((s) => s.saveSettings);

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    void saveSettings(orgId, 'publishing', settings);
  }

  return (
    <form onSubmit={submit} noValidate>
      <EditorFields>
        <SettingsSection
          id={`${id}-publishing`}
          title="Who publishes"
          description="Owners always publish to screens. Turn this off and editors still edit spots, playlists and assets, and pair, restart and rename screens, but only owners publish."
        >
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              name="editorsPublish"
              checked={edited ?? settings.editorsPublish}
              onChange={(e) => editSettings(orgId, 'publishing', settings.version, { editorsPublish: e.target.checked })}
              disabled={!canEdit}
              aria-describedby={`${id}-publishing-help`}
              className="mt-0.5 size-5 shrink-0 accent-primary"
            />
            <span>
              <span className="block font-medium">Editors can publish</span>
              <span id={`${id}-publishing-help`} className="block text-muted-foreground">
                Their connected agents follow the same rule.
              </span>
            </span>
          </label>
          <SaveRow at="publishing" scope={pageOf(orgId)} canEdit={canEdit} label="Save" />
        </SettingsSection>
      </EditorFields>
    </form>
  );
}

function RoleTable({ editorsPublish }: { editorsPublish: boolean }) {
  const id = useId();
  const mark = (yes: boolean) =>
    yes ? <CheckIcon className="mx-auto size-4" aria-label="Yes" /> : <MinusIcon className="mx-auto size-4 text-muted-foreground" aria-label="No" />;
  return (
    <SettingsSection id={`${id}-roles`} title="What each role can do">
      <section
        aria-label="What each role can do"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: it scrolls at phone width and holds nothing focusable, so it takes focus itself, else a keyboard cannot scroll it (WCAG 2.1.1).
        tabIndex={0}
        className="overflow-x-auto rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <table className="w-full min-w-[28rem] text-sm">
          <thead className="text-muted-foreground">
            <tr>
              <th scope="col" className="py-2 pr-3 text-left font-medium">
                <span className="sr-only">Permission</span>
              </th>
              {ROLES.map((r) => (
                <th key={r.value} scope="col" className="px-3 py-2 text-center font-medium">
                  {r.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {roleTable(editorsPublish).map((row) => (
              <tr key={row.what}>
                <th scope="row" className="py-2 pr-3 text-left font-normal">
                  {row.what}
                </th>
                <td className="px-3 py-2">{mark(row.owner)}</td>
                <td className="px-3 py-2">{mark(row.editor)}</td>
                <td className="px-3 py-2">{mark(row.viewer)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </SettingsSection>
  );
}

function RemoveDialog() {
  const orgId = useOrgId();
  const member = useAppStore((s) => (s.settings.removing?.orgId === orgId ? s.settings.removing.member : null));
  const running = useRunning(pageOf(orgId));
  const askToRemoveMember = useAppStore((s) => s.askToRemoveMember);
  const removeMember = useAppStore((s) => s.removeMember);
  const display = member ? member.user.name || member.user.email : '';
  const removing = member !== null && running === `remove:${member.id}`;

  return (
    <AlertDialog open={member !== null} onOpenChange={(open) => !open && askToRemoveMember(orgId, null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {display}?</AlertDialogTitle>
          <AlertDialogDescription>They lose access to this organization at once. You can invite them again later.</AlertDialogDescription>
        </AlertDialogHeader>
        {/* Once sent, a removal cannot be called back; closing the dialog leaves it running, its row saying so. */}
        <p role="status" className="text-sm empty:hidden">
          {removing && 'Removing… Waiting for SignForge to answer. You can close this; it goes on.'}
        </p>
        {member && <ActionError at={`remove:${member.id}`} />}
        <AlertDialogFooter>
          <AlertDialogCancel>{removing ? 'Close' : 'Cancel'}</AlertDialogCancel>
          <Button variant="destructive" aria-disabled={running !== undefined || undefined} onClick={() => member && void removeMember(orgId, member.id)}>
            {removing && <LoaderCircleIcon className="animate-spin" aria-hidden />} {removing ? 'Removing…' : 'Remove'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
