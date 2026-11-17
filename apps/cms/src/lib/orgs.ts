/**
 * Organization changes, through Better Auth's endpoints on the API. Nothing else in the CMS
 * changes data yet; from M3-12 every other change goes through the API's tool registry.
 */
import { useRouter } from '@tanstack/react-router';
import { useCallback } from 'react';
import { authClient, authErrorMessage } from './auth-client';
import { slugify } from './paths';

export class OrgActionError extends Error {}

const suffix = () => Math.random().toString(36).slice(2, 6);
const slugTaken = (e: { code?: string; message?: string }) => /ALREADY_EXISTS|SLUG/i.test(`${e.code ?? ''} ${e.message ?? ''}`);

export function useOrgActions() {
  const router = useRouter();

  /** Make an org active. The response sets a new session cache cookie; the browser keeps it. */
  const switchTo = useCallback(
    async (organizationId: string) => {
      const { error } = await authClient.organization.setActive({ organizationId });
      if (error) throw new OrgActionError(authErrorMessage(error, 'Could not switch organization.'));
      await router.invalidate();
    },
    [router],
  );

  /** Create an org; it becomes the active one. Slugs are not shown yet, so a taken one gets a suffix. */
  const create = useCallback(
    async (name: string) => {
      const base = slugify(name);
      let res = await authClient.organization.create({ name, slug: base });
      if (res.error && slugTaken(res.error)) res = await authClient.organization.create({ name, slug: `${base}-${suffix()}` });
      if (res.error || !res.data) throw new OrgActionError(authErrorMessage(res.error, 'Could not create the organization.'));
      await router.invalidate();
      return res.data;
    },
    [router],
  );

  return { switchTo, create };
}
