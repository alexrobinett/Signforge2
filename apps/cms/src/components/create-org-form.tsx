import { LoaderCircleIcon } from 'lucide-react';
import { useId, type SubmitEvent, type ReactNode } from 'react';
import { Button } from '~/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { cn } from '~/lib/utils';
import type { CreateOrgFormId } from '~/state/orgs';
import { useAppStore } from '~/state/provider';

/** Names and creates an org. `form` picks the store draft it edits (src/state/orgs.ts). */
export function CreateOrgForm({
  form,
  submitLabel = 'Create organization',
  footer,
  className,
}: {
  form: CreateOrgFormId;
  submitLabel?: string;
  footer?: ReactNode;
  className?: string;
}) {
  const { name, pending, error } = useAppStore((s) => s.orgs.drafts[form]);
  const switching = useAppStore((s) => s.orgs.switchingTo !== null);
  const editOrgName = useAppStore((s) => s.editOrgName);
  const createOrg = useAppStore((s) => s.createOrg);
  const id = useId();

  function submit(e: SubmitEvent) {
    e.preventDefault();
    void createOrg(form);
  }

  return (
    <form onSubmit={submit} className={cn('space-y-4', className)} noValidate>
      <div className="space-y-2">
        <Label htmlFor={`${id}-name`}>Organization name</Label>
        <Input
          id={`${id}-name`}
          name="name"
          value={name}
          onChange={(e) => editOrgName(form, e.target.value)}
          placeholder="Acme Coffee"
          autoComplete="organization"
          maxLength={80}
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
        />
      </div>
      <p id={`${id}-error`} role="alert" className="text-sm font-medium text-destructive empty:hidden">
        {error}
      </p>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {footer}
        <Button type="submit" disabled={pending || switching || !name.trim()}>
          {pending && <LoaderCircleIcon className="animate-spin" aria-hidden />}
          {pending ? 'Creating…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** The create-organization dialog the account menu and ⌘K open, once in the shell. */
export function CreateOrgDialog() {
  const open = useAppStore((s) => s.orgs.createDialogOpen);
  const openCreateOrg = useAppStore((s) => s.openCreateOrg);
  const closeCreateOrg = useAppStore((s) => s.closeCreateOrg);
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? openCreateOrg() : closeCreateOrg())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create organization</DialogTitle>
          <DialogDescription>An organization holds screens and content. You will be its owner, and it becomes your active organization.</DialogDescription>
        </DialogHeader>
        <CreateOrgForm
          form="dialog"
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
  );
}
