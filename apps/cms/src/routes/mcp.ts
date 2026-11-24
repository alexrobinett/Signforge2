/**
 * `/mcp` belongs to the API Worker (M4-06), like `/api/*` (see ./api/$.ts): agents connect to it on
 * this hostname, where the OAuth issuer is. A deployed environment routes it there first; locally the
 * CMS hands it over the service binding unchanged, cookie and all, which the API refuses there.
 */
import { createFileRoute } from '@tanstack/react-router';
import { forwardToApi } from '~/server/api.server';

const forward = ({ request }: { request: Request }) => forwardToApi(request);

export const Route = createFileRoute('/mcp')({
  server: {
    handlers: { GET: forward, POST: forward, DELETE: forward },
  },
});
