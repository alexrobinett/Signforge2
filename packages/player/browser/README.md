# Player browser tests

The player and the template SDK tested where they can break: in headless Chromium, through Playwright, run by Vitest. `pnpm test` at the root runs them with everything else; `pnpm --filter @signforge/player test` runs only the player's.

Chromium, not the Pi: these tests check behaviour, not frame rates. Performance still needs a Pi measurement (`device/pi/isolate.py`).

## First run

The tests use Playwright's Chromium. If it is missing:

```sh
pnpm --filter @signforge/player exec playwright install chromium
```

## What runs

- `global-setup.ts` builds the player with Vite into a temporary directory (never `dist/player`) and bundles `fixtures/template.ts` with the real SDK into one HTML file. Every run tests the current source.
- `fixture-server.ts` serves the built player at `/`, content at `/content/` (manifest, blobs, data snapshots, all in memory), and a supervisor at `/supervisor/` that answers 404. A test can:
  - `publish(content)`: serve a new manifest; the player sees it at its next poll. A manifest poll whose `If-None-Match` names the current id gets a 304, as the API does.
  - `intercept(/path regex/, { status })` or `intercept(/path regex/, 'stall')`: fail a path, or send the headers and half the body and then nothing. Returns a function that removes the rule.
  - `setData(id, snapshot)`: serve a data source snapshot.
  - read `requests` / `requestsTo(regex)`: every request, its status, its `If-None-Match`, and `abortedAt` if the client gave up on it.
- `content.ts` builds a manifest in memory. Every spot uses the fixture template; its `mode` field picks the behaviour: `ok`, `throw` (throws in `prepare`), `hang` (never ready), or a hostile mode that tries to reach the spot's `target` URL (see `fixtures/template.ts`).
- `harness.ts` gives each test file one browser and each test a fresh context (empty Cache Storage, no service worker) and fixture server. `openPlayer` opens the player with `?poll=1`; `until(predicate)` waits on `window.__sf`; `onScreen()` reads the template drawn on top. Templates sit inside a wrapper frame (see Template containment in `docs/architecture.md`), so `page.frames()` lists two frames per template.

Testing-only query options the tests use: `?poll=<s>`, `?stall=<s>` (the download stall timeout, 30 s by default), `?spots=` and `?transition=` (see `src/main.ts`).

## Tests

| File | Covers |
| --- | --- |
| `playback.test.ts` | Two spots play in order and loop; a spot whose template throws in `prepare` is skipped; a template that never reports ready is skipped after the ready timeout |
| `sync.test.ts` | A stalled download is abandoned after the stall timeout and the player recovers; a 304 poll changes nothing; a new manifest is adopted at the next poll |
| `containment.test.ts` | Hostile templates (the `navigate`, `refresh`, `link`, `form`, `open`, `iframe`, `fetch`, `image`, `font` and similar fixture modes) make no request that reaches the server and no popup; the spot fails and the next one plays. The template frame has an opaque origin and cannot reach the player |
| `sdk.test.ts` | The SDK on its own: `loaded` → `init` → `ready` with data bound and animations held, `play` starts them; an error in `prepare` is reported; a `prepare` that never finishes never reports ready |

Protocol 1 has no `done` message: a spot ends when the player moves on.

## Adding a test

Put it in the file for its area, or a new `browser/<area>.test.ts`. Start with `const h = useHarness();` at the top of the file, then:

```ts
const content = h.content([{ id: 'a', durationMs: 600 }, { id: 'b', mode: 'throw' }]);
const p = await h.openPlayer((server) => server.publish(content), { stall: '1' });
const s = await p.until((s) => s.log.length >= 2);
expect(spotsPlayed(s)).toEqual(['a', 'a']);
```

Keep spots short (500 to 1000 ms) and wait on state, never on fixed sleeps. Break the behaviour by hand once and check the test fails.
