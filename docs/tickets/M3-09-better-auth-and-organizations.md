# M3-09 Better Auth and organizations

Status: open  ·  Size: M  ·  Depends on: M3-02, M3-00

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

- [ ] Sign-up, sign-in, create org, invite, accept, switch org: covered by tests against local D1.
- [ ] A request with a session for org A cannot act on org B, even with org B's ids.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.

## Owner decision

Q3: passwordless sign-in acceptable, and which email service. Default if unanswered: Resend, email code plus GitHub.
