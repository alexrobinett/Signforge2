import { LoaderCircleIcon } from 'lucide-react';
import { useId, type SubmitEvent, type ReactNode } from 'react';
import { Button } from '~/components/ui/button';
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
        <Button type="submit" disabled={pending || !name.trim()}>
          {pending && <LoaderCircleIcon className="animate-spin" aria-hidden />}
          {pending ? 'Creating…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
