/**
 * Settings, Notifications (canvas board SettingsNotifications): where alerts go (email, a Slack
 * channel through an incoming webhook, a signed outgoing webhook), who hears about what, and the
 * deliveries of the last days (#88). Teams comes later, through the integrations foundation (#83).
 */
import { createFileRoute, Link } from '@tanstack/react-router';
import { CopyIcon, LoaderCircleIcon, RotateCwIcon, SendIcon } from 'lucide-react';
import { useId, type ReactNode, type SubmitEvent } from 'react';
import { toast } from 'sonner';
import { EditorFields } from '~/components/editor';
import { PageHeader } from '~/components/page';
import { ActionError, SaveRow, SettingsSection, useRunning } from '~/components/settings/parts';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { NativeSelect } from '~/components/ui/select';
import { useNow, useOrgId, useRole } from '~/lib/live';
import { ago } from '~/lib/screen-status';
import {
  ALERTS,
  AUDIENCES,
  CHANNEL_LABELS,
  EVENT_LABELS,
  isAudience,
  type AlertChannel,
  type AlertDelivery,
  type AlertKind,
  type AlertRule,
} from '~/lib/settings';
import { backToPage } from '~/server/form-post.server';
import { getNotifications } from '~/server/settings.functions';
import { useAppStore } from '~/state/provider';
import { editsIn, type SettingsScope } from '~/state/settings';

export const Route = createFileRoute('/_app/settings/notifications')({
  server: { handlers: backToPage },
  loader: () => getNotifications(),
  head: () => ({ meta: [{ title: 'Notifications · SignForge' }] }),
  component: NotificationSettings,
});

type Loaded = NonNullable<ReturnType<typeof Route.useLoaderData>>;

/** What runs on this page in `orgId`: one action at a time. */
const pageOf = (orgId: string): SettingsScope => ({ page: 'notifications', orgId });

function NotificationSettings() {
  const data = Route.useLoaderData();
  const canEdit = useRole() === 'owner';
  const id = useId();
  if (!data) return null;
  const { channels, deliveries } = data;
  const last = (kind: AlertChannel['kind']) => deliveries.find((d) => d.channel === kind && d.lastAttemptAt !== null);

  return (
    <div className="space-y-6">
      <PageHeader title="Notifications" description="Where alerts go, and who hears about what." />
      <SettingsSection id={`${id}-where`} title="Where alerts go">
        <ul className="grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(15rem,1fr))]">
          <ChannelCard title="Email" detail="To each member's address" state={<span className="font-medium text-status-online-foreground">On</span>}>
            {canEdit && <TestButton channel="email" label="Email me a test" />}
          </ChannelCard>
          <SlackCard channel={channels.slack} last={last('slack')} names={data.names} canEdit={canEdit} at={data.at} />
          <WebhookCard channel={channels.webhook} last={last('webhook')} names={data.names} canEdit={canEdit} at={data.at} />
        </ul>
        <SigningSecretOnce />
      </SettingsSection>
      <RulesForm data={data} canEdit={canEdit} />
      <SettingsSection
        id={`${id}-log`}
        title="Recent deliveries"
        description="What went to Slack and the webhook, and tests, over the last 7 days. A failed delivery is retried for 24 hours."
      >
        <DeliveryLog deliveries={deliveries} canEdit={canEdit} at={data.at} />
      </SettingsSection>
    </div>
  );
}

function ChannelCard({ title, detail, state, children }: { title: string; detail: ReactNode; state: ReactNode; children?: ReactNode }) {
  return (
    <li className="flex flex-col gap-1 rounded-xl border bg-background p-4 text-sm">
      <span className="font-semibold">{title}</span>
      <span className="text-muted-foreground">{detail}</span>
      {state}
      {children && <div className="mt-2 flex flex-wrap items-center gap-2">{children}</div>}
    </li>
  );
}

