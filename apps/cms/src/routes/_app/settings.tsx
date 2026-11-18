/** Settings: the organization's pages beside their navigation (canvas row 6). */
import { createFileRoute, Outlet } from '@tanstack/react-router';
import { SettingsNav } from '~/components/settings/parts';

export const Route = createFileRoute('/_app/settings')({
  component: SettingsLayout,
});

function SettingsLayout() {
  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
      <SettingsNav />
      <div className="min-w-0 flex-1 space-y-6">
        <Outlet />
      </div>
    </div>
  );
}
