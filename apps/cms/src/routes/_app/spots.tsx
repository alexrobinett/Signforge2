import { createFileRoute } from '@tanstack/react-router';
import { SectionPage } from '~/components/page';
import { sectionFor } from '~/lib/sections';

const section = sectionFor('/spots');

export const Route = createFileRoute('/_app/spots')({
  head: () => ({ meta: [{ title: `${section.label} · SignForge` }] }),
  component: () => <SectionPage section={section} />,
});
