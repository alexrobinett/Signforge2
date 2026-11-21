/**
 * Whom something plays on (#180): every screen, a group, or one screen, found by typing part of a
 * name or a group's name. The button shows the choice and opens the search, full-screen on a
 * phone, keyboard first; a group says how many screens it reaches. What is typed is in the store
 * (state/target-picker.ts). The schedule's dialogs use it, and the week view for its one screen.
 */
import { CheckIcon, ChevronsUpDownIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useId } from 'react';
import { KIND_WORD, StatusGlyph, toneOf } from '~/components/screens/status';
import { Button } from '~/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '~/components/ui/command';
import type { ScheduleEntryView } from '~/lib/schedule';
import type { GroupView, ScreenView } from '~/lib/screen-types';
import { findTargets, groupReach } from '~/lib/targets';
import { cn } from '~/lib/utils';
import { useAppStore } from '~/state/provider';

type Target = ScheduleEntryView['target'];

/** A choice: whom, and the group's or the screen's id (empty for the others). */
interface Aim {
  target: Target;
  groupId: string;
  screenId: string;
}

const EVERY_KIND: readonly Target[] = ['org', 'group', 'screen'];
const count = (n: number) => `${n} ${n === 1 ? 'screen' : 'screens'}`;

export function TargetPicker({
  label,
  value,
  screens,
  groups,
  kinds = EVERY_KIND,
  onPick,
  className,
}: {
  label: string;
  value: Aim;
  screens: ScreenView[];
  groups: GroupView[];
  /** What may be picked: the week view shows one screen, so it offers screens alone. */
  kinds?: readonly Target[];
  onPick: (aim: Aim) => void;
  className?: string;
}) {
  const id = useId();
  const open = useAppStore((s) => s.targetPicker.open === id);
  const query = useAppStore((s) => s.targetPicker.query);
  const openPicker = useAppStore((s) => s.openTargetPicker);
  const search = useAppStore((s) => s.searchTargets);
  const close = useAppStore((s) => s.closeTargetPicker);

  const found = findTargets(open ? query : '', screens, groups);
  const showOrg = kinds.includes('org') && found.org;
  const shownGroups = kinds.includes('group') ? found.groups : [];
  const shownScreens = kinds.includes('screen') ? found.screens : [];
  const group = value.target === 'group' ? groups.find((g) => g.id === value.groupId) : undefined;
  const screen = value.target === 'screen' ? screens.find((s) => s.id === value.screenId) : undefined;
  const chosen = value.target === 'org' ? 'Every screen' : (group?.name ?? screen?.name ?? (value.target === 'group' ? 'Choose a group' : 'Choose a screen'));
  const current = value.target === 'org' ? 'org' : value.target === 'group' ? `group:${value.groupId}` : `screen:${value.screenId}`;
  const what = kinds.length === 1 && kinds[0] === 'screen' ? 'screens' : 'screens and groups';

  const pick = (aim: Aim) => {
    close();
    onPick(aim);
  };
  const tick = (v: string) =>
    v === current && (
      <>
        <CheckIcon className="size-4 text-foreground" aria-hidden />
        <span className="sr-only">, chosen</span>
      </>
    );

  return (
    <div className={cn('grid gap-1.5', className)}>
      <label htmlFor={`${id}-button`} className="text-sm font-medium">
        {label}
      </label>
      <DialogPrimitive.Root open={open} onOpenChange={(o) => (o ? openPicker(id) : close())}>
        <DialogPrimitive.Trigger asChild>
          <button
            id={`${id}-button`}
            type="button"
            role="combobox"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-describedby={group ? `${id}-reach` : undefined}
            className="flex h-10 w-full min-w-0 items-center gap-2 rounded-lg border border-input bg-card px-3 text-left text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60 md:text-sm"
          >
            {screen && <StatusGlyph tone={toneOf(screen.state.kind)} />}
            <span className={cn('min-w-0 flex-1 truncate', !group && !screen && value.target !== 'org' && 'text-muted-foreground')}>{chosen}</span>
            <ChevronsUpDownIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        </DialogPrimitive.Trigger>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 dark:bg-black/70" />
          {/* Full-screen on a phone, where a list in a dialog in a dialog has no room; a panel like ⌘K's above it. */}
          <DialogPrimitive.Content
            aria-describedby={undefined}
            className="fixed inset-0 z-50 flex flex-col bg-popover text-popover-foreground outline-none sm:inset-auto sm:top-[12dvh] sm:left-1/2 sm:w-[calc(100%-2rem)] sm:max-w-lg sm:-translate-x-1/2 sm:overflow-hidden sm:rounded-xl sm:border sm:shadow-2xl dark:sm:border-border-strong"
          >
            <DialogPrimitive.Title className="sr-only">{label}</DialogPrimitive.Title>
            <Command label={`Search ${what}`} shouldFilter={false} loop defaultValue={current} className="min-h-0 flex-1">
              <CommandInput value={query} onValueChange={search} placeholder={`Type part of a name: ${what}`}>
                <DialogPrimitive.Close asChild>
                  <Button variant="ghost" size="sm" className="sm:hidden">
                    Cancel
                  </Button>
                </DialogPrimitive.Close>
              </CommandInput>
              <CommandList className="max-h-none flex-1 sm:max-h-[min(470px,60dvh)]">
                <CommandEmpty>
                  No {what} match “{query}”.
                </CommandEmpty>
                {showOrg && (
                  <CommandGroup heading="Every screen">
                    <CommandItem value="org" onSelect={() => pick({ target: 'org', groupId: '', screenId: '' })}>
                      <span className="min-w-0 flex-1 truncate">Every screen</span>
                      <span className="text-[13px] text-muted-foreground">{count(screens.length)}</span>
                      {tick('org')}
                    </CommandItem>
                  </CommandGroup>
                )}
                {shownGroups.length > 0 && (
                  <CommandGroup heading="Groups">
                    {shownGroups.map((g) => (
                      <CommandItem key={g.id} value={`group:${g.id}`} onSelect={() => pick({ target: 'group', groupId: g.id, screenId: '' })}>
                        <span className="min-w-0 flex-1 truncate">{g.name}</span>
                        <span className="text-[13px] text-muted-foreground">{count(g.screenIds.length)}</span>
                        {tick(`group:${g.id}`)}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {shownScreens.length > 0 && (
                  <CommandGroup heading="Screens">
                    {shownScreens.map((s) => {
                      const inGroups = groups.filter((g) => g.screenIds.includes(s.id)).map((g) => g.name);
                      return (
                        <CommandItem key={s.id} value={`screen:${s.id}`} onSelect={() => pick({ target: 'screen', groupId: '', screenId: s.id })}>
                          <StatusGlyph tone={toneOf(s.state.kind)} />
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate">{s.name}</span>
                            {inGroups.length > 0 && <span className="truncate text-[13px] text-muted-foreground">{inGroups.join(', ')}</span>}
                          </span>
                          <span className="text-[13px] text-muted-foreground">{KIND_WORD[s.state.kind]}</span>
                          {tick(`screen:${s.id}`)}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                )}
              </CommandList>
            </Command>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
      {group && (
        <p id={`${id}-reach`} className="text-xs text-muted-foreground">
          {groupReach(group, screens)}
        </p>
      )}
    </div>
  );
}
