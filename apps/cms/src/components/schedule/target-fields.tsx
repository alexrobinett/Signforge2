/** Whom a schedule entry or takeover plays on: every screen, a group's screens, or one screen. */
import { useId } from 'react';
import { NativeSelect } from '~/components/ui/select';
import type { ScheduleEntryView } from '~/lib/schedule';
import type { GroupView, ScreenView } from '~/lib/screen-types';

type Target = ScheduleEntryView['target'];
interface Aim {
  target: Target;
  groupId: string;
  screenId: string;
}

export function TargetFields({
  value,
  screens,
  groups,
  onChange,
}: {
  value: Aim;
  screens: ScreenView[];
  groups: GroupView[];
  onChange: (v: Partial<Aim>) => void;
}) {
  const id = useId();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="grid gap-1.5">
        <label htmlFor={`${id}-target`} className="text-sm font-medium">
          Plays on
        </label>
        <NativeSelect id={`${id}-target`} value={value.target} onChange={(e) => onChange({ target: targetOf(e.target.value) })}>
          <option value="org">Every screen</option>
          <option value="group" disabled={!groups.length}>
            A group of screens
          </option>
          <option value="screen" disabled={!screens.length}>
            One screen
          </option>
        </NativeSelect>
      </div>
      {value.target === 'group' && (
        <div className="grid gap-1.5">
          <label htmlFor={`${id}-group`} className="text-sm font-medium">
            Group
          </label>
          <NativeSelect id={`${id}-group`} value={value.groupId} onChange={(e) => onChange({ groupId: e.target.value })}>
            <option value="" disabled>
              Choose a group
            </option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name} ({g.screenIds.length === 1 ? '1 screen' : `${g.screenIds.length} screens`})
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
      {value.target === 'screen' && (
        <div className="grid gap-1.5">
          <label htmlFor={`${id}-screen`} className="text-sm font-medium">
            Screen
          </label>
          <NativeSelect id={`${id}-screen`} value={value.screenId} onChange={(e) => onChange({ screenId: e.target.value })}>
            <option value="" disabled>
              Choose a screen
            </option>
            {screens.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
    </div>
  );
}

const targetOf = (v: string): Target => (v === 'group' || v === 'screen' ? v : 'org');
