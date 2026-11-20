/**
 * Where an invitation email's link lands (M3-09's `/accept-invitation/<id>`). Outside the signed-in
 * layout, because an invitee may belong to no org yet. Signed out, it sends them to sign in and
 * back. Better Auth checks the invitation is theirs, open and unexpired.
 */
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { Logo } from '~/components/logo';
import { ActionError, useRunning } from '~/components/settings/parts';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { getInvitation } from '~/server/settings.functions';
import { getShell } from '~/server/shell.functions';
import { useAppStore } from '~/state/provider';

export const Route = createFileRoute('/accept-invitation/$invitationId')({
  loader: async ({ params, location }) => {
    const shell = await getShell();
    if (!shell) throw redirect({ to: '/sign-in', search: { redirect: location.href } });
    const invitation = await getInvitation({ data: params.invitationId });
    return { invitation, open: invitation?.status === 'pending' && Date.parse(invitation.expiresAt) > Date.now(), email: shell.user.email };
  },
  head: () => ({ meta: [{ title: 'Invitation · SignForge' }] }),
  component: InvitationPage,
});

function InvitationPage() {
  const { invitation, open, email } = Route.useLoaderData();
  const pending = useRunning({ page: 'invitation', orgId: null }) !== undefined;
  const acceptInvitation = useAppStore((s) => s.acceptInvitation);
  const declineInvitation = useAppStore((s) => s.declineInvitation);
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4 py-10">
      <div className="w-full max-w-md space-y-6">
        <Logo />
        <Card>
          {invitation && open ? (
            <>
              <CardHeader>
                <CardTitle>Join {invitation.organizationName}</CardTitle>
                <CardDescription>
                  {invitation.inviterEmail} invited you as {invitation.role}.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <ActionError at="invitation" />
                <div className="flex gap-2">
                  <Button disabled={pending} onClick={() => void acceptInvitation(invitation.id)}>
                    Accept
                  </Button>
                  <Button variant="outline" disabled={pending} onClick={() => void declineInvitation(invitation.id)}>
                    Decline
                  </Button>
                </div>
              </CardContent>
            </>
          ) : (
            <>
              <CardHeader>
                <CardTitle>This invitation can't be used</CardTitle>
                <CardDescription>
                  It may have expired, been revoked or used, or been sent to another address than {email}. Ask whoever invited you to send a new one.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild variant="outline">
                  <Link to="/">Go to SignForge</Link>
                </Button>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </main>
  );
}
