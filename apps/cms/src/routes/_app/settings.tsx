/** Settings: the organization's pages beside their navigation (canvas row 6). */
import { createFileRoute, Outlet } from '@tanstack/react-router';
import { PageHeader } from '~/components/page';
import { SettingsNav } from '~/components/settings/parts';

export const Route = createFileRoute('/_app/settings')({
  component: SettingsLayout,
});

function SettingsLayout() {
  return (
    <div className="space-y-8">
      <PageHeader title="Settings" description="Your organization's defaults, members and alerts." />
      <div className="flex flex-col gap-8 lg:flex-row">
        <SettingsNav />
        <div className="min-w-0 flex-1 space-y-6">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
