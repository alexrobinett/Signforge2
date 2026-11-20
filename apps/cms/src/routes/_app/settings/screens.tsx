/**
 * Settings, Screens & groups (canvas board SettingsScreens): the update window, and how long a
 * screen may go without a heartbeat before it alerts. Groups are managed on the Screens page.
 */
import { createFileRoute, Link } from '@tanstack/react-router';
import { useId, type SubmitEvent } from 'react';
import { PageHeader } from '~/components/page';
import { SaveRow, SettingsSection, useFormKey } from '~/components/settings/parts';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { useRole } from '~/lib/live';
import { getOrgSettings } from '~/server/settings.functions';
import { useAppStore } from '~/state/provider';

export const Route = createFileRoute('/_app/settings/screens')({
  loader: () => getOrgSettings(),
  head: () => ({ meta: [{ title: 'Screens & groups settings · SignForge' }] }),
  component: ScreenSettings,
});

function ScreenSettings() {
  const settings = Route.useLoaderData();
  const canEdit = useRole() === 'owner';
  const id = useId();
  const formKey = useFormKey();
  const saveScreenDefaults = useAppStore((s) => s.saveScreenDefaults);
  if (!settings) return null;

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!settings) return;
    const form = new FormData(e.currentTarget);
    const text = (key: string) => String(form.get(key) ?? '');
    void saveScreenDefaults({ updateWindow: { from: text('from'), to: text('to') }, unreachableAfterMinutes: Number(text('minutes')) }, settings.version);
  }

  return (
    <form key={formKey} onSubmit={submit} className="space-y-6" noValidate>
      <PageHeader title="Screens & groups" description="When screens update, and how long one may be silent before it alerts." />
      <SettingsSection
        id={`${id}-window`}
        title="Update window"
        description="Content changes download at once and switch at the end of the loop. Player and system updates wait for this window."
      >
        <div className="flex flex-wrap items-end gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-from`}>From</Label>
            <Input id={`${id}-from`} name="from" type="time" defaultValue={settings.updateWindow.from} disabled={!canEdit} className="w-36" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-to`}>To</Label>
            <Input id={`${id}-to`} name="to" type="time" defaultValue={settings.updateWindow.to} disabled={!canEdit} className="w-36" />
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
            defaultValue={settings.unreachableAfterMinutes}
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

      <SaveRow at="screens" canEdit={canEdit} />
    </form>
  );
}
