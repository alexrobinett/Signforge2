import { useQuery } from '@tanstack/react-query';
import { useParams, useRouterState } from '@tanstack/react-router';
import { defaultFilter } from 'cmdk';
import { ArrowLeftIcon, Building2Icon, CornerDownLeftIcon, LoaderCircleIcon, SparklesIcon, UsersIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useCallback } from 'react';
import { OrgAvatar } from '~/components/org-switcher';
import { KIND_WORD, StatusGlyph, toneOf } from '~/components/screens/status';
import { reachable } from '~/lib/screen-status';
import { Button } from '~/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '~/components/ui/command';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import {
  askEntry,
  commandEntries,
  foundValues,
  movesSelection,
  NULL_CHOICE,
  orgCommands,
  pageQuestions,
  pointerMovesSelection,
  readsAsSentence,
  selectedItem,
  targetActions,
  targetItemKey,
  type CommandEntry,
  type CommandTarget,
  type Field,
  type ToolListing,
} from '~/lib/command-menu';
import { useOrgId, useRole } from '~/lib/live';
import type { GroupView, ScreenView } from '~/lib/screen-types';
import { SECTIONS } from '~/lib/sections';
import { byName, matchesQuery, screenKeywords } from '~/lib/targets';
import { retryUnlessRedirect } from '~/queries/retry';
import { screensQuery } from '~/queries/screens';
import type { Shell } from '~/server/shell.functions';
import { useAppStore } from '~/state/provider';

const FIELD =
  'flex w-full min-w-0 rounded-lg border border-input bg-card px-3 py-2 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive md:text-sm';

const Mono = ({ children, className = '' }: { children: string; className?: string }) => (
  <span className={`shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground ${className}`}>{children}</span>
);

/** The org list's first button takes focus when the list replaces the commands. Stable, so it runs once. */
const focusFirstButton = (list: HTMLUListElement | null) => list?.querySelector('button')?.focus();

/** The form's first field takes focus when the form appears. Stable, so it runs once per form. */
const focusFirstField = (form: HTMLFormElement | null) => form?.querySelector<HTMLElement>('input, select, textarea')?.focus();

/** A search takes focus when its view appears within an open menu (Back). Stable, so it runs once per view. */
const focusSearch = (input: HTMLInputElement | null) => input?.focus();

/** A found screen's or group's item value: cmdk matches it with `matchesQuery` (lib/targets.ts), the target picker's search. */
const TARGET = /^(screen|group):/;
/**
 * A question for the agent always shows: what was typed, or the page's own (#270). What was typed ranks
 * first only as a sentence; one or two words rank below every page, record and tool they find.
 */
const filter = (value: string, search: string, keywords?: string[]) =>
  value.startsWith('ask:')
    ? value !== 'ask:typed' || readsAsSentence(search)
      ? 1
      : Number.MIN_VALUE
    : TARGET.test(value)
      ? matchesQuery(search, keywords ?? [])
        ? 1
        : 0
      : defaultFilter(value, search, keywords);

const screenCount = (n: number) => `${n} ${n === 1 ? 'screen' : 'screens'}`;

/**
 * A found screen's or group's actions (`targetActions`): Open first, so Enter opens it. A screen's
 * commands wait for the list read on this opening (`checked`). The header is outside cmdk's root,
 * which takes Enter for the selected action: Enter on Back goes back.
 */
