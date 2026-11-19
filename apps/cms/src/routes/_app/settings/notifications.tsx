/**
 * Settings, Notifications (canvas board SettingsNotifications): where alerts go (email, a Slack
 * channel through an incoming webhook, a signed outgoing webhook), who hears about what, and the
 * deliveries of the last days (#88). Teams comes later, through the integrations foundation (#83).
 */
import { createFileRoute, Link } from '@tanstack/react-router';
import { CopyIcon, LoaderCircleIcon, RotateCwIcon, SendIcon } from 'lucide-react';
import { useId, type ReactNode, type SubmitEvent } from 'react';
import { toast } from 'sonner';
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
import { useNow, useRole } from '~/lib/live';
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
import { getNotifications } from '~/server/settings.functions';
import { useAppStore } from '~/state/provider';

export const Route = createFileRoute('/_app/settings/notifications')({
  loader: () => getNotifications(),
  head: () => ({ meta: [{ title: 'Notifications · SignForge' }] }),
  component: NotificationSettings,
});

type Loaded = NonNullable<ReturnType<typeof Route.useLoaderData>>;

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
      <RemoveChannelDialog />
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

/** A set channel's rarer actions, folded away so the card stays a summary. */
function Manage({ children }: { children: ReactNode }) {
  return (
    <details className="w-full">
      <summary className="cursor-pointer text-sm font-medium">Manage</summary>
      <div className="mt-2 flex flex-wrap items-center gap-2">{children}</div>
    </details>
  );
}

interface CardProps {
  channel: AlertChannel | null;
  last: AlertDelivery | undefined;
  names: Record<string, string>;
  canEdit: boolean;
  at: number;
}

function SlackCard({ channel, last, names, canEdit, at }: CardProps) {
  const now = useNow(at);
  const connectSlack = useAppStore((s) => s.connectSlack);
  const ask = useAppStore((s) => s.askToRemoveAlertChannel);
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    void connectSlack(String(new FormData(e.currentTarget).get('url') ?? ''), channel?.version);
  };
  const form = (label: string) => (
    <UrlForm name="Slack incoming-webhook URL" placeholder="https://hooks.slack.com/services/…" button={label} at="slack" onSubmit={submit} />
  );
  if (!channel)
    return (
      <ChannelCard
        title="Slack"
        detail="Post to a channel through an incoming webhook you make in Slack"
        state={<span className="text-muted-foreground">Not set</span>}
      >
        {canEdit && form('Connect Slack')}
      </ChannelCard>
    );
  return (
    <ChannelCard
      title="Slack"
      detail={<span className="font-mono">{channel.host}</span>}
      state={<Connected channel={channel} names={names} last={last} now={now} />}
    >
      {canEdit && (
        <>
          <TestButton channel="slack" label="Send a test" />
          <Manage>
            {form('Replace')}
            <Button type="button" variant="ghost" className="text-destructive" onClick={() => ask('slack')}>
              Remove Slack
            </Button>
          </Manage>
        </>
      )}
    </ChannelCard>
  );
}

function WebhookCard({ channel, last, names, canEdit, at }: CardProps) {
  const now = useNow(at);
  const setWebhook = useAppStore((s) => s.setWebhook);
  const rotate = useAppStore((s) => s.rotateSigningSecret);
  const ask = useAppStore((s) => s.askToRemoveAlertChannel);
  const pending = useAppStore((s) => s.settings.pending === 'webhook');
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    void setWebhook(String(new FormData(e.currentTarget).get('url') ?? ''), channel?.version);
  };
  const form = (label: string) => (
    <UrlForm name="Webhook URL" placeholder="https://example.com/hooks/signforge" button={label} at="webhook" onSubmit={submit} />
  );
  if (!channel)
    return (
      <ChannelCard title="Webhook" detail="POST each alert as signed JSON to your own system" state={<span className="text-muted-foreground">Not set</span>}>
        {canEdit && form('Add webhook')}
      </ChannelCard>
    );
  return (
    <ChannelCard
      title="Webhook"
      detail={<span className="font-mono">{channel.host}</span>}
      state={<Connected channel={channel} names={names} last={last} now={now} />}
    >
      {canEdit && (
        <>
          <TestButton channel="webhook" label="Send a test" />
          <Manage>
            <Button type="button" variant="outline" disabled={pending} onClick={() => void rotate(channel.version)}>
              <RotateCwIcon aria-hidden /> New signing secret
            </Button>
            <Button type="button" variant="ghost" className="text-destructive" onClick={() => ask('webhook')}>
              Remove webhook
            </Button>
            {form('Save URL')}
          </Manage>
        </>
      )}
    </ChannelCard>
  );
}

