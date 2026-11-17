import { createFileRoute } from '@tanstack/react-router';
import { SectionPage } from '~/components/page';
import { sectionFor } from '~/lib/sections';

const section = sectionFor('/schedule');

export const Route = createFileRoute('/_app/schedule')({
  head: () => ({ meta: [{ title: `${section.label} · SignForge` }] }),
  component: () => <SectionPage section={section} />,
});
