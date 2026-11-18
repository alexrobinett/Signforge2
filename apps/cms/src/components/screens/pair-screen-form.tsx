/**
 * Claim the code a screen shows: name it, give its time zone, orientation, groups and display
 * hours. `claim_screen` makes the screen; its groups are then set with `set_group_members`, the
 * same tools an agent would use (M3-08: no groups in the claim).
 */
import { useNavigate, useRouter } from '@tanstack/react-router';
import { LoaderCircleIcon } from 'lucide-react';
import { useId, useMemo, useReducer, type FormEvent } from 'react';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { NativeSelect } from '~/components/ui/select';
import type { DisplayHours, GroupView, ScreenView } from '~/lib/screen-types';
import { callTool, toolMessage } from '~/lib/tools';
import { DisplayHoursEditor, hoursProblems } from './display-hours-editor';
import { normaliseCode, PAIRING_CODE_LENGTH, PairingCodeInput } from './pairing-code-input';

function timezones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC'];
  }
}

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

type Orientation = 'landscape' | 'portrait';

interface Pairing {
  code: string;
  name: string;
  timezone: string;
  orientation: Orientation;
  groupIds: string[];
  hours: DisplayHours | null;
  pending: boolean;
  error: string | null;
  /** One key per form, so a retried click cannot pair twice. */
  key: string;
}

type PairingAction =
  | { type: 'codeEntered'; code: string }
  | { type: 'nameEntered'; name: string }
  | { type: 'zoneChosen'; timezone: string }
  | { type: 'orientationChosen'; orientation: Orientation }
  | { type: 'groupToggled'; groupId: string; member: boolean }
  | { type: 'hoursChanged'; hours: DisplayHours | null }
  | { type: 'claimStarted' }
  | { type: 'claimFailed'; error: string };

const startPairing = (name: string): Pairing => ({
  code: '',
  name,
  timezone: browserZone(),
  orientation: 'landscape',
  groupIds: [],
  hours: null,
  pending: false,
  error: null,
  key: crypto.randomUUID(),
});

function pairing(s: Pairing, a: PairingAction): Pairing {
  switch (a.type) {
    case 'codeEntered':
      return { ...s, code: a.code };
    case 'nameEntered':
      return { ...s, name: a.name };
    case 'zoneChosen':
      return { ...s, timezone: a.timezone };
    case 'orientationChosen':
      return { ...s, orientation: a.orientation };
    case 'groupToggled':
      return { ...s, groupIds: a.member ? [...s.groupIds, a.groupId] : s.groupIds.filter((g) => g !== a.groupId) };
    case 'hoursChanged':
      return { ...s, hours: a.hours };
    case 'claimStarted':
      return { ...s, pending: true, error: null };
    case 'claimFailed':
      return { ...s, pending: false, error: a.error };
  }
}

export function PairScreenForm({ groups, compact = false, defaultName = '' }: { groups: GroupView[]; compact?: boolean; defaultName?: string }) {
  const router = useRouter();
  const navigate = useNavigate();
  const id = useId();
  const zones = useMemo(timezones, []);
  const [f, dispatch] = useReducer(pairing, undefined, () => startPairing(defaultName));
  const { code, name, timezone, orientation, groupIds, hours, pending, error, key } = f;

  const ready = normaliseCode(code).length === PAIRING_CODE_LENGTH && name.trim().length > 0 && hoursProblems(hours).length === 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    dispatch({ type: 'claimStarted' });
    try {
      const { screen } = await callTool<{ screen: ScreenView }>('claim_screen', {
        code: normaliseCode(code),
        name: name.trim(),
        timezone,
        orientation,
        ...(hours ? { displayHours: hours } : {}),
        idempotencyKey: key,
      });
      for (const g of groups.filter((g) => groupIds.includes(g.id))) {
        await callTool('set_group_members', { groupId: g.id, screenIds: [...g.screenIds, screen.id] });
      }
      await router.invalidate();
      await navigate({ to: '/screens/$screenId', params: { screenId: screen.id } });
    } catch (err) {
      dispatch({ type: 'claimFailed', error: toolMessage(err) });
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-5">
      <div className="space-y-2">
        <span id={`${id}-code`} className="text-[15px] font-semibold">
          Type the code the screen shows
        </span>
        <PairingCodeInput
          value={code}
          onChange={(code) => dispatch({ type: 'codeEntered', code })}
          labelledBy={`${id}-code`}
          describedBy={`${id}-code-help`}
          invalid={!!error}
        />
        <p id={`${id}-code-help`} className="text-[13px] text-muted-foreground">
          6 characters, as the screen shows them. Pasting the whole code works too. A code lasts 15 minutes.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-name`}>Name it</Label>
          <Input
            id={`${id}-name`}
            value={name}
            onChange={(e) => dispatch({ type: 'nameEntered', name: e.target.value })}
            placeholder="Lobby"
            maxLength={100}
            required
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-tz`}>Time zone</Label>
          <NativeSelect id={`${id}-tz`} value={timezone} onChange={(e) => dispatch({ type: 'zoneChosen', timezone: e.target.value })}>
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
            onChange={(e) => dispatch({ type: 'orientationChosen', orientation: e.target.value as Orientation })}
          >
            <option value="landscape">Landscape (16:9)</option>
            <option value="portrait">Portrait (9:16)</option>
          </NativeSelect>
        </div>
        {groups.length > 0 && (
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">Groups</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {groups.map((g) => (
                <label key={g.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={groupIds.includes(g.id)}
                    onChange={(e) => dispatch({ type: 'groupToggled', groupId: g.id, member: e.target.checked })}
                  />
                  {g.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </div>
      {!compact && <DisplayHoursEditor value={hours} onChange={(hours) => dispatch({ type: 'hoursChanged', hours })} />}
      <p role="alert" className="text-sm font-medium text-destructive empty:hidden">
        {error}
      </p>
      <Button type="submit" size="lg" disabled={!ready || pending}>
        {pending && <LoaderCircleIcon className="animate-spin" aria-hidden />}
        {pending ? 'Pairing…' : 'Pair'}
      </Button>
    </form>
  );
}
