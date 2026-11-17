# Milestone 3 tickets

Milestone 3 is the CMS and API from `docs/backend-plan.md`, cut into tickets small enough for one agent session each. Each ticket names what to read, what is in and out of scope, and a checkable **Done when** list.

## Picking up a ticket

1. Choose an `open` ticket whose dependencies are all `done`.
2. Set its status to `in progress` with your branch name, on a branch named after the ticket (`m3-05-player-api`).
3. Read the files under **Read first** before writing code. `packages/contract` is the source of truth for every shape a screen sees; change it only when the ticket says so.
4. Work until every **Done when** box is checked. A box is checked by evidence (a test, a command's output, a measurement), never by intent.
5. Where a ticket has an **Owner decision**, build the stated default and say so in the PR; do not wait.
6. Set the status to `done` in the same PR.

Tickets that end on the Pi (M3-05 onward) need the test rig: see `device/pi/` and `scripts/deploy-pi.sh`. Without access, stop at the last step that can be done locally and say what is left.

## Order

M3-00, M3-01 and M3-22 have no dependencies and can run in parallel. The first Pi demo is M3-05; the first CMS demo is M3-11.

| Ticket | Title | Size | Depends on |
| --- | --- | --- | --- |
| [M3-00](M3-00-platform-verification-spike.md) | Platform verification spike | M | — |
| [M3-01](M3-01-api-worker-scaffold.md) | API Worker scaffold | S | — |
| [M3-02](M3-02-database-package-and-tenancy-guard.md) | Database package and tenancy guard | M | M3-01 |
| [M3-03](M3-03-device-auth-and-content-routes.md) | Device auth and content routes | M | M3-02 |
| [M3-04](M3-04-sf-push-publish-from-the-cli.md) | `sf push`: publish from the CLI | S | M3-03 |
| [M3-05](M3-05-player-play-from-the-api.md) | Player: play from the API | M | M3-04 |
| [M3-06](M3-06-screen-durable-object-and-nudge-socket.md) | Screen Durable Object and nudge socket | M | M3-05 |
| [M3-07](M3-07-sync-endpoint-heartbeat-play-counts-snapshots.md) | Sync endpoint: heartbeat, play counts, snapshots | M | M3-06 |
| [M3-08](M3-08-pairing.md) | Pairing | M | M3-07 |
| [M3-09](M3-09-better-auth-and-organizations.md) | Better Auth and organizations | M | M3-02, M3-00 |
| [M3-10](M3-10-cms-scaffold.md) | CMS scaffold | M | M3-09 |
| [M3-11](M3-11-cms-screens.md) | CMS: screens | M | M3-10, M3-08 |
| [M3-12](M3-12-tool-registry-and-audit-log.md) | Tool registry and audit log | M | M3-09 |
| [M3-13](M3-13-server-manifest-compiler.md) | Server manifest compiler | M | M3-02 |
| [M3-14](M3-14-assets-upload-and-library.md) | Assets: upload and library | M | M3-12 |
| [M3-15](M3-15-templates-push-and-catalogue.md) | Templates: push and catalogue | S | M3-12 |
| [M3-16](M3-16-spot-editor.md) | Spot editor | L | M3-14, M3-15, M3-13 |
| [M3-17](M3-17-playlist-editor.md) | Playlist editor | S | M3-16 |
| [M3-18](M3-18-instant-publish-and-rollout.md) | Instant publish and rollout | M | M3-17, M3-06 |
| [M3-19](M3-19-schedules-groups-and-takeovers.md) | Schedules, groups and takeovers | M | M3-18 |
| [M3-20](M3-20-timed-publish.md) | Timed publish | S | M3-18 |
| [M3-21](M3-21-video-upload-and-check.md) | Video upload and check | M | M3-14, M3-00 |
| [M3-22](M3-22-feed-normalisers.md) | Feed normalisers | S | — |
| [M3-23](M3-23-data-source-poller.md) | Data source poller | M | M3-22, M3-07, M3-12 |
| [M3-24](M3-24-hardening-and-environments.md) | Hardening and environments | M | M3-23, M3-19, M3-21 |

Sizes: S is up to half a day of agent work, M about a day, L more than a day (split it if it grows).
