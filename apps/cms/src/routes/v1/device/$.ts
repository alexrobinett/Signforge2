/**
 * `/v1/device/*` belongs to the API Worker, like `/api/*` (see ../../api/$.ts): a deployed
 * environment routes it there first. Locally the CMS hands it over the service binding, so a
 * browser test screen served here (`/test-screen/`, M3-41) meets the device API on this origin, as
 * it will when deployed. The nudge socket's upgrade goes through the same way.
 */
import { createFileRoute } from '@tanstack/react-router';
import { forwardToApi } from '~/server/api.server';

const forward = ({ request }: { request: Request }) => forwardToApi(request);

export const Route = createFileRoute('/v1/device/$')({
  server: {
    handlers: { GET: forward, HEAD: forward, POST: forward, OPTIONS: forward },
  },
});
