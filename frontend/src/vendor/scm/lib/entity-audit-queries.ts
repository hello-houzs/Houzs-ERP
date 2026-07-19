/* entity-audit-queries — the read side of scm.entity_audit_log for the shared
   History drawer.

   Sibling of useSalesOrderAuditLog (sales-order-queries.ts). It lives in its own
   module rather than inside stock-queries / grn-queries / payment-voucher-queries
   because four unrelated modules read it, and putting it in any one of them would
   make the other three import a neighbour's query file for no reason.

   The backend deliberately mirrors the SO endpoint's `{ entries: [...] }`
   envelope and newest-first ordering (routes/entity-audit-log.ts), so the rows
   satisfy AuditHistoryPanel's AuditLogEntry shape with no adapter in between. */

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

export type EntityAuditFieldChange = {
  field: string;
  from?: unknown;
  to?: unknown;
};

export type EntityAuditEntry = {
  id: string;
  entity_type: string;
  entity_id: string;
  entity_doc_no: string | null;
  action: string;
  actor_id: string | null;
  actor_name_snapshot: string | null;
  field_changes: EntityAuditFieldChange[];
  status_snapshot: string | null;
  source: string | null;
  note: string | null;
  created_at: string;
};

/* Must stay in step with ENTITY_TYPES in backend/src/scm/lib/entity-audit.ts.
   The endpoint rejects an unknown type with 400 rather than an empty list, so a
   typo here surfaces as a visible error instead of a document that appears to
   have no history. */
export type AuditEntityType =
  | 'PAYMENT_VOUCHER'
  | 'GRN'
  | 'STOCK_TAKE'
  | 'STOCK_TRANSFER'
  | 'INVENTORY_ADJUSTMENT';

/**
 * One document's audit history, newest first.
 *
 * staleTime is 0, unlike most queries in this tree. The drawer is mounted only
 * while it is open, so every open is a fresh fetch — which is the point: the
 * common way to reach History is right after making an edit, and a cached list
 * that omits the edit the user just made reads as "the system did not record
 * it". The cost is one request per click on a capped (<=500 row) read.
 */
export const useEntityAuditLog = (
  entityType: AuditEntityType,
  entityId: string | null,
) => useQuery({
  queryKey: ['scm-entity-audit-log', entityType, entityId],
  queryFn: () => authedFetch<{ entries: EntityAuditEntry[] }>(
    `/entity-audit-log/${entityType}/${entityId}`,
  ).then((r) => r.entries),
  enabled: Boolean(entityId),
  staleTime: 0,
  retry: retryUnlessClientError,
});
