/**
 * Pieces every settings page uses (canvas row 6): the settings navigation, a titled section, and
 * the save row with its error. Brand kits is a slot until its page lands (M3-40).
 */
import { Link } from '@tanstack/react-router';
import { LoaderCircleIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '~/components/ui/button';
import { useAppStore } from '~/state/provider';

const LINK =
  'flex min-h-10 shrink-0 items-center rounded-md px-3 whitespace-nowrap text-sm font-medium text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[status=active]:bg-accent data-[status=active]:text-accent-foreground';

const ORG_PAGES = [
  { to: '/settings/general', label: 'General' },
  { to: '/settings/members', label: 'Members & roles' },
  { to: null, label: 'Brand kits' },
  { to: '/settings/screens', label: 'Screens & groups' },
  { to: '/settings/notifications', label: 'Notifications' },
] as const;

export function SettingsNav() {
  return (
    // Wrapping rows of links on phones, a column beside the page on wide screens.
    <nav aria-label="Settings" className="flex flex-wrap gap-1 lg:w-52 lg:shrink-0 lg:flex-col lg:flex-nowrap lg:gap-4">
      <div className="flex flex-wrap gap-1 lg:flex-col lg:gap-0.5">
        <span className="hidden px-3 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase lg:block">Organization</span>
        {ORG_PAGES.map(({ to, label }) =>
          to ? (
            <Link key={label} to={to} className={LINK}>
              {label}
            </Link>
          ) : (
            <span
              key={label}
              className="flex min-h-10 shrink-0 items-center justify-between gap-2 px-3 text-sm whitespace-nowrap text-muted-foreground"
              aria-disabled="true"
            >
              {label} <span className="sr-only text-xs lg:not-sr-only">Coming soon</span>
            </span>
          ),
        )}
      </div>
      <div className="flex gap-1 lg:flex-col lg:gap-0.5 lg:border-t lg:pt-3">
        <Link to="/account" className={LINK}>
          Your account
        </Link>
      </div>
    </nav>
  );
}

/** One titled block of a settings page. */
export function SettingsSection({ id, title, description, children }: { id: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-4 rounded-xl border bg-card p-4 sm:p-6">
      <div className="space-y-1">
        <h2 id={id} className="text-lg font-semibold">
          {title}
        </h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** The error of the action `at`, if the last one to fail was it. */
export function ActionError({ at }: { at: string }) {
  const error = useAppStore((s) => (s.settings.error?.at === at ? s.settings.error.text : null));
  return (
    <p role="alert" className="text-sm font-medium text-destructive empty:hidden">
      {error}
    </p>
  );
}

/** A form's save button and its error; only owners get the button. */
export function SaveRow({ at, canEdit, label = 'Save changes' }: { at: string; canEdit: boolean; label?: string }) {
  const pending = useAppStore((s) => s.settings.pending === at);
  if (!canEdit) return <p className="text-sm text-muted-foreground">Only owners can change these.</p>;
  return (
    <div className="space-y-2">
      <ActionError at={at} />
      <Button type="submit" disabled={pending}>
        {pending && <LoaderCircleIcon className="animate-spin" aria-hidden />} {label}
      </Button>
    </div>
  );
}
