import { parseTemplateRuntimeReport } from '@signforge/contract';
import type { TemplateChecker } from '@signforge/tools';

/**
 * Long enough for a cold start (the check Worker allows 60 s), the checks queued before this one in
 * the org's container (at most 3) and its own; past it the push fails rather than hang.
 */
const CHECK_TIMEOUT_MS = 90_000;

/** Counts one check against the org's limit (TEMPLATE_CHECK_LIMIT, 10 a minute); false over it. */
export const templateCheckAllowed = async (env: Pick<Env, 'TEMPLATE_CHECK_LIMIT'>, orgId: string) =>
  (await env.TEMPLATE_CHECK_LIMIT.limit({ key: `org:${orgId}` })).success;

/**
 * The runtime check, through the check Worker (apps/template-check), which renders the template in
 * the org's own container, with no network. Its report is parsed here, where it enters. A check that could not
 * run, or a report the contract refuses, throws: the version is not registered either way.
 */
export const templateChecker =
  (env: Pick<Env, 'TEMPLATE_CHECK'>): TemplateChecker =>
  async (template) => {
    // The org's own container: the org comes from the tool's scope, never from what was pushed.
    const res = await env.TEMPLATE_CHECK.fetch(`https://template-check/check/org/${template.orgId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: template.manifest, html: template.html }),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`the template check answered ${res.status}: ${await res.text()}`);
    const report = parseTemplateRuntimeReport(await res.json());
    if (!report.ok) throw new Error(`the template check sent a report the contract refuses: ${report.problems.join('; ')}`);
    return report.value;
  };
