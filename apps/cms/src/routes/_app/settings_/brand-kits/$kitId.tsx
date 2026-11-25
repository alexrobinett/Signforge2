/** A kit's old address, under Settings, before Brand kits were a section of their own (#381): it goes to the kit, with its search and hash. */
import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/settings_/brand-kits/$kitId')({
  beforeLoad: ({ params, location }) => {
    throw redirect({ href: `/brand-kits/${encodeURIComponent(params.kitId)}${location.searchStr}${location.hash ? `#${location.hash}` : ''}`, replace: true });
  },
});
