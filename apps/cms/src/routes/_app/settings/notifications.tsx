/**
 * Settings, Notifications (canvas board SettingsNotifications): who hears about what, by email.
 * Slack, Teams and webhooks come with the integrations proposal; until then email is the channel.
 */
import { createFileRoute } from '@tanstack/react-router';
import { useId, type SubmitEvent } from 'react';
import { PageHeader } from '~/components/page';
import { SaveRow, SettingsSection } from '~/components/settings/parts';
import { NativeSelect } from '~/components/ui/select';
import { useRole } from '~/lib/live';
import { ALERTS, AUDIENCES, isAudience, type AlertKind, type AlertRule } from '~/lib/settings';
import { getOrgSettings } from '~/server/settings.functions';
import { useAppStore } from '~/state/provider';

export const Route = createFileRoute('/_app/settings/notifications')({
  loader: () => getOrgSettings(),
  head: () => ({ meta: [{ title: 'Notifications · SignForge' }] }),
  component: NotificationSettings,
});

function NotificationSettings() {
  const settings = Route.useLoaderData();
  const canEdit = useRole() === 'owner';
  const id = useId();
  const saveAlerts = useAppStore((s) => s.saveAlerts);
  if (!settings) return null;

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!settings) return;
    const form = new FormData(e.currentTarget);
    const alerts: Record<AlertKind, AlertRule> = { ...settings.alerts };
    for (const { kind } of ALERTS) {
      const who = form.get(`${kind}.who`);
      alerts[kind] = { who: isAudience(who) ? who : settings.alerts[kind].who, email: form.get(`${kind}.email`) === 'on' };
    }
    void saveAlerts(alerts);
  }

  return (
    <form key={settings.updatedAt ?? 0} onSubmit={submit} className="space-y-6" noValidate>
      <PageHeader title="Notifications" description="Who hears about what, by email." />
      <SettingsSection id={`${id}-where`} title="Where alerts go" description="Email, to each member's own address. Slack, Teams and webhooks come later.">
        <p className="text-sm">
          <span className="font-medium">Email</span> · on
        </p>
      </SettingsSection>
      <SettingsSection id={`${id}-who`} title="Who hears about what">
        {/* A table's columns on wide screens; each rule stacks on a phone, its controls labelled. */}
        <div className="hidden grid-cols-[minmax(0,1fr)_12rem_4rem] gap-4 border-b pb-2 text-sm font-medium text-muted-foreground sm:grid" aria-hidden>
          <span>When</span>
          <span>Who</span>
          <span className="text-center">Email</span>
        </div>
        <ul className="divide-y">
          {ALERTS.map(({ kind, when, note }) => (
            <li key={kind} className="grid gap-3 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_12rem_4rem] sm:items-center sm:gap-4">
              <span>
                <span className="block font-medium">{when}</span>
                <span className="block text-muted-foreground">
                  {kind === 'screen_offline' ? `After ${settings.unreachableAfterMinutes} minutes; one email each way` : note}
                </span>
              </span>
              <NativeSelect name={`${kind}.who`} aria-label={`Who hears: ${when}`} defaultValue={settings.alerts[kind].who} disabled={!canEdit}>
                {AUDIENCES.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </NativeSelect>
              <label className="flex items-center gap-2 sm:justify-center">
                <input
                  type="checkbox"
                  name={`${kind}.email`}
                  aria-label={`Email for: ${when}`}
                  defaultChecked={settings.alerts[kind].email}
                  disabled={!canEdit}
                  className="size-5 accent-primary"
                />
                <span className="sm:sr-only" aria-hidden>
                  Email
                </span>
              </label>
            </li>
          ))}
        </ul>
      </SettingsSection>
      <SaveRow at="notifications" canEdit={canEdit} />
    </form>
  );
}
