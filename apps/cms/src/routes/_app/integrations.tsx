/**
 * Integrations (issue #80, canvas board Integrations): the org's data sources and their health,
 * a failing one in words with its fix, the accounts connected at providers, and the catalogue of
 * connectors with what is built and what is planned. Filter and search are in the URL, and so is
 * what the API's connection callback sends back (`?connected=` or `?connectionError=`).
 */
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { XIcon } from 'lucide-react';
import { SourcesDialog } from '~/components/integrations/sources-dialog';
import { PageHeader } from '~/components/page';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import {
  CATALOGUE,
  type Clock,
  type Connector,
  type ConnectionView,
  connectedWords,
  connectionNotice,
  FIX_WORD,
  failingWords,
  isShow,
  KIND_WORD,
  type ListedSource,
  providerName,
  SHOW,
  type Show,
  shows,
  sourceState,
  sourcesOf,
} from '~/lib/integrations';
import { useCanManage, useNow, useOrgId } from '~/lib/live';
import { sectionFor } from '~/lib/sections';
import { cn } from '~/lib/utils';
import { connectionsQuery, dataSourcesQuery } from '~/queries/integrations';
import { getOrgSettings } from '~/server/settings.functions';
import { useAppStore } from '~/state/provider';

const section = sectionFor('/integrations');

interface Search {
  show?: Exclude<Show, 'all'>;
  q?: string;
  connected?: string;
  connectionError?: string;
}

const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

export const Route = createFileRoute('/_app/integrations')({
  validateSearch: (s: Record<string, unknown>): Search => {
    const out: Search = {};
    if (isShow(s.show) && s.show !== 'all') out.show = s.show;
    const q = text(s.q);
    const connected = text(s.connected);
    const connectionError = text(s.connectionError);
    if (q) out.q = q;
    if (connected) out.connected = connected;
    if (connectionError) out.connectionError = connectionError;
    return out;
  },
  // The org's zone and locale write the times; the sources and connections are Query data.
  loader: async ({ context: { queryClient }, parentMatchPromise }) => {
    const orgId = (await parentMatchPromise).loaderData?.organization?.id;
    const [settings] = await Promise.all([
      getOrgSettings(),
      orgId && queryClient.query({ ...dataSourcesQuery(orgId), staleTime: 0 }),
      orgId && queryClient.query({ ...connectionsQuery(orgId), staleTime: 0 }),
    ]);
    return { timezone: settings?.timezone ?? 'UTC', locale: settings?.locale ?? 'en-US' };
  },
  head: () => ({ meta: [{ title: `${section.label} · SignForge` }] }),
  component: IntegrationsPage,
});

const SHOW_WORD: Record<Show, string> = { all: 'All', connected: 'Connected', built: 'Built', planned: 'Planned', later: 'Later' };
const STATE_WORD: Record<Connector['state'], string> = { built: 'Built', planned: 'Planned', later: 'Later · enterprise' };
const TILE: Record<Connector['state'], string> = {
  built: 'bg-primary text-primary-foreground',
  planned: 'bg-accent text-accent-foreground',
  later: 'bg-muted text-muted-foreground',
};

