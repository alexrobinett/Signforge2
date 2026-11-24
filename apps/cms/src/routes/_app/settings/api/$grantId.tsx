/**
 * One connected agent (M4-07, canvas board AgentDetail): its scopes, which apply from its next call,
 * its recent changes with a link to the audit log filtered to it, and Disconnect. The member who
 * connected it may add any scope they hold themselves and remove any; an owner may remove scopes from
 * anyone's and disconnect it; the tools check both again (`update_agent_grant_scopes`). Its last 7
 * days come from the call log (M4-08, `get_agent_grant_usage`): its numbers, its last refusal and its
 * recent calls, reads included, each change linked to its row in the audit log.
 */
import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router';
import { ArrowLeftIcon, LoaderCircleIcon } from 'lucide-react';
import { useId } from 'react';
import { AgentName } from '~/components/agent-name';
import { EditorFields } from '~/components/editor';
import { ActionError, SettingsSection, useRunning } from '~/components/settings/parts';
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
import { type AgentCall, type AgentGrant, type AgentUsage, grantedOn, lastActive, outcome } from '~/lib/agents';
import { CONNECT_SCOPES, type ConnectScope, SCOPE_WORDS } from '~/lib/connect';
import { useOrgId } from '~/lib/live';
import { ago } from '~/lib/screen-status';
import { getAgent } from '~/server/agents.functions';
import { useAppStore } from '~/state/provider';
import type { SettingsScope } from '~/state/settings';

export const Route = createFileRoute('/_app/settings/api/$grantId')({
  loader: ({ params }) => getAgent({ data: params.grantId }),
  head: () => ({ meta: [{ title: 'Agent · SignForge' }] }),
  component: AgentPage,
});

const app = getRouteApi('/_app');
const pageOf = (orgId: string): SettingsScope => ({ page: 'agents', orgId });

function AgentPage() {
  const found = Route.useLoaderData();
  if (!found) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">This agent is not connected</h1>
        <p className="text-sm text-muted-foreground">It was disconnected, or it is not one you may see.</p>
        <BackLink />
      </div>
    );
  }
  const { grant, recent, week, mine, names, at } = found;
  return (
    <>
      <AgentHeader grant={grant} grantedBy={names[grant.grantedBy] ?? 'a former member'} at={at} />
      <Scopes grant={grant} mine={mine} grantedBy={names[grant.grantedBy] ?? 'the member who connected it'} />
      <LastWeek grantId={grant.id} week={week} at={at} />
      <RecentChanges grantId={grant.id} recent={recent} at={at} />
      <DisconnectDialog grant={grant} />
    </>
  );
}

function BackLink() {
  return (
    <Link to="/settings/api" className="inline-flex min-h-10 items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground">
      <ArrowLeftIcon className="size-4" aria-hidden /> API & agents
    </Link>
  );
}

function AgentHeader({ grant, grantedBy, at }: { grant: AgentGrant; grantedBy: string; at: number }) {
  const orgId = useOrgId();
  const askToDisconnectAgent = useAppStore((s) => s.askToDisconnectAgent);
  const busy = useRunning(pageOf(orgId)) !== undefined;
  return (
    <div className="space-y-3">
      <BackLink />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            <AgentName client={grant.client} />
          </h1>
          <p className="text-sm text-muted-foreground">
            {grant.client.verified ? 'A SignForge app' : 'Unverified: SignForge has not checked who made it'} · connected by {grantedBy} on{' '}
            {grantedOn(grant.createdAt)} · last active {lastActive(grant.lastUsedAt, at).toLowerCase()}
          </p>
        </div>
        <EditorFields>
          <Button
            type="button"
            variant="outline"
            className="shrink-0 text-destructive"
            aria-disabled={busy || undefined}
            onClick={() => askToDisconnectAgent(orgId, grant.id)}
          >
            Disconnect…
          </Button>
        </EditorFields>
      </div>
    </div>
  );
}

