/**
 * `/.well-known/*` belongs to the API Worker, which serves the OAuth metadata agents discover `/mcp`
 * and its issuer by (M4-06): the protected resource's (RFC 9728) and the issuer's (RFC 8414). A
 * deployed environment routes `<host>/.well-known/oauth-*` there first; locally the CMS hands it over.
 */
import { createFileRoute } from '@tanstack/react-router';
import { forwardToApi } from '~/server/api.server';

const forward = ({ request }: { request: Request }) => forwardToApi(request);

export const Route = createFileRoute('/.well-known/$')({
  server: {
    handlers: { GET: forward, HEAD: forward },
  },
});
