/**
 * Settings, Notifications (canvas board SettingsNotifications): who hears about what, by email.
 * Slack, Teams and webhooks come with the integrations proposal; until then email is the channel.
 */
import { createFileRoute } from '@tanstack/react-router';
import { useId, type SubmitEvent } from 'react';
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
      <SettingsSection id={`${id}-where`} title="Where alerts go" description="Email, to each member's own address. Slack, Teams and webhooks come later.">
        <p className="text-sm">
          <span className="font-medium">Email</span> · on
        </p>
      </SettingsSection>
      <SettingsSection id={`${id}-who`} title="Who hears about what">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <th scope="col" className="py-2 pr-3 text-left font-medium">
                  When
                </th>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  Who
                </th>
                <th scope="col" className="px-3 py-2 text-center font-medium">
                  Email
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {ALERTS.map(({ kind, when, note }) => (
                <tr key={kind}>
                  <th scope="row" className="py-3 pr-3 text-left font-normal">
                    <span className="block font-medium">{when}</span>
                    <span className="block text-muted-foreground">{kind === 'screen_offline' ? `After ${settings.unreachableAfterMinutes} minutes; one email each way` : note}</span>
                  </th>
                  <td className="px-3 py-3">
                    <NativeSelect name={`${kind}.who`} aria-label={`Who hears: ${when}`} defaultValue={settings.alerts[kind].who} disabled={!canEdit} className="w-48">
                      {AUDIENCES.map((a) => (
                        <option key={a.value} value={a.value}>
                          {a.label}
                        </option>
                      ))}
                    </NativeSelect>
                  </td>
                  <td className="px-3 py-3 text-center">
                    <input
                      type="checkbox"
                      name={`${kind}.email`}
                      aria-label={`Email for: ${when}`}
                      defaultChecked={settings.alerts[kind].email}
                      disabled={!canEdit}
                      className="size-5 accent-primary"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SettingsSection>
      <SaveRow at="notifications" canEdit={canEdit} />
    </form>
  );
}
