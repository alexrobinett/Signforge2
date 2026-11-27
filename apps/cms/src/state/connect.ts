/**
 * The consent page (`/connect`, M4-05): which org the connection is for, which scopes it may hold,
 * and Allow or Cancel. The person's choices are kept here; what each org offers is the page's loader
 * data. Allow and Cancel post from the browser to `/api/auth/agent-grants/consent`, with the provider's
 * signed query, so Better Auth's origin check sees this site's `Origin`; then the browser follows the
 * answer back to the agent, with a code or `access_denied`.
 */
import { authClient, authErrorMessage } from '~/lib/auth-client';
import type { ConnectScope } from '~/lib/connect';
import type { SliceCreator } from './store';

interface ConnectState {
  /** The org picked, or none yet: the page shows the first. */
  orgId: string | null;
  /** Scopes the person turned on or off; the rest are as they start (`startsOn`). */
  turned: Partial<Record<ConnectScope, boolean>>;
  pending: 'allow' | 'cancel' | null;
  error: string | null;
}

export interface ConnectSlice {
  agentConnect: ConnectState;
  pickConnectOrg: (orgId: string) => void;
  turnConnectScope: (scope: ConnectScope, on: boolean) => void;
  /** Consents for `orgId` with `scopes`, then hands the browser back to the agent with its code. */
  allowConnection: (oauthQuery: string, orgId: string, scopes: ConnectScope[]) => Promise<void>;
  /** Refuses, then hands the browser back to the agent with `access_denied`. */
  cancelConnection: (oauthQuery: string) => Promise<void>;
}

const initialConnect: ConnectState = { orgId: null, turned: {}, pending: null, error: null };

export const createConnectSlice: SliceCreator<ConnectSlice> = (set, get) => {
  /** One decision at a time; the answer names where the browser goes next. */
  async function decide(pending: 'allow' | 'cancel', body: Record<string, unknown>) {
    if (get().agentConnect.pending) return;
    set((s) => ({ agentConnect: { ...s.agentConnect, pending, error: null } }));
    const { data, error } = await authClient.$fetch<{ url: string }>('/agent-grants/consent', { method: 'POST', body });
    if (error) {
      set((s) => ({ agentConnect: { ...s.agentConnect, pending: null, error: authErrorMessage(error, 'SignForge could not finish connecting. Try again.') } }));
      return;
    }
    // Leaving the site: the pending state stays until the page goes.
    window.location.assign(data.url);
  }

  return {
    agentConnect: initialConnect,
    pickConnectOrg: (orgId) => set((s) => ({ agentConnect: { ...s.agentConnect, orgId, error: null } })),
    turnConnectScope: (scope, on) => set((s) => ({ agentConnect: { ...s.agentConnect, turned: { ...s.agentConnect.turned, [scope]: on } } })),
    allowConnection: (oauthQuery, orgId, scopes) => decide('allow', { oauth_query: oauthQuery, accept: true, organizationId: orgId, scopes }),
    cancelConnection: (oauthQuery) => decide('cancel', { oauth_query: oauthQuery, accept: false }),
  };
};
