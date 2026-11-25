/**
 * Brand kits moved out of Settings to a section of their own (#381): a link or bookmark to the old address goes there.
 * It loads from the server, which sends the query on as it came: the router's own search would join a repeated key
 * into one value. The browser keeps the hash.
 */
import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/settings_/brand-kits/')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => new Response(null, { status: 308, headers: { location: `/brand-kits${new URL(request.url).search}` } }),
    },
  },
  beforeLoad: ({ location }) => {
    throw redirect({ href: `/brand-kits${location.searchStr}${location.hash ? `#${location.hash}` : ''}`, replace: true });
  },
});
