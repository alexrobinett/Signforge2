import { parseTemplateRuntimeReport } from '@signforge/contract';
import type { TemplateChecker } from '@signforge/tools';

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
    });
    if (!res.ok) throw new Error(`the template check answered ${res.status}: ${await res.text()}`);
    const report = parseTemplateRuntimeReport(await res.json());
    if (!report.ok) throw new Error(`the template check sent a report the contract refuses: ${report.problems.join('; ')}`);
    return report.value;
  };
