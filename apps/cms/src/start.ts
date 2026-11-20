import { createCsrfMiddleware, createMiddleware, createStart } from '@tanstack/react-start';
import { orgChangedAdapter } from './lib/org-changed';
import { tabOrgHeaders } from './lib/tab-org';

/** A server function called from the browser names the tab's org, which `callApi` passes on to the API (#129). */
const tabOrg = createMiddleware({ type: 'function' }).client(async ({ next }) => next({ headers: await tabOrgHeaders() }));

export const startInstance = createStart(() => ({
  // Start's own default, which a start file replaces: server functions answer same-origin requests only.
  requestMiddleware: [createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === 'serverFn' })],
  functionMiddleware: [tabOrg],
  serializationAdapters: [orgChangedAdapter],
}));
