# M4-01 OAuth provider and MCP round trip: results

Run on 2026-11-22, locally only: workerd tests and `wrangler dev`, with no deploy. Each section answers one question from #106.

**Versions**: better-auth and `@better-auth/oauth-provider` 1.7.25, `@modelcontextprotocol/server` and `/client` 2.4.0, wrangler 4.164.0, workerd 1.20261117.1, compatibility date 2026-11-01 with `nodejs_compat`. The real clients were Claude Code 2.1.326 and MCP Inspector 2.14.0 (CLI). Node was 26.13.1.

**How to rerun**
- The round trip in workerd: `pnpm --filter @signforge/spike-m4-oauth test` (14 tests, `test/round-trip.test.ts`). It drives the MCP SDK's own client.
- Against `wrangler dev`, from `spike/m4-oauth`:
  1. `wrangler d1 migrations apply DB --local`
  2. `wrangler dev --port 8861 --ip 127.0.0.1 --var CMS_ORIGIN:http://localhost:8861 --var MCP_ORIGIN:http://127.0.0.1:8861`
  3. `node scripts/person.mjs setup http://localhost:8861`, then the `wrangler d1 execute` command it prints.
  4. Connect a client to `http://127.0.0.1:8861/mcp`. `scripts/person.mjs consent` plays the person: it signs in by email code and consents with an org picked.
- CPU: `node scripts/cpu.mjs`.

One Worker plays both hosts. The CMS origin, which holds the issuer and the session cookie, is `localhost`. The API host serving `/mcp` is `127.0.0.1`. Cookies are per host, so the two are separate, as they would be on two hostnames.

## Summary

| Question | Answer |
| --- | --- |
| The provider plugin on Workers and D1 with transactions off | **Yes.** It adds 7 tables (below). |
| Authorization code with S256 PKCE | **Yes.** PKCE is required for public clients, and `plain` is refused. |
| Refresh token rotation | **Yes**, with replay detection: replaying a rotated refresh token revokes the whole family. |
| Revocation (RFC 7009) | **Yes.** One deviation: it answers 400, not 200, for a token it does not know or has already revoked. |
| Tokens stored hashed | **Yes.** Access and refresh tokens and codes are stored as SHA-256, base64url. |
| DCR (`allowDynamicClientRegistration`) | **Yes.** Unauthenticated registration also accepts confidential clients, which M4-04 must close. |
| Client ID Metadata Documents | **No** in 1.7.x. `@better-auth/cimd` exists only as 1.8.0 betas. Both clients fell back to DCR. |
| The org picked on the consent page reaches the grant | **Yes**, as the consent's reference id. That id is our grant row's id, and the plugin copies it onto every code and token. |
| Issuer and resource on different hosts | **Yes**, with metadata on each host and the audience checked by `/mcp`. Same-host works too and is simpler (see below). |
| Unauthenticated `/mcp` returns 401 with `WWW-Authenticate`, and clients discover from it | **Yes**: the SDK client, Claude Code and MCP Inspector all did. |
| Round trip from real clients | **Yes, both**: register, sign in, consent with an org picked, `tools/list`, `tools/call`, refresh, revoke, then not authorized. |
| Free-plan fit | **Yes.** About 1.5 ms CPU to build Better Auth per request, and 0.1–0.2 ms per MCP call. `/mcp` makes 1 D1 statement per call. The bundle grows by about 300 KiB gzip. |

**Decision.** Use Better Auth's provider plugin as the authorization server. Serve `/mcp` with the MCP SDK's stateless `createMcpHandler` (`@modelcontextprotocol/server` 2.x) on a plain route: no Durable Object and no session. Do not use Cloudflare's `workers-oauth-provider`, and do not use the Agents SDK's `McpAgent`:
- `workers-oauth-provider` 1.2.4 needs a KV namespace (`OAUTH_KV`) for clients, grants and tokens. KV on the Free plan allows 1,000 writes a day. Each authorization writes several entries, and each hourly refresh writes again, so a few dozen agents would fill it.
- KV is eventually consistent, so a revocation could take up to a minute to reach every location.
- It would be a second token store beside Better Auth's sessions, outside D1, where `packages/db` keeps tenancy.
- `McpAgent` is one Durable Object per MCP session. Its duration is the plan's scarce resource (backend plan, "Two numbers"), and the Agents docs now mark it deprecated in favour of `createMcpHandler`.

