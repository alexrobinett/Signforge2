/** Brand kits moved out of Settings to a section of their own (#381): a link or bookmark to the old address goes there. */
import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/settings_/brand-kits/')({
  beforeLoad: () => {
    throw redirect({ to: '/brand-kits', replace: true });
  },
});
