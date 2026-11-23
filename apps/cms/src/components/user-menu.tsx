import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import { LogOutIcon, MonitorIcon, MoonIcon, PlusIcon, SunIcon, UserIcon } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { authClient } from '~/lib/auth-client';
import { initials } from '~/lib/paths';
import type { Theme } from '~/lib/theme';
import { cn } from '~/lib/utils';
import type { Shell } from '~/server/shell.functions';
import { useAppStore } from '~/state/provider';

const THEMES: { value: Theme; label: string; icon: typeof SunIcon }[] = [
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
  { value: 'system', label: 'System', icon: MonitorIcon },
];

/**
 * The account menu. `compact` (the phone's top bar) is the avatar alone; `rail` (the folded sidebar) is
 * the avatar with a tooltip, its menu opening to the right of the rail.
 */
export function UserMenu({ user, compact: small = false, rail = false }: { user: Shell['user']; compact?: boolean; rail?: boolean }) {
  const compact = small || rail;
  const router = useRouter();
  const navigate = useNavigate();
  const theme = useAppStore((s) => s.ui.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const openCreateOrg = useAppStore((s) => s.openCreateOrg);
  const display = user.name || user.email;

  async function signOut() {
    await authClient.signOut();
    await router.invalidate();
    await navigate({ to: '/sign-in', replace: true });
  }

  // In the compact button the initials are the only visible text, so they stay in its name.
  const avatar = (
    <span aria-hidden={!compact} className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground">
      {initials(display)}
    </span>
  );

  return (
    <DropdownMenu modal={false}>
      <Tooltip open={rail ? undefined : false}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            {compact ? (
              <Button variant="ghost" size="icon" className="rounded-full">
                {avatar}
                <span className="sr-only">, account and settings</span>
              </Button>
            ) : (
              <Button variant="ghost" className="h-auto w-full justify-start gap-3 px-2.5 py-2 text-left">
                {avatar}
                <span className="min-w-0 flex-1">
                  {user.name && <span className="block truncate text-sm font-medium">{user.name}</span>}
                  <span className={cn('block truncate text-xs', user.name ? 'text-muted-foreground' : 'text-sm font-medium')}>{user.email}</span>
                </span>
                <span className="sr-only">, account and settings</span>
              </Button>
            )}
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="right">Account and settings</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align={compact ? 'end' : 'start'}
        side={rail ? 'right' : compact ? 'bottom' : 'top'}
        // Clear of the rail's 16 px margin round the avatar, so the menu starts beside the rail, not over its edge.
        sideOffset={rail ? 20 : undefined}
        className="w-60"
      >
        <DropdownMenuLabel className="truncate font-normal">
          Signed in as <span className="font-medium text-foreground">{user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/account">
            <UserIcon aria-hidden /> Your account
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={openCreateOrg}>
          <PlusIcon aria-hidden /> Create organization…
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {theme === 'dark' ? <MoonIcon aria-hidden /> : theme === 'light' ? <SunIcon aria-hidden /> : <MonitorIcon aria-hidden />}
            Theme
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
              {THEMES.map(({ value, label, icon: Icon }) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  <Icon aria-hidden /> {label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOutIcon aria-hidden /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
