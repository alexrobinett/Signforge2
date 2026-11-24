/**
 * An editor's agent proposal (#116), through the tool registry as the signed-in member: whether the
 * spot's or playlist's draft is an agent's, by whom and what it changes (`get_agent_draft`), and its
 * audit log strip, the newest rows for it with members' names and the org's time zone to say them in.
 * The query over it is in src/queries/proposals.ts.
 */
import { createServerFn } from '@tanstack/react-start';
import { names } from './members.server';
import { inOrg, tool } from './tools.server';

/** The rows the strip shows. */
const STRIP = 5;

export const getProposal = createServerFn({ method: 'GET', strict: { output: false } })
  .validator((p: { kind: 'spot' | 'playlist'; id: string }) => ({ kind: p.kind === 'playlist' ? ('playlist' as const) : ('spot' as const), id: String(p.id) }))
  .handler(({ data: { kind, id } }) =>
    inOrg(
      async () => {
        const [draft, { entries }, people, { settings }] = await Promise.all([
          tool('get_agent_draft', kind === 'spot' ? { spotId: id } : { playlistId: id }),
          tool('list_audit_log', { target: { kind, id }, limit: STRIP }),
          names(),
          tool('get_org_settings', {}),
        ]);
        return { draft, entries, names: people, timezone: settings.timezone ?? 'UTC', at: Date.now() };
      },
      null,
    ),
  );
