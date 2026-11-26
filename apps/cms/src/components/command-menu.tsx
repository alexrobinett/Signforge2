import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { defaultFilter } from 'cmdk';
import { ArrowLeftIcon, Building2Icon, SparklesIcon, UsersIcon, ZapIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { OrgAvatar } from '~/components/org-switcher';
import { KIND_WORD, StatusGlyph, toneOf } from '~/components/screens/status';
import { reachable } from '~/lib/screen-status';
import { Button } from '~/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '~/components/ui/command';
import {
  agentEntry,
  askEntry,
  asksFirst,
  foundValues,
  movesSelection,
  orgCommands,
  pageActions,
  pageEntries,
  pageQuestions,
  peopleActions,
  pointerMovesSelection,
  selectedItem,
  targetActions,
  targetItemKey,
  type CommandEntry,
  type CommandTarget,
  type ToolListing,
} from '~/lib/command-menu';
import { useCanPublish, useOrgId } from '~/lib/live';
import type { GroupView, ScreenView } from '~/lib/screen-types';
import { SECTIONS } from '~/lib/sections';
import { byName, matchesQuery, screenKeywords } from '~/lib/targets';
import { retryUnlessRedirect } from '~/queries/retry';
import { playlistsQuery } from '~/queries/playlists';
import { screensQuery } from '~/queries/screens';
import { spotsQuery } from '~/queries/spots';
import type { Shell } from '~/server/shell.functions';
import { useAppStore } from '~/state/provider';

/** The org list's first button takes focus when the list replaces the commands. Stable, so it runs once. */
const focusFirstButton = (list: HTMLUListElement | null) => list?.querySelector('button')?.focus();

/** A search takes focus when its view appears within an open menu (Back). Stable, so it runs once per view. */
const focusSearch = (input: HTMLInputElement | null) => input?.focus();

/** A found screen's or group's item value: cmdk matches it with `matchesQuery` (lib/targets.ts), the target picker's search. */
const TARGET = /^(screen|group):/;
/**
 * A question for the agent always shows: what was typed, or the page's own (#270). What was typed ranks
 * first only when the menu put it first (`asksFirst`); otherwise below every page, record and tool found.
 */
const filter = (value: string, search: string, keywords?: string[]) =>
  value.startsWith('ask:')
    ? value === 'ask:typed:last'
      ? Number.MIN_VALUE
      : 1
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
  const waiting = screen && !checked && screen.status !== 'revoked' && tools.some((t) => t.name === 'screen_command');

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
                : screen && checked && screen.status !== 'revoked' && !reachable(screen) && tools.some((t) => t.name === 'screen_command')
                  ? `Restart is off: ${name} cannot be reached now, and a restart only reaches a screen in touch.`
                  : ''}
        </p>
      </Command>
    </>
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
 * ⌘K (#358): the page's own actions and questions for the agent on opening; typed, every action the
 * member's role allows, the pages, the org commands, and screens and groups by name, each with its
 * actions. Each action opens the page's own dialog (src/lib/command-menu.ts). It opens with no motion.
 */
export function CommandMenu({ shell, hues }: { shell: Shell; hues: Map<string, number> }) {
  const open = useAppStore((s) => s.commandMenu.open);
  const openMenu = useAppStore((s) => s.openCommandMenu);
  const close = useAppStore((s) => s.closeCommandMenu);
  const focusBack = useAppStore((s) => s.menuFocusBack);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => (o ? openMenu() : close())}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-scrim" />
        <DialogPrimitive.Content
          onCloseAutoFocus={focusBack}
          className="fixed top-[12dvh] left-1/2 z-50 w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl outline-none dark:border-border-strong"
        >
          <DialogPrimitive.Title className="sr-only">Command menu</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Run an action for this page, ask the agent, or type to find a page, a screen or another action. Enter runs the selected one.
          </DialogPrimitive.Description>
          <MenuBody shell={shell} hues={hues} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** The open menu: the list, the org list, or a found screen's or group's actions. Mounted on each open, so it reads the screens again then. */
function MenuBody({ shell, hues }: { shell: Shell; hues: Map<string, number> }) {
  const { tools } = shell;
  const query = useAppStore((s) => s.commandMenu.query);
  const choosingOrg = useAppStore((s) => s.commandMenu.choosingOrg);
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
  const canPublish = useCanPublish();
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
  // The spots and playlists the pages have read, from their cache: a name typed in full is found, not asked about.
  const spots = useQuery({ ...spotsQuery(orgId), enabled: false });
  const playlists = useQuery({ ...playlistsQuery(orgId), enabled: false });
  // Publish all is offered while there is something to publish, by the count this opening read itself (state/command-menu.ts).
  const drafts = useAppStore((s) => s.commandMenu.drafts) && canPublish;
  const searching = query.trim() !== '';
  const found = foundValues(query, screens, groups);
  const shownSelection = selectedItem(selection, found, moved);
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

  const actions = peopleActions(tools, drafts);
  const pages = pageEntries();
  const org = orgCommands(shell.organizations.length);
  // What was typed, for the agent: first when it reads as a sentence, else last, below what it found (#270).
  // First only when it reads as a question or request and nothing listed matches it well (review of #406).
  const sentence =
    searching &&
    asksFirst(query, [
      ...screens.map((x) => x.name),
      ...groups.map((x) => x.name),
      ...(spots.data?.spots ?? []).map((x) => x.name),
      ...(playlists.data?.playlists ?? []).map((x) => x.name),
      ...[...actions, ...pages, ...org].map((e) => e.label),
    ]);
  const asked = searching ? askEntry(query, sentence) : undefined;
  const questions = searching ? [] : pageQuestions(path);
  const suggested = searching ? [] : pageActions(path, actions);
  const icon = (to: string) => SECTIONS.find((s) => s.to === to)?.icon;

  const item = (e: CommandEntry) => {
    const Icon = e.kind === 'go' ? icon(e.to) : undefined;
    return (
      <CommandItem key={e.id} value={e.id} keywords={[e.label, ...e.keywords]} disabled={running} onSelect={() => void choose(e)}>
        {Icon && <Icon className="size-4 text-muted-foreground" aria-hidden />}
        {e.kind === 'org' && <Building2Icon className="size-4 text-muted-foreground" aria-hidden />}
        {e.kind === 'action' && <ZapIcon className="size-4 text-muted-foreground" aria-hidden />}
        {(e.kind === 'agent' || e.kind === 'ask') && <SparklesIcon className="size-4 text-actor-agent" aria-hidden />}
        <span className="line-clamp-2 min-w-0 flex-1 sm:truncate">{e.label}</span>
      </CommandItem>
    );
  };

  return choosingOrg ? (
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
      <CommandInput ref={backed ? focusSearch : undefined} value={query} onValueChange={search} placeholder="Find an action, a screen or a page">
        <kbd className="rounded-md border px-1.5 py-0.5 font-mono text-xs text-muted-foreground">esc</kbd>
      </CommandInput>
      <p role="status" className="border-b px-4 py-2 text-meta text-muted-foreground empty:sr-only">
        {listStatus}
      </p>
      <CommandList>
        <CommandEmpty>No action, screen or page matches. Try part of a screen’s name, or ask the agent.</CommandEmpty>
        {asked && sentence && <CommandGroup heading="Agent">{item(asked)}</CommandGroup>}
        {/* Empty, the page's own actions, then its questions for the agent (#358). */}
        {suggested.length > 0 && <CommandGroup heading="For this page">{suggested.map(item)}</CommandGroup>}
        {!searching && <CommandGroup heading="Ask the agent">{[...questions, agentEntry].map(item)}</CommandGroup>}
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
        {/* Typed: every action allowed, then the pages and the org commands, which the sidebar lists already (#358). */}
        {/* Ask the agent… is everyone's, a viewer's too, whatever actions the role has. */}
        {searching && <CommandGroup heading="Actions">{[...actions, agentEntry].map(item)}</CommandGroup>}
        {searching && <CommandGroup heading="Go to">{pages.map(item)}</CommandGroup>}
        {searching && <CommandGroup heading="Organization">{org.map(item)}</CommandGroup>}
        {asked && !sentence && <CommandGroup heading="Agent">{item(asked)}</CommandGroup>}
      </CommandList>
    </Command>
  );
}
