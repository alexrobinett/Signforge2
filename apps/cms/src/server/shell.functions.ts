/**
 * What every page needs: who is signed in, their active org and the orgs they belong to, all read
 * from the API. Reads only; writes go through Better Auth's client today and the tool registry
 * (M3-12) later.
 */
import { createServerFn } from '@tanstack/react-start';
import { parseToolList, type ToolListing } from '~/lib/command-menu';
import { callApi } from './api.server';

export type Role = 'owner' | 'editor' | 'viewer';

export interface Organization {
  id: string;
  name: string;
  slug: string;
}

export interface Shell {
  user: { id: string; email: string; name: string };
  /** The active org and the user's role in it; null until one is chosen or created. */
  organization: (Organization & { role: Role }) | null;
  organizations: Organization[];
  /** The tools the member's role allows in the active org, for the command menu; none without one. */
  tools: ToolListing[];
}

export interface SignInOptions {
  emailCode: boolean;
  github: boolean;
  /** Dev only: codes are printed in the API's terminal instead of emailed. */
  codesInTerminal: boolean;
}

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`${what} failed: ${res.status}`);
  return (await res.json()) as T;
}

/** The signed-in shell, or null when there is no valid session. */
export const getShell = createServerFn({ method: 'GET' }).handler(async (): Promise<Shell | null> => {
  const sessionRes = await callApi('/api/session');
  if (sessionRes.status === 401) return null;
  const session = await json<{ user: Shell['user']; organization: { id: string; role: Role } | null }>(sessionRes, 'session');
  const [orgs, tools] = await Promise.all([
    callApi('/api/auth/organization/list').then((res) => json<Organization[]>(res, 'organization list')),
    session.organization ? callApi('/api/tools').then(async (res) => parseToolList(await json<unknown>(res, 'tool list'))) : [],
  ]);
  const organizations = orgs.map(({ id, name, slug }) => ({ id, name, slug })).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const active = session.organization && organizations.find((o) => o.id === session.organization!.id);
  return {
    user: session.user,
    organization: active ? { ...active, role: session.organization!.role } : null,
    organizations,
    tools,
  };
});

/** Which sign-in methods the API has configured. */
export const getSignInOptions = createServerFn({ method: 'GET' }).handler(async () =>
  json<SignInOptions>(await callApi('/api/sign-in-options'), 'sign-in options'),
);
