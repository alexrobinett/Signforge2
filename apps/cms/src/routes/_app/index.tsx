import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router';
import { ArrowRightIcon } from 'lucide-react';
import { PageHeader } from '~/components/page';
import { SECTIONS } from '~/lib/sections';

const app = getRouteApi('/_app');

export const Route = createFileRoute('/_app/')({
  head: () => ({ meta: [{ title: 'Overview · SignForge' }] }),
  component: Overview,
});

function Overview() {
  const shell = app.useLoaderData();
  const name = shell.user.name || shell.user.email;
  return (
    <div className="space-y-8">
      <PageHeader title={shell.organization?.name ?? 'Overview'} description={`Signed in as ${name}. Here is where everything in this organization lives.`} />
      <section aria-labelledby="sections-heading" className="space-y-4">
        <h2 id="sections-heading" className="text-sm font-medium text-muted-foreground">
          Sections
        </h2>
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {SECTIONS.filter((s) => s.to !== '/').map(({ to, label, icon: Icon, description }) => (
            <li key={to}>
              <Link
                to={to}
                className="group flex h-full flex-col gap-3 rounded-xl border bg-card p-5 shadow-xs transition-[border-color,box-shadow] outline-none hover:border-primary/40 hover:shadow-sm focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <span className="flex items-center justify-between">
                  <span className="grid size-10 place-items-center rounded-lg bg-accent text-accent-foreground">
                    <Icon className="size-5" aria-hidden />
                  </span>
                  <ArrowRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
                </span>
                <span className="font-semibold">{label}</span>
                <span className="text-sm text-muted-foreground">{description}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
