import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useHydrated } from '~/lib/hydrated';
import { themeScript } from '~/lib/theme';
import styles from '~/styles.css?url';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'SignForge' },
      { name: 'description', content: 'Manage the screens, content and schedules of your digital signage.' },
      { name: 'color-scheme', content: 'light dark' },
    ],
    links: [
      { rel: 'stylesheet', href: styles },
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
    ],
  }),
  component: () => (
    <RootDocument>
      <Outlet />
    </RootDocument>
  ),
  notFoundComponent: NotFound,
});

function RootDocument({ children }: { children: ReactNode }) {
  // `data-hydrated` tells tests (and anything else) when clicks reach React: before it, the page is
  // the server's HTML and a menu button does nothing.
  const hydrated = useHydrated();
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Before first paint, so the page never flashes the wrong theme. */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: themeScript is a constant in this file, not user input. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <HeadContent />
      </head>
      <body className="min-h-dvh" data-hydrated={hydrated ? '' : undefined}>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center p-6 text-center">
      <div className="space-y-3">
        <p className="text-sm font-medium text-primary">404</p>
        <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
        <p className="text-muted-foreground">
          <a className="font-medium text-primary underline-offset-4 hover:underline" href="/">
            Back to the dashboard
          </a>
        </p>
      </div>
    </main>
  );
}
