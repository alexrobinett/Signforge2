import { ErrorComponent, type ErrorComponentProps } from '@tanstack/react-router';
import { RotateCwIcon } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { isOrgChanged } from '~/lib/tools';

/** A page whose data could not load. A tab left on the old org says to reload (#129); any other error keeps the router's own page. */
export function RouteError({ error }: ErrorComponentProps) {
  if (!isOrgChanged(error)) return <ErrorComponent error={error} />;
  return (
    <main className="grid min-h-[50dvh] place-items-center p-6 text-center">
      <div className="max-w-md space-y-4">
        <p role="alert" className="font-medium">
          {error.message}
        </p>
        <Button onClick={() => window.location.reload()}>
          <RotateCwIcon aria-hidden /> Reload
        </Button>
      </div>
    </main>
  );
}
