# M3-15 Templates: push and catalogue

Status: done (branch `t3/m3-15-template-push-catalogue`)  ·  Size: S  ·  Depends on: M3-12

## Goal

Get built templates into the system with the build's checks repeated on the server.

## Read first

- docs/template-spec.md
- packages/cli/src/sf.ts (`buildTemplate`)
- packages/contract (FORBIDDEN_CSS, FORBIDDEN_TEMPLATE_CODE, TEMPLATE_BUDGET)

## Scope

- `sf template push <dir>`: build locally, upload bundle and `template.json`.
- Server repeats manifest validation, forbidden CSS, size and network checks on the bundle; stores a check report.
- Base templates (org null) seeded from `templates/` on deploy.
- Versions are immutable; a template version is draft, approved or retired.
- Server checks are a lint over the bundle, not a security boundary (the SDK itself calls `parent.postMessage`). Check the author's sources where the CLI uploads them; record that the sandbox is the guarantee.

## Out of scope

- The agent submission pipeline and review UI (Milestone 4).

## Done when

- [x] All seven templates in `templates/` push and appear as approved base templates (`apps/api/test/templates.test.ts`: built in Node by `buildTemplate`, pushed by the real client through `/admin`, read back with `list_templates` on `/api/tools`; and end to end below).
- [x] A bundle with a `fetch` call or `backdrop-filter` is rejected with the reason (`apps/api/test/templates.test.ts`, `packages/tools/test/templates.test.ts`; and end to end below). The `fetch(` check runs on the author's sources, the CSS check on the bundle.
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated (`docs/template-spec.md`, `docs/backend-plan.md`, `packages/tools/README.md`, `packages/db/README.md`).

## What was built

- **Contract.** `checkTemplateBundle({ manifest, html, sources })` returns a `TemplateCheckReport`: five checks (`manifest`, `forbidden-css`, `size`, `network`, `source-code`), each with its problems. `sf build` and the server run this one function. Committed on its own, ahead of the rest.
- **`packages/cli`.**
  - `buildTemplate` moved to `src/template.ts`. It returns the manifest, the HTML, the author's sources and the report, so `sf build` and `sf template push` share it. The golden test still passes.
  - `src/template-push.ts` is the client, with no Node imports, so the API tests drive it in workerd.
  - `sf template push <dir> --api <url> [--org <id>] [--approve]`: builds, refuses locally on any problem, uploads the bundle and sources, registers the version. Without `--org` it is a base template.
  - `sf template seed [templates-dir] --api <url>` (root: `pnpm seed:templates --api <url>`): pushes every template as an approved base template. Documented for deploys in `docs/backend-plan.md`.
- **`/admin` routes.**
  - `PUT /admin/orgs/:org/blobs/:sha256`: an org template's bytes, under the org's prefix. Base bytes use the existing `PUT /admin/base/blobs/:sha256` (`sys/b/`).
  - `PUT /admin/base/templates` and `PUT /admin/orgs/:org/templates`: run `register_template_version` through `dispatch()` as the system actor `sf-push`, then with `approve` run `set_template_version_status` on a new draft.
  - All three are in the route guard's `WRITERS` with their reasons, and in the admin auth test.
