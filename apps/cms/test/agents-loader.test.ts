// Settings › Connected agents (MCP)' loaders (M4-08, review of #343): the call log failing in any way, the SQL
// API down, slow, answering nonsense or not configured, or the request to the API failing, never
// fails a page. Its grants, their scopes and Disconnect still load, and the numbers read as null,
// which the pages say are not available. A session that has ended still goes to sign-in.
import { redirect } from '@tanstack/react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Refusal } from '../src/lib/tools';
import { getAgent, getAgents } from '../src/server/agents.functions';
import { all, tool } from '../src/server/tools.server';

// A server function as its handler alone: these tests call the loaders' code, not the RPC around it.
vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => ({
    handler: (run: (ctx: object) => unknown) => () => run({}),
    validator: (check: (v: unknown) => unknown) => ({
      handler: (run: (ctx: { data: unknown }) => unknown) => (ctx: { data: unknown }) => run({ data: check(ctx.data) }),
    }),
  }),
}));
vi.mock('@tanstack/react-start/server', () => ({ getRequest: () => new Request('https://cms.test/settings/api') }));
vi.mock('~/server/api.server', () => ({
  callApi: async (path: string) =>
    path.startsWith('/api/auth/organization/list-members')
      ? Response.json({ members: [{ userId: 'usr_1', user: { name: 'Ada', email: 'ada@example.com' } }] })
      : Response.json({ tools: [{ name: 'rename_screen', scope: 'screens:manage', minRole: 'editor' }] }),
}));
vi.mock('~/server/tools.server', () => ({ tool: vi.fn(), all: vi.fn(), inOrg: (read: () => unknown) => read() }));

const GRANT = { id: 'agt_1', scopes: ['content:read'], grantedBy: 'usr_1', version: 1 };

/** The tools as the API answers them, with the usage tool failing as `usageFails` does. */
function apiWith(usageFails: () => never) {
  // The grants; no publish request waits (#115).
  vi.mocked(all).mockImplementation((async (name: string) => (name === 'list_publish_requests' ? [] : [GRANT])) as never);
  vi.mocked(tool).mockImplementation((async (name: string) => {
    if (name === 'get_agent_grant_usage') usageFails();
    if (name === 'get_agent_grant') return { grant: GRANT };
    if (name === 'list_audit_log') return { entries: [], next: null };
    throw new Error(`unexpected tool ${name}`);
  }) as never);
}

const FAILURES: Record<string, () => never> = {
  'the SQL API down, slow or answering nonsense (unavailable)': () => {
    throw new Refusal('unavailable', 'the call log could not be read just now; try again in a minute');
  },
  'no call log configured (forbidden)': () => {
    throw new Refusal('forbidden', "get_agent_grant_usage needs the agents' call log, and this caller has none");
  },
  'the API not answering (a network error)': () => {
    throw new TypeError('Network connection lost.');
  },
  'the API answering with what is not JSON': () => {
    throw new SyntaxError('Unexpected token < in JSON at position 0');
  },
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('when the call log cannot be read', () => {
  for (const [what, fails] of Object.entries(FAILURES)) {
    it(`still loads the agents and an agent's page: ${what}`, async () => {
      apiWith(fails);
      const list = await getAgents();
      expect(list.grants).toEqual([GRANT]);
      expect(list.week).toBeNull();
      expect(list.waiting).toBe(0);
      const one = await getAgent({ data: 'agt_1' });
      expect(one).toMatchObject({ grant: GRANT, week: null, mine: ['screens:manage'], names: { usr_1: 'Ada' } });
    });
  }

  it('still sends an ended session to sign-in', async () => {
    apiWith(() => {
      throw redirect({ to: '/sign-in' });
    });
    await expect(getAgents()).rejects.toMatchObject({ options: { to: '/sign-in' } });
  });
});
