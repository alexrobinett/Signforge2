# M3-39 Brand in the player and SDK

Status: open  ·  Size: M  ·  Depends on: M3-32, M3-28, M3-38

## Goal

Templates draw with the brand: tokens as CSS custom properties, brand fonts and the logo. The proposal said "player unchanged"; that was wrong, since Blob URLs do not reach an opaque-origin frame (review, proposal point 5).

## Read first

- docs/proposals/brand-and-editor.md, packages/template-sdk, packages/player/src/slot.ts

## Scope

- The player passes `theme` in `init` (protocol 2), with fonts and logo as Blobs like `assets`.
- The SDK applies the theme before `prepare`: `--sf-primary`, `--sf-accent`, `--sf-bg`, `--sf-surface`, `--sf-text`, `--sf-muted`, `--sf-radius`, `--sf-font-display`, `--sf-font-body`; `@font-face` per brand font (the template CSP allows `blob:` fonts); `data-sf-src="$brand.logo"` gets the logo. `settle()` waits for the fonts.
- The token lint in `sf build` and the server template check: colours come from `var(--sf-*)` or are built on them; a literal outside a `var()` fallback is a warning, not a failure (shadows, scrims and weather use literals legitimately).

## Done when

- [ ] Browser test: a template using every token and a brand font renders with the brand values, and with its fallbacks when no theme is sent.
- [ ] A brand font adds no more than the prepare budget on the Pi (measured).
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
