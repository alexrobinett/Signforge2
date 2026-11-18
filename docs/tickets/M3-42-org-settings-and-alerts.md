# M3-42 Org settings, members and alerts

Status: open  ·  Size: M  ·  Depends on: M3-11

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

- [ ] A screen unplugged past the threshold sends one email, and one more when it is back.
- [ ] An editor cannot change roles or settings; a viewer cannot change anything (tests).
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
