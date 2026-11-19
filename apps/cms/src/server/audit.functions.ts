/**
 * The Audit log page's read: one page of `list_audit_log` as the signed-in member, for the page's
 * filters. The query over it is in src/queries/audit.ts; the CSV export pages the tool from the
 * browser (src/state/audit.ts).
 */
import { createServerFn } from '@tanstack/react-start';
import { auditInput, type AuditFilters, type AuditPage } from '~/lib/audit';
import { inOrg, tool } from './tools.server';

/** How many entries the page shows at first, and adds with each Load older. */
const PAGE = 50;

export const getAuditPage = createServerFn({ method: 'GET', strict: { output: false } })
  .validator((p: { filters: AuditFilters; cursor: string | null }) => p)
  .handler(({ data: { filters, cursor } }) =>
    inOrg(() => tool<AuditPage>('list_audit_log', { ...auditInput(filters, Date.now()), limit: PAGE, ...(cursor ? { cursor } : {}) }), {
      entries: [],
      next: null,
    }),
  );
