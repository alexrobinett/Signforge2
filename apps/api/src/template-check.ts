import { parseTemplateRuntimeReport } from '@signforge/contract';
import { ToolError, type TemplateChecker } from '@signforge/tools';

/**
 * Long enough for the worst case: a cold start (the check Worker allows 60 s), then the checks queued
 * before this one in the org's container (at most 3) and its own, each up to about 10 s (two renders
 * of a template that never gets ready). Past it the push is refused to retry rather than hang.
 */
const CHECK_TIMEOUT_MS = 120_000;

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
    // Not run, so not a verdict on the template: the push may simply be tried again.
    const unavailable = (why: string, cause?: unknown) =>
      new ToolError('unavailable', `the template check is not available (${why}); try again in a minute`, { retryAfterSeconds: 60 }, false, { cause });
    let res: Response;
    let body: unknown;
    try {
      // The org's own container: the org comes from the tool's scope, never from what was pushed.
      res = await env.TEMPLATE_CHECK.fetch(`https://template-check/check/org/${template.orgId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: template.manifest, html: template.html }),
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
    } catch (e) {
      throw unavailable('it could not be reached', e);
    }
    // Why it failed (probe URLs, a runner's error) is for the operator's logs, not the member or agent.
    if (!res.ok) {
      console.error(`template check for ${template.orgId} answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 500)}`);
      throw unavailable(`it answered ${res.status}`);
    }
    try {
      body = JSON.parse(await res.text());
    } catch (e) {
      throw unavailable('its answer could not be read', e);
    }
    const report = parseTemplateRuntimeReport(body);
    if (!report.ok) throw new Error(`the template check sent a report the contract refuses: ${report.problems.join('; ')}`);
    return report.value;
  };
