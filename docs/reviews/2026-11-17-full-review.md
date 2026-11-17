# Full review, 2026-11-17 (master @ ff684e0)

Two independent reviews of the whole repository: GPT Astra (OpenAI) and Fable (Anthropic), same brief. This is the combined picture; file:line references are in the reviewers' own reports.

## Verdicts

- **Astra:** "A credible flagship with unusually good hardware evidence and sensible boundaries. It is not yet product-standard under hostile content, partial failure, or concurrent updates." Fix foundations before CMS breadth.
- **Fable:** "The tenancy boundary is designed and tested better than most production codebases, and the performance claims are measured on the target device." The weak points are where the milestones have not reached yet. The player trusts its own updates and manifests too much. The contract is missing shapes the next tickets need. There is no draft state.

Neither found a way across orgs. Both praise the tenancy design, the generated isolation test, the auth handling, and the Pi measurements.

## Where they agree (do these)

| # | Finding | Astra | Fable |
| --- | --- | --- | --- |
| A1 | **A template can escape its no-network rule by navigating itself.** The CSP is a meta tag that dies with the document. The second-`load` check fires too late, or never. | High | Medium (high before agent templates) |
| A2 | **Cache cleanup races a spot preparing under the old manifest**, so a spot can be skipped. | Medium | Low |
| A3 | **`finalize_asset` can mark an asset verified with no renditions.** The rows are written separately. | Medium | Low |
| A4 | **One broken or unfinished spot blocks every screen's publish.** The compiler checks the whole org, and there is no draft state. | Medium | Architecture |
| A5 | **Runtime validation is weaker than the types.** Malformed input can throw; number min/max are ignored. Validation sits in player-core but the server imports it. | Medium | Architecture |
| A6 | **The contract lacks shapes the sync work needs.** Snapshot `version`; a clock in `init`, since templates call `new Date()` and miss server-time correction; recovery rules for `seq` and the clock without an RTC; absolute expiry for takeovers. | Medium | Architecture |
| A7 | **Testing is thin where the risk is:** playback loop, slots, data loop, SDK, iframe lifecycle, service worker. The CMS e2e is not in the root test run. | Quality | Quality |
| A8 | **Docs have drifted:** bundle limit "undecided", "templates report done", images resized at publish, the architecture doc stopping at M2. | Low | Quality |
| A9 | **Brand proposal: right direction, wrong mechanics, too much scope.** See below. | | |

## Found by one reviewer, checked and worth doing

- **Malformed live data replaces a valid fallback and survives offline** (Astra). `items: {}` makes the news template throw. Validate bound values against the field definition.
- **A player update can blank an offline screen** (Fable). The cached manifest is dropped if it fails the newer validator, and only schema 2 is supported. Keep the last playable cache, and support the previous schema.
- **No last-known-good** (Fable). A manifest that validates but whose spots all fail leaves "Content is unavailable" until someone republishes.
- **Change without audit** (Astra). The audit row is written after the change; if it fails, the caller sees an error and may retry, which can duplicate a creation. Batch the change with its audit row, and add idempotency keys.
- **Decode budget** (Astra). An image passes if one side fits, so a 65,535×1,080 PNG costs about 270 MB to decode. Add a pixel-count cap.
- **`dev` is the default deploy environment** (Fable). A bare `wrangler deploy` would ship the known dev auth secret and log codes instead of emailing them. Only the placeholder database id stops it.
- **Device blobs are `cache-control: public`** although they need the credential (Fable). Use `private`.
- **The player has one content transport** (Fable). The demo and the editor preview run on the CMS origin, so they need a content-source seam and a user-side blob route.
- **Tools have no output schemas or pagination** (Fable). Fix the convention before the editor adds many tools.
- **Hygiene** (Fable):
  - no README, CI or linter;
  - `.pyc` files committed;
  - the stress golden test skips silently without media;
  - the "temporary" `/admin` tree keeps growing.
- **Downloads buffer whole files in memory**, which matters for video (Fable).

## The brand and editor proposal

Both say the three-layer model is right. Their changes:

1. **Scope:**
   - one brand kit per org, modelled as a table with a default so more is not a migration later;
   - curated fonts, not uploads;
   - no re-theming of the CMS by tenant brand in v1;
   - Fable also cuts `seek`, `field-clicked` and `notice` from v1.
2. **Freeze branding at publish:** editing the kit must not change live screens until a publish.
3. **One theme path:** the compiler resolves token defaults into field values, and spot overrides are ordinary fields.
4. **Updating a live template is a defined lifecycle, not re-sending `init`.** Today list templates append rows again, and weather accumulates effects. Reload the frame on a debounce, or have the SDK restore a clean snapshot.
5. **Fonts need a player change.** Blob URLs do not reach an opaque-origin frame. Pass Blobs the way `assets` are passed, and allow `blob:` fonts. The proposal's "player unchanged" is wrong, and the change needs a schema bump, which depends on the offline-update fix above.
6. **The preview channel is a new inbound surface:** gate it on origin and on being framed by the CMS.
7. **The colour lint should warn, not fail:** shadows, scrims and weather legitimately use literals.

## Recommended order

Both put foundations before CMS breadth. Merged:

1. **Player resilience.**
   - Contain template navigation (A1). Fable suggests a same-origin wrapper frame with `frame-src 'none'`; verify on the Pi.
   - Keep the last playable manifest and support the previous schema.
   - Pin files for in-flight spots (A2).
   - Validate live data before it replaces fallbacks.
   - Add browser tests for these.
2. **Contract fixes, in one commit:**
   - snapshot `version`;
   - a clock in `init`;
   - frame protocol 2 with a defined template update lifecycle;
   - absolute takeover expiry;
   - a `seq` epoch;
   - full runtime schemas in the contract;
   - a decoded-pixel cap.
3. **Write safety:**
   - each change batched with its audit row;
   - idempotency keys;
   - assets written in one batch;
   - finalize requiring both renditions.
4. **The screen path: M3-06 to M3-08** (socket, sync, pairing). This retires polling, `/admin` and hand-installed credentials.
5. **The publish model:**
   - where the default playlist lives;
   - drafts, so broken spots stay out of publishes;
   - the database-to-compiler loader;
   - tool output schemas and pagination.
6. **Hygiene, pulled forward from M3-24:**
   - README, CI and lint;
   - `dev` as an explicit opt-in;
   - `private` blobs;
   - `.pyc` removed;
   - docs brought current.
7. **Then the brand migration (M3-25) and the editor (M3-16), on the trimmed proposal.**
