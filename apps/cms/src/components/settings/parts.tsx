/**
 * Pieces every settings page uses (canvas row 6): the settings navigation (the Audit log page has it too), a titled section, and
 * the save row with its error.
 */
import { Link } from '@tanstack/react-router';
import { RotateCwIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { saveWord } from '~/components/editor';
import { Button } from '~/components/ui/button';
import { useOrgOnScreen } from '~/lib/live';
import { useAppStore } from '~/state/provider';
import { errorOf, runningIn, type SettingsScope } from '~/state/settings';

const LINK =
  'flex min-h-10 shrink-0 items-center rounded-md px-3 whitespace-nowrap text-sm font-medium text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[status=active]:bg-accent data-[status=active]:text-accent-foreground';

const ORG_PAGES = [
  { to: '/settings/general', label: 'General' },
  { to: '/settings/members', label: 'Members & roles' },
  { to: '/settings/screens', label: 'Screens & groups' },
  { to: '/settings/notifications', label: 'Notifications' },
  { to: '/settings/ai', label: 'AI model' },
  { to: '/settings/api', label: 'Connected agents (MCP)' },
] as const;

export function SettingsNav() {
  return (
    // Wrapping rows of links on phones, a column beside the page on wide screens.
    <nav aria-label="Settings" className="flex flex-wrap gap-1 lg:w-52 lg:shrink-0 lg:flex-col lg:flex-nowrap lg:gap-4">
      <div className="flex flex-wrap gap-1 lg:flex-col lg:gap-0.5">
        <span className="hidden px-3 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase lg:block">Organization</span>
        {ORG_PAGES.map(({ to, label }) => (
          <Link key={label} to={to} className={LINK}>
            {label}
          </Link>
        ))}
      </div>
      <div className="flex flex-wrap gap-1 lg:flex-col lg:gap-0.5">
        <span className="hidden px-3 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase lg:block">Admin</span>
        <Link to="/audit" className={LINK}>
          Audit log
        </Link>
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

/** The action running in `scope`, if one is: its controls then say so, and ignore input (the store's check). */
export function useRunning(scope: SettingsScope): string | undefined {
  return useAppStore((s) => runningIn(s.settings, scope));
}

/**
 * The error of the action `at`, in the org on screen; a reload when the settings changed since the edits were made, or,
 * with `onRetry`, Try again for one that got no answer or was refused, its edit still here (#479).
 */
export function ActionError({ at, onRetry }: { at: string; onRetry?: () => void }) {
  const orgId = useOrgOnScreen();
  // One value per selector: errorOf builds the error of a form's save afresh each time.
  const text = useAppStore((s) => errorOf(s.settings, at, orgId)?.text);
  const stale = useAppStore((s) => errorOf(s.settings, at, orgId)?.stale);
  const reload = useAppStore((s) => s.reloadSettings);
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 text-sm font-medium text-destructive empty:hidden">
      {text}
      {stale && (
        <Button type="button" variant="outline" size="sm" onClick={() => void reload(orgId ?? null, at)}>
          <RotateCwIcon aria-hidden /> Reload
        </Button>
      )}
      {text && !stale && onRetry && (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/**
 * How a form's save is going, quietly, in the editors' words (#366): each change saves itself, so
 * there is no Save button. A refusal is said here, with Reload after a conflict.
 */
export function SaveState({ form, canEdit }: { form: string; canEdit: boolean }) {
  const orgId = useOrgOnScreen();
  const draft = useAppStore((s) => (s.settings.drafts[form]?.orgId === orgId ? s.settings.drafts[form] : undefined));
  if (!canEdit) return <p className="text-sm text-muted-foreground">Only owners can change these.</p>;
  return (
    <div className="space-y-2">
      <ActionError at={form} />
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {draft ? saveWord(draft.status, draft.savedAt) : 'Changes save as you make them.'}
      </p>
    </div>
  );
}

/** Why a typed field would be refused, under it; `id` is what the field's `aria-describedby` names. */
export function FieldProblem({ id, text }: { id: string; text: string | undefined }) {
  return text ? (
    <p id={id} className="text-sm font-medium text-destructive">
      {text}
    </p>
  ) : null;
}
