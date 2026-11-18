# Proposal: brand-aware templates and the live editor

Status: decided 2026-11-17 (see **Decisions** at the end); built through M3-38, M3-39, M3-25, M3-40 and M3-16. Built so far: brand kits (M3-38), the theme in the player and SDK (M3-39), every template on brand tokens (M3-25), and the spot editor's first PR, whose stage has a brand-kit switcher (M3-16). Not built yet: the CMS's brand kit pages (M3-40). It changes the contract and the template SDK, so it is decided before the CMS editor (M3-16) and before more templates are written.

## Where we are

- Templates hard-code their look: 43 colour literals across the seven `style.css` files.
- Four templates expose an `accent` colour field, each with its own default, and nothing ties them to the org.
- Fonts are the bundled Inter. There is no logo slot.
- The player sends a template its data, assets, duration, orientation, viewport, time zone and locale. It sends nothing about the brand.

## The model: three layers of look

1. **Brand kit (org).** The org's colours, fonts and logo, set once in the CMS. Every template, every spot and every screen picks it up, so a rebrand is one publish.
2. **Style fields (spot).** A template declares which parts of its look a spot may change: an accent, a layout variant, background dimming. A style field defaults to a brand token, not a hex value, so a spot that changes nothing stays on brand.
3. **Template code (org templates).** For anything beyond style fields, an org forks a base template into its own version. That is the agent and developer path, with review, in Milestone 4.

## Contract changes

**`BrandKit`**, carried in the manifest (one per screen, from its org):

```ts
interface BrandKit {
  colors: {
    primary: string; onPrimary: string;     // a filled button, a badge
    accent: string; onAccent: string;       // highlights, tags, the crawl's label
    background: string; surface: string;    // the page; cards and rows on it
    text: string; muted: string;            // body text; secondary text
  };
  fonts: { display: FontRef; body: FontRef }; // FontRef: { family, files: { weight, sha256 }[] }, or a bundled default
  logo?: { onDark: Sha256; onLight?: Sha256 }; // SVG or PNG asset
  shape?: 'square' | 'soft' | 'round';       // corner radius scale
}
```

`on*` colours are derived by the CMS for contrast (4.5:1 against their fill) unless set by hand. The CMS warns on any pair that fails.

**Template fields can default to a token:** `{ "type": "color", "label": "Accent", "default": "$brand.accent" }`. The compiler resolves tokens, so the screen only ever receives values. That keeps the player unchanged.

**`init` gains `theme`**: the resolved tokens for this spot (brand kit plus the spot's style overrides), and blob URLs for brand fonts and logo.

**The SDK applies the theme** before `prepare` runs:
- Each token becomes a CSS custom property on the root (`--sf-primary`, `--sf-accent`, `--sf-bg`, `--sf-surface`, `--sf-text`, `--sf-muted`, `--sf-radius`).
- Each brand font gets an `@font-face`, and `--sf-font-display` and `--sf-font-body` are set.
- Elements with `data-sf-src="$brand.logo"` get the logo.
- `settle()` already waits for fonts, so a brand font is drawn before `ready`.

**Template rule (lint, enforced by `sf build` and the server):** colours in `style.css` come from `var(--sf-*)`, or from `color-mix()` and gradients built on them. A literal colour is allowed only as the fallback inside `var()`, so a template still renders on its own. Weather is the one exception: sky and precipitation colours mean something in themselves and stay literal, with the brand used for text and panels.

**Pi cost.** Custom properties cost nothing per frame: they resolve once at style time. A brand font is one more decode at `prepare`, inside the 500 ms budget for one WOFF2 of normal size. The budget gains a font size cap (about 150 kB per family).

## The live editor

The preview is the **real player build** in an iframe, in a preview mode. It is not a re-implementation, so what the user sees is what the screen shows.

- **Instant edits.** The CMS posts the draft spot and theme to the preview. The player re-sends `init` to the live template frame, with no reload and no publish. Typing in a field updates the screen within a frame or two.
- **True aspect.** The preview renders at the screen's real resolution (1920×1080 or 1080×1920) and is scaled to fit with a CSS transform, so text wraps exactly as on the screen. It has a landscape/portrait toggle and a "fit / 100%" toggle.
- **Scrubbing.** A timeline under the preview shows the spot's duration. Dragging it seeks every animation to that moment, so intro and outro can be checked without waiting. New protocol message: `seek { ms }`. The SDK sets `currentTime` on every animation; templates already animate only through CSS, so this works for all of them.
- **Click to edit.** Clicking a headline in the preview focuses its field in the form. In preview mode the SDK reports which `data-sf` field was clicked (`field-clicked { field }`). It is off on screens.
- **Brand while editing.** Switching to another brand kit, or toggling a style override, re-themes the preview the same way.
- **Live data in the preview** uses the data source's latest snapshot. A "sample data" switch shows the static fallback, to check the empty state.
- **Checks next to the preview:**
  - text that the template had to clamp or drop ("2 headlines did not fit");
  - contrast warnings;
  - the template's duration range.
  - Templates report clamping through a new `notice` message.

Protocol: `seek`, `field-clicked` and `notice` are additions, so the frame protocol goes to 2. The player speaks 1 and 2 (`SUPPORTED_PROTOCOLS`), so published version-1 bundles keep working.

## CMS theming

- The CMS uses the same token names as templates (`--sf-*`), mapped onto shadcn's variables, in light, dark and system modes.
- The org's brand primary becomes the CMS accent when it passes contrast against the active mode; otherwise the CMS uses its own accent and shows the brand colour as a swatch.

## Order of work

1. Contract: `BrandKit`, token defaults, `theme` in `init`, protocol 2 messages. Done in its own commit with tests.
2. SDK: apply the theme; `seek`, `field-clicked` and `notice`.
3. Templates: move to tokens, and pass the new lint. Re-measure on the Pi, since nothing should get slower.
4. Compiler: resolve tokens and carry the brand kit. A `brand` tool group in the registry.
5. The CMS editor (M3-16) built on the above, in the direction chosen from the design concepts.

## Decisions for the owner

1. Is the three-layer model right (brand kit, style fields, forked templates), or should spots be able to override any colour?
2. One brand kit per org, or several (sub-brands, seasonal themes) chosen per screen group?
3. Should brand fonts be uploadable, or picked from a curated list of licensed open fonts? Uploads raise licensing questions for screens in public places.

## Decisions (owner, 2026-11-17)

Answers to the three questions, with the reviewers' changes from `docs/reviews/2026-11-17-full-review.md`. Where this section and the text above disagree, this section wins.

1. **Three layers: yes.** One theme path: the compiler resolves token defaults into field values, and a spot's override is an ordinary field value. Branding is frozen at publish.
2. **Several brand kits per org.** One is the default. A screen uses its own kit, else its group's, else the default; a screen in two groups with different kits and no choice of its own is a publish problem for that screen.
3. **Fonts: curated now, custom later.** Fonts come from a catalogue with an owner, like templates: `base` holds the curated open fonts. The id format leaves room for org uploads later (with a licence statement) without a migration.

Also changed from the text above:

- The player does change: fonts and logo reach the frame as Blobs, like `assets`, and the template CSP allows `blob:` fonts (M3-39).
- Updating a live template is a defined lifecycle (frame reload or SDK `reset`), not a re-sent `init` (M3-32).
- `seek`, `field-clicked` and `notice` are cut from v1 of the editor.
- The colour lint warns; it does not fail.
- The preview channel accepts messages only from the CMS origin, framed by it (M3-36).
- The CMS is not re-themed by tenant brand in v1.
