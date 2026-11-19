import { ChevronRightIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Section } from '~/lib/sections';

export function PageHeader({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        {description && <p className="max-w-2xl text-muted-foreground">{description}</p>}
      </div>
      {children}
    </header>
  );
}

/** A section with nothing in it yet, and what to do about it (`action`). */
export function EmptyState({ icon: Icon, title, children, action }: { icon: Section['icon']; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section
      aria-labelledby="empty-title"
      className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-card/50 px-6 py-16 text-center"
    >
      <div className="mb-4 grid size-12 place-items-center rounded-full bg-accent text-accent-foreground">
        <Icon className="size-6" aria-hidden />
      </div>
      <h2 id="empty-title" className="text-lg font-semibold">
        {title}
      </h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{children}</p>
      {action && <div className="mt-4">{action}</div>}
    </section>
  );
}

/** A list row that is all one link: put on the `Link`, around `RowText`. */
export const ROW_LINK =
  'flex items-center gap-3 px-4 py-3 outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset';

/** A list row's name, a line about it (wrapping on a phone), and the chevron that says it opens. */
export function RowText({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{title}</span>
        <span className="block text-sm text-muted-foreground sm:truncate">{children}</span>
      </span>
      <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden />
    </>
  );
}

/** The page for one dashboard section, empty until its feature ticket lands. */
export function SectionPage({ section }: { section: Section }) {
  return (
    <div className="space-y-8">
      <PageHeader title={section.label} description={section.description} />
      <EmptyState icon={section.icon} title={section.empty.title}>
        {section.empty.body}
      </EmptyState>
    </div>
  );
}
