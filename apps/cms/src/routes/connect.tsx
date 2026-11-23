/**
 * Connecting an agent (M4-05, the AgentConsent board): the page the OAuth provider sends a person
 * to, both signed out (its login page) and signed in (its consent page), with its signed query as
 * the whole search. Signed out, it sends them through sign-in and back here. Outside the signed-in
 * layout: the connection picks its own org, whichever the session has active. The provider's query
 * is read from the request as it signed it and carried as one parameter, `q`, from then on.
 */
import { createFileRoute, redirect } from '@tanstack/react-router';
import { BotIcon, TriangleAlertIcon } from 'lucide-react';
import { useId } from 'react';
import { EditorFields } from '~/components/editor';
import { Logo } from '~/components/logo';
import { Alert, AlertDescription } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { NativeSelect } from '~/components/ui/select';
import { CONNECT_SCOPES, type ConnectRequest, type ConnectScope, SCOPE_WORDS, startsOn } from '~/lib/connect';
import { getConnectRequest, getSignedQuery } from '~/server/connect.functions';
import { useAppStore } from '~/state/provider';

export const Route = createFileRoute('/connect')({
  // The provider's signed query, carried whole as `q` once the page has read it (`getSignedQuery`).
  validateSearch: (search: Record<string, unknown>): { q?: string } => (typeof search.q === 'string' ? { q: search.q } : {}),
  loaderDeps: ({ search }) => ({ q: search.q }),
  loader: async ({ deps, location }) => {
    if (deps.q === undefined) throw redirect({ to: '/connect', search: { q: await getSignedQuery() }, replace: true });
    const read = await getConnectRequest({ data: deps.q });
    if (!read.ok && read.signedOut) throw redirect({ to: '/sign-in', search: { redirect: location.href } });
    return { oauthQuery: deps.q, read };
  },
  head: () => ({ meta: [{ title: 'Connect an agent · SignForge' }] }),
  component: ConnectPage,
});

const ROLE_NAMES = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' } as const;

function ConnectPage() {
  const { oauthQuery, read } = Route.useLoaderData();
  return (
    <div className="flex min-h-dvh flex-col items-center gap-5 bg-background px-4 py-12 text-foreground">
      <Logo />
      {read.ok ? (
        <Consent request={read.request} oauthQuery={oauthQuery} />
      ) : (
        <main className="w-full max-w-[560px] rounded-[14px] border bg-card p-7">
          <h1 className="text-[22px] font-semibold tracking-tight">This request can’t be used</h1>
          <p className="mt-2 text-sm text-muted-foreground">{read.message} Go back to the app and connect again.</p>
        </main>
      )}
    </div>
  );
}

