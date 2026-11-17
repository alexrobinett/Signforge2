/**
 * `/api/*` belongs to the API Worker. In a deployed environment the API's route on the shared
 * hostname takes these requests before they reach the CMS; locally, and if a route is ever
 * missing, the CMS hands them over the service binding unchanged, so the browser still talks to
 * one origin.
 */
import { createFileRoute } from '@tanstack/react-router';
import { forwardToApi } from '~/server/api.server';

const forward = ({ request }: { request: Request }) => forwardToApi(request);

export const Route = createFileRoute('/api/$')({
  server: {
    handlers: { GET: forward, HEAD: forward, POST: forward, PUT: forward, PATCH: forward, DELETE: forward, OPTIONS: forward },
  },
});