## 1. The plugin on Workers and D1

**Answer: yes.** Better Auth runs the plugin through its D1 dialect, with transactions off, as in M3-00. `npx auth generate --config auth.config.ts` produced `migrations/0001_better_auth.sql`. The plugin's tables are:

| Table | Holds |
| --- | --- |
| `oauthClient` | Registered clients: redirect URIs, auth method, a hashed secret if confidential, `referenceId`. |
| `oauthResource`, `oauthClientResource` | Resources (RFC 8707) and which clients may ask for them. |
| `oauthConsent` | Consent per client, user and `referenceId`. |
| `oauthAccessToken`, `oauthRefreshToken` | Opaque tokens as hashes, with `referenceId`, `resources`, `scopes`, `sessionId`, `expiresAt` and `revoked`. |
| `oauthClientAssertion` | `private_key_jwt` replay markers (unused here). |

Dates are stored as ISO strings. An access token row, from the test output, with the hash shortened:

```
{"token":"Pap6BHGc…LzZLfg","clientId":"XTnb…","sessionId":"MSGx…","userId":"GDOS…","referenceId":"agt_115db…","resources":"[\"http://127.0.0.1:8787/mcp\"]","refreshId":"oUZI…","expiresAt":"2026-11-23T05:09:35.000Z","revoked":null,"scopes":"[\"content:read\",\"content:draft\",\"content:publish\",\"offline_access\"]"}
```

