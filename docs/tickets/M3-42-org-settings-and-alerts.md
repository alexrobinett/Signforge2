# M3-42 Org settings, members and alerts

Status: done (branch `m3-42-org-settings`)  ·  Size: M  ·  Depends on: M3-11

## Goal

The settings pages from the design canvas that are not covered elsewhere.

## Read first

- Design: the design canvas (https://claude.ai/artifact/JUMHm7PCsat6RV8yDXNb3H), `docs/proposals/cms-ui.md` and `docs/research/cms-ux.md`. (Row 6 · Settings)
- docs/tickets/M3-09-better-auth-and-organizations.md (roles)

## Scope

- **General:** org name, default time zone, locale and default display hours for new screens (`org_settings`, M3-34).
- **Members & roles:** invite by email, pending invites, change role, remove. Roles are owner, editor and viewer (M3-09); the canvas's "admin" role is not in v1.
- **Screens & groups defaults:** update window, and how long a screen may be unreachable before it alerts (default 15 minutes).
- **Notifications:** who gets which alert (screen needs you, publish finished, agent refused) by email first. Slack, Teams and webhooks come with the integrations proposal.
- **Your account:** profile, sign-in methods, sessions, theme (light, dark, system).
- An alert is sent once per incident, after the threshold, and once when it clears.

## Out of scope

- Billing & usage and the audit log page (M3-24); API & agents (Milestone 4).

## Done when

- [x] A screen unplugged past the threshold sends one email, and one more when it is back (`apps/api/test/alerts.test.ts`: none at 14 minutes, one each to owners and editors at 16, none on later checks, one each when it syncs again, and again for a second incident; the org's threshold and audience are followed; nothing with email off, or for a revoked or never-seen screen).
- [x] An editor cannot change roles or settings; a viewer cannot change anything (tests: `apps/api/test/members.test.ts`, neither can raise their own role or anyone's, invite, cancel an invite, remove a member, rename the org or call `update_org_settings`, and a viewer cannot call a changing tool; the sole owner cannot step down. `packages/tools/test/settings.test.ts` for the tool's roles. `apps/cms/e2e/settings.spec.ts`: an editor sees the settings read-only.)
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated (packages/tools and packages/db READMEs, apps/cms README, docs/backend-plan.md).

## What was built

- **Settings (`packages/tools/src/settings.ts`).** `get_org_settings` (viewer) and `update_org_settings` (owner, new scope `org:manage` that editors do not hold). Migration `0012_org_settings_and_incidents` adds the columns to `org_settings`. Defaults until set: no default time zone or locale, always on, update window 02:00 to 04:00, alert after 15 minutes, screen-offline and publish alerts to owners and editors, agent refusals to owners, by email.
- **Unreachable follows the org.** A screen's state turns `unreachable` after the org's threshold, the same one the alerts use.
- **Alerts (`apps/api/src/alerts.ts`).** A Cron Trigger every 5 minutes (the sync interval). `screen_incidents` holds at most one open incident per screen; the row is written before the email and only by the check that wrote it, so an alert is sent once per incident. The "back" email names how long the screen was silent. Only the offline alert is sent: publish (M3-18) and agent (Milestone 4) alerts are stored settings with nothing sending them yet.
- **Members.** Better Auth's organization endpoints, which already allow only owners to invite, change roles and remove (`apps/api/src/auth/roles.ts`). The CMS's auth client is typed with the API's roles (`@signforge/api/roles`).
- **CMS.** `/settings/general`, `/settings/members`, `/settings/screens`, `/settings/notifications`, `/account`, and `/accept-invitation/<id>` (the link M3-09's invite email points to). Brand kits is a nav slot for M3-40. The pairing form starts with the org's time zone, locale and hours.

## Notes

- **The roles boundary is Better Auth's.** Role changes, invitations and removal are not tools and are not in our audit log. The owner should review `apps/api/test/members.test.ts` and `apps/api/src/auth/roles.ts`.
- **Better Auth answers some refusals 401.** `cancel-invitation` and `remove-member` from an editor or viewer answer 401, not 403; the test accepts either.
- **Sessions on the Account page.** Signing out another session needs its token, so other sessions' tokens reach that page, as Better Auth's own client would fetch them. The current session's token is left out.
- **No link in alert emails.** A deployed CMS shares the API's hostname and `CMS_ORIGIN` is usually unset, so the cron has no origin to link to.
- **Not built:** changing your email address, deleting your account, transferring ownership, closed dates, skipping closed hours for alerts, and the update window's use (player updates wait for it once the supervisor updates players).
