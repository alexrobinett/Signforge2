import { Link, useRouterState } from '@tanstack/react-router';
import { MenuIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Logo } from '~/components/logo';
import { OrgSwitcher } from '~/components/org-switcher';
import { Button } from '~/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '~/components/ui/sheet';
import { UserMenu } from '~/components/user-menu';
import { SECTIONS } from '~/lib/sections';
import type { Shell } from '~/server/shell.functions';

function Sidebar({ shell }: { shell: Shell }) {
  return (
    <div className="flex h-full flex-col gap-6 p-4">
      <Link to="/" className="rounded-md px-1.5 py-1 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" aria-label="SignForge home">
        <Logo />
      </Link>
      <OrgSwitcher shell={shell} />
      <nav aria-label="Main" className="flex-1">
        <ul className="space-y-1">
          {SECTIONS.map(({ to, label, icon: Icon }) => (
            <li key={to}>
              <Link
                to={to}
                activeOptions={{ exact: to === '/' }}
                className="flex h-10 items-center gap-3 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[status=active]:bg-accent data-[status=active]:text-accent-foreground"
              >
                <Icon className="size-4.5 shrink-0" aria-hidden />
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <UserMenu user={shell.user} />
    </div>
  );
}

/** The signed-in frame: a sidebar on wide screens, a top bar with a navigation drawer on phones. */
export function AppShell({ shell, children }: { shell: Shell; children: ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger: navigating closes the drawer.
  useEffect(() => setDrawer(false), [pathname]);

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[17rem_minmax(0,1fr)]">
      <a href="#main" className="sr-only z-50 rounded-md bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3">
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-dvh border-r bg-sidebar text-sidebar-foreground lg:block" aria-label="Sidebar">
        <Sidebar shell={shell} />
      </aside>
      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/90 px-2 backdrop-blur supports-[backdrop-filter]:bg-background/75 lg:hidden">
          <Sheet open={drawer} onOpenChange={setDrawer}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Open navigation">
                <MenuIcon className="size-5" aria-hidden />
              </Button>
            </SheetTrigger>
            <SheetContent>
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <SheetDescription className="sr-only">Organization, sections and account</SheetDescription>
              <Sidebar shell={shell} />
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
    </div>
  );
}
