/** Brand kits moved out of Settings to a section of their own (#381): a link or bookmark to the old address goes there, with its search and hash. */
import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/settings_/brand-kits/')({
  beforeLoad: ({ location }) => {
    throw redirect({ href: `/brand-kits${location.searchStr}${location.hash ? `#${location.hash}` : ''}`, replace: true });
  },
});
