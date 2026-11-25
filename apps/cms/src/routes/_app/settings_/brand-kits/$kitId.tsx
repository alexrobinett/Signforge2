/**
 * A kit's old address, under Settings, before Brand kits were a section of their own (#381): it goes to the kit.
 * A link or bookmark loads it from the server, which sends the query on as it came: the router's own search would
 * join a repeated key into one value. The browser keeps the hash.
 */
import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/settings_/brand-kits/$kitId')({
  server: {
    handlers: {
      GET: ({ request, params }: { request: Request; params: { kitId: string } }) =>
        new Response(null, { status: 308, headers: { location: `/brand-kits/${encodeURIComponent(params.kitId)}${new URL(request.url).search}` } }),
    },
  },
  beforeLoad: ({ params, location }) => {
    throw redirect({ href: `/brand-kits/${encodeURIComponent(params.kitId)}${location.searchStr}${location.hash ? `#${location.hash}` : ''}`, replace: true });
  },
});
