/**
 * Organization changes, through Better Auth's endpoints on the API. Nothing else in the CMS
 * changes data yet; from M3-12 every other change goes through the API's tool registry.
 * The app store's org actions (`src/state/orgs.ts`) call these.
 */
import type { AnyRouter } from '@tanstack/react-router';
import { authClient, authErrorMessage } from './auth-client';
import { slugify } from './paths';

class OrgActionError extends Error {}

const suffix = () => Math.random().toString(36).slice(2, 6);
const slugTaken = (e: { code?: string; message?: string }) => /ALREADY_EXISTS|SLUG/i.test(`${e.code ?? ''} ${e.message ?? ''}`);

/** Make an org active. The response sets a new session cache cookie; the browser keeps it. */
export async function switchOrganization(router: AnyRouter, organizationId: string) {
  const { error } = await authClient.organization.setActive({ organizationId });
  if (error) throw new OrgActionError(authErrorMessage(error, 'Could not switch organization.'));
  await router.invalidate();
}

/** Create an org; it becomes the active one. Slugs are not shown yet, so a taken one gets a suffix. */
export async function createOrganization(router: AnyRouter, name: string) {
  const base = slugify(name);
  let res = await authClient.organization.create({ name, slug: base });
  if (res.error && slugTaken(res.error)) res = await authClient.organization.create({ name, slug: `${base}-${suffix()}` });
  if (res.error) throw new OrgActionError(authErrorMessage(res.error, 'Could not create the organization.'));
  await router.invalidate();
  return res.data;
}
