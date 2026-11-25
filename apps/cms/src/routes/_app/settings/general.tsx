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
import { FieldProblem, SaveState, SettingsSection } from '~/components/settings/parts';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { NativeSelect } from '~/components/ui/select';
import { useOrgId, useRole } from '~/lib/live';
import { getOrgSettings } from '~/server/settings.functions';
import { useAppStore } from '~/state/provider';
import { editsIn, settingsProblems, type SettingsEdits } from '~/state/settings';

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
  const orgId = useOrgId();
  const edits = useAppStore((s) => editsIn(s.settings, 'general', orgId, settings?.version ?? null));
  const editSettings = useAppStore((s) => s.editSettings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  if (!settings || !org) return null;
  // Each field shows its edit, else what the page read: a reload refreshes those not edited.
  const hours = edits.displayHours !== undefined ? edits.displayHours : settings.displayHours;
  const timezone = edits.timezone ?? settings.timezone ?? '';
  const locale = edits.locale ?? settings.locale ?? '';
  const locales = locale && !LOCALES.includes(locale) ? [locale, ...LOCALES] : LOCALES;
  const problems = settingsProblems(edits, settings);
  const edit = (change: SettingsEdits) => editSettings(orgId, 'general', settings.version, change);
  // Each change saves itself (#366): a choice at once, a typed field when it is left (or on Enter).
  const save = () => void saveSettings(orgId, 'general', settings, org);
  const choose = (change: SettingsEdits) => {
    edit(change);
    save();
  };

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    save();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6" noValidate>
      <EditorFields>
        <PageHeader title="General" description="The organization's name, and what new screens start with." />
        <SettingsSection id={`${id}-org`} title="Organization" description="Shown to members and in invite emails.">
          <div className="grid max-w-md gap-1.5">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input
              id={`${id}-name`}
              name="name"
              value={edits.name ?? org.name}
              onChange={(e) => edit({ name: e.target.value })}
              onBlur={save}
              maxLength={100}
              required
              disabled={!canEdit}
              aria-invalid={problems.name !== undefined || undefined}
              aria-describedby={problems.name ? `${id}-name-bad` : undefined}
            />
            <FieldProblem id={`${id}-name-bad`} text={problems.name} />
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
              <NativeSelect id={`${id}-tz`} name="timezone" value={timezone} onChange={(e) => choose({ timezone: e.target.value })} disabled={!canEdit}>
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
              <NativeSelect
                id={`${id}-locale`}
                name="locale"
                value={locale}
                onChange={(e) => choose({ locale: e.target.value })}
                disabled={!canEdit}
                aria-describedby={`${id}-locale-help`}
              >
                <option value="">The player's default</option>
                {locales.map((tag) => (
                  <option key={tag} value={tag}>
                    {localeName(tag)}
                  </option>
                ))}
              </NativeSelect>
              <p id={`${id}-locale-help`} className="text-meta text-muted-foreground">
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
          {canEdit ? (
            <DisplayHoursEditor
              value={hours}
              // Hours a screen would refuse are said in the editor, and not sent.
              onChange={(displayHours) => (hoursProblems(displayHours).length ? edit({ displayHours }) : choose({ displayHours }))}
              headed
            />
          ) : (
            <p className="text-sm">{describeHours(settings.displayHours)}</p>
          )}
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
              value={edits.auditRetentionDays ?? settings.auditRetentionDays}
              onChange={(e) => edit({ auditRetentionDays: e.target.value })}
              onBlur={save}
              disabled={!canEdit}
              className="w-24"
              aria-invalid={problems.auditRetentionDays !== undefined || undefined}
              aria-describedby={problems.auditRetentionDays ? `${id}-retention-unit ${id}-retention-bad` : `${id}-retention-unit`}
            />
            <span id={`${id}-retention-unit`} className="text-sm">
              days, 30 to 3,650
            </span>
          </div>
          <FieldProblem id={`${id}-retention-bad`} text={problems.auditRetentionDays} />
        </SettingsSection>

        <SaveState form="general" canEdit={canEdit} />
      </EditorFields>
    </form>
  );
}
