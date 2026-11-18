/**
 * Settings, Members & roles (canvas board SettingsMembers): invite by email, invites waiting for
 * a reply, each member's role, and removing someone. Roles are owner, editor and viewer (M3-09);
 * the canvas's "admin" and per-location access are not in v1. Owners also choose whether editors
 * publish (Q7). Only owners change any of it, and Better Auth and the tools check that again on
 * every call.
 */
import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import { CheckIcon, MinusIcon } from 'lucide-react';
import { useId, type SubmitEvent } from 'react';
import { PageHeader } from '~/components/page';
import { ActionError, SaveRow, SettingsSection } from '~/components/settings/parts';
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
import { useRole } from '~/lib/live';
import { isRole, roleTable, ROLES, type Invitation, type Member, type OrgSettings } from '~/lib/settings';
import { getMembers, getOrgSettings } from '~/server/settings.functions';
import type { Role } from '~/server/shell.functions';
import { useAppStore } from '~/state/provider';

export const Route = createFileRoute('/_app/settings/members')({
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
  const pending = useAppStore((s) => s.settings.pending === 'invite');
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
    const target = e.currentTarget;
    void inviteMembers(emails, role).then((sent) => sent && target.reset());
  }

  return (
    <SettingsSection id={`${id}-invite`} title="Invite" description="Each address gets an email with a link to join.">
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-end" noValidate>
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
        <Button type="submit" disabled={pending}>
          Send invites
        </Button>
        <div className="sm:col-span-3">
          <ActionError at="invite" />
        </div>
      </form>
    </SettingsSection>
  );
}

function MemberRow({ member, canEdit }: { member: Member; canEdit: boolean }) {
  const me = app.useLoaderData().user.id;
  const pending = useAppStore((s) => s.settings.pending === `role:${member.id}` || s.settings.pending === `remove:${member.id}`);
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
            <NativeSelect
              aria-label={`Role for ${display}`}
              value={member.role}
              disabled={pending}
              onChange={(e) => {
                if (isRole(e.target.value)) void changeMemberRole(member.id, e.target.value);
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
              <Button variant="ghost" className="text-destructive" disabled={pending} onClick={() => askToRemoveMember(member)}>
                Remove
              </Button>
            )}
          </div>
        ) : (
          <span className="text-sm">{roleLabel(member.role)}</span>
        )}
      </div>
      <ActionError at={`role:${member.id}`} />
    </li>
  );
}

function InvitationRow({ invitation, canEdit }: { invitation: Invitation; canEdit: boolean }) {
  const pending = useAppStore((s) => s.settings.pending === `resend:${invitation.email}` || s.settings.pending === `cancel:${invitation.id}`);
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
            <Button variant="outline" size="sm" disabled={pending} onClick={() => void resendInvitation(invitation.email, invitation.role)}>
              Resend
            </Button>
            <Button variant="ghost" size="sm" className="text-destructive" disabled={pending} onClick={() => void cancelInvitation(invitation.id)}>
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
  const saveEditorsPublish = useAppStore((s) => s.saveEditorsPublish);

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    void saveEditorsPublish(new FormData(e.currentTarget).get('editorsPublish') === 'on', settings.version);
  }

  return (
    <form key={settings.version} onSubmit={submit} noValidate>
      <SettingsSection
        id={`${id}-publishing`}
        title="Who publishes"
        description="Owners always publish to screens. Turn this off and editors still edit spots, playlists and screens, but an owner publishes their changes."
      >
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            name="editorsPublish"
            defaultChecked={settings.editorsPublish}
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
        <SaveRow at="publishing" canEdit={canEdit} label="Save" />
      </SettingsSection>
    </form>
  );
}

function RoleTable({ editorsPublish }: { editorsPublish: boolean }) {
  const id = useId();
  const mark = (yes: boolean) =>
    yes ? <CheckIcon className="mx-auto size-4" aria-label="Yes" /> : <MinusIcon className="mx-auto size-4 text-muted-foreground" aria-label="No" />;
  return (
    <SettingsSection id={`${id}-roles`} title="What each role can do">
      <div className="overflow-x-auto">
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
      </div>
    </SettingsSection>
  );
}

function RemoveDialog() {
  const member = useAppStore((s) => s.settings.removing);
  const pending = useAppStore((s) => (member ? s.settings.pending === `remove:${member.id}` : false));
  const askToRemoveMember = useAppStore((s) => s.askToRemoveMember);
  const removeMember = useAppStore((s) => s.removeMember);
  const display = member ? member.user.name || member.user.email : '';

  return (
    <AlertDialog open={member !== null} onOpenChange={(open) => !open && askToRemoveMember(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {display}?</AlertDialogTitle>
          <AlertDialogDescription>They lose access to this organization at once. You can invite them again later.</AlertDialogDescription>
        </AlertDialogHeader>
        {member && <ActionError at={`remove:${member.id}`} />}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={pending} onClick={() => member && void removeMember(member.id)}>
            Remove
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
