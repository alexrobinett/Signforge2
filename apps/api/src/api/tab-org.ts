/**
 * The header in which a CMS tab names the org it shows (#129). The API refuses the call, with
 * `ORG_CHANGED`, when that is not the session's active org: the member switched org in another
 * tab. A caller with no tab (an agent, a script, the CLI) sends none. See `refuseOtherTabOrg` in ./index.ts.
 */
export const TAB_ORG_HEADER = 'x-signforge-org';

/** The refusal's `error` when the tab's org is not the session's (409). */
export const ORG_CHANGED = 'org_changed';
