import { LoaderCircleIcon } from 'lucide-react';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { useOrgActions } from '~/lib/orgs';
import { cn } from '~/lib/utils';

export function CreateOrgForm({ onCreated, submitLabel = 'Create organization', footer, className }: { onCreated?: () => void; submitLabel?: string; footer?: ReactNode; className?: string }) {
  const { create } = useOrgActions();
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setError('Enter a name.');
    setError(null);
    setPending(true);
    try {
      await create(trimmed);
      setName('');
      onCreated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the organization.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className={cn('space-y-4', className)} noValidate>
      <div className="space-y-2">
        <Label htmlFor={`${id}-name`}>Organization name</Label>
        <Input
          id={`${id}-name`}
          name="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
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
