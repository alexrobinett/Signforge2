// Tool services for tests: a harmless fake of every one a tool can need, so a test's caller can
// reach any tool (the generated tests call them all). A test that watches a service puts its own
// over these: `{ ...fakeServices, places }`. The ones dispatch uses after the commit (`notify`,
// `deliverNow`) are left out: without them a change is still made, and a test that watches them
// passes its own.
import { r2Presigner, type ServiceName, type ToolServices } from '../src';
import { connectors } from './connectors-stub';

export const fakeServices: Pick<Required<ToolServices>, ServiceName> = {
  uploads: r2Presigner({ endpoint: 'https://r2.test', bucket: 'blobs', accessKeyId: 'k', secretAccessKey: 's' }),
  feedUrls: { seal: async (_source, url) => `sealed:${url}` },
  alertSecrets: { seal: async (_channel, _field, value) => `sealed:${value}` },
  places: { search: async () => [] },
  tables: { read: async () => ({ columns: [], rows: [] }) },
  // A test that registers an org template passes a check that answers.
  templateCheck: () => Promise.reject(new Error('this test has no runtime check')),
  connectors,
  aiProviders: { seal: async (_key, apiKey) => `sealed:${apiKey}`, test: async () => ({ ok: true, models: ['model-a'] }) },
  rateLimit: async () => true,
};
