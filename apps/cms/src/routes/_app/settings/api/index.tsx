/**
 * Settings, API & agents (M4-07, canvas board SettingsApi): how an agent connects (the MCP server's
 * address and three steps), the agents connected to this org with Manage on each, what each scope
 * allows, and the tool reference. An owner sees every member's agents, anyone else their own
 * (`list_agent_grants`). This week's numbers per agent come with M4-08's call telemetry.
 */
import { createFileRoute, Link } from '@tanstack/react-router';
import { CopyIcon } from 'lucide-react';
import { useId } from 'react';
import { toast } from 'sonner';
import { AgentName } from '~/components/agent-name';
import { PageHeader } from '~/components/page';
import { SettingsSection } from '~/components/settings/parts';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { type AgentGrant, type AgentTool, grantedOn, lastActive } from '~/lib/agents';
import { CONNECT_SCOPES, SCOPE_WORDS } from '~/lib/connect';
import { useRole } from '~/lib/live';
import { getAgents } from '~/server/agents.functions';

export const Route = createFileRoute('/_app/settings/api/')({
  loader: () => getAgents(),
  head: () => ({ meta: [{ title: 'API & agents · SignForge' }] }),
  component: ApiSettings,
});

const ROLE_WORDS = { viewer: 'Viewer', editor: 'Editor', owner: 'Owner' } as const;

function ApiSettings() {
  const { grants, tools, names, mcpUrl, at } = Route.useLoaderData();
  const isOwner = useRole() === 'owner';
  const id = useId();

  return (
    <>
      <PageHeader
        title="API & agents"
        description="Agents use the same tools as this app, with the scopes you grant. Every change they make is in the audit log."
      />
      <ConnectSteps mcpUrl={mcpUrl} />
      <SettingsSection
        id={`${id}-agents`}
        title="Connected agents"
        description={
          isOwner
            ? 'Each connection works in this organization only. You see every member’s.'
            : 'Each connection works in this organization only. You see the ones you connected; owners see everyone’s.'
        }
      >
        {grants.length ? <AgentTable grants={grants} names={names} at={at} /> : <p className="text-sm text-muted-foreground">No agents are connected yet.</p>}
      </SettingsSection>
      <ScopeWords />
      <ToolReference tools={tools} />
    </>
  );
}

function ConnectSteps({ mcpUrl }: { mcpUrl: string }) {
  const id = useId();
  const copy = () =>
    void navigator.clipboard.writeText(mcpUrl).then(
      () => toast.success('Copied'),
      () => toast.error('Could not copy it. Select it and copy it yourself.'),
    );
  return (
    <SettingsSection id={`${id}-connect`} title="Connect an agent">
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        <li>Add this address to any MCP client as a remote server.</li>
        <li>The client opens a SignForge sign-in. Pick this organization and the scopes.</li>
        <li>The agent appears below. Disconnect it here at any time.</li>
      </ol>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-url`}>MCP server address</Label>
        <div className="flex gap-2">
          <Input id={`${id}-url`} readOnly value={mcpUrl} className="font-mono" />
          <Button type="button" variant="outline" onClick={copy}>
            <CopyIcon aria-hidden /> Copy
          </Button>
        </div>
      </div>
    </SettingsSection>
  );
}

function AgentTable({ grants, names, at }: { grants: AgentGrant[]; names: Record<string, string>; at: number }) {
  return (
    <section
      aria-label="Connected agents"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: it scrolls at phone width; its links take focus, but the scroll needs the region (WCAG 2.1.1).
      tabIndex={0}
      className="overflow-x-auto rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <table className="w-full min-w-[40rem] text-sm">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th scope="col" className="py-2 pr-3 font-medium">
              Agent
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Scopes
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Granted by
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Last active
            </th>
            <th scope="col" className="py-2 pl-3 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {grants.map((g) => (
            <tr key={g.id} className="align-top">
              <th scope="row" className="py-3 pr-3 text-left font-medium">
                <AgentName client={g.client} />
                <span className="block text-xs font-normal text-muted-foreground">{g.client.verified ? 'A SignForge app' : 'Unverified'}</span>
              </th>
              <td className="px-3 py-3">
                <ul className="flex flex-wrap gap-1" aria-label="Scopes">
                  {g.scopes.map((s) => (
                    <li key={s} className="rounded-md border px-1.5 py-0.5 font-mono text-xs">
                      {s}
                    </li>
                  ))}
                </ul>
              </td>
              <td className="px-3 py-3">
                {names[g.grantedBy] ?? 'A former member'} · {grantedOn(g.createdAt)}
              </td>
              <td className="px-3 py-3">{lastActive(g.lastUsedAt, at)}</td>
              <td className="py-3 pl-3 text-right">
                <Button asChild variant="outline" size="sm">
                  <Link to="/settings/api/$grantId" params={{ grantId: g.id }}>
                    Manage<span className="sr-only"> {g.client.name ?? 'this unverified app'}</span>
                  </Link>
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ScopeWords() {
  const id = useId();
  return (
    <SettingsSection
      id={`${id}-scopes`}
      title="What each scope allows"
      description="Never more than the person granting it may do, checked again on every call."
    >
      <dl className="divide-y text-sm">
        {CONNECT_SCOPES.map((s) => (
          <div key={s} className="grid gap-1 py-2 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
            <dt className="font-mono text-xs leading-5">{s}</dt>
            <dd>
              <span className="font-medium">{SCOPE_WORDS[s].title}.</span> <span className="text-muted-foreground">{SCOPE_WORDS[s].desc}</span>
            </dd>
          </div>
        ))}
      </dl>
    </SettingsSection>
  );
}

function ToolReference({ tools }: { tools: AgentTool[] }) {
  const id = useId();
  return (
    <SettingsSection
      id={`${id}-tools`}
      title="Tool reference"
      description="The tools you may use, each with the scope an agent needs for it and the least role."
    >
      <details className="text-sm">
        <summary className="cursor-pointer font-medium">Tool reference, with each tool’s scope and role ({tools.length})</summary>
        <section
          aria-label="Tools"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: it scrolls at phone width and holds nothing focusable, so it takes focus itself (WCAG 2.1.1).
          tabIndex={0}
          className="mt-3 overflow-x-auto rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <table className="w-full min-w-[28rem]">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Tool
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Scope
                </th>
                <th scope="col" className="py-2 pl-3 font-medium">
                  Role
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {[...tools]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((t) => (
                  <tr key={t.name}>
                    <th scope="row" className="py-1.5 pr-3 text-left font-mono text-xs font-normal">
                      {t.name}
                    </th>
                    <td className="px-3 py-1.5 font-mono text-xs">{t.scope}</td>
                    <td className="py-1.5 pl-3">{ROLE_WORDS[t.minRole]}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      </details>
    </SettingsSection>
  );
}
