import { Link } from '@tanstack/react-router';
import { MenuIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, SearchIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { CommandMenu } from '~/components/command-menu';
import { CreateOrgDialog } from '~/components/create-org-form';
import { Logo } from '~/components/logo';
import { OrgSwitcher } from '~/components/org-switcher';
import { ScheduleDialogs } from '~/components/schedule/schedule-dialogs';
import { Button } from '~/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '~/components/ui/sheet';
import { SidebarMenuButton } from '~/components/ui/sidebar';
import { Toaster } from '~/components/ui/sonner';
import { TooltipProvider } from '~/components/ui/tooltip';
import { UserMenu } from '~/components/user-menu';
import { orgHues } from '~/lib/paths';
import { SECTIONS } from '~/lib/sections';
import { cn } from '~/lib/utils';
import type { Shell } from '~/server/shell.functions';
import { useAppStore } from '~/state/provider';
import { isFolded } from '~/state/ui';

/** The sidebar; `folded` (wide screens only) is an icon rail, each item named and with a tooltip. */
function Sidebar({ shell, hues, folded = false }: { shell: Shell; hues: Map<string, number>; folded?: boolean }) {
  const openCommandMenu = useAppStore((s) => s.openCommandMenu);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const FoldIcon = folded ? PanelLeftOpenIcon : PanelLeftCloseIcon;
  return (
    <div className={cn('flex h-full flex-col gap-6 p-4', folded && 'items-center px-3')}>
      <div className="space-y-1">
        <Link to="/" className="block rounded-md px-1.5 py-1 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" aria-label="SignForge home">
          <Logo className={folded ? '[&>span]:hidden' : undefined} />
        </Link>
        {!folded && <OrgSwitcher shell={shell} hues={hues} />}
      </div>
      {folded ? (
        <SidebarMenuButton folded tooltip="Search and actions (⌘K)">
          <button type="button" onClick={openCommandMenu}>
            <SearchIcon aria-hidden />
            <span>Search and actions</span>
          </button>
        </SidebarMenuButton>
      ) : (
        <Button variant="outline" className="justify-start gap-2.5 text-muted-foreground" onClick={openCommandMenu}>
          <SearchIcon className="size-4" aria-hidden />
          <span className="flex-1 text-left">Search and actions</span>
          <kbd className="font-mono text-xs" aria-label="Command K, or Control K">
            ⌘K
          </kbd>
        </Button>
      )}
      <nav aria-label="Main" className="flex-1">
        <ul className="space-y-1">
          {SECTIONS.map(({ to, label, icon: Icon }) => (
            <li key={to}>
              <SidebarMenuButton folded={folded} tooltip={label}>
                <Link to={to} activeOptions={{ exact: to === '/' }}>
                  <Icon aria-hidden />
                  <span>{label}</span>
                </Link>
              </SidebarMenuButton>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex flex-col gap-2">
        <SidebarMenuButton folded={folded} tooltip="Unfold the sidebar" className="hidden lg:flex">
          <button type="button" onClick={toggleSidebar} aria-expanded={!folded}>
            <FoldIcon aria-hidden />
            <span>{folded ? 'Unfold the sidebar' : 'Fold the sidebar'}</span>
          </button>
        </SidebarMenuButton>
        <UserMenu user={shell.user} compact={folded} />
      </div>
    </div>
  );
}

/**
 * The signed-in frame: a sidebar on wide screens, which folds to an icon rail (by its button, or
 * when a panel opens on the right), and a top bar with a navigation drawer on phones. The store
 * closes the drawer whenever navigation changes the path (src/state/ui.ts).
 */
export function AppShell({ shell, children }: { shell: Shell; children: ReactNode }) {
  const drawerOpen = useAppStore((s) => s.ui.drawerOpen);
  const openDrawer = useAppStore((s) => s.openDrawer);
  const closeDrawer = useAppStore((s) => s.closeDrawer);
  const status = useAppStore((s) => s.orgs.status);
  const folded = useAppStore((s) => isFolded(s.ui));
  const hues = orgHues(shell.organizations.map((o) => o.id));

  return (
    <TooltipProvider delayDuration={0}>
      <div className={cn('min-h-dvh lg:grid', folded ? 'lg:grid-cols-[4.5rem_minmax(0,1fr)]' : 'lg:grid-cols-[17rem_minmax(0,1fr)]')}>
        <a href="#main" className="sr-only z-50 rounded-md bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3">
          Skip to content
        </a>
        <aside
          className="sticky top-0 hidden h-dvh border-r bg-sidebar text-sidebar-foreground lg:block"
          aria-label="Sidebar"
          data-state={folded ? 'collapsed' : 'expanded'}
          data-collapsible={folded ? 'icon' : ''}
        >
          <Sidebar shell={shell} hues={hues} folded={folded} />
        </aside>
        <div className="flex min-w-0 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/90 px-2 backdrop-blur supports-[backdrop-filter]:bg-background/75 lg:hidden">
            <Sheet open={drawerOpen} onOpenChange={(open) => (open ? openDrawer() : closeDrawer())}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Open navigation">
                  <MenuIcon className="size-5" aria-hidden />
                </Button>
              </SheetTrigger>
              <SheetContent>
                <SheetTitle className="sr-only">Navigation</SheetTitle>
                <SheetDescription className="sr-only">Organization, sections and account</SheetDescription>
                <Sidebar shell={shell} hues={hues} />
              </SheetContent>
            </Sheet>
            <Link to="/" aria-label="SignForge home" className="rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
              <Logo />
            </Link>
            <div className="ml-auto">
              <UserMenu user={shell.user} compact />
            </div>
          </header>
          <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 outline-none sm:px-8 lg:py-10">
            {children}
          </main>
        </div>
        <CommandMenu shell={shell} hues={hues} />
        <CreateOrgDialog />
        <ScheduleDialogs />
        <p role="status" className="sr-only">
          {status}
        </p>
        <Toaster />
      </div>
    </TooltipProvider>
  );
}
