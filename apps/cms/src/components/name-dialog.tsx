/** Making something that starts with only a name (a playlist, a brand kit): a button that opens a dialog asking for it. */
import { PlusIcon } from 'lucide-react';
import type { SubmitEvent } from 'react';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';

export function NameDialog({
  id,
  thing,
  title,
  description,
  placeholder,
  draft,
  busy,
  onOpenChange,
  onName,
  onCreate,
}: {
  id: string;
  /** What is made, as the buttons say it: "playlist" gives New playlist and Create playlist. */
  thing: string;
  title: string;
  description: string;
  placeholder?: string;
  /** The dialog's draft, from the store. */
  draft: { open: boolean; name: string; pending: boolean; error: string | null };
  /** Another action is on its way, so Create is ignored (by the store) and says so. */
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onName: (name: string) => void;
  onCreate: () => void;
}) {
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    onCreate();
  };
  return (
    <Dialog open={draft.open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <PlusIcon aria-hidden />
          New {thing}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={id}>Name</Label>
            <Input id={id} value={draft.name} onChange={(e) => onName(e.target.value)} maxLength={100} placeholder={placeholder} />
          </div>
          <p role="alert" className="text-sm font-medium text-destructive empty:hidden">
            {draft.error}
          </p>
          <div className="flex justify-end">
            <Button type="submit" disabled={!draft.name.trim() || draft.pending} aria-disabled={busy || undefined}>
              {draft.pending ? 'Creating…' : `Create ${thing}`}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