/** Who set a set channel (by name if they are a member), and how its last delivery went. */
function Connected({ channel, names, last, now }: { channel: AlertChannel; names: Record<string, string>; last: AlertDelivery | undefined; now: number }) {
  const ok = last?.status !== 'pending' && last?.status !== 'failed';
  return (
    <>
      <span className="font-medium text-status-online-foreground">Connected by {names[channel.connectedBy] ?? 'an agent or a former member'}</span>
      {!last?.lastAttemptAt ? (
        <span className="text-muted-foreground">No deliveries yet</span>
      ) : (
        <span className={ok ? 'text-muted-foreground' : 'font-medium text-destructive'}>
          Last delivery {since(now - last.lastAttemptAt)}
          {last.lastHttpStatus === null ? '' : `, ${last.lastHttpStatus}`}
          {ok ? '' : ` (${last.status === 'failed' ? 'failed' : 'retrying'})`}
        </span>
      )}
    </>
  );
}

/** "just now", or "14 min ago". */
const since = (ms: number) => (ms < 60_000 ? 'just now' : `${ago(ms)} ago`);

interface CardProps {
  channel: AlertChannel | null;
  last: AlertDelivery | undefined;
  names: Record<string, string>;
  canEdit: boolean;
  at: number;
}

const CHANNEL_COPY = {
  slack: {
    title: 'Slack',
    unset: 'Post to a channel through an incoming webhook you make in Slack',
    field: 'Slack incoming-webhook URL',
    placeholder: 'https://hooks.slack.com/services/…',
    add: 'Connect Slack',
    change: 'Replace',
  },
  webhook: {
    title: 'Webhook',
    unset: 'POST each alert as signed JSON to your own system',
    field: 'Webhook URL',
    placeholder: 'https://example.com/hooks/signforge',
    add: 'Add webhook',
    change: 'Save URL',
  },
} as const;

/** Slack or the webhook: how to set it, or what it is, with a test and its rarer actions (`extra`) folded away. */
function ChannelOf({
  kind,
  channel,
  last,
  names,
  canEdit,
  at,
  onUrl,
  extra,
}: CardProps & { kind: AlertChannel['kind']; onUrl: (url: string) => Promise<boolean>; extra?: ReactNode }) {
  const now = useNow(at);
  const copy = CHANNEL_COPY[kind];
  const form = (button: string) => <UrlForm name={copy.field} placeholder={copy.placeholder} button={button} at={kind} onUrl={onUrl} />;
  if (!channel)
    return (
      <ChannelCard title={copy.title} detail={copy.unset} state={<span className="text-muted-foreground">Not set</span>}>
        {canEdit && form(copy.add)}
      </ChannelCard>
    );
  return (
    <ChannelCard
      title={copy.title}
      detail={<span className="font-mono">{channel.host}</span>}
      state={<Connected channel={channel} names={names} last={last} now={now} />}
    >
      {canEdit && (
        <>
          <TestButton channel={kind} label="Send a test" />
          <details className="w-full">
            <summary className="cursor-pointer text-sm font-medium">Manage</summary>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {extra}
              <RemoveChannel kind={kind} />
              {form(copy.change)}
            </div>
          </details>
        </>
      )}
    </ChannelCard>
  );
}

function SlackCard(props: CardProps) {
  const orgId = useOrgId();
  const connectSlack = useAppStore((s) => s.connectSlack);
  return <ChannelOf kind="slack" {...props} onUrl={(url) => connectSlack(orgId, url, props.channel?.version)} />;
}

function WebhookCard(props: CardProps) {
  const setWebhook = useAppStore((s) => s.setWebhook);
  const rotate = useAppStore((s) => s.rotateSigningSecret);
  const orgId = useOrgId();
  const busy = useRunning(pageOf(orgId)) !== undefined;
  const { channel } = props;
  return (
    <ChannelOf
      kind="webhook"
      {...props}
      onUrl={(url) => setWebhook(orgId, url, channel?.version)}
      extra={
        channel && (
          <Button type="button" variant="outline" aria-disabled={busy || undefined} onClick={() => void rotate(orgId, channel.version)}>
            <RotateCwIcon aria-hidden /> New signing secret
          </Button>
        )
      }
    />
  );
}

