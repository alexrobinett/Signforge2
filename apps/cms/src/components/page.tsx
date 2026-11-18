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

/** A section with nothing in it yet. */
function EmptyState({ icon: Icon, title, children }: { icon: Section['icon']; title: string; children: ReactNode }) {
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
    </section>
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
