/** A kit's old address, under Settings, before Brand kits were a section of their own (#381): it goes to the kit. */
import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/settings_/brand-kits/$kitId')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/brand-kits/$kitId', params: { kitId: params.kitId }, replace: true });
  },
});
