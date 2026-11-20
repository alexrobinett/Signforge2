import { environmentManager, QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';
import { retryUnlessRedirect } from './queries/retry';
import { routeTree } from './routeTree.gen';
import { StoreProvider } from './state/provider';
import { createAppStore } from './state/store';

/**
 * Called once per request on the server and once per page in the browser, so each gets its own
 * store and its own Query cache (server data, docs/research/cms-data-layer.md).
 */
export function getRouter() {
  // Query's own retries (three in the browser, none on the server), less a redirect's. Loaders'
  // reads (`queryClient.query`) take them too: any default `retry` replaces their none.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 10_000, retry: environmentManager.isServer() ? 0 : retryUnlessRedirect(3) } },
  });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: 'intent',
    // biome-ignore lint/correctness/noComponentHookFactories: made once per router, so its identity never changes and nothing remounts.
    Wrap: ({ children }) => <StoreProvider store={store}>{children}</StoreProvider>,
  });
  const store = createAppStore({ router, queryClient });
  setupRouterSsrQueryIntegration({ router, queryClient });
  return router;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
