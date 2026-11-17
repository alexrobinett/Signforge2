# SignForge 2

Digital signage: a CMS publishes immutable manifests, and an offline-first web player on a Raspberry Pi 4 plays them. `docs/architecture.md` is the design; scripts live in `package.json`.

## Rules that are not written down elsewhere

- **The contract leads.** `packages/contract` defines every shape a screen sees. The backend produces exactly that; when a change needs a new shape, change the contract first and in its own commit.
- **The Pi sets the budget.** Performance claims are measured on the Pi 4 at 1080p 60 Hz, not on a laptop: a Mac draws every template at 0% dropped frames and hides regressions. Template and player changes that touch rendering need a Pi measurement (`device/pi/isolate.py`), with numbers in the PR. The measured rules are in `docs/template-spec.md`.
- **Screens are untrusted territory and so are templates.** Templates run sandboxed with no network; URL spots are https pages on another origin; the device supervisor acts only with its token. Keep those boundaries when touching the player, SDK or device scripts.
- **Org isolation lives in one place.** Only `packages/db`'s scoped repositories touch tenant tables.
- **Docs are plain and current.** Update the doc a change makes wrong, in the same change.

## Backend work

Milestone 3 is cut into tickets: start at `docs/tickets/README.md`.