**Found on the way: Better Auth's schema check costs about 19 D1 statements per request.**
- Since 1.7, the adapter introspects every table once per instance: 17 `pragma_table_info` statements, `sqlite_master` and `index_list`. The instance is built per request, so the check runs on every request.
- With it, the metadata GET ran 20 statements and sign-in ran 33. With `advanced.database.validateSchema: false` they ran 1 and 14 (the test's request log).
- apps/api builds its instance per request without that option. **It probably pays the same on every `/api/auth` call and every `getSession`.** That was not measured in apps/api and is worth an issue of its own.

## 2. Code, PKCE, refresh, revocation, hashing

All of this is in `test/round-trip.test.ts`, "registers, signs in, consents…", and the PKCE tests:
- **PKCE.** The metadata advertises `code_challenge_methods_supported: ["S256"]`. `plain` gets `invalid_request: code_challenge_method must be one of: S256`. A public client that sends no challenge gets `invalid_request: pkce is required for public clients`.
- **Refresh.** Each refresh issues a new refresh token and marks the old one `revoked` and `rotatedAt`. The old access token keeps working until it expires: an hour at our setting.
- **Replay.** Replaying a rotated refresh token gets `400 invalid_grant` and **revokes the family**: the live pair stopped working, and no token rows were left.
- **Revocation** (`POST /api/auth/oauth2/revoke`, public clients send `client_id`):
  - Revoking an access token stops it at once (`/mcp` 401 with `error="invalid_token"`), and its refresh token still refreshes.
  - Revoking a refresh token also removes its access tokens.
  - A token it no longer knows gets `400 invalid_request` ("Invalid access token"), where RFC 7009 says 200. Claude Code's logout hit this on its second call and carried on.
- **Hashing.** No stored token equals the raw one. Each is SHA-256 in base64url (`storeTokens: 'hashed'`, the default). Client secrets are hashed too.
- **Signing out of the CMS.** It revokes the access tokens issued under that session (the plugin's session-delete hook). The refresh token survives, its `sessionId` set to null, and refreshing gives a working token. An agent therefore recovers from a sign-out with one refresh (the test asserts this).

## 3. Registration: DCR and CIMD

- `allowDynamicClientRegistration` with `allowUnauthenticatedClientRegistration` makes `POST /api/auth/oauth2/register` open. The SDK client, Claude Code and the Inspector each registered as public clients (`token_endpoint_auth_method: none`) with loopback redirects.
- Native clients send no `application_type`, so `clientRegistrationDefaultApplicationType: 'infer'` treats loopback callbacks as native, as the plugin's docs suggest for Cursor and Claude Code.
- **Open registration also accepts a confidential client** (`client_secret_post`) and returns its secret. The test "lets anyone register a confidential client too" shows it. The default `grant_types_supported` also includes `client_credentials`.
- **CIMD**: the plugin's option points to `@better-auth/cimd`, which has only 1.8.0 betas on npm. Neither client needed it.
- Registration is rate-limited by the plugin, 5 a minute per address by default, through Better Auth's limiter (database storage in apps/api). The spike turns rate limits off.

## 4. Carrying the org into the grant

The plugin has no org parameter. What it does have is a **consent reference id**: `postLogin.consentReferenceId({ user, session, scopes })`. The consent, the code, and every access and refresh token store that id as `referenceId`.

The spike makes that id our grant row's id (`agt_…`):
1. The consent page (`GET /consent`, ours) lists the person's orgs with their role, and the scopes the client asked for.
2. Allow (`POST /consent`, ours) checks membership of the chosen org and caps the scopes by the role. It **writes the grant row first**: org, member, client and scopes.
3. Then it calls `auth.api.oauth2Consent` with an instance built for this request, whose `consentReferenceId` returns that grant's id. The plugin stores it on the consent and the code, and the token endpoint copies it onto the tokens.
4. Every other instance returns no reference, so no stored consent is ever found, and the consent page shows on every authorization. That is wanted: each connection picks its org.
5. `/mcp` reads the token by its hash, joined with the grant, the org and the membership, in one statement (`src/mcp.ts`).

Tests: "a grant in one org reaches only that org", "a revoked grant stops its tokens", "a removed member loses the grant", and Cancel giving `access_denied`.

The alternative, the plugin's `postLogin` page with `setActiveOrganization`, was rejected. It would switch the active org of the person's CMS session, which every tab shares (#129).

## 5. Issuer and resource on two hosts

- **The API host** serves the protected resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource/mcp`, naming `resource: <api>/mcp` and `authorization_servers: [<cms>/api/auth]`.
  - An unauthenticated `/mcp` answers 401 with `WWW-Authenticate: Bearer resource_metadata="…", scope="…"`.
- **The CMS origin** serves the authorization server metadata (RFC 8414) at the path-inserted URL `/.well-known/oauth-authorization-server/api/auth`, with `issuer: <cms>/api/auth`.
  - Deployed, the CMS Worker must route that path to the API Worker, since only `<host>/api/*` goes there today.
  - Claude Code's logout also probed `/.well-known/oauth-protected-resource/api/auth`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration` on the CMS host before the path-inserted one. All got 404, harmlessly.
- **Audience.** The client sends `resource=<api>/mcp` (RFC 8707). The plugin stores it on the token, and `/mcp` refuses a token whose `resources` lack it. Authorizing for another resource gets `invalid_target`. The authorization response carries `iss` (RFC 9207), and the SDK client checks it.
- **Token validation across hosts** needs nothing cross-host. Both hosts are served by the API Worker and share D1, so `/mcp` looks the token up directly.
  - The plugin's only validator for opaque tokens is `/oauth2/introspect`, which needs a confidential client's credentials.
  - JWT access tokens (the `jwt` plugin, JWKS) would allow validation without D1. Revocation would then wait for expiry, and `/mcp` reads the grant row anyway.
- **Same host is simpler.** The deployed layout already routes `<host>/api/*` to the API Worker. Routing `<host>/mcp` and `<host>/.well-known/oauth-*` there too puts issuer and resource on one origin. That needs no metadata on a second host and makes the redirect host one the person knows. Both work. The owner picks the hostname in M4-04 or M3-24.

## 6. Real clients against `wrangler dev`

The person was played by `scripts/person.mjs`, a cookie jar that signs in by the dev email code and posts the consent form. The authorization codes were never printed.

**Claude Code 2.1.326**: `claude mcp add --transport http -s local sf-spike http://127.0.0.1:8861/mcp`, then `claude mcp login sf-spike --no-browser`, driven by `expect`.
- **Discovery and registration.** Claude Code fetched the resource metadata, then the authorization server metadata, then `POST /api/auth/oauth2/register` (201).
- **Authorize URL.** It carried `code_challenge_method=S256`, `state`, `prompt=consent`, `resource=http://127.0.0.1:8861/mcp` and every advertised scope.
- **Consent.** The page showed "Connect Claude Code (sf-spike) (unverified) | Redirects to localhost:58682". The person picked Hearth Café with `content:read content:draft`. The redirect URL was pasted back, and Claude Code printed: `Authenticated with "sf-spike". Its tools are now available in Claude Code.`
- **`tools/call`.** `claude mcp get` showed `✔ Connected`. `claude -p "Call the whoami tool…"` returned:
  `{"org":{"id":"WHBW…","name":"Hearth Café"},"role":"editor","scopes":["content:read","content:draft"],"grantId":"agt_924e…","clientId":"eIoB…"}`
- **Refresh.** The access token's `expiresAt` was set in the past in local D1. The next call went `POST /mcp 401`, then `POST /api/auth/oauth2/token 200`, then `POST /mcp 200`, and one refresh token row was rotated.
- **Revoke.** `claude mcp logout sf-spike` called `POST /api/auth/oauth2/revoke` twice: 200, then 400 (the RFC 7009 deviation). No live refresh token was left, and `claude mcp get` said `! Needs authentication`.

**MCP Inspector 2.14.0 (CLI)**: `mcp-inspector --cli http://127.0.0.1:8861/mcp --method tools/list`. It runs its own OAuth flow with a loopback callback on `127.0.0.1:6276`.
- **Consent.** "Connect MCP Inspector (unverified) | Redirects to 127.0.0.1:6276". The person picked Northside Market with `content:read` only, and the Inspector printed "Authorization complete."
- **`tools/list`.** It returned only `whoami`: `draft_note` needs `content:draft`.
- **`tools/call`.** `--method tools/call --tool-name whoami` returned Northside Market, `owner`, `["content:read"]`.
- **Refresh.** After the token was expired in D1: `POST /mcp 401`, then `token 200`, then the call succeeded.
- **Revoke.** Revoking our grant row: `POST /mcp 401`, then `token 200`, then `POST /mcp 401`, and the CLI stopped with an error. The plugin still refreshed tokens of a grant we had revoked (see limitation 3).

Both clients spoke the 2025 protocol, which the SDK handler serves on its stateless legacy leg. The SDK's own client negotiated `2025-11-25`. No client here used the 2026-07-28 per-request envelope, though the handler serves it.

## 7. Free-plan fit

- **CPU** (`scripts/cpu.mjs`, Node 26, warm, no I/O; the Free plan allows 10 ms per request):

  | Work | CPU per request |
  | --- | --- |
  | MCP `tools/list` with 80 tools | 0.14 ms |
  | MCP `tools/call` | 0.07 ms |
  | Better Auth with the provider built per request, serving metadata | 1.4–1.65 ms |

- **D1 statements per request**, with the schema check off:

  | Request | Statements |
  | --- | --- |
  | `/mcp` call | 1 (token, grant, org and membership in one join) |
  | register | 5 |
  | authorize | 4 |
  | sign-in that continues the authorization | 14 |
  | consent | 11 |
  | token exchange | 17 |
  | refresh | 10 |

  The `/mcp` call writes nothing to D1. M4-06 should answer `GET /mcp` with 405 before reading the token: it costs one statement now.
- **Bundle** (`wrangler deploy --dry-run`, gzip):

  | Bundle | Size |
  | --- | --- |
  | Better Auth with email OTP and organizations | 364 KiB |
  | … plus the provider plugin | 530 KiB |
  | The MCP SDK server alone | 133 KiB |
  | apps/api today | 809 KiB |

  apps/api would reach roughly 1.1 MiB. The Free plan's limit is 3 MB compressed.
- **No Durable Object.** `/mcp` is a plain route. The limiter (`AgentGrantObject`, M4-02) is the only per-call Durable Object cost.

## Plugin limitations M4-04 has to design around

1. **No in-process validator for opaque tokens.** `/mcp` reads `oauthAccessToken` by SHA-256 base64url of the token, as the plugin stores it, and must check `expiresAt`, `revoked` and `resources`. That ties us to the plugin's storage format. Pin the version and keep the spike's assertions as tests.
2. **The org is not a plugin concept.** It rides on the consent reference id, which is our grant id, set by a per-request `consentReferenceId` (section 4). Two consequences:
   - The consent page shows on every authorization.
   - `prompt=none` always fails with `consent_required`.
3. **The plugin does not know our grant.** Revoking a grant row, removing a member or leaving the org leaves the plugin's refresh tokens live, so the client refreshes and gets 401 in a loop (the Inspector run).
   - Revoking must also revoke or delete the plugin's tokens and consent where `referenceId` is the grant id, in the same request.
   - `/mcp` must still treat a token without a live grant row as invalid, since D1 has no transaction to make the two atomic.
4. **Open registration is too open.**
   - Refuse anything but `token_endpoint_auth_method: none`, for example with a before hook on `/oauth2/register`.
   - Set `grantTypes: ['authorization_code', 'refresh_token']`, so `client_credentials` is neither advertised nor issued.
   - Registered clients get every scope as their capability set. Only consent narrows it.
5. **No CIMD** in 1.7.x. Revisit with `@better-auth/cimd` once 1.8 is stable.
6. **Turn off Better Auth's schema check** (`advanced.database.validateSchema: false`). It is about 19 D1 statements on every request with a per-request instance (section 1), and our migrations own the schema anyway.
7. **Scopes must all be asked for up front.** Consent can only narrow what the client requested ("Scope not originally requested"). So the resource metadata and `WWW-Authenticate` advertise every scope plus `offline_access`, and clients ask for all of them. Without `offline_access` there is no refresh token.
8. **The plugin answers fetches with JSON, `{ redirect, url }`, and navigations with 302.** It decides by `sec-fetch-mode` and `accept`. The consent page's Allow must follow the URL it returns.
9. **The session binds access tokens.**
   - Signing out of the CMS revokes the access tokens issued under that session, and the agent recovers with one refresh.
   - A refreshed pair outlives the person's session, which is what an agent needs.
10. **RFC 7009 deviation.** It answers 400 for unknown or already-revoked tokens. Clients tolerate it.
11. **Old access tokens live until expiry after a refresh**, an hour at our setting. The grant row check on every call bounds that: a revoked grant stops them at once.
12. **`resources` seeding.** The `resources` option inserts the `oauthResource` row when an instance initialises: one statement, insert-only. A migration could seed it instead.
13. **CSRF on consent.** Allow is our route, not one of Better Auth's, so it must check `Origin` itself, as Better Auth does for its own endpoints. The signed `oauth_query` stops a forged query, and SameSite=Lax cookies stop a cross-site POST from carrying the session. M4-05 should add the origin check, and M4-17 test it.

## Resources created and deleted

- **Cloudflare**: nothing. Everything ran locally.
- **Claude Code**: a `sf-spike` server in local scope, for a scratch directory only. It was logged out and removed after the run.
- **MCP Inspector**: its state lived under a scratch `HOME` and was deleted.
