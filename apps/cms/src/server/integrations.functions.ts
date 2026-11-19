/**
 * The Integrations page's reads, through the tool registry as the signed-in member
 * (`list_data_sources`, `list_connections`). The query keys and options over them are in
 * src/queries/integrations.ts.
 */
import { createServerFn } from '@tanstack/react-start';
import type { ConnectionView, ListedSource } from '~/lib/integrations';
import { all, inOrg } from './tools.server';

export const getDataSources = createServerFn({ method: 'GET' }).handler(async () => ({
  dataSources: await inOrg(() => all<ListedSource, { next: string | null; dataSources: ListedSource[] }>('list_data_sources', (p) => p.dataSources), []),
}));

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