/** Remove, then a second click to confirm: the URL (and secret) are forgotten. */
function RemoveChannel({ kind }: { kind: AlertChannel['kind'] }) {
  const orgId = useOrgId();
  const asking = useAppStore((s) => s.settings.removingChannel?.orgId === orgId && s.settings.removingChannel.kind === kind);
  const ask = useAppStore((s) => s.askToRemoveAlertChannel);
  const remove = useAppStore((s) => s.removeAlertChannel);
  const running = useRunning(pageOf(orgId));
  const busy = running !== undefined;
  const removing = running === `remove:${kind}`;
  const focus = useAppStore((s) => s.focusWhenReplaced);
  const name = CHANNEL_COPY[kind].title;
  if (!asking)
    return (
      <Button
        ref={focus(`remove:${kind}`)}
        type="button"
        variant="ghost"
        className="text-destructive"
        aria-disabled={busy || undefined}
        onClick={() => ask(orgId, kind)}
      >
        Remove {name}
      </Button>
    );
  return (
    <div className="w-full space-y-2 rounded-lg border border-destructive/40 p-3">
      {/* Focus comes here as Remove gives way to it (#289): the question first, then Tab to its answers. */}
      <p ref={focus(`confirm:${kind}`)} tabIndex={-1} className="rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
        Stop sending alerts to {name}? Its URL is forgotten, and alerts still waiting for it are not sent.
      </p>
      <ActionError at={`remove:${kind}`} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="destructive" aria-disabled={busy || undefined} onClick={() => void remove(orgId, kind)}>
          {removing && <LoaderCircleIcon className="animate-spin" aria-hidden />} {removing ? 'Removing…' : 'Remove'}
        </Button>
        {/* Once the removal is sent it cannot be called back, so Keep it waits for the answer. */}
        <Button type="button" variant="outline" aria-disabled={busy || undefined} onClick={() => ask(orgId, null)}>
          Keep it
        </Button>
      </div>
    </div>
  );
}

/** A channel's URL, which SignForge stores sealed and never shows again. */
function UrlForm({
  name,
  placeholder,
  button,
  at,
  onUrl,
}: {
  name: string;
  placeholder: string;
  button: string;
  at: string;
  onUrl: (url: string) => Promise<boolean>;
}) {
  const id = useId();
  const running = useRunning(pageOf(useOrgId()));
  // Once the channel is removed, its card's form to set one takes the focus Remove had (#289).
  const focus = useAppStore((s) => s.focusWhenReplaced(`form:${at}`));
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const url = String(new FormData(e.currentTarget).get('url') ?? '');
    const field = e.currentTarget.elements.namedItem('url');
    // Cleared once saved: the URL is kept sealed, and never shown again here either. A URL typed
    // while it saved is kept.
    void onUrl(url).then((saved) => {
      if (saved && field instanceof HTMLInputElement && field.value === url) field.value = '';
    });
  };
  return (
    <EditorFields>
      <form method="post" onSubmit={submit} className="mt-2 w-full space-y-2" noValidate>
        <Label htmlFor={id}>{name}</Label>
        <Input ref={focus} id={id} name="url" type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder={placeholder} required />
        <p className="text-xs text-muted-foreground">Kept encrypted, and never shown again.</p>
        <ActionError at={at} />
        <Button type="submit" aria-disabled={running !== undefined || undefined}>
          {running === at && <LoaderCircleIcon className="animate-spin" aria-hidden />} {button}
        </Button>
      </form>
    </EditorFields>
  );
}

function TestButton({ channel, label }: { channel: AlertDelivery['channel']; label: string }) {
  const orgId = useOrgId();
  const test = useAppStore((s) => s.testAlertChannel);
  const running = useRunning(pageOf(orgId));
  return (
    <>
      <Button type="button" variant="outline" aria-disabled={running !== undefined || undefined} onClick={() => void test(orgId, channel)}>
        {running === `test:${channel}` ? <LoaderCircleIcon className="animate-spin" aria-hidden /> : <SendIcon aria-hidden />} {label}
      </Button>
      <ActionError at={`test:${channel}`} />
    </>
  );
}