function Scopes({ grant, mine, grantedBy }: { grant: AgentGrant; mine: ConnectScope[]; grantedBy: string }) {
  const id = useId();
  const me = app.useLoaderData().user.id;
  const orgId = useOrgId();
  const running = useRunning(pageOf(orgId));
  const shown = useAppStore((s) => (s.settings.agentScopes?.grantId === grant.id ? s.settings.agentScopes.scopes : grant.scopes));
  const setAgentScopes = useAppStore((s) => s.setAgentScopes);
  const own = grant.grantedBy === me;

  /** Why a scope cannot be turned on here, if it cannot: content:read is always on. */
  const lockedOn = (s: ConnectScope): string | undefined => {
    if (s === 'content:read') return 'Always on: an agent can do nothing without it.';
    if (shown.includes(s)) return undefined;
    if (!own) return `Only ${grantedBy} can turn it on.`;
    if (!mine.includes(s)) return 'You cannot grant what you may not do yourself.';
    return undefined;
  };
  const turn = (s: ConnectScope, on: boolean) => {
    if (running !== undefined) return;
    const scopes = CONNECT_SCOPES.filter((x) => (x === s ? on : shown.includes(x)));
    void setAgentScopes(orgId, grant.id, scopes, grant.version);
  };

  return (
    <SettingsSection id={`${id}-scopes`} title="Scopes" description="Changes apply from its next call.">
      <EditorFields>
        <fieldset className="space-y-1">
          <legend className="sr-only">What it may do</legend>
          {CONNECT_SCOPES.map((s) => {
            const why = lockedOn(s);
            return (
              <label key={s} className={`flex items-start gap-3 rounded-[10px] p-3 ${shown.includes(s) ? 'bg-accent' : ''}`}>
                <input
                  type="checkbox"
                  className="mt-px size-5 flex-none accent-primary"
                  checked={shown.includes(s)}
                  disabled={why !== undefined}
                  // Not disabled while a change runs: a disabled box loses keyboard focus. A change then is ignored.
                  aria-disabled={running !== undefined || undefined}
                  aria-describedby={`${id}-${s}`}
                  onChange={(e) => turn(s, e.target.checked)}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="font-semibold">
                    {SCOPE_WORDS[s].title} <span className="font-mono text-xs font-normal text-muted-foreground">{s}</span>
                  </span>
                  <span id={`${id}-${s}`} className="text-[13px] leading-snug text-muted-foreground">
                    {why ?? SCOPE_WORDS[s].desc}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>
        <p role="status" className="text-sm text-muted-foreground empty:hidden">
          {running === `scopes:${grant.id}` && (
            <>
              <LoaderCircleIcon className="inline size-4 animate-spin" aria-hidden /> Saving…
            </>
          )}
        </p>
        <ActionError at={`scopes:${grant.id}`} />
      </EditorFields>
    </SettingsSection>
  );
}

function LastWeek({
  grantId,
  week,
  at,
}: {
  grantId: string;
  /** Null when the call log cannot be read. */
  week: { usage: AgentUsage; calls: AgentCall[]; lastRefusal: AgentCall | null } | null;
  at: number;
}) {
  const id = useId();
  if (!week) {
    return (
      <SettingsSection id={`${id}-week`} title="Last 7 days">
        <p className="text-sm text-muted-foreground">Its calls are not available just now. Its changes are below, from the audit log.</p>
      </SettingsSection>
    );
  }
  const { usage, calls, lastRefusal } = week;
  const numbers = [
    ['Tool calls', usage.calls],
    ['Changes', usage.changes],
    ['Drafts made', usage.drafts],
    ['Refused', usage.refusals],
  ] as const;
  return (
    <SettingsSection id={`${id}-week`} title="Last 7 days" description="Every call it made: what it called and how that ended, never what it sent or got back.">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {numbers.map(([label, n]) => (
          <div key={label} className="rounded-md border p-3">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-2xl font-semibold tabular-nums">{n.toLocaleString('en-US')}</dd>
          </div>
        ))}
      </dl>
      <div className="space-y-1 text-sm">
        <h3 className="font-medium">Last refusal</h3>
        {lastRefusal ? (
          <p>
            {ago(at - lastRefusal.at)} ago, calling <span className="font-mono text-xs">{lastRefusal.tool}</span>: {outcome(lastRefusal)}.
          </p>
        ) : (
          <p className="text-muted-foreground">None in the last 7 days.</p>
        )}
      </div>
      <div className="space-y-1 text-sm">
        <h3 className="font-medium">Recent calls</h3>
        {calls.length ? (
          <ul className="divide-y">
            {calls.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: two calls can share a millisecond, tool and ending, and the list is never reordered, so a call's place keys it.
              <li key={i} className="grid gap-1 py-2 sm:grid-cols-[6rem_minmax(0,1fr)_auto] sm:gap-4">
                <span className="text-muted-foreground">{ago(at - c.at)} ago</span>
                <span className="min-w-0">
                  <span className="font-mono text-xs">{c.tool}</span> <span className="text-muted-foreground">{outcome(c)}</span>
                </span>
                {c.target && (
                  <Link
                    to="/audit"
                    search={{ who: grantId, target: c.target.kind, targetId: c.target.id }}
                    className="font-medium underline underline-offset-4"
                  >
                    See the change<span className="sr-only"> by {c.tool}</span>
                  </Link>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">No calls in the last 7 days.</p>
        )}
      </div>
    </SettingsSection>
  );
}

function RecentChanges({ grantId, recent, at }: { grantId: string; recent: { at: number; action: string; what: string; detail: string }[]; at: number }) {
  const id = useId();
  return (
    <SettingsSection
      id={`${id}-recent`}
      title="Recent changes"
      description={
        <>
          What it changed, newest first, from the audit log.{' '}
          <Link to="/audit" search={{ who: grantId }} className="font-medium text-foreground underline underline-offset-4">
            Open in the audit log
          </Link>
        </>
      }
    >
      {recent.length ? (
        <ul className="divide-y text-sm">
          {recent.map((e) => (
            <li key={`${e.at}-${e.action}-${e.detail}`} className="grid gap-1 py-2 sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-4">
              <span className="text-muted-foreground">{ago(at - e.at)} ago</span>
              <span className="min-w-0">
                <span className="font-medium">{e.what}</span> <span className="font-mono text-xs text-muted-foreground">{e.action}</span>
                {e.detail && <span className="block truncate text-muted-foreground">{e.detail}</span>}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No changes yet.</p>
      )}
    </SettingsSection>
  );
}

function DisconnectDialog({ grant }: { grant: AgentGrant }) {
  const orgId = useOrgId();
  const open = useAppStore((s) => s.settings.disconnecting?.orgId === orgId && s.settings.disconnecting.grantId === grant.id);
  const running = useRunning(pageOf(orgId));
  const askToDisconnectAgent = useAppStore((s) => s.askToDisconnectAgent);
  const disconnectAgent = useAppStore((s) => s.disconnectAgent);
  const disconnecting = running === `disconnect:${grant.id}`;

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && askToDisconnectAgent(orgId, null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Disconnect <AgentName client={grant.client} />?
          </AlertDialogTitle>
          <AlertDialogDescription>Its next call is refused, and it has to ask a person to connect again.</AlertDialogDescription>
        </AlertDialogHeader>
        <p role="status" className="text-sm empty:hidden">
          {disconnecting && 'Disconnecting… Waiting for SignForge to answer. You can close this; it goes on.'}
        </p>
        <ActionError at={`disconnect:${grant.id}`} />
        <AlertDialogFooter>
          <AlertDialogCancel>{disconnecting ? 'Close' : 'Cancel'}</AlertDialogCancel>
          <Button variant="destructive" aria-disabled={running !== undefined || undefined} onClick={() => void disconnectAgent(orgId, grant.id)}>
            {disconnecting && <LoaderCircleIcon className="animate-spin" aria-hidden />} {disconnecting ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
