# Less slop: rules and tools that keep agent-written code lean

Researched 2026-11-17 on `m3-foundations` at `bc35dca`, plus the uncommitted `t3/cms-react-lint` worktree. Status: research, not a decision. Each candidate ends with a recommendation for the owner to accept or reject. The ranked list is at the end.

"Slop" here means code that is over-commented, over-abstracted, duplicated, overly defensive, dead or inconsistent, or full of needless type assertions, wrappers and fallbacks.

Claims are tagged **[verified]** (checked this session against the source linked beside it), **[measured]** (I ran the tool on this repo this session, read-only, with the command or setup described), **[vendor]** (a vendor's claim about its own product), **[unverified]** (not confirmed against a primary source this session), or **[judgement]** (my own reading, with no source behind it). Every link is listed again at the end.

## Summary

- **Much of the worth lies in Biome rules the repo already has installed but has not switched on.** Biome 2.6.5 ships type-aware rules for floating promises, exhaustive switches and needless assertions. They find almost nothing in the repo today, so they cost nothing to turn on, and they stop agents adding those patterns later [measured].
- **Typed typescript-eslint cannot run on the repo's TypeScript.** The repo is on TypeScript 7.0.2, the Go port, which has no JavaScript compiler API. typescript-eslint 8.73 requires `typescript <6.1.0`. Support is being built against TypeScript 7.1 ([#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)) [verified]. The CMS branch works around this by aliasing `typescript` to `@typescript/typescript6`. So typed ESLint makes sense in the CMS now, not repo-wide.
- **The biggest structural source of `as` is "validate, then cast".** Contract validators return a list of problems. Callers then write `body as SyncRequest`. One `parse` shape in the contract would remove those casts at the edges. This is "parse, don't validate" applied to code that already exists [measured].
- **Dead code is the cheapest new tool.** knip ran in 1.3 s and found 63 unused exports and 1 unused dependency, plus some false positives that a small config removes [measured].
- **Size, magic-number and barrel-file rules would hurt more than they help here.** They fire hundreds of times. `noBarrelFile` flags every package's public `index.ts`, which is the very entry point the tenancy boundary test relies on [measured].
- **For agents, Anthropic's guidance draws one line:** put what Claude can't see in a short CLAUDE.md, and put zero-exception rules in hooks or CI ([Claude Code best practices](https://code.claude.com/docs/en/best-practices)) [verified]. Its sample "avoid over-engineering" prompt lists four slop types: scope, documentation, defensive coding and abstractions. It fits AGENTS.md almost word for word ([prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)) [verified].

---

## 0. What the repo already enforces

| Where | What | Source |
| --- | --- | --- |
| `tsconfig.base.json` | `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules` | repo |
| `biome.json` | Biome `recommended` preset, repo-wide. Off: `noNonNullAssertion`, `useTemplate`, `noCommaOperator`, `noVoidTypeReturn`, `noAssignInExpressions`, `useIterableCallbackReturn`, `noUndeclaredEnvVars`. `noExplicitAny` is allowed in tests and `packages/tools/src` | repo |
| CI (`.github/workflows/ci.yml`) | `pnpm typecheck`, `pnpm lint` (`biome lint .`), format check on changed files, `pnpm test`. **Warnings do not fail** (M3-37 notes); there are 2 today, an unused import and an unused type [measured] | repo |
| `packages/db/test/node/boundary.test.ts` | Fails if anything outside `packages/db` imports its table objects. This is the tenancy guard's second half | repo |
| `packages/tools/test/{isolation,conventions,write-guard}.test.ts` | Tests generated from the registry: cross-org access, output schemas and paging, writes outside `batch()` | `packages/tools/README.md` |
| `packages/contract/src/validate.test.ts` | fast-check feeds random JSON to every validator; none may throw | repo |
| `apps/cms/eslint.config.js` (branch `cms-react-lint`, uncommitted) | ESLint 10 with `typescript-eslint` parser only (untyped), `eslint-plugin-slop` 0.1.3 in `full` mode, `eslint-plugin-react-hooks` 7.1.1 `recommended`, and `no-restricted-imports` banning `useState`, `useEffect`, `useLayoutEffect`, `useInsertionEffect` | worktree |
| Biome suppressions | A `biome-ignore` with no reason is an error ("Reason is missing and can't be empty"), and an unused suppression is reported as `suppressions/unused` | [measured] on 2.6.5, scratch file |

Today's counts from grep over `apps/` and `packages/`, outside `node_modules` [measured]:

- 171 `as SomeType` assertions, excluding `as const`. 53 are in tests.
- 36 `as unknown as`, nearly all in tests.
- 61 non-null `!` assertions. The house style allows them.
- 3 empty `catch {}` blocks (CMS e2e setup ×2, `apps/cms/src/lib/theme.tsx`).
- 2 `biome-ignore` comments, both with reasons.

---

## 1. TypeScript compiler strictness beyond `strict`

What each flag does, from the [TSConfig reference](https://www.typescriptlang.org/tsconfig/) and the [5.8 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-8.html) [verified]. The repo already sets `noUncheckedIndexedAccess` and `verbatimModuleSyntax`.

The error counts come from `tsc -p <pkg> --noEmit --<flag>` over the 12 package tsconfigs on TS 7.0.2, deduplicated by file and line [measured]. The baseline has 0 errors.

| Flag | What it catches | New errors here | Recommendation |
| --- | --- | --- | --- |
| `noUncheckedIndexedAccess` (4.1) | `arr[i]` and `record[k]` typed as `T \| undefined` | already on | keep |
| `verbatimModuleSyntax` (5.0) | imports without `type` are kept, and `type` ones dropped, so no surprise elision | already on | keep |
| `noImplicitOverride` (4.3) | subclass methods must say `override` | 0 | **adopt now** (free) |
| `noFallthroughCasesInSwitch` (1.8) | a non-empty `case` with no `break`, `return` or `throw` | 0 | **adopt now** (free) |
| `noImplicitReturns` (1.8) | some code paths return a value and some don't | 6, all in `apps/api` (Hono handlers) | **adopt now** after fixing 6 |
| `noUnusedLocals` / `noUnusedParameters` (2.0) | unused locals and parameters | 2 / 0 | **skip**: Biome's `noUnusedVariables` and `noUnusedImports` already report these. Make Biome warnings fail instead (§3) |
| `exactOptionalPropertyTypes` (4.4) | `{ a?: string }` stops accepting `{ a: undefined }` | 73 repo-wide; **1 in `packages/contract`** | **adopt now in `packages/contract` only**; skip elsewhere |
| `noPropertyAccessFromIndexSignature` (4.2) | requires `o['k']` rather than `o.k` on index signatures | about 827, almost all in `contract/src/validate.ts` | **skip** |
| `erasableSyntaxOnly` (5.8) | `enum`, runtime `namespace`, parameter properties, `import =` | 26, all parameter properties (`constructor(private readonly log = false)`) | **adopt later**, only if code is ever run by Node's type stripping rather than tsx, esbuild or Vite |

Notes:

- `exactOptionalPropertyTypes` catches a real slop pattern: `{ field: maybe ?? undefined }` passed where "absent" was meant. The fix often adds its own noise, though, such as `...(x ? { a: x } : {})` [judgement]. It suits the contract, where "absent" versus "undefined" is part of what a screen receives. Applying it to callers that pass library objects (`RequestInit` and the like) mostly adds churn. Many of the 73 are in `apps/api` and `packages/tools`.
- `noPropertyAccessFromIndexSignature` would make the validators worse. `validate.ts` deliberately reads untrusted `Record<string, unknown>` objects with dot access after `isObj` [judgement].
- The TypeScript 6.0 release changed some defaults (`strict` on, `noUncheckedSideEffectImports` on, `types: []`), according to secondary coverage. I did not read the official announcement [unverified]. The repo sets its options explicitly, so this matters only for new tsconfigs.

---

## 2. typescript-eslint: `strict-type-checked` and `stylistic`

**What the sets are.** `strict-type-checked` contains `recommended`, `recommended-type-checked` and `strict`, plus strict rules that need type information. It is "not considered 'stable' under Semantic Versioning", so its rules can change in minor releases. The docs advise `strict` only if "a nontrivial percentage of its developers are highly proficient in TypeScript". `stylistic` holds best-practice rules "that do not impact program logic" ([shared configs](https://typescript-eslint.io/users/configs/)) [verified].

Five rules that matter for slop [verified]:

- **`no-unnecessary-condition`** (in `strict-type-checked`): conditions whose type is always truthy or always falsy. Suggestions only, no autofix. The docs recommend `noUncheckedIndexedAccess`, which the repo has, to avoid false positives on indexed access ([rule](https://typescript-eslint.io/rules/no-unnecessary-condition/)).
  ```ts
  // before: the manifest type says `templates` is required, so this fallback is dead
  Object.values(m.templates ?? {})
  // after
  Object.values(m.templates)
  ```
- **`no-unnecessary-type-assertion`** (in `recommended-type-checked`, autofix): an assertion that does not change the type ([rule](https://typescript-eslint.io/rules/no-unnecessary-type-assertion/)). For example, `const n = count as number;` becomes `const n = count;`.
- **`no-floating-promises`** (in `recommended-type-checked`): an unhandled promise statement. `void` is accepted by default, but "Voiding a Promise doesn't handle it" ([rule](https://typescript-eslint.io/rules/no-floating-promises/)). For example, `save();` becomes `await save();`, or `void save().catch(report);`.
- **`switch-exhaustiveness-check`** (in no preset; enable it by hand): a switch over a union with a case missing and no `default`. With `allowDefaultCaseForExhaustiveSwitch: false` it also flags a needless `default` on a switch that is already exhaustive, which is a typical defensive fallback ([rule](https://typescript-eslint.io/rules/switch-exhaustiveness-check/)).
- **`no-unsafe-*`** (`assignment`, `argument`, `call`, `member-access`, `return`; in `recommended-type-checked`): these stop an `any` from leaking into typed code ([rule](https://typescript-eslint.io/rules/no-unsafe-assignment/)).

**Cost.** "Running typed linting on a project is generally as slow as type checking that same project" ([performance](https://typescript-eslint.io/troubleshooting/typed-linting/performance/)) [verified]. I ran `strictTypeChecked` and `stylisticTypeChecked` with `projectService` over `apps/cms/src` in the worktree: 39 files, about 1,700 lines [measured]. It took **2.3 s, against 0.5 s for the current untyped config**, and found 39 problems:

- 23 `no-confusing-void-expression`. This is noise for arrow-bodied handlers [judgement].
- 8 `no-non-null-assertion`. This conflicts with the house style, which turned off Biome's equivalent.
- 3 `no-deprecated`: React's `FormEvent`. These are real.
- 2 `only-throw-error` on TanStack's `throw redirect(...)`. These are false positives; the rule has an `allow` option for this ([rule](https://typescript-eslint.io/rules/only-throw-error/)) [verified].
- 1 `no-unnecessary-condition`, 1 `prefer-nullish-coalescing` and 1 `restrict-template-expressions`, not triaged.

**Fit.** Repo-wide it is blocked by TypeScript 7 (see the Summary). The issue was unblocked on 2026-09-11. PR #12803 for TypeScript 7.1 was awaiting team review on 2026-09-29, and the author expects no large speed-up from it [verified, issue thread]. The CMS can use it today, because its worktree already pins TS 6 for ESLint.

The alternative for TypeScript 7 is **Oxlint with tsgolint**. Its stable v7 "tracks TypeScript v7.0.2", the repo's exact version. It covers 59 of typescript-eslint's 61 type-aware rules and reports 12 to 18× faster than ESLint with typescript-eslint on four large repos ([Oxc blog](https://oxc.rs/blog/2026-07-22-type-aware-linting-stable)) [vendor]. I did not run it here.

**Recommendation.**

- **Adopt now, in the CMS only:** a short list of typed rules rather than the full preset:
  - `no-floating-promises`;
  - `no-misused-promises`;
  - `no-unnecessary-condition`;
  - `no-unnecessary-type-assertion`;
  - `switch-exhaustiveness-check` with `allowDefaultCaseForExhaustiveSwitch: false`;
  - `only-throw-error` with `allow` for TanStack's `redirect` and `notFound`;
  - `no-deprecated`.

  Cost: about 2 s of CI time.
- **Adopt later:** repo-wide typed linting, once typescript-eslint supports TypeScript 7.1, or after a trial of Oxlint with tsgolint.
- **Skip:** full `strict-type-checked` plus `stylistic`. The noisiest rules fight house style.

---

## 3. Biome rules not yet on

All rules below are in the installed 2.6.5 (`node_modules/@biomejs/biome/configuration_schema.json`). The counts come from `biome lint --only=<group/rule> .` over the whole repo, 448 files [measured]. Each run took 0.25 s for a syntax rule and about 0.45 s for a type-aware one. Type-aware rules belong to Biome's `types` domain. Enabling one "will activate the Biome Scanner ... and enable the type inference engine" ([noFloatingPromises](https://biomejs.dev/linter/rules/no-floating-promises/)) [verified]. Biome's own early figure is that its inference finds "about 75% of the cases" typescript-eslint finds ([Biome v2](https://biomejs.dev/blog/biome-v2/)) [vendor].

| Rule (group) | Catches | Hits here | Notes | Recommendation |
| --- | --- | --- | --- | --- |
| `noFloatingPromises` (nursery) | `save();` with no `await` or handling | 0 | unsafe fix: add `await` | **adopt now** |
| `noMisusedPromises` (nursery) | a promise used as a condition | 1 info: `running ? running.then(...)` in `player/src/data.ts:152`, an existence check (false positive) | | **adopt now**, rewrite that line as `running !== undefined ?` |
| `useExhaustiveSwitchCases` (nursery) | a union switch missing a case | 0 | fixable | **adopt now** |
| `useAwaitThenable`, `noUselessAwait` (nursery) | `await` on a value that isn't a promise | 0 / 0 | | **adopt now** |
| `noUselessTypeAssertion` (nursery) | `x as T` where `x` is already `T` | 6, all in tests | fixable | **adopt now** |
| `noUnsafeTypeAssertion` (nursery) | any `as T` that narrows | 399 (208 outside tests; `db/src/scoped.ts` 32, `contract/src/validate.ts` 20, `player/src/main.ts` 12) | this is the "ban `as`" rule; see §15 | **adopt now with an allow-list** (§15) |
| `noUnnecessaryConditions` (suspicious) | always-truthy or always-falsy checks, needless `??` | 36 | Of a sample of 10, 3 were true slop: `m.templates ?? {}`, `m.files ?? {}`, `m.dataSources ?? {}` on required fields in `apps/api/src/device/manifests.ts`. 7 were false positives: class fields initialised to `''` or `false` and changed in other methods (`player/src/credential.ts`, `socket.ts`) | **adopt later** as a warning; in the CMS prefer typescript-eslint's version |
| `noImportCycles` (suspicious) | import cycles | 3 diagnostics, one cycle: `contract/src/index.ts` ↔ `validate.ts` | | **adopt now** after breaking the cycle |
| `useErrorCause` (style) | `catch (e) { throw new Error('x') }` without `{ cause: e }` | 4 | no fix | **adopt now** (§10) |
| `noExcessiveCognitiveComplexity` (complexity) | deeply nested functions (default max 15, Sonar's algorithm) ([rule](https://biomejs.dev/linter/rules/no-excessive-cognitive-complexity/)) | 50 functions; 11 score ≥ 30. Top: `validateManifest` 153, `player/src/main.ts:385` 59, `cli/src/sf.ts:210` 58 | see §11 | **adopt later**, as a report, not a gate |
| `noBarrelFile` (performance) | files that only re-export | 11: every package's `src/index.ts` | these are the public entry points `boundary.test.ts` depends on | **skip** |
| `noNamespaceImport` (performance) | `import * as x` | 3 | | **skip** |
| `noMagicNumbers` (style) | bare numeric literals | 1,375 | | **skip** (§8) |
| `noExcessiveLinesPerFunction` (complexity) | long functions | 58 | | **skip** (§8) |
| `noExportedImports` (style) | re-exporting an import | 6 | | **skip** |

Two settings that cost nothing:

- **Fail on warnings.** `biome lint --error-on-warnings` "exits with an error status if any warning diagnostics are emitted" [measured, `biome lint --help`]. Today CI passes with 2 warnings (an unused import and an unused variable), so dead locals can pile up. **Adopt now**: fix the 2 and add the flag to `pnpm lint`.
- **Nursery rules can change between releases.** The repo pins Biome exactly (`"@biomejs/biome": "2.6.5"`), so a rule only changes when someone upgrades [judgement].

---

## 4. Dead code and unused dependencies: knip, and ts-prune's status

**knip** reports "unused dependencies, exports and files" ([getting started](https://knip.dev/overview/getting-started)) [verified]. It has plugins for Vite, Vitest, Playwright, Wrangler, Drizzle, TanStack Router, Biome, ESLint and Turborepo ([plugin list](https://knip.dev/reference/plugins)) [verified]. `--fix` removes the `export` keyword and unused dependencies, and deletes files only with `--allow-remove-files` ([auto-fix](https://knip.dev/features/auto-fix)) [verified]. `--production` drops tests and devDependencies from the analysis ([production mode](https://knip.dev/features/production-mode)) [verified].

```ts
// before: exported for nobody (knip: unused export)
export const PING_MS = 25_000;
// after
const PING_MS = 25_000;
```

**Measured** (knip 6.45.1, from a scratch install; config only ignores `spike/**`): **1.3 s**. It found:

- 63 unused exports, such as `CMS_ORIGIN`, `READY_TIMEOUT_MS`, `PING_MS`, `STALL_MS`, `sendCommand` and `TICKET_TTL_MS`;
- 3 unused exported types;
- 1 unused dependency (`packages/cli` → `@signforge/player-core`);
- 12 unused devDependencies, 6 of them `@fontsource-variable/inter` in templates;
- 5 unused files.

At least two of the files are false positives: `packages/player/public/sw.js` is served as a static file, and `apps/api/auth.config.ts` is read by the Better Auth CLI. The template font devDependencies were not triaged. The first run failed until `spike/m3-platform` was ignored, because its Vitest config reads a missing `./migrations`.

**Fit.** It is good. Agents leave exports behind when they refactor, and nothing in the repo reports them. Tests count as entry files, so an export used only by a test is not reported.

**ts-prune.** Search results quote an older README that put it in maintenance mode and recommended knip; I did not read that version [unverified]. The repository was "resurrected after a long hiatus" (last push 2026-10-31, not archived). But the newest npm release is still 0.10.3 from 2021-12-12, and it only finds unused exports [verified via `gh api` and `npm view`].

**Recommendation.** **Adopt knip now:** a `knip.json` listing entry files for the static `sw.js`, `auth.config.ts` and the test harness workers, and a CI step. **Skip ts-prune.**

---

## 5. Duplication: jscpd and sonarjs

**jscpd** finds "duplicated token sequences across files with a rolling Rabin-Karp hash", using the oxc parser for TS and TSX. `--threshold` fails when duplication of the whole tree exceeds a percentage ([README](https://github.com/kucherenko/jscpd)) [verified].

**Measured** (jscpd 5.4.3, default token settings, `apps` and `packages`, excluding generated files): **0.1 s**. 207 files and 25,473 lines; **23 clones, 179 duplicated lines (0.70%)**. 15 clones are in tests. The 8 in source are:

- `cli/src/push.ts` ↔ `cli/src/template-push.ts`;
- three pairs within `db/src/schema.ts`;
- three within `db/src/scoped.ts`;
- one within `tools/src/assets.ts`.

```ts
// before: two copies of a fetch-with-retry block in push.ts and template-push.ts
// after: one function both call (only if the two really must stay in step)
```

**Noise.** Schema and repository code repeats on purpose: one column block per table [judgement]. Because the threshold is a whole-tree percentage, a new 30-line copy moves it by about 0.1 point. So the gate catches large copy-paste, not small.

**sonarjs** (`eslint-plugin-sonarjs` 4.2.2, LGPL-3.0-only, 215 rules) has one `recommended` config that "enables most of the rules" [verified, npm README]. Its rules for duplication and dead logic are all in `recommended`:

- `no-identical-functions`;
- `no-duplicated-branches` and `no-all-duplicated-branches`;
- `no-identical-conditions`;
- `no-gratuitous-expressions`;
- `no-dead-store`;
- `no-redundant-jump`;
- `no-ignored-exceptions`.

`cognitive-complexity` is also included. It would run only in the CMS, which is ESLint's only home, and Biome already covers much of this.

**Recommendation.**

- **Adopt jscpd now** as a CI gate at `--threshold 1`. It is 0.70% today.
- **Adopt sonarjs later, if at all**, and then only `no-identical-functions`, `no-duplicated-branches` and `no-ignored-exceptions` in the CMS, not `recommended`.

---

## 6. Module boundaries: "only packages/db touches tenant tables" and "contract leads"

The tenancy rule is already enforced by `packages/db/test/node/boundary.test.ts`, using regex over import specifiers. It is a test rather than a lint, which is fine: it runs in `pnpm test`.

**Turborepo boundaries** (experimental: "This feature is experimental") checks two things. It flags imports of files outside the package's directory, and imports of packages not declared in `package.json`. Tags can `allow` or `deny` dependencies and dependents ([reference](https://turborepo.dev/docs/reference/boundaries)) [verified].

**Measured:** `npx turbo boundaries` (turbo 2.11.11, already installed) took **0.28 s** and found 10 issues in 245 files across 20 packages:

- 7 cases of "cannot import package `vitest` because it is not a dependency", where a package relies on the root's Vitest;
- 3 relative imports that leave the package: `apps/api/vitest.config.ts` → `packages/compiler/src/fonts.ts`, and two test fixtures.

A sketch, not tested. The `app` and `lib` tags would have to be added to the other packages' `turbo.json` [judgement]:

```jsonc
// packages/contract/turbo.json: the contract depends on no workspace package
{ "tags": ["contract"] }
// turbo.json
{ "boundaries": { "tags": { "contract": { "dependencies": { "deny": ["app", "lib"] } } } } }
```

**dependency-cruiser** validates imports against `forbidden` rules with `from` and `to` path patterns; `--init` adds circular, orphan and missing-dependency rules ([README](https://github.com/sverweij/dependency-cruiser)) [verified]. It could replace the regex test, with a rule from `^(?!packages/db/)` to `packages/db/src/schema`. That duplicates a test which already works.

**eslint-plugin-boundaries** classifies files into element types by path, and reports dependencies that no policy allows ([docs](https://www.jsboundaries.dev/docs/overview/)) [verified]. It needs ESLint across the repo, which this repo does not have.

**"Contract leads"** is about commit order, not imports, so no import checker sees it. A small CI script can check it [judgement]: any commit that changes `packages/contract/src/**` must change nothing outside `packages/contract`.

**Recommendation.**

- **Adopt turbo boundaries now:** fix the 10 issues, add `turbo boundaries` to CI, and add a `contract` tag that may depend on no workspace package.
- **Adopt the "contract commit stands alone" script now.**
- **Skip dependency-cruiser and eslint-plugin-boundaries** while `boundary.test.ts` covers the tenancy rule.

---

## 7. eslint-plugin-unicorn

There are "more than 300" rules, each marked for its `recommended` or `unopinionated` config ([README](https://github.com/sindresorhus/eslint-plugin-unicorn)) [verified]. The slop-relevant subset, all autofixable unless noted, is:

- `no-useless-undefined`, `no-useless-spread`, `no-useless-fallback-in-spread`, `no-useless-promise-resolve-reject`;
- `no-lonely-if`, `prefer-optional-catch-binding`, `no-unnecessary-await`;
- `throw-new-error`, `error-message` (no fix), `no-useless-error-capture-stack-trace`;
- `consistent-function-scoping` (no fix).

```ts
// before (no-useless-fallback-in-spread)
const opts = { ...(input ?? {}) };
// after
const opts = { ...input };
```

**Fit.** It is poor. ESLint runs only in the CMS, and Biome already has most of these: `noUselessUndefined`, `noUselessCatchBinding`, `noUselessSwitchCase`, `noUselessTernary`, `noUselessFragments` and `noUselessRename` all exist in 2.6.5 [measured, schema]. The opinionated half (`no-null`, `no-array-reduce`, `no-for-each`, `name-replacements`) would fight house style [judgement].

**Recommendation.** **Skip.** Revisit `consistent-function-scoping` for the CMS if components start defining helpers inline.

---

## 7b. eslint-comments: a reason on every disable, no stale disables

`@eslint-community/eslint-plugin-eslint-comments` has these rules ([require-description](https://eslint-community.github.io/eslint-plugin-eslint-comments/rules/require-description.html)) [verified]:

- `require-description` "warns directive comments without description", where the description follows `--`;
- `no-unlimited-disable`;
- `disable-enable-pair`;
- `no-unused-enable`;
- `no-restricted-disable`.

ESLint itself reports unused disable directives through `linterOptions.reportUnusedDisableDirectives`, which "defaults to `"warn"`" ([configuration files](https://eslint.org/docs/latest/use/configure/configuration-files)) [verified].

```ts
// before: no reason, and it outlives the code it excused
// eslint-disable-next-line react-hooks/refs
// after
// eslint-disable-next-line react-hooks/refs -- the ref is read in the event handler, not during render
```

**Fit.**

- **Biome already covers the other 90% of the repo.** A `biome-ignore` with no reason is an error, and an unused one is reported (§0, [measured]).
- **Only the CMS's ESLint lacks both.** Its config sets neither option, so an unused disable is a warning and a reason is optional.

**Recommendation.** **Adopt now in the CMS:** `linterOptions: { reportUnusedDisableDirectives: 'error' }`, plus `eslint-comments/require-description` and `no-unlimited-disable`. That is one devDependency and no findings today. The CMS's only `eslint-disable` is in the generated, ignored `routeTree.gen.ts`.

---

## 8. Comments and size

**Comments that restate code.** No linter judges whether a comment adds anything. The closest proxies are already in the CMS through `eslint-plugin-slop` 0.1.3 [verified, shipped README]:

- `max-comment-length` (50 words);
- `no-jargon`;
- `prefer-jsdoc`;
- `no-trivial-functions`, against wrappers used fewer than 5 times;
- `no-trivial-type-aliases`;
- `no-static-only-class`;
- `no-chained-type-assertions`;
- `no-em-dash`.

```ts
// before: restates the code, and is caught by no rule
// Increment the counter by one
count += 1;
// after: no comment, or one that says why
```

**Magic numbers.** ESLint's `no-magic-numbers` is frozen ("not accepting feature requests") and flags numbers "without an explicit meaning" ([rule](https://eslint.org/docs/latest/rules/no-magic-numbers)) [verified]. Biome's `noMagicNumbers` fires **1,375** times here [measured]. Most hits are pixel sizes, timeouts already named in a nearby constant, and test values.

**Size limits.** `max-lines-per-function` defaults to 50 and counts comment lines unless `skipComments` is set ([rule](https://eslint.org/docs/latest/rules/max-lines-per-function)) [verified]. So it pushes against explanatory comments. Biome's `noExcessiveLinesPerFunction` fires 58 times [measured]. Ousterhout's second edition adds a comparison with *Clean Code*, noting "significant differences of opinion on topics such as the length of methods and the role of comments" ([book page](https://web.stanford.edu/~ouster/cgi-bin/book.php)) [verified].

**Help or hurt.** Here they hurt [judgement]:

- A length cap makes an agent split one readable function into several shallow ones. That is the over-abstraction this note is trying to remove.
- A magic-number rule makes it add `const ONE = 1`.
- The repo's comments explain why (see `validate.ts`'s header), which is the kind worth keeping.

**Recommendation.**

- **Keep the slop rules in the CMS.**
- **Adopt later:** a second, untyped ESLint run of only `eslint-plugin-slop` across `apps/` and `packages/`. It took 0.5 s on the CMS, and the cost scales roughly with file count [measured].
- **Skip** magic-number and size rules.

---

## 9. Validation at the edges: parse, don't validate

"The difference between validation and parsing lies almost entirely in how information is preserved." The advice is to push "the burden of proof upward as far as possible, but no further", and to get data "into the most precise representation you need as quickly as you can" ([Alexis King](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/)) [verified].

**Where the repo stands.** M3-31 put full runtime checks in `packages/contract/src/validate.ts`. Each returns `string[]` and never throws, and fast-check tests that. That is validation: the caller learns the value is fine, but the type system doesn't. Every caller then casts [measured]:

```ts
// before: apps/api/src/device/sync.ts (and admin/index.ts with ScreenManifest)
const problems = validateSyncRequest(body);
if (problems.length) return c.json({ error: 'invalid sync request', problems }, 400);
const req = body as SyncRequest;

// after: the contract owns the cast, once
export type Parsed<T> = { ok: true; value: T } | { ok: false; problems: string[] };
export const parseSyncRequest = (v: unknown): Parsed<SyncRequest> => {
  const problems = validateSyncRequest(v);
  return problems.length ? { ok: false, problems } : { ok: true, value: v as SyncRequest };
};
// caller
const r = parseSyncRequest(body);
if (!r.ok) return c.json({ error: 'invalid sync request', problems: r.problems }, 400);
const req = r.value;
```

The same pattern appears for template manifests read from D1: `JSON.parse(v.manifestJson) as TemplateManifest` in `tools/src/publishing.ts` and `templates.ts`. `packages/tools` already parses tool input and output with zod, so the tool boundary is fine.

**Cost.** One small function per validator, in the contract. Callers lose a line each.

**Fit.** It is direct. The contract changes first, in its own commit, as AGENTS.md requires. It also gives §15's `as` ban an obvious allow-list: `packages/contract/src/parse.ts`.

**Recommendation.** **Adopt now.**

---

## 10. Errors: no swallowing, no catch-all fallbacks

Rules that apply:

- **`preserve-caught-error`** (ESLint 9.35+, in `@eslint/js` `recommended`): requires `cause` when throwing a new error inside `catch`. `requireCatchParameter` forbids `catch {}` without a binding ([rule](https://eslint.org/docs/latest/rules/preserve-caught-error)) [verified]. The CMS config does not extend `@eslint/js` recommended today.
- **Biome `useErrorCause`** (style, since 2.3.12, no fix): the same rule for Biome. It has **4** hits here [measured].
- **Biome `noEmptyBlockStatements`**: 17 hits [measured], not triaged. grep finds 3 empty `catch {}` blocks (§0).
- **typescript-eslint `only-throw-error`**: only `Error` objects are thrown (§2).
- **sonarjs `no-ignored-exceptions`** (§5).

```ts
// before: the failure is gone, and the caller sees a default as if it were data
try { return JSON.parse(raw); } catch { return {}; }
// after: name what is expected and let the rest throw, or keep the cause
try { return JSON.parse(raw); } catch (e) { throw new Error('stored settings are not JSON', { cause: e }); }
```

Patterns [judgement]:

- Catch only where something can be done about the error. The tool dispatcher's `ToolError` and the player's fallback rules are the places that do.
- A fallback is a decision, so it belongs in a named function with a comment saying why the fallback is safe. Anthropic's sample prompt says the same: "Don't add error handling, fallbacks, or validation for scenarios that can't happen ... Only validate at system boundaries" ([prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#overeagerness)) [verified].
- The three `?? {}` on required manifest fields in §3 are the textbook case.

**Recommendation.**

- **Adopt now:** Biome `useErrorCause` (fix 4), and `preserve-caught-error` in the CMS.
- **Adopt later:** `noEmptyBlockStatements`, after triaging the 17.

---

## 11. Design: deep modules as a review lens

Ousterhout's *A Philosophy of Software Design* (2nd ed., 2021) argues for deep modules: a simple interface over a lot of functionality. Its second edition reworks the chapter "General-Purpose Modules are Deeper" ([book page](https://web.stanford.edu/~ouster/cgi-bin/book.php)) [verified]. The book's wording on deep and shallow modules was not re-read this session [unverified]. The repo already has a clear example: `scoped(db, orgId)` hides tenancy, staging and batching behind `org.<repo>.<op>`.

Agent slop is usually shallow: a wrapper that forwards its arguments, a "utils" file, or a type alias for `string` [judgement].

```ts
// before: shallow. The wrapper adds a name and nothing else
export const getScreen = (org: Org, id: string) => org.screens.get(id);
// after: call org.screens.get(id) where it is needed
```

**How to make it checkable.** These are proxies, not proofs:

- `slop/no-trivial-functions` and `slop/no-trivial-type-aliases`, already in the CMS;
- knip's unused exports (§4): an export nobody imports widens the interface for nothing;
- a script that counts exports per package entry and fails if it grows without a note in the PR [judgement];
- cognitive complexity reported, not gated.

`validateManifest` scores 153. Splitting it to pass a threshold would produce many single-use helpers, which is shallower, not deeper [judgement]. That is why §3 says "report".

**Recommendation.** **Adopt now as review questions** in the PR template or AGENTS.md:

1. Does this add a new export or a new module? What does it hide?
2. Could the caller have used what already exists?
3. Is each new function used more than once, or does it hide real complexity?

The checkable parts come from knip and the slop plugin.

---

## 12. Tests that catch weak tests: Stryker and property tests

**Stryker** mutates source and fails if tests still pass. Its Vitest runner always uses `perTest` coverage, and it forces one worker, no watch mode and no coverage. It supports only threads, and "Browser Mode is not supported" ([vitest runner](https://stryker-mutator.io/docs/stryker-js/vitest-runner/)) [verified]. Incremental mode stores results in `reports/stryker-incremental.json` and reruns only changed code and tests. Its example reused 3,731 of 3,965 mutants ([incremental](https://stryker-mutator.io/docs/stryker-js/incremental/)) [verified]. The runner's current release is 10.1.1, with peer `vitest >=2.0.0` [verified, npm].

```ts
// a test that runs the code but asserts too little; Stryker's surviving mutant shows it
it('validates', () => { validateManifest(sample); });                      // survives `return []`
it('validates', () => { expect(validateManifest(sample)).toEqual([]); });  // kills it
```

**Fit.**

- **Good targets:** `packages/contract` and `packages/player-core`. They are pure, run on plain Vitest, and hold the validators and schedule logic.
- **Poor targets:** `apps/api`, `packages/db`, `packages/tools` and `packages/feeds`. They run in workerd through `@cloudflare/vitest-plugin`. Whether Stryker's forced pool settings work with that pool was not checked [unverified].
- **Browser tests** in `packages/player/browser` are out.

The run time here was not measured.

**Property tests.** fast-check generates inputs, and "shrinks failures down to the smallest inputs that still reproduces them" ([intro](https://fast-check.dev/docs/introduction/)) [verified]. The repo uses it in exactly one file, `contract/src/validate.test.ts`. Round-trip properties fit what the repo already has [judgement]:

- `parse(serialise(x))` equals `x` for manifests;
- `canonicalJson` is stable under key order;
- the compiler output always passes `validateManifest`.

**Recommendation.**

- **Adopt later:** Stryker on `packages/contract`, run by hand or nightly with `--incremental`, not on every PR.
- **Adopt now:** one or two property tests for the compiler and player-core. These are tests, not tooling.

---

## 13. React: Compiler, effects and Zustand

- **React Compiler** is "stable and has been tested extensively in production". It "automatically applies the equivalent of manual memoization", and for new code the advice is to rely on it and use `useMemo` and `useCallback` only as escape hatches ([introduction](https://react.dev/learn/react-compiler/introduction)) [verified]. `babel-plugin-react-compiler` is at 1.0.0 on npm [verified, npm]. How it wires into `@vitejs/plugin-react` 6 was not checked [unverified].
- **`eslint-plugin-react-hooks` `recommended`** includes the compiler's diagnostics: `set-state-in-effect`, `set-state-in-render`, `purity`, `refs`, `immutability`, `static-components`, `use-memo` and more. They "can be used even if your app hasn't adopted the compiler yet" ([plugin](https://react.dev/reference/eslint-plugin-react-hooks)) [verified]. The CMS branch already enables this.
- **"You Might Not Need an Effect"** [verified, [react.dev](https://react.dev/learn/you-might-not-need-an-effect)]:
  - if a value can be calculated from props or state, calculate it during rendering;
  - reset state with a `key`;
  - put event-caused logic in the handler;
  - subscribe to outside stores with `useSyncExternalStore`.

  The CMS ban on `useEffect` enforces this mechanically. Zustand 5's hook is built on `React.useSyncExternalStore` [verified, `zustand/esm/react.mjs`].
- **Zustand** [verified]:
  - "We recommend using selectors when using either the properties or actions from the store" ([auto-generating selectors](https://zustand.docs.pmnd.rs/learn/guides/auto-generating-selectors)).
  - A selector re-renders when its output changes by `Object.is`; wrap selectors that build a new object or array in `useShallow` from `zustand/react/shallow` ([useShallow](https://zustand.docs.pmnd.rs/learn/guides/prevent-rerenders-with-use-shallow)).
  - Slices combine into one store, and "you should only apply middlewares in the combined store" ([slices](https://zustand.docs.pmnd.rs/learn/guides/slices-pattern)).
  - Colocating actions with state is "the recommended usage"; module-level actions are an alternative ([no store actions](https://zustand.docs.pmnd.rs/learn/guides/practice-with-no-store-actions)).

```tsx
// before: subscribes to the whole store, so it re-renders on every change
const s = useAppStore();
// after: a selector for what this component reads
const orgId = useAppStore((s) => s.orgId);
```

A `no-restricted-syntax` selector can ban the zero-argument call: `CallExpression[callee.name='useAppStore'][arguments.length=0]` [judgement; selector not tested].

**Recommendation.**

- **Adopt now:** the zero-argument store-call ban in the CMS ESLint config.
- **Adopt later:** the React Compiler itself. The lints already give most of the slop value, and the compiler is a build change to measure first.

---

## 14. Agent guidance: AGENTS.md and CLAUDE.md

What first-party docs say [verified]:

- **Two kinds of instruction.** Prompts, CLAUDE.md and skills are non-deterministic: the model "decides what to do with this information". Hooks, deny rules and CI are deterministic. "If something has to happen every time, make it a hook, a deny rule, or a managed setting. `CLAUDE.md` is for guidelines" ([best practices](https://code.claude.com/docs/en/best-practices)).
- **Keep CLAUDE.md short.** It should hold only what Claude can't work out from the code:
  - check commands;
  - misleading places;
  - decisions not in the repo;
  - "anything you've had to correct twice already".

  The memory guide recommends staying under 200 lines (same page).
- **Give it a check that comes back pass or fail.** Enforce it with a `Stop` hook, which sends Claude back to work while the script exits with code 2 (same page).
- **Review.** `/code-review` reviews in a fresh subagent. A warning applies directly to slop: "A reviewer that's asked to find problems will always find *something*. If you fix every finding, you end up with extra abstraction layers and tests for cases that can't happen." Hence the advice to tell reviewers "skip style" (same page).
- **The over-engineering prompt.** Claude Opus 4.5 and 4.6 "have a tendency to overengineer by creating extra files, adding unnecessary abstractions, or building in flexibility that wasn't requested". The sample prompt covers four areas:
  - Scope;
  - Documentation ("Don't add docstrings, comments, or type annotations to code you didn't change");
  - Defensive coding ("Only validate at system boundaries");
  - Abstractions ("Don't create helpers, utilities, or abstractions for one-time operations").

  A companion prompt warns against hard-coding to pass tests ([prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#overeagerness)).
- **AGENTS.md** is "a simple, open format for guiding coding agents". In a monorepo the nearest file wins, and the chat prompt overrides all files. Codex, Cursor, Gemini CLI, Copilot's agent and many other tools read it ([agents.md](https://agents.md/)).

**Fit.** This repo's AGENTS.md is already short and holds only what the code can't show, which is what the guidance asks for. It lacks the slop list and a deterministic check.

**Recommendation.** **Adopt now:**

1. A five-line "Keep it lean" section in AGENTS.md, adapted from the Anthropic sample: scope, comments, fallbacks only at boundaries, no single-use helpers, no `as` outside the allow-list.
2. A `Stop` hook in `.claude/settings.json` running `pnpm lint && pnpm typecheck`. This needs Claude Code; the user owns that settings change.

---

## 15. Review-time checks: a diff budget, and banning `any` and `as`

**Diff budget.** Google's review guide says "100 lines is usually a reasonable size for a CL, and 1000 lines is usually too large". It also says a 200-line change across 50 files is usually too large, and that refactors belong in their own CL ([small CLs](https://google.github.io/eng-practices/review/developer/small-cls.html)) [verified]. A CI step can count lines with `git diff --shortstat origin/<base>...HEAD`, excluding `pnpm-lock.yaml`, `*.gen.ts`, `docs/**` and golden fixtures. It warns over 1,000 and fails over a hard cap unless the PR has a `large-change` label [judgement; script not written]. Milestone branches such as `m3-foundations` are far over any cap by design. The check belongs on ticket PRs, not milestone merges.

**`any`.** Biome's `noExplicitAny` is already on, with overrides for tests and `packages/tools/src`. Nothing more is needed.

**`as` outside allow-listed places.** There are two ways, both in the installed Biome:

1. **`nursery/noUnsafeTypeAssertion`**, with 399 hits today (§3). Turn it on as an error, and use `overrides` to turn it off for an allow-list:
   - test files;
   - `packages/db/src/**`, where Drizzle row typing needs it;
   - `packages/contract/src/validate.ts`, plus the new `parse.ts` (§9);
   - the files that hold casts today, as a frozen list that only shrinks.
2. **A GritQL plugin**, if the nursery rule changes or a custom message is wanted. I tested this on 2.6.5 [measured]. It reported `JSON.parse(...) as number`, skipped `as const`, and honoured `includes`:

   ```grit
   language js(typescript);
   `$value as $type` where {
     $type <: not "const",
     register_diagnostic(span=$value, message="No type assertions here: parse with the contract, or annotate.", severity="error")
   }
   ```

   ```json
   { "plugins": [{ "path": "./biome/no-as.grit", "includes": ["apps/*/src/**", "packages/*/src/**", "!packages/db/src/**"] }] }
   ```

   Biome says plugins "only allow you to match code snippets and report diagnostics on them", and that "bugs are still expected" ([Biome v2](https://biomejs.dev/blog/biome-v2/), [GritQL reference](https://biomejs.dev/reference/gritql/)) [verified].

**Recommendation.**

- **Adopt now:** `noUnsafeTypeAssertion` with an allow-list that only shrinks.
- **Adopt later:** the diff budget, warning only at first.

---

## Ranked shortlist

Ranked by slop prevented per unit of cost and noise, for this repo as it is today [judgement]. "Hits" are from this session's runs.

| # | Candidate | What it catches | Cost | Recommendation |
| --- | --- | --- | --- | --- |
| 1 | `biome lint --error-on-warnings` in `pnpm lint` | unused imports, variables and types that pile up because warnings don't fail CI | fix 2 warnings; 0 s | **Adopt now** |
| 2 | Biome type-aware nursery rules: `noFloatingPromises`, `noMisusedPromises`, `useExhaustiveSwitchCases`, `useAwaitThenable`, `noUselessAwait`, `noUselessTypeAssertion` | unhandled promises, missing switch cases, needless `await` and `as` | 7 hits (6 autofixable, 1 false positive); about +0.2 s per lint | **Adopt now** |
| 3 | Contract `parseX()` returning `{ ok, value } \| { ok, problems }` | "validate then cast" at every edge (`body as SyncRequest`) | one function per validator, in its own contract commit | **Adopt now** |
| 4 | knip with a small config, in CI | unused exports (63), files, dependencies (1) | 1.3 s; a `knip.json` for static and CLI-loaded files | **Adopt now** |
| 5 | `nursery/noUnsafeTypeAssertion` with an allow-list that only shrinks | new `as` casts outside db, the contract validators and tests | 208 existing source hits frozen by path; new ones fail | **Adopt now** |
| 6 | AGENTS.md "Keep it lean" section, plus a Claude Code `Stop` hook running lint and typecheck | over-engineering, stray comments, needless fallbacks; "done" without passing checks | five lines; one hook | **Adopt now** |
| 7 | Typed typescript-eslint rules in the CMS: `no-floating-promises`, `no-misused-promises`, `no-unnecessary-condition`, `no-unnecessary-type-assertion`, `switch-exhaustiveness-check`, `only-throw-error` (allow TanStack), `no-deprecated`; plus `reportUnusedDisableDirectives: 'error'` and `eslint-comments/require-description` | needless conditions and casts, floating promises, deprecated React types (3 found), disables with no reason or no use | +1.8 s on CMS lint; uses the CMS's TS 6 alias; one devDependency | **Adopt now** |
| 8 | Error cause: Biome `useErrorCause`, ESLint `preserve-caught-error` in the CMS | rethrowing without the original error; swallowed causes | fix 4; no fix available | **Adopt now** |
| 9 | Free tsc flags: `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noImplicitReturns`; `exactOptionalPropertyTypes` in `packages/contract` only | missing returns, `{ a: undefined }` where absent was meant | fix 6 + 1 errors | **Adopt now** |
| 10 | `turbo boundaries` in CI, a `contract` tag, and a "contract commit stands alone" script | imports leaving a package, undeclared deps (10 found), contract changes mixed with consumers | 0.28 s; experimental feature, turbo already installed | **Adopt now** |
| 11 | Biome `noImportCycles` | import cycles (1 today, contract `index.ts` ↔ `validate.ts`) | break 1 cycle | **Adopt now** |
| 12 | jscpd `--threshold 1` in CI | large copy-paste blocks (0.70% today) | 0.1 s; one devDependency | **Adopt now** |
| 13 | Stryker on `packages/contract`, incremental, nightly or by hand | tests that run code but assert too little | run time not measured; workerd packages likely unsupported | **Adopt later** |
| 14 | Repo-wide typed lint: typescript-eslint once it supports TS 7.1, or Oxlint + tsgolint (tracks TS 7.0.2) | the §2 rules across API, db, tools and player | a second linter; vendor-reported 12–18× faster than typescript-eslint | **Adopt later** (trial) |
| 15 | CI diff budget (warn over 1,000 changed lines, `large-change` label override) | agent PRs that bundle refactors with features | a short script; noisy on milestone merges | **Adopt later**, warning only |

**Not recommended**, each with its reason above:

- full `strict-type-checked` plus `stylistic` (§2);
- `noBarrelFile` and `noNamespaceImport` (§3);
- `noMagicNumbers` and size limits (§8);
- a cognitive-complexity gate (§3, §11);
- `noPropertyAccessFromIndexSignature` (§1);
- unicorn (§7);
- sonarjs `recommended` (§5);
- ts-prune (§4);
- dependency-cruiser and eslint-plugin-boundaries while `boundary.test.ts` holds (§6).

## Open questions

1. Does Stryker's Vitest runner work under `@cloudflare/vitest-plugin`'s workerd pool? If not, mutation testing stays in the plain-Node packages.
2. Does Oxlint with tsgolint read this repo's per-package tsconfigs on TS 7.0.2 without changes, and what does it find against the §2 list? A one-hour trial answers both.
3. When does typescript-eslint's TS 7.1 support (PR #12803) ship, and does it need TS 7.1 itself, which the repo is not on?
4. Are the template `@fontsource-variable/inter` devDependencies really unused (knip), or loaded by CSS that knip does not follow?
5. How does the React Compiler plug into `@vitejs/plugin-react` 6, and what does it change in the CMS bundle size?

## Sources

**TypeScript**
- TSConfig reference: https://www.typescriptlang.org/tsconfig/
- TypeScript 5.8 release notes (`erasableSyntaxOnly`): https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-8.html
- TypeScript 6.0 defaults (secondary, unverified): https://www.infoq.com/news/2026/02/typescript-6-released-beta

**typescript-eslint and Oxlint**
- Shared configs: https://typescript-eslint.io/users/configs/
- Typed linting performance: https://typescript-eslint.io/troubleshooting/typed-linting/performance/
- `no-unnecessary-condition`: https://typescript-eslint.io/rules/no-unnecessary-condition/
- `no-unnecessary-type-assertion`: https://typescript-eslint.io/rules/no-unnecessary-type-assertion/
- `no-floating-promises`: https://typescript-eslint.io/rules/no-floating-promises/
- `switch-exhaustiveness-check`: https://typescript-eslint.io/rules/switch-exhaustiveness-check/
- `no-unsafe-assignment` (and the `no-unsafe-*` family): https://typescript-eslint.io/rules/no-unsafe-assignment/
- `consistent-type-assertions`: https://typescript-eslint.io/rules/consistent-type-assertions/
- `only-throw-error`: https://typescript-eslint.io/rules/only-throw-error/
- Issue #10940, TS 7 for type information: https://github.com/typescript-eslint/typescript-eslint/issues/10940
- Oxc, type-aware linting stable (tsgolint v7): https://oxc.rs/blog/2026-07-22-type-aware-linting-stable

**Biome**
- Biome v2 announcement (type inference, plugins): https://biomejs.dev/blog/biome-v2/
- `noFloatingPromises`: https://biomejs.dev/linter/rules/no-floating-promises/
- `noExcessiveCognitiveComplexity`: https://biomejs.dev/linter/rules/no-excessive-cognitive-complexity/
- Suppressions: https://biomejs.dev/analyzer/suppressions/
- GritQL reference: https://biomejs.dev/reference/gritql/
- Rule groups and names for 2.6.5: `node_modules/@biomejs/biome/configuration_schema.json`; `biome explain useErrorCause`; `biome lint --help`

**Dead code and duplication**
- Knip, getting started: https://knip.dev/overview/getting-started
- Knip, plugins: https://knip.dev/explanations/plugins and https://knip.dev/reference/plugins
- Knip, auto-fix: https://knip.dev/features/auto-fix
- Knip, production mode: https://knip.dev/features/production-mode
- ts-prune: https://github.com/nadeesha/ts-prune (npm `ts-prune` 0.10.3, 2021-12-12)
- jscpd: https://github.com/kucherenko/jscpd
- eslint-plugin-sonarjs (npm README): https://www.npmjs.com/package/eslint-plugin-sonarjs

**Boundaries**
- Turborepo boundaries: https://turborepo.dev/docs/reference/boundaries
- dependency-cruiser: https://github.com/sverweij/dependency-cruiser
- eslint-plugin-boundaries: https://www.jsboundaries.dev/docs/overview/

**ESLint rules and plugins**
- eslint-plugin-unicorn: https://github.com/sindresorhus/eslint-plugin-unicorn
- eslint-comments `require-description`: https://eslint-community.github.io/eslint-plugin-eslint-comments/rules/require-description.html
- ESLint configuration files (`reportUnusedDisableDirectives`, default `"warn"`): https://eslint.org/docs/latest/use/configure/configuration-files
- `no-magic-numbers`: https://eslint.org/docs/latest/rules/no-magic-numbers
- `max-lines-per-function`: https://eslint.org/docs/latest/rules/max-lines-per-function
- `preserve-caught-error`: https://eslint.org/docs/latest/rules/preserve-caught-error
- eslint-plugin-slop: https://github.com/antfu/eslint-plugin-slop (0.1.3 README as installed)

**Design, validation, tests**
- Alexis King, Parse, don't validate: https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/
- John Ousterhout, A Philosophy of Software Design (book page): https://web.stanford.edu/~ouster/cgi-bin/book.php
- Stryker, Vitest runner: https://stryker-mutator.io/docs/stryker-js/vitest-runner/
- Stryker, incremental mode: https://stryker-mutator.io/docs/stryker-js/incremental/
- fast-check introduction: https://fast-check.dev/docs/introduction/
- Google engineering practices, Small CLs: https://google.github.io/eng-practices/review/developer/small-cls.html

**React and Zustand**
- React Compiler introduction: https://react.dev/learn/react-compiler/introduction
- eslint-plugin-react-hooks: https://react.dev/reference/eslint-plugin-react-hooks
- You Might Not Need an Effect: https://react.dev/learn/you-might-not-need-an-effect
- Zustand, useShallow: https://zustand.docs.pmnd.rs/learn/guides/prevent-rerenders-with-use-shallow
- Zustand, slices pattern: https://zustand.docs.pmnd.rs/learn/guides/slices-pattern
- Zustand, auto-generating selectors: https://zustand.docs.pmnd.rs/learn/guides/auto-generating-selectors
- Zustand, practice with no store actions: https://zustand.docs.pmnd.rs/learn/guides/practice-with-no-store-actions

**Agent guidance**
- Claude Code best practices: https://code.claude.com/docs/en/best-practices
- Claude prompting best practices (Overeagerness): https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
- AGENTS.md: https://agents.md/
