import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { ChevronRightIcon, LoaderCircleIcon } from 'lucide-react';
import { useState } from 'react';
import { AppShell } from '~/components/app-shell';
import { CreateOrgForm } from '~/components/create-org-form';
import { OrgAvatar } from '~/components/org-switcher';
import { PageHeader } from '~/components/page';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { useOrgActions } from '~/lib/orgs';
import { getShell, type Shell } from '~/server/shell.functions';

/**
 * Every signed-in page. Signed-out visitors go to sign-in and come back here afterwards. This is
 * the page-level check; the API checks the session and org membership on every request itself.
 */
export const Route = createFileRoute('/_app')({
  loader: async ({ location }) => {
    const shell = await getShell();
    if (!shell) throw redirect({ to: '/sign-in', search: location.href === '/' ? {} : { redirect: location.href } });
    return shell;
  },
  staleTime: 30_000,
  component: AppLayout,
});

function AppLayout() {
  const shell = Route.useLoaderData();
  return <AppShell shell={shell}>{shell.organization ? <Outlet /> : <NoActiveOrg shell={shell} />}</AppShell>;
}

/** Signed in, but no org is active: pick one, or create the first. */
function NoActiveOrg({ shell }: { shell: Shell }) {
  const { switchTo } = useOrgActions();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const first = shell.organizations.length === 0;

  async function choose(id: string) {
    setPending(id);
    setError(null);
    try {
      await switchTo(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch organization.');
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-8">
      <PageHeader
        title={first ? 'Welcome to SignForge' : 'Choose an organization'}
        description={first ? 'Start by creating an organization. Your screens, content and team live inside it.' : 'Pick the organization to work in. You can switch at any time from the menu.'}
      />
      {!first && (
        <section aria-labelledby="your-orgs">
          <h2 id="your-orgs" className="sr-only">
            Your organizations
          </h2>
          <ul className="divide-y overflow-hidden rounded-xl border bg-card">
            {shell.organizations.map((org) => (
              <li key={org.id}>
                <button
                  type="button"
                  onClick={() => void choose(org.id)}
                  disabled={pending !== null}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset disabled:opacity-60"
                >
                  <OrgAvatar name={org.name} />
                  <span className="flex-1 truncate font-medium">{org.name}</span>
                  {pending === org.id ? <LoaderCircleIcon className="size-4 animate-spin" aria-label="Switching" /> : <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden />}
                </button>
              </li>
            ))}
          </ul>
          <p role="alert" className="mt-2 text-sm font-medium text-destructive empty:hidden">
            {error}
          </p>
        </section>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{first ? 'Create your organization' : 'Or create a new one'}</CardTitle>
          <CardDescription>You will be its owner. You can invite your team later.</CardDescription>
        </CardHeader>
        <CardContent>
          <CreateOrgForm />
        </CardContent>
      </Card>
    </div>
  );
}
