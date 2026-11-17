import { createFileRoute } from '@tanstack/react-router';
import { SectionPage } from '~/components/page';
import { sectionFor } from '~/lib/sections';

const section = sectionFor('/playlists');

export const Route = createFileRoute('/_app/playlists')({
  head: () => ({ meta: [{ title: `${section.label} · SignForge` }] }),
  component: () => <SectionPage section={section} />,
});
