import { QueryCache, QueryClient } from '@tanstack/react-query';
import { createRouter, isRedirect } from '@tanstack/react-router';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';
import { routeTree } from './routeTree.gen';
import { StoreProvider } from './state/provider';
import { createAppStore } from './state/store';

/**
 * Called once per request on the server and once per page in the browser, so each gets its own
 * store and its own Query cache (server data, docs/research/cms-data-layer.md).
 */
export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 10_000 } },
    // A read whose session has ended (`tool` in server/tools.server.ts), such as the Screens poll:
    // the shell's loader, run again, sends the member to sign-in and back here afterwards. So the
    // integration below does not follow the redirect itself, which would lose the way back.
    queryCache: new QueryCache({
      onError: (err) => {
        if (isRedirect(err)) void router.invalidate();
      },
    }),
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
  setupRouterSsrQueryIntegration({ router, queryClient, handleRedirects: false });
  return router;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
