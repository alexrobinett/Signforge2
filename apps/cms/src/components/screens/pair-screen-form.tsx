/**
 * Claim the code a screen shows: name it, give its time zone, orientation, labels (#185: typed, or copied from
 * another screen), groups and display hours. `claim_screen` makes the screen with its labels; it is then added to its groups with `save_group`, the
 * same tools an agent would use (M3-08: no groups in the claim).
 */
import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { LoaderCircleIcon } from 'lucide-react';
import { useId, useSyncExternalStore, type SubmitEvent } from 'react';
import { EditorFields } from '~/components/editor';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { NativeSelect } from '~/components/ui/select';
import { isOrientation, type GroupView } from '~/lib/screen-types';
import { useOrgId } from '~/lib/live';
import { byName } from '~/lib/targets';
import { screensQuery } from '~/queries/screens';
import { LabelEditor } from './labels';
import { labelRowsOf } from '~/state/labels';
import { useAppStore } from '~/state/provider';
import { hoursProblems } from '~/lib/screen-types';
import { DisplayHoursEditor } from './display-hours-editor';
import { normaliseCode, PAIRING_CODE_LENGTH, PairingCodeInput } from './pairing-code-input';

function timezones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC'];
  }
}

/** Every IANA zone the browser knows, once. */
export const zones = timezones();

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/** The browser's own time zone, read as an outside value so the server's render (UTC) hydrates cleanly. */
const noChange = () => () => {};
const useBrowserZone = () => useSyncExternalStore(noChange, browserZone, () => 'UTC');

/** The form is on the Screens page, whose loader reads the org's defaults for new screens. */
const screensPage = getRouteApi('/_app/screens/');

export function PairScreenForm({ groups, compact = false }: { groups: GroupView[]; compact?: boolean }) {
  const id = useId();
  const browser = useBrowserZone();
  const orgDefaults = screensPage.useLoaderData({ select: (d) => d.settings });
  const { code, name, timezone: chosenZone, orientation, groupIds, hours: chosenHours, pending, error } = useAppStore((s) => s.screens.pairing);
  const enterPairingCode = useAppStore((s) => s.enterPairingCode);
  const nameNewScreen = useAppStore((s) => s.nameNewScreen);
  const chooseNewScreenZone = useAppStore((s) => s.chooseNewScreenZone);
  const chooseNewScreenOrientation = useAppStore((s) => s.chooseNewScreenOrientation);
  const toggleNewScreenGroup = useAppStore((s) => s.toggleNewScreenGroup);
  const setNewScreenHours = useAppStore((s) => s.setNewScreenHours);
  const pairScreen = useAppStore((s) => s.pairScreen);
  const copyLabelsForPairing = useAppStore((s) => s.copyLabelsForPairing);
  const chooseLabelSource = useAppStore((s) => s.chooseLabelSource);
  const copyFrom = useAppStore((s) => s.labels.copyFrom);
  const typed = useAppStore((s) => labelRowsOf(s.labels, 'pairing').some((r) => r.key.trim() || r.value.trim()));
  // The screens with labels to copy, as the Screens page has them: a new store's screens labelled as they are paired.
  const labelled = (useQuery(screensQuery(useOrgId())).data?.screens ?? [])
    .filter((s) => s.status !== 'revoked' && Object.keys(s.labels).length)
    .toSorted(byName);
  const source = labelled.find((s) => s.id === copyFrom);
  const defaults = { timezone: orgDefaults?.timezone ?? browser, locale: orgDefaults?.locale ?? null, hours: orgDefaults?.displayHours ?? null };
  const timezone = chosenZone ?? defaults.timezone;
  const hours = chosenHours === undefined ? defaults.hours : chosenHours;

  const ready = normaliseCode(code).length === PAIRING_CODE_LENGTH && name.trim().length > 0 && hoursProblems(hours).length === 0;

  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (ready) void pairScreen(defaults);
  }

  return (
    <form onSubmit={submit} noValidate>
      {/* Controlled by the store: a field changed before the form hydrates is set back by React (#140). */}
      <EditorFields>
        <div className="space-y-5">
          <div className="space-y-2">
            <span id={`${id}-code`} className="text-md font-semibold">
              Type the code the screen shows
            </span>
            <PairingCodeInput value={code} onChange={enterPairingCode} labelledBy={`${id}-code`} describedBy={`${id}-code-help`} invalid={!!error} />
            <p id={`${id}-code-help`} className="text-meta text-muted-foreground">
              6 characters, as the screen shows them. Pasting the whole code works too. A code lasts 15 minutes.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-name`}>Name it</Label>
              <Input id={`${id}-name`} value={name} onChange={(e) => nameNewScreen(e.target.value)} placeholder="Lobby" maxLength={100} required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-tz`}>Time zone</Label>
              <NativeSelect id={`${id}-tz`} value={timezone} onChange={(e) => chooseNewScreenZone(e.target.value)}>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z.replaceAll('_', ' ')}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-or`}>Orientation</Label>
              <NativeSelect
                id={`${id}-or`}
                value={orientation}
                onChange={(e) => {
                  if (isOrientation(e.target.value)) chooseNewScreenOrientation(e.target.value);
                }}
              >
                <option value="landscape">Landscape (16:9)</option>
                <option value="portrait">Portrait (9:16)</option>
              </NativeSelect>
            </div>
            {groups.length > 0 && (
              <fieldset className="grid gap-1.5">
                <legend className="mb-1.5 text-sm font-medium">Groups</legend>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {groups.toSorted(byName).map((g) => (
                    <label key={g.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={groupIds.includes(g.id)}
                        onChange={(e) => toggleNewScreenGroup(g.id, e.target.checked)}
                      />
                      {g.name}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
          </div>
          {labelled.length > 0 && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="grid gap-1.5 sm:max-w-xs">
                <Label htmlFor={`${id}-copy`}>Copy labels from…</Label>
                <NativeSelect id={`${id}-copy`} value={copyFrom} onChange={(e) => chooseLabelSource(e.target.value)}>
                  <option value="">Another screen</option>
                  {labelled.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              {/* Only this button copies, so choosing in the list (arrow keys change it) never replaces what is typed. */}
              <Button type="button" variant="outline" disabled={!source} onClick={() => source && copyLabelsForPairing(source.labels)}>
                {typed ? 'Replace with its labels' : 'Copy its labels'}
              </Button>
            </div>
          )}
          <LabelEditor target="pairing" />
          {!compact && <DisplayHoursEditor value={hours} onChange={setNewScreenHours} headed={false} />}
          <p role="alert" className="text-sm font-medium text-destructive empty:hidden">
            {error}
          </p>
          <Button type="submit" size="lg" disabled={!ready || pending}>
            {pending && <LoaderCircleIcon className="animate-spin" aria-hidden />}
            {pending ? 'Pairing…' : 'Pair'}
          </Button>
        </div>
      </EditorFields>
    </form>
  );
}