function TargetView({
  target,
  screens,
  groups,
  tools,
  checked,
  checking,
  failed,
}: {
  target: CommandTarget;
  screens: ScreenView[];
  groups: GroupView[];
  tools: ToolListing[];
  checked: boolean;
  checking: boolean;
  /** The list read on this opening failed, and is not being tried again. */
  failed: boolean;
}) {
  const running = useAppStore((s) => s.commandMenu.running);
  const back = useAppStore((s) => s.backToCommands);
  const run = useAppStore((s) => s.runTargetAction);
  const screen = target.kind === 'screen' ? screens.find((s) => s.id === target.id) : undefined;
  const group = target.kind === 'group' ? groups.find((g) => g.id === target.id) : undefined;
  const actions = screen ? targetActions({ kind: 'screen', screen }, tools, checked) : group ? targetActions({ kind: 'group', group }, tools, checked) : [];
  const name = screen?.name ?? group?.name ?? (checking ? 'Checking…' : 'Not found');
  // Said only where the role has commands and the screen is not known to be revoked: only the check is missing.
  const waiting = screen && !checked && screen.status !== 'revoked' && tools.some((t) => t.name === 'identify_screen' || t.name === 'restart_screen');

  return (
    <>
      <div className="flex items-center gap-2 border-b py-2.5 pr-4 pl-2">
        <Button type="button" variant="ghost" size="icon" onClick={back} aria-label="Back to commands">
          <ArrowLeftIcon className="size-4.5" aria-hidden />
        </Button>
        {screen && <StatusGlyph tone={toneOf(screen.state.kind)} />}
        {group && <UsersIcon className="size-4 text-muted-foreground" aria-hidden />}
        <h3 className="min-w-0 flex-1 truncate text-base font-semibold">{name}</h3>
        <span className="shrink-0 text-meta text-muted-foreground">
          {screen ? KIND_WORD[screen.state.kind] : group ? screenCount(group.screenIds.length) : ''}
        </span>
      </div>
      <Command label={`Actions for ${name}`} loop>
        <CommandInput ref={focusSearch} placeholder={`Filter the actions for ${name}`} />
        <CommandList>
          <CommandEmpty>
            {screen || group ? 'No action matches.' : checking ? 'Checking it is still here…' : 'It is no longer here. Go back and search again.'}
          </CommandEmpty>
          <CommandGroup heading="Actions">
            {actions.map((a) => (
              <CommandItem key={a.label} value={a.label} disabled={running} onSelect={() => void run(a)}>
                <span className="min-w-0 flex-1 truncate">{a.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
        <p role="status" className="border-t px-4 py-3 text-meta text-muted-foreground empty:sr-only">
          {running
            ? 'A call is on its way: these wait for its answer.'
            : waiting && checking
              ? `Checking ${name} before Identify and Restart…`
              : waiting && failed
                ? `Couldn’t check ${name}, so Identify and Restart are off. Close ⌘K and open it again to retry.`
                : screen && checked && screen.status !== 'revoked' && !reachable(screen) && tools.some((t) => t.name === 'restart_screen')
                  ? `Restart is off: ${name} cannot be reached now, and a restart only reaches a screen in touch.`
                  : ''}
        </p>
      </Command>
    </>
  );
}

function FieldInput({
  field,
  id,
  defaultValue,
  invalid,
  ref,
}: {
  field: Field;
  id: string;
  defaultValue: string | undefined;
  invalid: boolean;
  ref: ((el: HTMLElement | null) => void) | undefined;
}) {
  const common = {
    ref,
    id,
    name: field.name,
    required: field.required && !field.nullable,
    defaultValue,
    'aria-invalid': invalid || undefined,
    'aria-describedby': `${id}-hint`,
  };
  switch (field.type) {
    case 'key':
      return null;
    case 'boolean':
      return <input type="checkbox" {...common} className="size-4.5 accent-primary" />;
    case 'choice':
      return (
        <select {...common} className={`${FIELD} h-10`}>
          {!field.required && <option value="">Not set</option>}
          {field.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
          {field.nullable && <option value={NULL_CHOICE}>null</option>}
        </select>
      );
    case 'json':
      return <textarea {...common} rows={3} spellCheck={false} className={`${FIELD} font-mono`} />;
    case 'integer':
    case 'number':
      return <Input {...common} type="number" step={field.type === 'integer' ? 1 : 'any'} />;
    case 'text':
      return <Input {...common} autoComplete="off" spellCheck={false} />;
  }
}

/** A picked tool's form: one field per input, from its JSON Schema. */
function ToolForm({ entry }: { entry: Extract<CommandEntry, { kind: 'tool' }> }) {
  const running = useAppStore((s) => s.commandMenu.running);
  const fieldError = useAppStore((s) => s.commandMenu.fieldError);
  const back = useAppStore((s) => s.backToCommands);
  const submit = useAppStore((s) => s.submitToolForm);
  // The page's own ids fill the fields of the same name: on a screen's page, its screenId.
  const params: Record<string, string | undefined> = useParams({ strict: false });
  const { tool } = entry;
  // Each refusal moves focus to its field, which then reads out its error (its description): from
  // Run, a keyboard or screen-reader user would miss both. A new error is a new ref, so React calls it again.
  const focusInvalid = useCallback((el: HTMLElement | null) => (fieldError ? el?.focus() : undefined), [fieldError]);

  return (
    <form
      ref={focusFirstField}
      className="flex flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(entry.label, tool, new FormData(e.currentTarget));
      }}
    >
      <div className="flex items-center gap-2 border-b py-2.5 pr-4 pl-2">
        <Button type="button" variant="ghost" size="icon" onClick={back} aria-label="Back to commands">
          <ArrowLeftIcon className="size-4.5" aria-hidden />
        </Button>
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-3">
          <h3 className="line-clamp-2 flex-1 text-base font-semibold">{entry.label}</h3>
          <Mono>{tool.name}</Mono>
        </div>
      </div>
      <div className="max-h-[min(470px,60dvh)] space-y-4 overflow-y-auto px-4 py-4">
        <p className="text-sm text-muted-foreground">{tool.description}</p>
        {tool.fields
          .filter((f) => f.type !== 'key')
          .map((f) => {
            const id = `cmd-field-${f.name}`;
            const error = fieldError?.field === f.name ? fieldError.message : null;
            return (
              <div key={f.name} className={f.type === 'boolean' ? 'flex flex-row-reverse items-center justify-end gap-2.5' : 'space-y-1.5'}>
                <Label htmlFor={id} className="font-mono text-xs">
                  {f.name}
                  {f.required ? '' : ' (optional)'}
                </Label>
                <FieldInput field={f} id={id} defaultValue={params[f.name]} invalid={error !== null} ref={error === null ? undefined : focusInvalid} />
                <p id={`${id}-hint`} className={error ? 'text-xs font-medium text-destructive' : 'text-xs text-muted-foreground empty:hidden'}>
                  {error ?? f.hint}
                </p>
              </div>
            );
          })}
      </div>
      <div className="flex items-center justify-end gap-2 border-t bg-muted/50 px-4 py-3">
        <Button type="button" variant="ghost" onClick={back}>
          Back
        </Button>
        <Button type="submit" disabled={running}>
          {running && <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />}
          Run
        </Button>
      </div>
    </form>
  );
}

/**
 * "Switch organization…": the member's other orgs as buttons, the first focused. The active one is
 * not offered: choosing it would reload for nothing, and the sidebar switcher ignores it too.
 */
function OrgList({ shell, hues }: { shell: Shell; hues: Map<string, number> }) {
  const back = useAppStore((s) => s.backToCommands);
  const chooseOrg = useAppStore((s) => s.chooseOrg);
  const switchingTo = useAppStore((s) => s.orgs.switchingTo);
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b py-2.5 pr-4 pl-2">
        <Button type="button" variant="ghost" size="icon" onClick={back} aria-label="Back to commands">
          <ArrowLeftIcon className="size-4.5" aria-hidden />
        </Button>
        <h3 id="switch-org-heading" className="text-base font-semibold">
          Switch organization
        </h3>
      </div>
      <ul ref={focusFirstButton} aria-labelledby="switch-org-heading" className="max-h-[min(470px,60dvh)] space-y-0.5 overflow-y-auto p-2">
        {shell.organizations
          .filter((org) => org.id !== shell.organization?.id)
          .map((org) => (
            <li key={org.id}>
              <button
                type="button"
                onClick={() => void chooseOrg(org)}
                disabled={switchingTo !== null}
                className="flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
              >
                <OrgAvatar name={org.name} hue={hues.get(org.id)!} className="size-6 rounded text-2xs" />
                <span className="min-w-0 flex-1 truncate">{org.name}</span>
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}

/**
 * ⌘K: go to any section, run any tool the member's role allows, switch or create an org, or find a
 * screen or group by name and act on it, from every signed-in page. The tools are the registry
 * agents call (src/lib/command-menu.ts). It opens with no motion.
 */
export function CommandMenu({ shell, hues }: { shell: Shell; hues: Map<string, number> }) {
  const open = useAppStore((s) => s.commandMenu.open);
  const openMenu = useAppStore((s) => s.openCommandMenu);
  const close = useAppStore((s) => s.closeCommandMenu);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => (o ? openMenu() : close())}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 dark:bg-black/70" />
        <DialogPrimitive.Content className="fixed top-[12dvh] left-1/2 z-50 w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl outline-none dark:border-border-strong">
          <DialogPrimitive.Title className="sr-only">Command menu</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Go to a page, or run an action. Type to filter; Enter runs the selected one.
          </DialogPrimitive.Description>
          <MenuBody shell={shell} hues={hues} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** The open menu: the list, a tool's form, the org list, or a found screen's or group's actions. Mounted on each open, so it reads the screens again then. */
function MenuBody({ shell, hues }: { shell: Shell; hues: Map<string, number> }) {
  const { tools } = shell;
  const query = useAppStore((s) => s.commandMenu.query);
  const choosingOrg = useAppStore((s) => s.commandMenu.choosingOrg);
  const form = useAppStore((s) => s.commandMenu.form);
  const target = useAppStore((s) => s.commandMenu.target);
  const running = useAppStore((s) => s.commandMenu.running);
  const choose = useAppStore((s) => s.chooseCommand);
  const search = useAppStore((s) => s.searchCommands);
  const selection = useAppStore((s) => s.commandMenu.selection);
  const moved = useAppStore((s) => s.commandMenu.moved);
  const backed = useAppStore((s) => s.commandMenu.backed);
  const select = useAppStore((s) => s.selectCommand);
  const move = useAppStore((s) => s.moveCommandSelection);
  const chooseTarget = useAppStore((s) => s.chooseTarget);
  const askFromMenu = useAppStore((s) => s.askFromMenu);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const owner = useRole() === 'owner';
  // The org's screens and groups (`list_screens`, `list_groups`): the Screens page's list, shown from its cache and read again
  // on each opening (this body mounts on each), so a screen or group someone else made since is found.
  const orgId = useOrgId();
  // One retry, not the app's three: someone is waiting at the menu, and opening it again tries again.
  const fleet = useQuery({ ...screensQuery(orgId), enabled: orgId !== '', refetchOnMount: 'always', retry: retryUnlessRedirect(1) });
  // Read since this opening, and it worked: only then may a screen be sent a command. A read already on its way as the
  // menu opens (leaving Screens, say) is joined, not repeated: it began moments before.
  const checked = fleet.isFetchedAfterMount && fleet.isSuccess;
  const failed = fleet.isError && !fleet.isFetching;
  const screens = fleet.data?.screens ?? [];
  const groups = fleet.data?.groups ?? [];
  const searching = query.trim() !== '';
  const found = foundValues(query, screens, groups);
  const shownSelection = selectedItem(selection, found, moved);
  // Said in the list, as the tools' long descriptions match almost any search, so the empty text seldom shows.
  const listStatus = running
    ? 'A call is on its way: the commands wait for its answer.'
    : !searching
      ? ''
      : failed
        ? fleet.data
          ? 'Couldn’t check the screens: they are as last read, and Identify and Restart are off. Close ⌘K and open it again to retry.'
          : 'Couldn’t read the screens, so none are listed. Close ⌘K and open it again to retry.'
        : !checked && fleet.isFetching && !found.length
          ? 'Looking for screens…'
          : '';

  const entries = [...commandEntries(tools, owner), ...orgCommands(shell.organizations.length)];
  // What was typed, for the agent: first when it reads as a sentence, else last, below what it found (#270).
  const asked = searching ? askEntry(query) : undefined;
  const sentence = searching && readsAsSentence(query);
  const questions = searching ? [] : pageQuestions(path);
  const picked = entries.find((e) => e.kind === 'tool' && e.tool.name === form);
  const go = entries.filter((e) => e.kind === 'go' || e.kind === 'agent');
  const org = entries.filter((e) => e.kind === 'org');
  const actions = entries.filter((e) => (e.kind === 'tool' && !e.developer) || e.kind === 'takeover');
  const developer = entries.filter((e) => e.kind === 'tool' && e.developer);
  const icon = (to: string) => SECTIONS.find((s) => s.to === to)?.icon;

  const item = (e: CommandEntry) => {
    const Icon = e.kind === 'go' ? icon(e.to) : undefined;
    return (
      <CommandItem key={e.id} value={e.id} keywords={[e.label, ...e.keywords]} disabled={running} onSelect={() => void choose(e)}>
        {Icon && <Icon className="size-4 text-muted-foreground" aria-hidden />}
        {e.kind === 'org' && <Building2Icon className="size-4 text-muted-foreground" aria-hidden />}
        {(e.kind === 'agent' || e.kind === 'ask') && <SparklesIcon className="size-4 text-actor-agent" aria-hidden />}
        <span className="line-clamp-2 min-w-0 flex-1 sm:truncate">{e.label}</span>
        {(e.kind === 'tool' || e.kind === 'takeover') && <Mono className="hidden sm:inline">{e.tool.name}</Mono>}
      </CommandItem>
    );
  };

  return picked?.kind === 'tool' ? (
    <ToolForm key={picked.id} entry={picked} />
  ) : choosingOrg ? (
    <OrgList shell={shell} hues={hues} />
  ) : target ? (
    <TargetView target={target} screens={screens} groups={groups} tools={tools} checked={checked} checking={fleet.isFetching} failed={failed} />
  ) : (
    <Command
      label="Search pages, screens and actions"
      loop
      filter={filter}
      value={shownSelection}
      onValueChange={(value) => select(value, JSON.stringify(found))}
      onKeyDown={(e) => {
        // ⌘Enter on a question asks it and keeps the menu open (#270).
        const question = [asked, ...questions].find((q) => q?.id === shownSelection);
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && question?.kind === 'ask') {
          e.preventDefault();
          askFromMenu(question.question, true);
          return;
        }
        if (movesSelection(e)) move();
      }}
      // cmdk selects by pointer only over an enabled item, in each item's own handler, which replaces one passed to it.
      onPointerMove={(e) => {
        const item = e.target instanceof Element ? e.target.closest('[cmdk-item]') : null;
        const under = item && { value: item.getAttribute('data-value') ?? '', disabled: item.getAttribute('aria-disabled') === 'true' };
        if (pointerMovesSelection(under, shownSelection)) move();
      }}
    >
      {/* On opening, Radix's focus trap focuses the search, once it holds focus: a focus before that is lost to a menu still closing. */}
      <CommandInput ref={backed ? focusSearch : undefined} value={query} onValueChange={search} placeholder="Go to a page, find a screen, or type an action">
        <kbd className="rounded-md border px-1.5 py-0.5 font-mono text-xs text-muted-foreground">esc</kbd>
      </CommandInput>
      <p role="status" className="border-b px-4 py-2 text-meta text-muted-foreground empty:sr-only">
        {listStatus}
      </p>
      <CommandList>
        <CommandEmpty>No page, screen or action matches. Try part of a screen’s name, or a verb like “rename”.</CommandEmpty>
        {asked && sentence && <CommandGroup heading="Agent">{item(asked)}</CommandGroup>}
        {/* Found by name only: listed before anything is typed, a fleet of 200 would bury the pages. */}
        {searching && screens.length > 0 && (
          <CommandGroup heading="Screens">
            {[...screens].sort(byName).map((s) => {
              const keywords = screenKeywords(s, groups);
              return (
                <CommandItem
                  key={targetItemKey(s.id, keywords)}
                  value={`screen:${s.id}`}
                  keywords={keywords}
                  disabled={running}
                  onSelect={() => chooseTarget({ kind: 'screen', id: s.id })}
                >
                  <StatusGlyph tone={toneOf(s.state.kind)} />
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  <span className="text-meta text-muted-foreground">{KIND_WORD[s.state.kind]}</span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}
        {searching && groups.length > 0 && (
          <CommandGroup heading="Groups">
            {[...groups].sort(byName).map((g) => (
              <CommandItem
                key={targetItemKey(g.id, [g.name])}
                value={`group:${g.id}`}
                keywords={[g.name]}
                disabled={running}
                onSelect={() => chooseTarget({ kind: 'group', id: g.id })}
              >
                <UsersIcon className="size-4 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{g.name}</span>
                <span className="text-meta text-muted-foreground">{screenCount(g.screenIds.length)}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup heading="Go to">{go.map(item)}</CommandGroup>
        {questions.length > 0 && <CommandGroup heading="Ask the agent">{questions.map(item)}</CommandGroup>}
        <CommandGroup heading="Organization">{org.map(item)}</CommandGroup>
        {actions.length > 0 && <CommandGroup heading="Actions">{actions.map(item)}</CommandGroup>}
        {developer.length > 0 && <CommandGroup heading="Developer">{developer.map(item)}</CommandGroup>}
        {asked && !sentence && <CommandGroup heading="Agent">{item(asked)}</CommandGroup>}
      </CommandList>
      <p className="flex items-center gap-2 border-t bg-muted/50 px-4 py-3 text-meta text-muted-foreground">
        <CornerDownLeftIcon className="size-3.5 shrink-0" aria-hidden />
        These actions are the tool registry: the same names and roles agents call. The audit log records them by name.
      </p>
    </Command>
  );
}
