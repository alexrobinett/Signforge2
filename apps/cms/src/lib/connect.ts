/**
 * Connecting an agent (M4-05, the AgentConsent board): what the consent page shows, and the scopes
 * in the board's words. The API's `/api/auth/agent-grants/request` and `/consent` are the source;
 * docs/backend-plan.md (Agents, Grants) says how a grant is made.
 */

/** The tool scopes a grant can hold, in the order the page lists them. */
export const CONNECT_SCOPES = ['content:read', 'content:draft', 'content:publish', 'screens:manage', 'org:manage'] as const;
export type ConnectScope = (typeof CONNECT_SCOPES)[number];

/** What the page shows for a request: the client, the person, and each of their orgs with the scopes a grant there may hold. */
export interface ConnectRequest {
  /** Where its code goes: a web callback's host, or an app's own scheme (`com.example.app:`). */
  client: { id: string; name: string; verified: boolean; redirect: { kind: 'web'; host: string } | { kind: 'app'; target: string } };
  user: { name: string; email: string };
  orgs: { orgId: string; name: string; role: 'owner' | 'editor' | 'viewer'; scopes: ConnectScope[] }[];
}

/** Each scope's line on the page. `content:read` says it shares the team list with addresses (#110, review of #288). */
export const SCOPE_WORDS: Record<ConnectScope, { title: string; desc: string }> = {
  'content:read': {
    title: 'See your content and screens',
    desc: 'Always on: an agent can do nothing without it. Screens, spots, playlists, schedules, brand kits, the audit log, and the team list with names and email addresses.',
  },
  'content:draft': { title: 'Make and edit drafts', desc: 'Drafts never reach a screen on their own.' },
  'content:publish': { title: 'Publish to live screens', desc: 'Off unless you turn it on.' },
  'screens:manage': { title: 'Manage screens', desc: 'Rename screens, change display hours and groups.' },
  'org:manage': { title: 'Manage the organisation', desc: 'Invite people, change organisation settings. Off unless you turn it on.' },
};

/** Whether a scope starts on: reading is always on, drafting on, the rest off. */
export const startsOn = (scope: ConnectScope) => scope === 'content:read' || scope === 'content:draft';

/**
 * The response headers of the pages in an agent's sign-in and consent (`/connect`, `/sign-in`): no
 * other site may frame them, so none can lay its own page over Allow (OAuth's clickjacking advice).
 */
export const NOT_FRAMED = { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" };