/** The signing secret just made: shown here once, then only its holder has it. */
function SigningSecretOnce() {
  const orgId = useOrgId();
  const secret = useAppStore((s) => (s.settings.signingSecret?.orgId === orgId ? s.settings.signingSecret.secret : null));
  const dismiss = useAppStore((s) => s.dismissSigningSecret);
  const id = useId();
  if (!secret) return null;
  const copy = () =>
    void navigator.clipboard.writeText(secret).then(
      () => toast.success('Copied'),
      () => toast.error('Could not copy it. Select it and copy it yourself.'),
    );
  return (
    <section aria-labelledby={id} className="space-y-2 rounded-xl border border-primary/40 bg-accent p-4 text-sm">
      <p id={id} className="font-semibold">
        The webhook's signing secret
      </p>
      <p>Copy it now: it is not shown again. Check each request's SignForge-Signature header with it (packages/tools README, Alert channels).</p>
      <code className="block overflow-x-auto rounded-md border bg-background p-2 font-mono text-sm break-all">{secret}</code>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={copy}>
          <CopyIcon aria-hidden /> Copy
        </Button>
        <Button type="button" onClick={dismiss}>
          I have saved it
        </Button>
      </div>
    </section>
  );
}

const COLUMNS = 'sm:grid-cols-[minmax(0,1fr)_12rem_4rem_4rem_4rem]';

