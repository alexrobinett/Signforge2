/**
 * Settings, Screens & groups (canvas board SettingsScreens): the update window, and how long a
 * screen may go without a heartbeat before it alerts. Groups are managed on the Screens page.
 */
import { createFileRoute, Link } from '@tanstack/react-router';
import { useId, type SubmitEvent } from 'react';
import { EditorFields } from '~/components/editor';
import { PageHeader } from '~/components/page';
import { SaveRow, SettingsSection } from '~/components/settings/parts';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { useOrgId, useRole } from '~/lib/live';
import { getOrgSettings } from '~/server/settings.functions';
import { useAppStore } from '~/state/provider';
import { editsIn, type SettingsEdits } from '~/state/settings';

export const Route = createFileRoute('/_app/settings/screens')({
  loader: () => getOrgSettings(),
  head: () => ({ meta: [{ title: 'Screens & groups settings · SignForge' }] }),
  component: ScreenSettings,
});

function ScreenSettings() {
  const settings = Route.useLoaderData();
  const canEdit = useRole() === 'owner';
  const id = useId();
  const orgId = useOrgId();
  const edits = useAppStore((s) => editsIn(s.settings, 'screens', orgId, settings?.version ?? null));
  const editSettings = useAppStore((s) => s.editSettings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  if (!settings) return null;
  const edit = (change: SettingsEdits) => editSettings(orgId, 'screens', settings.version, change);

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (settings) void saveSettings(orgId, 'screens', settings);
  }

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      <EditorFields>
        <PageHeader title="Screens & groups" description="When screens update, and how long one may be silent before it alerts." />
        <SettingsSection
          id={`${id}-window`}
          title="Update window"
          description="Content changes download at once and switch at the end of the loop. Player and system updates wait for this window."
        >
          <div className="flex flex-wrap items-end gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-from`}>From</Label>
              <Input
                id={`${id}-from`}
                name="from"
                type="time"
                value={edits.updateFrom ?? settings.updateWindow.from}
                onChange={(e) => edit({ updateFrom: e.target.value })}
                disabled={!canEdit}
                className="w-36"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-to`}>To</Label>
              <Input
                id={`${id}-to`}
                name="to"
                type="time"
                value={edits.updateTo ?? settings.updateWindow.to}
                onChange={(e) => edit({ updateTo: e.target.value })}
                disabled={!canEdit}
                className="w-36"
              />
            </div>
          </div>
          <p className="text-[13px] text-muted-foreground">Local time at each screen. A window that ends before it starts runs past midnight.</p>
        </SettingsSection>

        <SettingsSection
          id={`${id}-offline`}
          title="Offline alerts"
          description="A screen that misses heartbeats keeps playing from its cache, so a short gap is not worth a message."
        >
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor={`${id}-minutes`}>Alert after</Label>
            <Input
              id={`${id}-minutes`}
              name="minutes"
              type="number"
              min={5}
              max={1440}
              step={1}
              inputMode="numeric"
              value={edits.unreachableAfterMinutes ?? settings.unreachableAfterMinutes}
              onChange={(e) => edit({ unreachableAfterMinutes: e.target.value })}
              disabled={!canEdit}
              className="w-24"
              aria-describedby={`${id}-minutes-unit`}
            />
            <span id={`${id}-minutes-unit`} className="text-sm">
              minutes without a heartbeat
            </span>
          </div>
          <p className="text-[13px] text-muted-foreground">
            Screens check in every 5 minutes. One email goes out when a screen passes this, and one when it is back.{' '}
            <Link to="/settings/notifications" className="text-primary underline underline-offset-4">
              Choose who gets these alerts
            </Link>
            .
          </p>
        </SettingsSection>

        <SaveRow at="screens" scope={{ page: 'screens', orgId }} canEdit={canEdit} />
      </EditorFields>
    </form>
  );
}