function IntegrationsPage() {
  const orgId = useOrgId();
  const canManage = useCanManage();
  const { timezone, locale } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data, dataUpdatedAt } = useSuspenseQuery(dataSourcesQuery(orgId));
  const { connections, providers } = useSuspenseQuery(connectionsQuery(orgId)).data;
  const sources = data.dataSources;
  const clock: Clock = { timezone, locale, now: useNow(dataUpdatedAt) };
  const show: Show = search.show ?? 'all';
  const q = search.q ?? '';
  const set = (next: Partial<Search>) => void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });
  const all = CATALOGUE.flatMap((g) => g.items);
  const groups = CATALOGUE.map((g) => ({ ...g, items: g.items.filter((c) => shows(c, show, q, sources)) })).filter((g) => g.items.length);
  const notice = connectionNotice(search, connections);

  return (
    <div className="space-y-6">
      <PageHeader title={section.label} description={section.description} />
      {notice && (
        <div
          role="status"
          className={cn(
            'flex items-start gap-3 rounded-xl border px-4 py-3 text-[15px]',
            search.connectionError ? 'border-destructive/40 bg-card' : 'border-status-online/40 bg-card',
          )}
        >
          <span className="flex-1">{notice}</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Dismiss"
            className="-my-2 -mr-2"
            onClick={() => set({ connected: undefined, connectionError: undefined })}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-start gap-7">
        <aside
          aria-label="Sources and accounts"
          className="order-first flex w-full flex-col gap-3.5 lg:order-last lg:w-auto lg:max-w-[340px] lg:flex-[1_1_280px]"
        >
          <FeedingNow sources={sources} clock={clock} canManage={canManage} />
          {(connections.length > 0 || providers.length > 0) && <Accounts orgId={orgId} connections={connections} providers={providers} canManage={canManage} />}
          <section aria-labelledby="missing-h" className="flex flex-col gap-2 rounded-[14px] border bg-card p-4 text-[15px]">
            <h2 id="missing-h" className="text-lg font-semibold tracking-tight">
              Missing one?
            </h2>
            <p className="text-muted-foreground">
              Most systems publish an RSS feed or an .ics calendar link. Agents can also edit spots through the MCP server.
            </p>
          </section>
        </aside>

        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-6">
          <div className="flex flex-wrap items-center gap-2">
            {/* biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, as the board draws it; a fieldset would need a legend shown. */}
            <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5 text-[15px]">
              {SHOW.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={show === s}
                  onClick={() => set({ show: s === 'all' ? undefined : s })}
                  className={cn(
                    'min-h-10 rounded-full border px-3.5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    show === s ? 'border-foreground bg-foreground text-background' : 'border-border-strong bg-card hover:bg-accent',
                  )}
                >
                  {SHOW_WORD[s]} {all.filter((c) => shows(c, s, '', sources)).length}
                </button>
              ))}
            </div>
            <span className="flex-1" />
            <label htmlFor="integrations-q" className="sr-only">
              Find an integration
            </label>
            <Input
              id="integrations-q"
              type="search"
              placeholder="Find an integration"
              defaultValue={q}
              onChange={(e) => set({ q: e.target.value || undefined })}
              className="w-full sm:w-56"
            />
          </div>

          {groups.length ? (
            groups.map((g) => (
              <section key={g.name} aria-labelledby={`group-${g.name}`} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1 border-b border-border-strong pb-1.5">
                  <h2 id={`group-${g.name}`} className="text-xl font-semibold tracking-tight">
                    {g.name}
                  </h2>
                  <span className="text-[15px] text-muted-foreground">{g.why}</span>
                </div>
                <ul>
                  {g.items.map((c) => (
                    <ConnectorRow key={c.name} connector={c} sources={sources} canManage={canManage} />
                  ))}
                </ul>
              </section>
            ))
          ) : (
            <p className="text-muted-foreground">No integration matches.</p>
          )}
        </div>
      </div>
      <SourcesDialog orgId={orgId} sources={sources} clock={clock} canManage={canManage} />
    </div>
  );
}

function ConnectorRow({ connector: c, sources, canManage }: { connector: Connector; sources: ListedSource[]; canManage: boolean }) {
  const openSources = useAppStore((s) => s.openSources);
  const mine = sourcesOf(c, sources);
  const failing = mine.some((s) => s.failures > 0);
  // Feeds and calendars are added here by their address; weather from a place, in a weather spot.
  const addable = c.format === 'rss' || c.format === 'ical';
  const action = !c.format ? null : mine.length ? (canManage ? 'Manage' : 'View') : canManage && addable ? 'Connect' : null;
  const format = c.format;

  return (
    <li className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-x-3.5 gap-y-2 border-b py-2.5 sm:grid-cols-[40px_minmax(0,1fr)_auto]">
      <span aria-hidden className={cn('flex size-10 items-center justify-center rounded-md text-xs font-semibold', TILE[c.state])}>
        {c.mono}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <strong className="text-base font-semibold">{c.name}</strong>
          <span className={cn('text-[13px] font-semibold', c.state === 'built' ? 'text-status-online-foreground' : 'text-muted-foreground')}>
            {STATE_WORD[c.state]}
          </span>
        </span>
        <span className="text-[15px] text-muted-foreground">{c.does}</span>
      </span>
      {(mine.length > 0 || action) && (
        <span className="col-start-2 flex items-center gap-3 sm:col-start-3 sm:justify-end sm:text-right">
          {format && mine.length > 0 && (
            <span className={cn('text-sm', failing ? 'text-status-updating-foreground' : 'text-status-online-foreground')}>{connectedWords(format, mine)}</span>
          )}
          {format && action && (
            <Button
              variant={action === 'Connect' ? 'default' : 'outline'}
              className="min-h-10 px-3.5 text-[15px] font-semibold"
              aria-label={`${action} ${c.name}`}
              onClick={() => openSources(format, { adding: action === 'Connect' })}
            >
              {action}
            </Button>
          )}
        </span>
      )}
    </li>
  );
}

