import { createFileRoute } from '@tanstack/react-router';
import { SectionPage } from '~/components/page';
import { sectionFor } from '~/lib/sections';

const section = sectionFor('/assets');

export const Route = createFileRoute('/_app/assets')({
  head: () => ({ meta: [{ title: `${section.label} · SignForge` }] }),
  component: () => <SectionPage section={section} />,
});