- **Tools.** `list_templates`, `get_template` (read, viewer), `register_template_version` (content:draft, editor), `set_template_version_status` (content:publish, owner). Registering reads the bundle and sources from R2, runs `checkTemplateBundle`, and on failure refuses with `invalid_input`, one `details` entry per problem naming its check. On success it stores the report (plus `checkedAt` and the sources' hash) on the new draft version.
- **Base templates and the platform registry.** Base templates have a null org, and `scoped(db, orgId)` cannot write them. So:
  - `packages/db` has `platform(db)`, which reads and writes only null-org template rows. Its `templates` has the same shape as an org scope's.
  - `packages/tools` has a `platformRegistry` with the same two writing tools (`defineSharedTool`), dispatched with `platform(db)`. Only `/admin` uses it; it is never on `/api`.
  - The dispatcher is generic over the scope.
- **`platform_audit_log`.** Migration `0004` adds it. `audit_log.org_id` is NOT NULL and references an organization, so platform changes are audited in their own table, which is not a tenant table. The schema test lists it as not a tenant table.
- **Tests.**
  - `packages/tools/test/templates.test.ts`: checks, immutability, statuses, base templates.
  - `apps/api/test/templates.test.ts`: all seven, rejections, org templates.
  - `packages/db/test/isolation.test.ts`: `platform(db)` never touches org rows.
  - The generated isolation test maps the new id kinds (`template`, `templateVersion`, and `bundle` and `sources` for org A's uploads) and checks org A's templates are unchanged. The route guard's read-tool pass gives `get_template` a base template id.

## Notes

- **Judgement calls.**
  - Failing versions are refused and not stored. The stored report is the passing report, kept for review.
  - A push with `--approve` (and `seed`) approves only a new draft. It never revives a retired version, so re-seeding on deploy leaves retirements alone.
  - Approving or retiring an org's version is owner-only.
  - The dispatcher audits every successful call. A no-op re-push therefore writes an audit row, though no template row changes.
  - The network and forbidden-CSS checks now run on the whole bundle rather than the built CSS alone, so the build and the server check the same bytes. All seven templates pass.
- **End to end against `wrangler dev`** (local D1 and R2 only, `ADMIN_TOKEN` in a local `.dev.vars`):

```
$ pnpm exec wrangler d1 migrations apply DB --local      # in apps/api
│ 0004_platform_audit_log.sql       │ ✅     │
$ pnpm exec wrangler dev --port 8799                     # in apps/api
$ SF_ADMIN_TOKEN=… pnpm seed:templates --api http://127.0.0.1:8799
Pushing agenda to base templates
  template agenda@1.0.0  70 kB (budget 600 kB)
  uploaded bundle 05f03b30e266 (70 kB) and sources 9a61930e7ff4
  base/agenda@1.0.0 registered, approved
… (clock, cstore-promo, menu-board, news, photo-promo, weather: the same)
$ SF_ADMIN_TOKEN=… pnpm seed:templates --api http://127.0.0.1:8799      # again
  base/agenda@1.0.0 was already registered with these bytes (approved); nothing changed
… (all seven)

# A copy of clock with `.glass { backdrop-filter: blur(8px); }`: the build refuses it locally,
$ sf template push <glass> --api http://127.0.0.1:8799
  - `backdrop-filter` drops about a fifth of frames over moving content
1 of 1 template(s) not pushed
# and pushed with the local check skipped, the server refuses it:
server refused: PUT /admin/base/templates: 400
the template failed its checks: `backdrop-filter` drops about a fifth of frames over moving content
  - forbidden-css: `backdrop-filter` drops about a fifth of frames over moving content
# clock's sources with `fetch('/feed.json')` added, pushed with the local check skipped:
server refused: PUT /admin/base/templates: 400
  - source-code: templates may not make network requests; bind to a data source instead

# An org template, then the same version with an edited style.css:
$ sf template push <tick> --api http://127.0.0.1:8799 --org org-e2e
  org-e2e/tick@1.0.0 registered, draft
$ sf template push <tick, edited> --api http://127.0.0.1:8799 --org org-e2e
  failed: PUT /admin/orgs/org-e2e/templates: 409
org-e2e/tick@1.0.0 is already registered with a different bundle or manifest; versions never change, so bump the version

$ wrangler d1 execute DB --local --command "SELECT owner, key, version, status, report ok, bytes …"
(base)  agenda 1.0.0 approved ok 71170 · clock 69472 · cstore-promo 72132 · menu-board 69865 · news 70873 · photo-promo 68304 · weather 73737 (all approved, ok)
org-e2e tick   1.0.0 draft    ok 69459
platform_audit_log: register_template_version ×14 (7 + 7 no-op re-pushes), set_template_version_status ×7, all sf-push
audit_log (org-e2e): register_template_version ×1, sf-push
```

- **Not done here.** The CMS catalogue page and agent submission are later tickets (M3-16, Milestone 4). `/admin` still retires with M3-14 and OAuth grants; template registration moves to `/mcp` then.