function RulesForm({ data, canEdit }: { data: Loaded; canEdit: boolean }) {
  const { settings, channels } = data;
  const id = useId();
  const orgId = useOrgId();
  const edits = useAppStore((s) => editsIn(s.settings, 'notifications', orgId, settings.version).alerts);
  const editSettings = useAppStore((s) => s.editSettings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  // A rule shows its edited fields, else what the page read: a reload refreshes the rest.
  const rule = (kind: AlertKind): AlertRule => ({ ...settings.alerts[kind], ...edits?.[kind] });
  const edit = (kind: AlertKind, change: Partial<AlertRule>) =>
    editSettings(orgId, 'notifications', settings.version, { alerts: { ...edits, [kind]: { ...edits?.[kind], ...change } } });

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    void saveSettings(orgId, 'notifications', settings);
  }

  const box = (kind: AlertKind, when: string, channel: 'email' | 'slack' | 'webhook') => (
    <label className="flex items-center gap-2 sm:justify-center">
      <input
        type="checkbox"
        name={`${kind}.${channel}`}
        aria-label={`${CHANNEL_LABELS[channel]} for: ${when}`}
        checked={rule(kind)[channel]}
        onChange={(e) => edit(kind, { [channel]: e.target.checked })}
        disabled={!canEdit || (channel !== 'email' && !channels[channel])}
        className="size-5 accent-primary"
      />
      <span className="sm:sr-only" aria-hidden>
        {CHANNEL_LABELS[channel]}
      </span>
    </label>
  );

  return (
    <form onSubmit={submit} noValidate>
      <EditorFields>
        <SettingsSection
          id={`${id}-who`}
          title="Who hears about what"
          description="Who is for email; Slack and the webhook post to their one channel. Set a channel above to choose it here."
        >
          {/* A table's columns on wide screens; each rule stacks on a phone, its controls labelled. */}
          <div className={`hidden ${COLUMNS} gap-4 border-b pb-2 text-sm font-medium text-muted-foreground sm:grid`} aria-hidden>
            <span>When</span>
            <span>Who</span>
            <span className="text-center">Email</span>
            <span className="text-center">Slack</span>
            <span className="text-center">Webhook</span>
          </div>
          <ul className="divide-y">
            {ALERTS.map(({ kind, when, note }) => (
              <li key={kind} className={`grid gap-3 py-3 text-sm ${COLUMNS} sm:items-center sm:gap-4`}>
                <span>
                  <span className="block font-medium">{when}</span>
                  <span className="block text-muted-foreground">
                    {kind === 'screen_offline' ? `After ${settings.unreachableAfterMinutes} minutes; one alert each way` : note}
                  </span>
                </span>
                <NativeSelect
                  name={`${kind}.who`}
                  aria-label={`Who hears: ${when}`}
                  value={rule(kind).who}
                  onChange={(e) => {
                    if (isAudience(e.target.value)) edit(kind, { who: e.target.value });
                  }}
                  disabled={!canEdit}
                >
                  {AUDIENCES.map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </NativeSelect>
                <div className="flex flex-wrap gap-4 sm:contents">
                  {box(kind, when, 'email')}
                  {box(kind, when, 'slack')}
                  {box(kind, when, 'webhook')}
                </div>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">
            Offline alerts wait {settings.unreachableAfterMinutes} minutes:{' '}
            <Link to="/settings/screens" className="text-primary underline underline-offset-4">
              Screens &amp; groups
            </Link>
            .
          </p>
          <SaveRow at="notifications" scope={pageOf(orgId)} canEdit={canEdit} />
        </SettingsSection>
      </EditorFields>
    </form>
  );
}

function result(d: AlertDelivery): { text: string; tone: string } {
  const code = d.lastHttpStatus === null ? (d.lastError ?? '') : String(d.lastHttpStatus);
  const detail = code ? ` · ${code}` : '';
  switch (d.status) {
    case 'delivered':
      return { text: `Delivered${detail}`, tone: 'text-status-online-foreground' };
    case 'failed':
      return { text: `Failed${detail}`, tone: 'text-destructive' };
    case 'pending':
      return d.attempts ? { text: `Retrying${detail}`, tone: 'text-destructive' } : { text: 'Sending', tone: 'text-muted-foreground' };
  }
}

const LOG_COLUMNS = 'sm:grid-cols-[6rem_6rem_minmax(0,1fr)_minmax(0,1fr)_4.5rem_8rem]';

function DeliveryLog({ deliveries, canEdit, at }: { deliveries: AlertDelivery[]; canEdit: boolean; at: number }) {
  const now = useNow(at);
  const orgId = useOrgId();
  const retry = useAppStore((s) => s.retryAlertDelivery);
  const busy = useRunning(pageOf(orgId)) !== undefined;
  if (!deliveries.length) return <p className="text-sm text-muted-foreground">Nothing has been sent to Slack or a webhook yet.</p>;
  return (
    <>
      <div className={`hidden ${LOG_COLUMNS} gap-4 border-b pb-2 text-sm font-medium text-muted-foreground sm:grid`} aria-hidden>
        <span>When</span>
        <span>Where</span>
        <span>Alert</span>
        <span>Result</span>
        <span>Tries</span>
        <span />
      </div>
      <ul className="divide-y" aria-label="Recent deliveries">
        {deliveries.map((d) => {
          const { text, tone } = result(d);
          return (
            <li key={d.id} className={`grid grid-cols-2 gap-x-4 gap-y-1 py-3 text-sm ${LOG_COLUMNS} sm:items-center`}>
              <span className="text-muted-foreground">{since(now - d.createdAt)}</span>
              <span className="font-medium">{CHANNEL_LABELS[d.channel]}</span>
              <span>{EVENT_LABELS[d.eventType] ?? d.eventType}</span>
              <span className={`font-medium ${tone}`}>{text}</span>
              <span className="text-muted-foreground">
                {d.attempts} {d.attempts === 1 ? 'try' : 'tries'}
              </span>
              <span>
                {canEdit && d.status !== 'delivered' && (
                  <Button type="button" variant="outline" size="sm" aria-disabled={busy || undefined} onClick={() => void retry(orgId, d.id)}>
                    <RotateCwIcon aria-hidden /> Retry now
                  </Button>
                )}
              </span>
              <span className="col-span-2 empty:hidden sm:col-span-6">
                <ActionError at={`retry:${d.id}`} />
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}
