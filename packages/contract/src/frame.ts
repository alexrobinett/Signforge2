/**
 * The contract's values a template bundle carries: the template SDK imports them from
 * `@signforge/contract/frame`, so that is all of the contract a bundle holds. Anything else here
 * would ride along in every template, and a change to it would change every bundle's bytes, which
 * needs a new version of every template (docs/template-spec.md). The frame protocol's types are in
 * `shapes.ts`: types leave nothing in a bundle.
 */

/**
 * The frame protocol this build of the SDK speaks. Stamped into every template bundle.
 *   1  init, play, stop
 *   2  adds `clock` and `theme` to init, and `reset`: a template can take new data without a reload
 */
export const PROTOCOL_VERSION = 2;

/** The CSS custom properties the SDK sets on a template's root from a theme. */
export const BRAND_CSS_VARS = {
  primary: '--sf-primary',
  onPrimary: '--sf-on-primary',
  accent: '--sf-accent',
  onAccent: '--sf-on-accent',
  background: '--sf-bg',
  surface: '--sf-surface',
  text: '--sf-text',
  muted: '--sf-muted',
  radius: '--sf-radius',
  fontDisplay: '--sf-font-display',
  fontBody: '--sf-font-body',
} as const;
