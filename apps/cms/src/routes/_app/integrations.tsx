/**
 * Integrations (issue #80, canvas board Integrations): the org's data sources and their health,
 * a failing one in words with its fix, the accounts connected at providers, and the catalogue of
 * connectors with what is built and what is planned. Filter and search are in the URL, and so is
 * what the API's connection callback sends back (`?connected=` or `?connectionError=`).
 */
import { Choice } from '~/components/ui/choice';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { CloudOffIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { SourcesDialog } from '~/components/integrations/sources-dialog';
import { PageHeader } from '~/components/page';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
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
import {
  CATALOGUE,
  type Clock,
  clockTime,
  type Connector,
  type ConnectionView,
  connectedWords,
  connectionNotice,
  FIX_WORD,
  failingWords,
  hasAddress,
  weatherFixWords,
  isShow,
  KIND_WORD,
  kindOf,
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
import { connectionsQuery } from '~/queries/integrations';
import { retryUnlessRedirect } from '~/queries/retry';
import { dataSourcesQuery } from '~/queries/spots';
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
  // Read again every 30 s while the page is open, so a poll's result (a fixed URL's first good
  // check) shows; a read fails when two tries in a row do, and the page says it is not current.
  const { data, dataUpdatedAt, errorUpdatedAt } = useSuspenseQuery({ ...dataSourcesQuery(orgId), refetchInterval: 30_000, retry: retryUnlessRedirect(1) });
  // Not `isError`, which goes back to pending on each retry: the notice would blink (as on Screens).
  const notCurrent = errorUpdatedAt > dataUpdatedAt;
  const { connections, providers } = useSuspenseQuery(connectionsQuery(orgId)).data;
  const sources = data.dataSources;
  const clock: Clock = { timezone, locale, now: useNow(dataUpdatedAt) };
  const show: Show = search.show ?? 'all';
  const q = search.q ?? '';
  const set = (next: Partial<Search>) => void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });
  const all = CATALOGUE.flatMap((g) => g.items);
  const groups = CATALOGUE.map((g) => ({ ...g, items: g.items.filter((c) => shows(c, show, q, sources)) })).filter((g) => g.items.length);
  const notice = connectionNotice(search, connections);
  // One filled button on the page (#364): the first failing source's fix, else the first Connect shown, else none.
  const fixing = canManage && sources.some((s) => s.failures > 0 && hasAddress(s));
  const firstConnect = fixing ? undefined : groups.flatMap((g) => g.items).find((c) => actionOf(c, sources, canManage) === 'Connect')?.name;

  return (
    <div className="space-y-6">
      <PageHeader title={section.label} description={section.description} />
      {notice && (
        <div
          role="status"
          className={cn(
            'flex items-start gap-3 rounded-xl border px-4 py-3 text-md',
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
      <FailingSources sources={sources} clock={clock} canManage={canManage} />
      {/* Sources first and "Missing one?" last on a phone; beside the catalogue on a wide screen (the board). */}
      <div className="grid items-start gap-7 lg:grid-cols-[minmax(0,1fr)_minmax(280px,340px)] lg:grid-rows-[auto_1fr]">
        <aside aria-label="Sources and accounts" className="flex flex-col gap-3.5 lg:col-start-2 lg:row-start-1">
          <FeedingNow sources={sources} clock={clock} notCurrent={notCurrent} heardAt={dataUpdatedAt} />
          {(connections.length > 0 || providers.length > 0) && (
            <Accounts orgId={orgId} connections={connections} providers={providers} sources={sources} canManage={canManage} />
          )}
        </aside>

        <div className="flex min-w-0 flex-col gap-6 lg:col-start-1 lg:row-span-2 lg:row-start-1">
          <div className="flex flex-wrap items-center gap-2">
            {/* biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, as the board draws it; a fieldset would need a legend shown. */}
            <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5 text-md">
              {SHOW.map((s) => (
                <Choice key={s} selected={show === s} onClick={() => set({ show: s === 'all' ? undefined : s })} className="min-h-10 rounded-full px-3.5">
                  {SHOW_WORD[s]} {all.filter((c) => shows(c, s, '', sources)).length}
                </Choice>
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
              className="w-full sm:w-56 md:text-md"
            />
          </div>

          {groups.length ? (
            groups.map((g) => (
              <section key={g.name} aria-labelledby={`group-${g.name}`} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1 border-b border-border-strong pb-1.5">
                  <h2 id={`group-${g.name}`} className="text-xl font-semibold tracking-tight">
                    {g.name}
                  </h2>
                  <span className="text-md text-muted-foreground">{g.why}</span>
                </div>
                <ul>
                  {g.items.map((c) => (
                    <ConnectorRow key={c.name} connector={c} sources={sources} canManage={canManage} primary={c.name === firstConnect} />
                  ))}
                </ul>
              </section>
            ))
          ) : (
            <p className="text-muted-foreground">No integration matches.</p>
          )}
        </div>
        <section aria-labelledby="missing-h" className="lg:col-start-2 lg:row-start-2 flex flex-col gap-2 self-start rounded-xl border bg-card p-4 text-md">
          <h2 id="missing-h" className="text-lg font-semibold tracking-tight">
            Missing one?
          </h2>
          <p className="text-muted-foreground">Most systems publish an RSS feed or an .ics calendar link. Agents can also edit spots through the MCP server.</p>
        </section>
      </div>
      <SourcesDialog orgId={orgId} sources={sources} clock={clock} canManage={canManage} />
    </div>
  );
}

/**
 * What a connector's row offers: Manage (or View) its sources, Connect a feed or a calendar, or nothing.
 * Feeds and calendars are added here by their address; weather from a place, in a weather spot; a table in a menu board spot.
 */
function actionOf(c: Connector, sources: ListedSource[], canManage: boolean) {
  if (!c.kind) return null;
  if (sourcesOf(c, sources).length) return canManage ? 'Manage' : 'View';
  return canManage && (c.kind === 'rss' || c.kind === 'ical') ? 'Connect' : null;
}

function ConnectorRow({
  connector: c,
  sources,
  canManage,
  primary,
}: {
  connector: Connector;
  sources: ListedSource[];
  canManage: boolean;
  /** The page's one filled button (#364): the first Connect, while no source needs fixing. */
  primary: boolean;
}) {
  const openSources = useAppStore((s) => s.openSources);
  const mine = sourcesOf(c, sources);
  const failing = mine.some((s) => s.failures > 0);
  const action = actionOf(c, sources, canManage);
  const kind = c.kind;

  return (
    <li className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-x-3.5 gap-y-2 border-b py-2.5 sm:grid-cols-[40px_minmax(0,1fr)_auto]">
      <span aria-hidden className={cn('flex size-10 items-center justify-center rounded-md text-xs font-semibold', TILE[c.state])}>
        {c.mono}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <strong className="text-base font-semibold">{c.name}</strong>
          <span className={cn('text-meta font-semibold', c.state === 'built' ? 'text-status-online-foreground' : 'text-muted-foreground')}>
            {STATE_WORD[c.state]}
          </span>
        </span>
        <span className="text-md text-muted-foreground">{c.does}</span>
      </span>
      {(mine.length > 0 || action) && (
        <span className="col-start-2 flex items-center gap-3 sm:col-start-3 sm:justify-end sm:text-right">
          {kind && mine.length > 0 && (
            <span className={cn('text-sm', failing ? 'text-status-updating-foreground' : 'text-status-online-foreground')}>{connectedWords(kind, mine)}</span>
          )}
          {kind && action && (
            <Button
              variant={primary ? 'default' : 'outline'}
              className="min-h-10 px-3.5 text-md font-semibold"
              aria-label={`${action} ${c.name}`}
              onClick={() => openSources(kind, { adding: action === 'Connect' })}
            >
              {action}
            </Button>
          )}
        </span>
      )}
    </li>
  );
}

/**
 * A failing source, at the top of the page (#364): what is wrong in words, the spots it feeds, and its
 * fix as a button, so the urgent thing is not a link in the margin. The first fix is the page's one filled button.
 */
function FailingSources({ sources, clock, canManage }: { sources: ListedSource[]; clock: Clock; canManage: boolean }) {
  const openSources = useAppStore((s) => s.openSources);
  const failing = sources.filter((s) => s.failures > 0);
  // One filled button per view: the first fix; the others are outlined.
  const first = canManage ? failing.find((s) => hasAddress(s))?.id : undefined;
  return failing.map((s) => (
    <Alert key={s.id} variant="destructive" role="alert" aria-labelledby={`failing-${s.id}`}>
      <TriangleAlertIcon aria-hidden />
      <AlertTitle id={`failing-${s.id}`} className="wrap-anywhere">
        {KIND_WORD[s.format]} · {s.name}
      </AlertTitle>
      <AlertDescription className="text-foreground">
        <p>
          {failingWords(s, clock)}
          {s.spots.length > 0 && ` It feeds ${s.spots.length === 1 ? 'the spot' : 'the spots'} ${s.spots.map((x) => x.name).join(', ')}.`}
        </p>
        {s.format === 'json' && <p>{weatherFixWords(s)}</p>}
        {canManage && hasAddress(s) && (
          <Button
            type="button"
            variant={s.id === first ? 'default' : 'outline'}
            className="mt-1 justify-self-start"
            onClick={() => openSources(kindOf(s.format), { editing: s.id })}
          >
            {FIX_WORD[s.format]}
            <span className="sr-only"> for {s.name}</span>
          </Button>
        )}
      </AlertDescription>
    </Alert>
  ));
}

/** The board's "Feeding screens now": every source and its last good check; a failing one's fix is at the top of the page. */
function FeedingNow({
  sources,
  clock,
  notCurrent,
  heardAt,
}: {
  sources: ListedSource[];
  clock: Clock;
  /** The page's poll is failing: what it shows is what SignForge last said, at `heardAt`. */
  notCurrent: boolean;
  heardAt: number;
}) {
  return (
    <section aria-labelledby="now-h" className="flex flex-col gap-2.5 rounded-xl border bg-card p-4">
      <h2 id="now-h" className="text-lg font-semibold tracking-tight">
        Feeding screens now
      </h2>
      {/* In the accessibility tree while empty, so the notice is announced when it comes. */}
      <div role="status" className="empty:sr-only">
        {notCurrent && (
          <p className="flex items-start gap-2 text-sm">
            <CloudOffIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span>
              <strong className="font-semibold">Not current.</strong> SignForge has not answered since {clockTime(heardAt, clock)}. This page keeps trying.
            </span>
          </p>
        )}
      </div>
      {sources.length ? (
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 text-md">
          {sources.map((s) => {
            const state = sourceState(s, clock);
            return (
              <div key={s.id} className="contents">
                <dt className="min-w-0 break-words">
                  {KIND_WORD[s.format]} · {s.name}
                </dt>
                <dd className={cn('m-0 font-mono text-meta', state.tone === 'failing' ? 'font-semibold text-destructive' : 'text-muted-foreground')}>
                  {state.word}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">No data sources yet. Connect a feed or a calendar from the list.</p>
      )}
    </section>
  );
}

const STATUS_WORD: Record<ConnectionView['status'], string> = {
  active: 'Connected',
  needs_reconnect: 'Needs reconnecting',
  disconnected: 'Disconnected',
};

/** Accounts connected at providers, with Connect for each provider this deployment offers. */
function Accounts({
  orgId,
  connections,
  providers,
  sources,
  canManage,
}: {
  orgId: string;
  connections: ConnectionView[];
  providers: string[];
  sources: ListedSource[];
  canManage: boolean;
}) {
  const connecting = useAppStore((s) => s.integrations.connecting);
  const error = useAppStore((s) => s.integrations.connectError);
  const connect = useAppStore((s) => s.connect);
  const askToDisconnect = useAppStore((s) => s.askToDisconnect);
  // The confirm says a refused disconnect itself.
  const disconnecting = useAppStore((s) => s.integrations.disconnecting !== null);
  const busy = (id: string, doing: 'connect' | 'disconnect') => connecting?.id === id && connecting.doing === doing;

  return (
    <section aria-labelledby="accounts-h" className="flex flex-col gap-2.5 rounded-xl border bg-card p-4">
      <h2 id="accounts-h" className="text-lg font-semibold tracking-tight">
        Connected accounts
      </h2>
      {connections.length ? (
        <ul className="flex flex-col gap-3 text-md">
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
                    <Button
                      variant="outline"
                      disabled={connecting !== null}
                      onClick={() => void connect(c.provider, c.id)}
                      aria-label={`Reconnect ${c.account}`}
                    >
                      {busy(c.id, 'connect') ? 'Opening…' : 'Reconnect'}
                    </Button>
                  )}
                  {c.status !== 'disconnected' && (
                    <Button variant="outline" disabled={connecting !== null} onClick={() => askToDisconnect(c)} aria-label={`Disconnect ${c.account}`}>
                      Disconnect
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
            {busy(p, 'connect') ? 'Opening…' : `Connect ${providerName(p)}`}
          </Button>
        ))}
      <p role="alert" className="text-sm font-medium text-destructive empty:hidden">
        {disconnecting ? null : error}
      </p>
      <ConfirmDisconnect orgId={orgId} sources={sources} />
    </section>
  );
}

/** Disconnecting revokes the grant at the provider, and only someone who can sign in to the account there gets it back, so it asks first. */
function ConfirmDisconnect({ orgId, sources }: { orgId: string; sources: ListedSource[] }) {
  const c = useAppStore((s) => s.integrations.disconnecting);
  const pending = useAppStore((s) => s.integrations.connecting?.doing === 'disconnect');
  const error = useAppStore((s) => s.integrations.connectError);
  const ask = useAppStore((s) => s.askToDisconnect);
  const disconnect = useAppStore((s) => s.disconnect);
  const focusBack = useAppStore((s) => s.focusBack);
  const reading = c ? sources.filter((s) => s.connectionId === c.id).map((s) => s.name) : [];
  return (
    <AlertDialog open={c !== null} onOpenChange={(open) => !open && ask(null)}>
      <AlertDialogContent onCloseAutoFocus={(e) => focusBack('disconnect', e)}>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">Disconnect {c?.account}?</AlertDialogTitle>
          <AlertDialogDescription>
            {reading.length
              ? `Sources that read through it stop updating: ${reading.join(', ')}. Their spots show the last copy for a day, then their fallback values.`
              : 'Sources that read through it stop updating; none do now.'}{' '}
            Connecting it again needs someone who can sign in to this account at {c ? providerName(c.provider) : 'the provider'}.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p role="alert" className="text-sm font-medium text-destructive empty:hidden">
          {error}
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={pending} onClick={() => void disconnect(orgId)}>
            {pending ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