function Consent({ request, oauthQuery }: { request: ConnectRequest; oauthQuery: string }) {
  const { client, user, orgs } = request;
  const orgFieldId = useId();
  const picked = useAppStore((s) => s.agentConnect.orgId);
  const turned = useAppStore((s) => s.agentConnect.turned);
  const pending = useAppStore((s) => s.agentConnect.pending);
  const error = useAppStore((s) => s.agentConnect.error);
  const pickConnectOrg = useAppStore((s) => s.pickConnectOrg);
  const turnConnectScope = useAppStore((s) => s.turnConnectScope);
  const allowConnection = useAppStore((s) => s.allowConnection);
  const cancelConnection = useAppStore((s) => s.cancelConnection);

  const org = orgs.find((o) => o.orgId === picked) ?? orgs[0];
  const offered = CONNECT_SCOPES.filter((s) => org?.scopes.includes(s));
  const isOn = (s: ConnectScope) => s === 'content:read' || (turned[s] ?? startsOn(s));
  const chosen = offered.filter(isOn);
  const publishing = chosen.includes('content:publish');
  const busy = pending !== null;
  const cancel = () => void cancelConnection(oauthQuery);

  return (
    <>
      <main className="flex w-full max-w-[560px] flex-col gap-[22px] rounded-[14px] border bg-card p-7">
        <div className="flex items-center gap-3.5">
          <span aria-hidden className="flex size-9 flex-none items-center justify-center rounded-[10px] bg-foreground text-background">
            <BotIcon className="size-4" />
          </span>
          <div className="flex flex-col gap-0.5">
            <h1 className="text-[22px] font-semibold tracking-tight">{client.name} wants to work in SignForge</h1>
            <span className="text-sm text-muted-foreground">
              Signed in as {user.name || user.email}
              {org ? ` · ${ROLE_NAMES[org.role]}` : ''}
            </span>
          </div>
        </div>

        <p className="-mt-2 text-[13px] text-muted-foreground">
          {client.verified ? 'A SignForge app.' : 'Unverified: SignForge has not checked who made this app.'} It sends you back to{' '}
          <span className="font-mono">{client.redirectHost}</span>.
        </p>

        {org ? (
          <EditorFields>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={orgFieldId} className="font-semibold">
                Organisation
              </label>
              <NativeSelect id={orgFieldId} className="w-full" value={org.orgId} onChange={(e) => pickConnectOrg(e.target.value)}>
                {orgs.map((o) => (
                  <option key={o.orgId} value={o.orgId}>
                    {o.role === 'owner' ? o.name : `${o.name} (${ROLE_NAMES[o.role]})`}
                  </option>
                ))}
              </NativeSelect>
              <span className="text-[13px] text-muted-foreground">The connection works in this organisation only. Connect again for another.</span>
            </div>

            {offered.length ? (
              <fieldset className="flex flex-col gap-0.5">
                <legend className="mb-2 font-semibold">It may</legend>
                {offered.map((s) => (
                  <label key={s} className={`flex cursor-pointer items-start gap-3 rounded-[10px] p-3 ${isOn(s) ? 'bg-accent' : ''}`}>
                    <input
                      type="checkbox"
                      className="mt-px size-5 flex-none accent-primary"
                      checked={isOn(s)}
                      disabled={s === 'content:read'}
                      onChange={(e) => turnConnectScope(s, e.target.checked)}
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="font-semibold">
                        {SCOPE_WORDS[s].title} <span className="font-mono text-xs font-normal text-muted-foreground">{s}</span>
                      </span>
                      <span className="text-[13px] leading-snug text-muted-foreground">
                        {SCOPE_WORDS[s].desc}
                        {s === 'content:publish' ? ` You can grant it because you are an ${ROLE_NAMES[org.role]}.` : ''}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : (
              <p className="text-sm text-muted-foreground">
                Nothing {client.name} asked for is open to you in {org.name}. Pick another organisation, or cancel.
              </p>
            )}

            {publishing ? (
              <p
                role="status"
                className="flex gap-2.5 rounded-[10px] border border-status-updating bg-status-updating-muted px-3.5 py-3 text-sm leading-snug text-status-updating-foreground"
              >
                <TriangleAlertIcon className="mt-0.5 size-4 flex-none" aria-hidden />
                <span>
                  {client.name} will be able to change what every screen in {org.name} shows without asking. Each publish is in the audit log and can be undone.
                </span>
              </p>
            ) : (
              <p className="text-sm leading-snug text-muted-foreground">
                Without publishing, {client.name}’s changes stay drafts until someone who may publish in {org.name} publishes them.
              </p>
            )}

            {error ? (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" size="lg" aria-disabled={busy} onClick={busy ? undefined : cancel}>
                Cancel
              </Button>
              <Button
                type="button"
                size="lg"
                aria-disabled={busy || !chosen.length}
                onClick={busy || !chosen.length ? undefined : () => void allowConnection(oauthQuery, org.orgId, chosen)}
              >
                Allow
              </Button>
            </div>
          </EditorFields>
        ) : (
          <EditorFields>
            <p className="text-sm text-muted-foreground">You are not in an organisation yet, so there is nowhere to connect {client.name} to.</p>
            <div className="flex justify-end">
              <Button type="button" variant="outline" size="lg" aria-disabled={busy} onClick={busy ? undefined : cancel}>
                Cancel
              </Button>
            </div>
          </EditorFields>
        )}
      </main>
      <p className="max-w-[520px] text-center text-[13px] text-muted-foreground">
        You can change these scopes or disconnect {client.name} at any time in Settings › API &amp; agents.
      </p>
    </>
  );
}
