/**
 * M4-01 spike Worker. Requests to the CMS origin (`CMS_ORIGIN`) get Better Auth with the OAuth
 * provider under `/api/auth`, its authorization server metadata (RFC 8414), and the sign-in and
 * consent pages the plugin points at. Requests to the MCP host (`MCP_ORIGIN`) get `/mcp` (./mcp.ts).
 */
import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider';
import { createAuth, ROLE_SCOPES, TOOL_SCOPES, type Role, type SendOtp } from './auth';
import { protectedResourceMetadata, serveMcp } from './mcp';

/** Dev codes go to D1 (each request builds its own instance) and the terminal. */
const devMailbox =
  (env: Env): SendOtp =>
  async (email, otp) => {
    console.log(`[spike] sign-in code for ${email}: ${otp}`);
    await env.DB.prepare('INSERT INTO spike_otp (email, otp) VALUES (?, ?) ON CONFLICT (email) DO UPDATE SET otp = excluded.otp').bind(email, otp).run();
  };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const html = (body: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>SignForge spike</title><body style="font:16px system-ui;max-width:32rem;margin:2rem auto">${body}`,
    {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    },
  );

/** The plugin sends a signed-out person here with its signed query; signing in with it continues the authorization. */
function signInPage() {
  return html(`<h1>Sign in</h1>
<form id="e"><input name="email" type="email" placeholder="email" required> <button>Send code</button></form>
<form id="c" hidden><input name="otp" placeholder="code" required> <button>Sign in</button></form>
<script>
const q = location.search.slice(1); let email;
e.onsubmit = async (ev) => { ev.preventDefault(); email = new FormData(e).get('email');
  await fetch('/api/auth/email-otp/send-verification-otp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, type: 'sign-in' }) });
  c.hidden = false; };
c.onsubmit = async (ev) => { ev.preventDefault();
  const r = await fetch('/api/auth/sign-in/email-otp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, otp: new FormData(c).get('otp'), oauth_query: q }) });
  const j = await r.json(); if (j.url) location.href = j.url; else document.body.append(JSON.stringify(j)); };
</script>`);
}

interface OrgRow {
  id: string;
  name: string;
  role: Role;
}

/** The consent page: which org, which scopes. Shown on every authorization (see ./auth.ts). */
async function consentPage(request: Request, env: Env) {
  const url = new URL(request.url);
  const auth = createAuth(env, devMailbox(env));
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return Response.redirect(`${env.CMS_ORIGIN}/sign-in${url.search}`, 302);
  const clientId = url.searchParams.get('client_id') ?? '';
  const client = await env.DB.prepare('SELECT name, redirectUris FROM oauthClient WHERE clientId = ?')
    .bind(clientId)
    .first<{ name: string | null; redirectUris: string }>();
  if (!client) return html('<p>Unknown client.</p>', 400);
  const orgs = await env.DB.prepare(
    'SELECT o.id, o.name, m.role FROM member m JOIN organization o ON o.id = m.organizationId WHERE m.userId = ? ORDER BY o.name',
  )
    .bind(session.user.id)
    .all<OrgRow>();
  const requested = (url.searchParams.get('scope') ?? '').split(' ');
  const hosts = (JSON.parse(client.redirectUris) as string[]).map((u) => new URL(u).host);
  const orgOptions = orgs.results
    .map((o) => `<label><input type="radio" name="org" value="${esc(o.id)}" required> ${esc(o.name)} (${o.role})</label><br>`)
    .join('');
  const scopeBoxes = TOOL_SCOPES.filter((s) => requested.includes(s))
    .map((s) => `<label><input type="checkbox" name="scope" value="${s}" ${s === 'content:read' || s === 'content:draft' ? 'checked' : ''}> ${s}</label><br>`)
    .join('');
  return html(`<h1>Connect ${esc(client.name ?? clientId)} <small>(unverified)</small></h1>
<p>Redirects to ${hosts.map(esc).join(', ')}. The connection works in one organization only.</p>
<form method="post" action="/consent">
<input type="hidden" name="oauth_query" value="${esc(url.search.slice(1))}">
<fieldset><legend>Organization</legend>${orgOptions}</fieldset>
<fieldset><legend>Scopes</legend>${scopeBoxes}</fieldset>
<button name="accept" value="true">Allow</button> <button name="accept" value="false" formnovalidate>Cancel</button>
</form>`);
}

/**
 * Allow or Cancel. Allow writes the grant row first (org, member, client, scopes capped by the role),
 * then completes the plugin's consent with an instance whose consent reference is that grant's id.
 */
async function consentDecision(request: Request, env: Env) {
  const form = await request.formData();
  const oauthQuery = String(form.get('oauth_query') ?? '');
  const query = new URLSearchParams(oauthQuery);
  const accept = form.get('accept') === 'true';
  let grantId: string | undefined;
  const auth = createAuth(env, devMailbox(env), () => {
    if (!grantId) throw new Error('consent completed before its grant row was written');
    return grantId;
  });
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return html('<p>Signed out.</p>', 401);
  let scope: string | undefined;
  if (accept) {
    const orgId = String(form.get('org') ?? '');
    const member = await env.DB.prepare('SELECT role FROM member WHERE organizationId = ? AND userId = ?').bind(orgId, session.user.id).first<{ role: Role }>();
    if (!member) return html('<p>Not a member of that organization.</p>', 403);
    const chosen = form.getAll('scope').map(String);
    const granted = ROLE_SCOPES[member.role].filter((s) => chosen.includes(s));
    grantId = `agt_${crypto.randomUUID().replace(/-/g, '')}`;
    await env.DB.prepare('INSERT INTO spike_grants (id, org_id, user_id, client_id, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(grantId, orgId, session.user.id, query.get('client_id'), JSON.stringify(granted), Date.now())
      .run();
    // The plugin refuses scopes the client did not ask for; offline_access passes through when asked for.
    const requested = (query.get('scope') ?? '').split(' ');
    scope = [...granted, ...(requested.includes('offline_access') ? ['offline_access'] : [])].join(' ');
  }
  const result = await auth.api.oauth2Consent({ body: { accept, oauth_query: oauthQuery, ...(scope ? { scope } : {}) }, headers: request.headers });
  return Response.redirect(result.url, 302);
}

/** Counts the D1 statements a request runs, for RESULTS.md: answered in `x-spike-d1-statements`. */
function counting(db: D1Database) {
  let statements = 0;
  const proxy = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => (statements++, target.prepare(sql));
      if (key === 'batch') return (list: D1PreparedStatement[]) => target.batch(list);
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: proxy, statements: () => statements };
}

export default {
  async fetch(request, rawEnv) {
    const { db, statements } = counting(rawEnv.DB);
    const res = await route(request, { ...rawEnv, DB: db });
    const out = new Response(res.body, res);
    out.headers.set('x-spike-d1-statements', String(statements()));
    return out;
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin === env.MCP_ORIGIN) {
    if (url.pathname === '/mcp') return serveMcp(request, env);
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp' || url.pathname === '/.well-known/oauth-protected-resource') {
      return protectedResourceMetadata(env);
    }
  }
  if (url.origin === env.CMS_ORIGIN) {
    const auth = createAuth(env, devMailbox(env));
    if (url.pathname.startsWith('/api/auth/')) return auth.handler(request);
    if (url.pathname === '/.well-known/oauth-authorization-server/api/auth') return oauthProviderAuthServerMetadata(auth)(request);
    if (url.pathname === '/sign-in') return signInPage();
    if (url.pathname === '/consent') return request.method === 'POST' ? consentDecision(request, env) : consentPage(request, env);
    if (url.pathname === '/dev/otp') {
      const row = await env.DB.prepare('SELECT otp FROM spike_otp WHERE email = ?').bind(url.searchParams.get('email')).first<{ otp: string }>();
      return Response.json({ otp: row?.otp ?? null });
    }
    if (url.pathname === '/dev/grants/revoke' && request.method === 'POST') {
      const { grantId } = await request.json<{ grantId: string }>();
      await env.DB.prepare('UPDATE spike_grants SET revoked_at = ? WHERE id = ?').bind(Date.now(), grantId).run();
      return Response.json({ ok: true });
    }
  }
  console.log(`[spike] 404 ${request.method} ${url.href}`);
  return new Response('not found', { status: 404 });
}
