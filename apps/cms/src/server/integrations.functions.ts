/**
 * The Integrations page's own read, through the tool registry as the signed-in member
 * (`list_connections`); its data sources are the spot pages' read (`getDataSources` in
 * spots.functions.ts). The query options over it are in src/queries/integrations.ts.
 */
import { createServerFn } from '@tanstack/react-start';
import type { ConnectionView } from '~/lib/integrations';
import { all, inOrg } from './tools.server';

interface ConnectionsPage {
  next: string | null;
  connections: ConnectionView[];
  providers: string[];
}

export const getConnections = createServerFn({ method: 'GET' }).handler(() =>
  inOrg(
    async () => {
      let providers: string[] = [];
      const connections = await all<ConnectionView, ConnectionsPage>('list_connections', (p) => {
        providers = p.providers;
        return p.connections;
      });
      return { connections, providers };
    },
    { connections: [], providers: [] },
  ),
);
