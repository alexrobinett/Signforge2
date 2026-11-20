/**
 * The API's refusal of a call from a tab whose org is no longer the session's (#129, `ORG_CHANGED`),
 * with its sentence telling the member to reload. `callApi` and `callTool` throw it; the router's
 * error page (src/components/route-error.tsx) shows it with a Reload button, and Query never retries it.
 */
import { createSerializationAdapter } from '@tanstack/react-router';

export class OrgChanged extends Error {
  override name = 'OrgChanged';
}

/** So a server function's refusal reaches the browser as an `OrgChanged`, not a plain Error. */
export const orgChangedAdapter = createSerializationAdapter({
  key: 'signforge-org-changed',
  test: (value): value is OrgChanged => value instanceof OrgChanged,
  toSerializable: (error) => error.message,
  fromSerializable: (message: string) => new OrgChanged(message),
});
