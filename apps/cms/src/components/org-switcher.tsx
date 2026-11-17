import { Building2Icon, ChevronsUpDownIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { CreateOrgForm } from '~/components/create-org-form';
import { Button } from '~/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '~/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { useOrgActions } from '~/lib/orgs';
import { initials } from '~/lib/paths';
import { cn } from '~/lib/utils';
import type { Shell } from '~/server/shell.functions';

const ROLE_LABEL = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' } as const;

export function OrgAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <span aria-hidden className={cn('grid size-8 shrink-0 place-items-center rounded-md bg-primary text-xs font-semibold text-primary-foreground', className)}>
      {initials(name)}
    </span>
  );
}

/** Lists the user's orgs, switches the active one, and creates a new one. */
export function OrgSwitcher({ shell }: { shell: Shell }) {
  const { switchTo } = useOrgActions();
  const [creating, setCreating] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const active = shell.organization;

  async function choose(id: string) {
    if (id === active?.id) return;
    const org = shell.organizations.find((o) => o.id === id);
    setSwitching(id);
    setStatus(`Switching to ${org?.name ?? 'organization'}…`);
    try {
      await switchTo(id);
      setStatus(`Switched to ${org?.name ?? 'organization'}.`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Could not switch organization.');
    } finally {
      setSwitching(null);
    }
  }

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="h-auto w-full justify-start gap-3 px-2.5 py-2 text-left">
            {active ? <OrgAvatar name={active.name} /> : <Building2Icon className="size-8 p-1.5 text-muted-foreground" aria-hidden />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{active?.name ?? 'No organization'}</span>
              <span className="block truncate text-xs font-normal text-muted-foreground">{active ? ROLE_LABEL[active.role] : 'Choose or create one'}</span>
            </span>
            <span className="sr-only">, switch organization</span>
            <ChevronsUpDownIcon className="text-muted-foreground" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-60">
          <DropdownMenuLabel>Organizations</DropdownMenuLabel>
          {shell.organizations.length > 0 && (
            <DropdownMenuRadioGroup value={active?.id ?? ''} onValueChange={(id) => void choose(id)}>
              {shell.organizations.map((org) => (
                <DropdownMenuRadioItem key={org.id} value={org.id} disabled={switching !== null}>
                  <OrgAvatar name={org.name} className="size-6 rounded text-[0.6rem]" />
                  <span className="truncate">{org.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreating(true)}>
            <PlusIcon aria-hidden /> Create organization
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <p role="status" className="sr-only">
        {status}
      </p>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create organization</DialogTitle>
            <DialogDescription>An organization holds screens and content. You will be its owner, and it becomes your active organization.</DialogDescription>
          </DialogHeader>
          <CreateOrgForm
            onCreated={() => {
              setCreating(false);
              setStatus('Organization created.');
            }}
            footer={
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
            }
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
