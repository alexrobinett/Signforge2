/**
 * Settings, General (canvas board SettingsGeneral): the org's name, the time zone, locale
 * and display hours new screens start with, and how long the audit log is kept. Owners change
 * them; everyone else reads them.
 */
import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import { useId, type SubmitEvent } from 'react';
import { describeHours, DisplayHoursEditor, hoursProblems } from '~/components/screens/display-hours-editor';
import { zones } from '~/components/screens/pair-screen-form';
import { EditorFields } from '~/components/editor';
import { PageHeader } from '~/components/page';
import { SaveRow, SettingsSection, useFormKey } from '~/components/settings/parts';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { NativeSelect } from '~/components/ui/select';
import { useRole } from '~/lib/live';
import { getOrgSettings } from '~/server/settings.functions';
import { useAppStore } from '~/state/provider';

export const Route = createFileRoute('/_app/settings/general')({
  loader: () => getOrgSettings(),
  head: () => ({ meta: [{ title: 'General settings · SignForge' }] }),
  component: GeneralSettings,
});

/** Locales offered, by tag; one already chosen that is not here is offered too. */
const LOCALES = ['en-US', 'en-GB', 'en-CA', 'en-AU', 'fr-FR', 'fr-CA', 'de-DE', 'es-ES', 'es-MX', 'it-IT', 'nl-NL', 'pt-BR', 'ja-JP'];

const localeName = (tag: string) => {
  try {
    return `${new Intl.DisplayNames([tag], { type: 'language' }).of(tag) ?? tag}, ${tag}`;
  } catch {
    return tag;
  }
};

const app = getRouteApi('/_app');

function GeneralSettings() {
  const settings = Route.useLoaderData();
  const org = app.useLoaderData().organization;
  const canEdit = useRole() === 'owner';
  const id = useId();
  const formKey = useFormKey();
  const draftHours = useAppStore((s) => s.settings.hours);
  const editDefaultHours = useAppStore((s) => s.editDefaultHours);
  const saveGeneral = useAppStore((s) => s.saveGeneral);
  if (!settings || !org) return null;
  const hours = draftHours ? draftHours.value : settings.displayHours;
  const locales = settings.locale && !LOCALES.includes(settings.locale) ? [settings.locale, ...LOCALES] : LOCALES;

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!org || !settings || hoursProblems(hours).length) return;
    const form = new FormData(e.currentTarget);
    const text = (key: string) => {
      const v = form.get(key);
      return typeof v === 'string' && v ? v : null;
    };
    void saveGeneral(
      org,
      { name: text('name') ?? '', timezone: text('timezone'), locale: text('locale'), auditRetentionDays: Number(text('auditRetentionDays')) },
      settings.version,
    );
  }

  return (
    <form key={formKey} onSubmit={submit} className="flex flex-col gap-6" noValidate>
      <EditorFields>
        <PageHeader title="General" description="The organization's name, and what new screens start with." />
        <SettingsSection id={`${id}-org`} title="Organization" description="Shown to members and in invite emails.">
          <div className="grid max-w-md gap-1.5">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input id={`${id}-name`} name="name" defaultValue={org.name} maxLength={100} required disabled={!canEdit} />
          </div>
        </SettingsSection>

        <SettingsSection
          id={`${id}-time`}
          title="Time and language"
          description="New screens start with these; each screen can change them afterwards. Schedules run in each screen's own time zone."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid content-start gap-1.5">
              <Label htmlFor={`${id}-tz`}>Time zone</Label>
              <NativeSelect id={`${id}-tz`} name="timezone" defaultValue={settings.timezone ?? ''} disabled={!canEdit}>
                <option value="">The browser's, when pairing</option>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z.replaceAll('_', ' ')}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid content-start gap-1.5">
              <Label htmlFor={`${id}-locale`}>Locale</Label>
              <NativeSelect id={`${id}-locale`} name="locale" defaultValue={settings.locale ?? ''} disabled={!canEdit} aria-describedby={`${id}-locale-help`}>
                <option value="">The player's default</option>
                {locales.map((tag) => (
                  <option key={tag} value={tag}>
                    {localeName(tag)}
                  </option>
                ))}
              </NativeSelect>
              <p id={`${id}-locale-help`} className="text-[13px] text-muted-foreground">
                Templates format dates, times and prices with it.
              </p>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          id={`${id}-hours`}
          title="Default display hours"
          description="New screens start with these. Outside them a screen turns its panel off and keeps syncing."
        >
          {canEdit ? <DisplayHoursEditor value={hours} onChange={editDefaultHours} /> : <p className="text-sm">{describeHours(settings.displayHours)}</p>}
        </SettingsSection>

        <SettingsSection
          id={`${id}-audit`}
          title="Audit log"
          description="Every change by a person, agent or screen is recorded. Entries older than this are deleted each night at 00:00 UTC."
        >
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor={`${id}-retention`}>Keep entries for</Label>
            <Input
              id={`${id}-retention`}
              name="auditRetentionDays"
              type="number"
              min={30}
              max={3650}
              step={1}
              inputMode="numeric"
              defaultValue={settings.auditRetentionDays}
              disabled={!canEdit}
              className="w-24"
              aria-describedby={`${id}-retention-unit`}
            />
            <span id={`${id}-retention-unit`} className="text-sm">
              days, 30 to 3,650
            </span>
          </div>
        </SettingsSection>

        <SaveRow at="general" canEdit={canEdit} />
      </EditorFields>
    </form>
  );
}