/** The board's "Feeding screens now": every source, its last good check, and a failing one in words with its fix. */
function FeedingNow({ sources, clock, canManage }: { sources: ListedSource[]; clock: Clock; canManage: boolean }) {
  const openSources = useAppStore((s) => s.openSources);
  const failing = sources.filter((s) => s.failures > 0);
  return (
    <section aria-labelledby="now-h" className="flex flex-col gap-2.5 rounded-[14px] border bg-card p-4">
      <h2 id="now-h" className="text-lg font-semibold tracking-tight">
        Feeding screens now
      </h2>
      {sources.length ? (
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 text-[15px]">
          {sources.map((s) => {
            const state = sourceState(s, clock);
            return (
              <div key={s.id} className="contents">
                <dt className="min-w-0 break-words">
                  {KIND_WORD[s.format]} · {s.name}
                </dt>
                <dd className={cn('m-0 font-mono text-[13px]', state.tone === 'failing' ? 'font-semibold text-destructive' : 'text-muted-foreground')}>
                  {state.word}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">No data sources yet. Connect a feed or a calendar from the list.</p>
      )}
      {failing.map((s) => (
        <div key={s.id} className="flex flex-col gap-1.5">
          <p className="text-sm text-muted-foreground">
            {failingWords(s, clock)}
            {s.spots.length > 0 && ` It feeds ${s.spots.map((x) => x.name).join(', ')}.`}
          </p>
          {canManage && s.format !== 'provider' && (
            <button
              type="button"
              className="self-start text-[15px] text-primary underline-offset-4 hover:underline"
              onClick={() => openSources(s.format, { editing: s.id })}
            >
              {FIX_WORD[s.format]}
              <span className="sr-only"> for {s.name}</span>
            </button>
          )}
        </div>
      ))}
    </section>
  );
}

const STATUS_WORD: Record<ConnectionView['status'], string> = {
  active: 'Connected',
  needs_reconnect: 'Needs reconnecting',
  disconnected: 'Disconnected',
};

/** Accounts connected at providers, with Connect for each provider this deployment offers. */
function Accounts({ orgId, connections, providers, canManage }: { orgId: string; connections: ConnectionView[]; providers: string[]; canManage: boolean }) {
  const connecting = useAppStore((s) => s.integrations.connecting);
  const error = useAppStore((s) => s.integrations.connectError);
  const connect = useAppStore((s) => s.connect);
  const disconnect = useAppStore((s) => s.disconnect);

  return (
    <section aria-labelledby="accounts-h" className="flex flex-col gap-2.5 rounded-[14px] border bg-card p-4">
      <h2 id="accounts-h" className="text-lg font-semibold tracking-tight">
        Connected accounts
      </h2>
      {connections.length ? (
        <ul className="flex flex-col gap-3 text-[15px]">
          {connections.map((c) => (
            <li key={c.id} className="flex flex-col gap-1.5">
              <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="min-w-0 break-words">
                  {providerName(c.provider)} · {c.account}
                </span>
                <span className={cn('text-sm', c.status === 'active' ? 'text-status-online-foreground' : 'font-semibold text-destructive')}>
                  {STATUS_WORD[c.status]}
                </span>
              </span>
              {canManage && (
                <span className="flex flex-wrap gap-2">
                  {c.status !== 'active' && (
                    <Button size="sm" disabled={connecting !== null} onClick={() => void connect(c.provider, c.id)} aria-label={`Reconnect ${c.account}`}>
                      Reconnect
                    </Button>
                  )}
                  {c.status !== 'disconnected' && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={connecting !== null}
                      onClick={() => void disconnect(orgId, c.id)}
                      aria-label={`Disconnect ${c.account}`}
                    >
                      {connecting === c.id ? 'Disconnecting…' : 'Disconnect'}
                    </Button>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No accounts connected yet.</p>
      )}
      {canManage &&
        providers.map((p) => (
          <Button key={p} variant="outline" className="self-start" disabled={connecting !== null} onClick={() => void connect(p)}>
            {connecting === p ? 'Opening…' : `Connect ${providerName(p)}`}
          </Button>
        ))}
      <p role="alert" className="text-sm font-medium text-destructive empty:hidden">
        {error}
      </p>
    </section>
  );
}
