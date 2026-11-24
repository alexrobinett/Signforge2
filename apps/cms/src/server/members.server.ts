/** The org's members' names, through Better Auth's member list as the signed-in member: for the server functions that name people. */
import type { Member } from '~/lib/settings';
import { callApi } from './api.server';

/** Members' names by user id: who granted each agent (API & agents), and who did what on an editor's audit strip (#116). */
export async function names(): Promise<Record<string, string>> {
  const res = await callApi('/api/auth/organization/list-members?limit=200');
  if (!res.ok) throw new Error(`member list failed: ${res.status}`);
  // Better Auth's answer (better-auth 1.7.25, pinned), as the other settings pages read it.
  const { members }: { members: Member[] } = await res.json();
  return Object.fromEntries(members.map((m) => [m.userId, m.user.name || m.user.email]));
}
