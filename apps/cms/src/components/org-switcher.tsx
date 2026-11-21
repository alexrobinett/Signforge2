import { ChevronsUpDownIcon } from 'lucide-react';
import { Button } from '~/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { initials } from '~/lib/paths';
import { cn } from '~/lib/utils';
import type { Shell } from '~/server/shell.functions';
import { useAppStore } from '~/state/provider';

/** An org's initials on its hue (`orgHues`), so two orgs with the same initials differ. */
export function OrgAvatar({ name, hue, className }: { name: string; hue: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('grid size-8 shrink-0 place-items-center rounded-md text-xs font-semibold', className)}
      style={{ background: `hsl(${hue} var(--org-saturation) var(--org-lightness))`, color: 'var(--org-foreground)' }}
    >
      {initials(name)}
    </span>
  );
}

/**
 * The active org's name under the logo, as quiet text (#182). Only a member of two or more orgs
 * gets a menu to switch; creating one is in the account menu and ⌘K.
 */
export function OrgSwitcher({ shell, hues }: { shell: Shell; hues: Map<string, number> }) {
  const switchingTo = useAppStore((s) => s.orgs.switchingTo);
  const switchOrg = useAppStore((s) => s.switchOrg);
  const active = shell.organization;

  if (shell.organizations.length < 2) return active && <p className="truncate px-1.5 text-sm text-muted-foreground">{active.name}</p>;

  function choose(id: string) {
    const org = shell.organizations.find((o) => o.id === id);
    if (org && id !== active?.id) void switchOrg(org, 'switcher');
  }

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="w-full justify-start gap-1.5 px-1.5 font-normal text-muted-foreground">
          <span className="truncate">{active?.name ?? 'Choose an organization'}</span>
          <span className="sr-only">, switch organization</span>
          <ChevronsUpDownIcon className="size-3.5 shrink-0" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={active?.id ?? ''} onValueChange={choose}>
          {shell.organizations.map((org) => (
            <DropdownMenuRadioItem key={org.id} value={org.id} disabled={switchingTo !== null}>
              <OrgAvatar name={org.name} hue={hues.get(org.id)!} className="size-6 rounded text-[0.6rem]" />
              <span className="min-w-0 truncate">{org.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