/** A channel's URL, which SignForge stores sealed and never shows again. */
function UrlForm({
  name,
  placeholder,
  button,
  at,
  onSubmit,
}: {
  name: string;
  placeholder: string;
  button: string;
  at: string;
  onSubmit: (e: SubmitEvent<HTMLFormElement>) => void;
}) {
  const id = useId();
  const pending = useAppStore((s) => s.settings.pending === at);
  return (
    <form onSubmit={onSubmit} className="mt-2 w-full space-y-2" noValidate>
      <Label htmlFor={id}>{name}</Label>
      <Input id={id} name="url" type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder={placeholder} required />
      <p className="text-xs text-muted-foreground">Kept encrypted, and never shown again.</p>
      <ActionError at={at} />
      <Button type="submit" disabled={pending}>
        {pending && <LoaderCircleIcon className="animate-spin" aria-hidden />} {button}
      </Button>
    </form>
  );
}

function TestButton({ channel, label }: { channel: AlertDelivery['channel']; label: string }) {
  const test = useAppStore((s) => s.testAlertChannel);
  const pending = useAppStore((s) => s.settings.pending === `test:${channel}`);
  return (
    <>
      <Button type="button" variant="outline" disabled={pending} onClick={() => void test(channel)}>
        {pending ? <LoaderCircleIcon className="animate-spin" aria-hidden /> : <SendIcon aria-hidden />} {label}
      </Button>
      <ActionError at={`test:${channel}`} />
    </>
  );
}

/** The signing secret just made: shown here once, then only its holder has it. */
function SigningSecretOnce() {
  const secret = useAppStore((s) => s.settings.signingSecret);
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
  const saveAlerts = useAppStore((s) => s.saveAlerts);

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const alerts: Record<AlertKind, AlertRule> = { ...settings.alerts };
    for (const { kind } of ALERTS) {
      const who = form.get(`${kind}.who`);
      const rule = settings.alerts[kind];
      // A channel that is not set has its box disabled, which sends nothing: its stored choice stays.
      const on = (channel: 'email' | 'slack' | 'webhook') =>
        channel !== 'email' && !channels[channel] ? rule[channel] : form.get(`${kind}.${channel}`) === 'on';
      alerts[kind] = { who: isAudience(who) ? who : rule.who, email: on('email'), slack: on('slack'), webhook: on('webhook') };
    }
    void saveAlerts(alerts, settings.version);
  }

  const box = (kind: AlertKind, when: string, channel: 'email' | 'slack' | 'webhook') => (
    <label className="flex items-center gap-2 sm:justify-center">
      <input
        type="checkbox"
        name={`${kind}.${channel}`}
        aria-label={`${CHANNEL_LABELS[channel]} for: ${when}`}
        defaultChecked={settings.alerts[kind][channel]}
        disabled={!canEdit || (channel !== 'email' && !channels[channel])}
        className="size-5 accent-primary"
      />
      <span className="sm:sr-only" aria-hidden>
        {CHANNEL_LABELS[channel]}
      </span>
    </label>
  );

  return (
    <form key={settings.version} onSubmit={submit} noValidate>
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
              <NativeSelect name={`${kind}.who`} aria-label={`Who hears: ${when}`} defaultValue={settings.alerts[kind].who} disabled={!canEdit}>
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
        <SaveRow at="notifications" canEdit={canEdit} />
      </SettingsSection>
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
  const retry = useAppStore((s) => s.retryAlertDelivery);
  const pending = useAppStore((s) => s.settings.pending);
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
                  <Button type="button" variant="outline" size="sm" disabled={pending === `retry:${d.id}`} onClick={() => void retry(d.id)}>
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

function RemoveChannelDialog() {
  const kind = useAppStore((s) => s.settings.removingChannel);
  const ask = useAppStore((s) => s.askToRemoveAlertChannel);
  const remove = useAppStore((s) => s.removeAlertChannel);
  const pending = useAppStore((s) => s.settings.pending === `remove:${kind}`);
  const name = kind === 'slack' ? 'Slack' : 'the webhook';
  return (
    <AlertDialog open={kind !== null} onOpenChange={(open) => !open && ask(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Stop sending alerts to {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its URL{kind === 'webhook' ? ' and signing secret are' : ' is'} forgotten, and alerts still waiting for it are not sent. You can set it again later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {kind && <ActionError at={`remove:${kind}`} />}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={pending} onClick={() => kind && void remove(kind)}>
            Remove
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
