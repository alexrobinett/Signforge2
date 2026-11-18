# M3-09 Better Auth and organizations

Status: done (branch `t3/m3-09-better-auth-organizations`)  ·  Size: M  ·  Depends on: M3-02, M3-00

## Goal

Users sign in and belong to organizations, on D1 inside the API Worker.

## Read first

- docs/backend-plan.md#auth-and-tenancy
- spike/m3-platform/RESULTS.md (Better Auth findings)

## Scope

- Better Auth instance built per request; organization plugin; owner, editor, viewer roles.
- Passwordless sign-in: email code plus GitHub. Session cookie cache on.
- Rate limiting stored in D1 or the rate-limit binding.
- Middleware that resolves the active org and re-checks membership on every request, then hands handlers a `scoped(db, orgId)`.

## Out of scope

- The CMS UI (M3-10).

## Done when

- [x] Sign-up, sign-in, create org, invite, accept, switch org: covered by tests against local D1 (`apps/api/test/auth.test.ts`).
- [x] A request with a session for org A cannot act on org B, even with org B's ids (`apps/api/test/tenancy.test.ts`).
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
- [x] Rate limiting holds across a restart with no in-memory state (`apps/api/test/auth-platform.test.ts`).

## Owner decision

Q3: passwordless sign-in acceptable, and which email service. Default if unanswered: Resend, email code plus GitHub.

**Built with Cloudflare Email Sending, not Resend.** Q3 is still open. The email service sits behind `EmailSender` (`apps/api/src/email`), so changing provider means one new class.

## What was built

- **Better Auth in the API Worker, under `/api/auth`.** An instance is built per request (`apps/api/src/auth`). `auth.config.ts` is the static config for the CLI. Sign-in is by email code (hashed in D1, 6 digits, 10 minutes) or GitHub. Signing up is the first sign-in. The session cookie cache is on (5 minutes), and cookies are named `sf.*`.
- **Organizations** have the roles owner, editor and viewer, from M3-00. Org hooks refuse any other role, including Better Auth's built-in `admin` and `member`. Org deletion is off; see the notes below.
- **Middleware** (`apps/api/src/api`):
  - `/api` refuses any `Authorization` header.
  - `/api/session` reports the user and their active org.
  - Every other `/api` route runs behind `requireSession` and `requireOrg`. `requireOrg` reads the active org from the session only, re-checks membership in D1 on every request (`findMembership` in `packages/db`), and sets `c.var.org = scoped(db, orgId)` along with `c.var.role`.
  - `/v1/device/*` refuses any request that carries an `sf.*` cookie (`apps/api/src/auth/guards.ts`).
- **Email.** `EmailSender` has two implementations. `CloudflareEmailSender` uses the `send_email` binding `EMAIL`, sending from `EMAIL_FROM`. `RecordingEmailSender` keeps every message so tests can read it, and logs it to the terminal. Dev uses the recorder; demo and prod use Cloudflare.
- **Rate limiting** is Better Auth's database storage, in the `rateLimit` table in D1, keyed by `cf-connecting-ip` and path. The limits are 3 codes a minute, 3 sign-ins per 10 s, and 100 requests per 10 s elsewhere.
- **Database.** Better Auth's tables are in `packages/db/src/schema.ts`. Migration `0002_better_auth` adds them, and every tenant `org_id` now references `organization(id)`. A test asks Better Auth whether the migrated database is missing anything.

## Setup the owner must do

Nothing has been created on Cloudflare. Before the first deploy of each environment (`demo`, `prod`):

1. **Auth secret.** Run `wrangler secret put AUTH_SECRET --env <env>` with 32+ random bytes, for example from `openssl rand -base64 32`. The Worker refuses to start auth without it outside dev.
2. **Email Sending.**
   1. Onboard the sending domain: `wrangler email sending enable <domain>`, or in the dashboard go to Compute & AI → Email Service → Email Sending → Onboard Domain.
   2. Check the SPF and DKIM records with `wrangler email sending dns get <domain>`.
   3. Set `EMAIL_FROM` in `apps/api/wrangler.jsonc` for that env to an address on the domain. The placeholder `no-reply@signforge.invalid` will not send.
   4. Optionally, restrict the `send_email` binding with `allowed_sender_addresses`.
3. **GitHub OAuth app.** Create one per environment under GitHub → Settings → Developer settings → OAuth Apps.
   - Homepage URL: the CMS origin.
   - Authorization callback URL: `https://<api host>/api/auth/callback/github`.
   - Then run `wrangler secret put GITHUB_CLIENT_ID --env <env>` and `wrangler secret put GITHUB_CLIENT_SECRET --env <env>`.
   - GitHub sign-in is offered only when both secrets are set.
4. **CMS origin.** If the CMS is served from a different origin than the API, set `CMS_ORIGIN` as a var or secret. It is trusted for auth requests and used for invitation links. M3-10 plans the same hostname, so it can stay unset.
5. **Local dev.** Needs nothing. Sign-in codes are printed in the `wrangler dev` terminal, and a fixed dev secret is used. To try GitHub locally, put `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in `apps/api/.dev.vars`.

## Notes

- **Cache cookie after create and accept.** In 1.7.25, creating an org and accepting an invitation make that org active in the database but do not reissue the cache cookie. For up to 5 minutes, the server would still see the old active org. An after hook reissues the cookie, as `set-active` does. The CMS still needs to keep every cookie a response sets.
- **Failed org creation.** If adding the owner member fails, the `organization` row is left with no members. No one can make it active or reach it through `/api`; the test shows this. It is accepted rather than cleaned up. Its slug stays taken.
- **Org deletion is disabled.** Tenant rows reference `organization` without cascade. Better Auth deletes without a transaction, so a refused delete could remove the members and keep the org. A later ticket should delete an org's content first, then enable deletion.
- **No migration for existing data.** Adding the `organization` foreign key rebuilds every tenant table. `0002_better_auth` assumes the tenant tables are empty, which holds because nothing has been deployed.
- **Cache cookie on removal.** A removed member's cache cookie can still name the org for up to 5 minutes. `requireOrg` refuses them anyway, because membership is read fresh on every request. A revoked session still works for up to 5 minutes. Pass `disableCookieCache` on sensitive routes if that matters.
- **Editors can publish,** as in M3-00's roles. That is open question Q7 in the plan.
  - **Since GitHub issue #48:** Q7 is decided: an owner chooses whether editors publish (`editorsPublish` in the org's settings; `packages/tools/README.md`).
- **No real CMS data routes yet.** Isolation is proven with test-only routes mounted behind `requireOrg`. Real routes arrive with the tool registry (M3-12).
  - **Since M3-12:** the test-only routes are gone. `tenancy.test.ts` uses the real `/api/tools` route.
