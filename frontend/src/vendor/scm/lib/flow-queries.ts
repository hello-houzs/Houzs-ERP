// Vendored SLICE of apps/backend/src/lib/flow-queries.ts — only the document
// relationship-map read (useDocumentFlow + its FlowNode/FlowEdge types) that
// DocumentFlowModal / RelationshipMapButton render on the PO detail page.
//
// The full source module is ~1996 lines (the entire SO/DO/SI/PO/GRN/PI/return
// query surface + verified-save + supabase + serviceNotify). None of that is
// needed for the relationship map, so it is intentionally NOT vendored. The one
// read below is copied verbatim and goes through the vendored authedFetch
// (→ /api/scm/document-flow/:type/:id).

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

/* ── Document relationship map (SAP-style flow diagram) ─────────────────── */
export type FlowNodeType =
  | 'so' | 'do' | 'si' | 'payment' | 'po' | 'grn' | 'pi' | 'dr' | 'pr'
  | 'cso' | 'cdo' | 'cdr' | 'pco' | 'pcr' | 'pcrn';
export type FlowEdgeKind = 'full' | 'partial' | 'value' | 'payment';
export type FlowNode = {
  key: string;
  type: FlowNodeType;
  id: string;
  label: string;
  status: string | null;
  isAnchor: boolean;
};
export type FlowEdge = { from: string; to: string; kind: FlowEdgeKind };

export const useDocumentFlow = (type: FlowNodeType | null, id: string | null) =>
  useQuery({
    queryKey: ['document-flow', type, id],
    queryFn: () => authedFetch<{ nodes: FlowNode[]; edges: FlowEdge[]; rootSos: string[] }>(
      `/document-flow/${type}/${encodeURIComponent(id!)}`,
    ),
    enabled: Boolean(type && id),
    staleTime: 30_000,
    retry: retryUnlessClientError,
  });

/* Advisory candidate POs for an SO with NO linked purchase leg (pre-MRP orders,
   see the backend route). Read-only: matched by material_code, never a stored
   link. Pass a null docNo to disable — the map only asks when its PO node is
   empty, so a normal linked SO never fires this request. */
export type CandidatePo = { id: string; poNumber: string; status: string | null; poDate: string | null };
export const useCandidatePos = (soDocNo: string | null) =>
  useQuery({
    queryKey: ['candidate-pos', soDocNo],
    queryFn: () => authedFetch<{ candidates: CandidatePo[] }>(
      `/document-flow/candidate-pos/${encodeURIComponent(soDocNo!)}`,
    ),
    enabled: Boolean(soDocNo),
    staleTime: 30_000,
    retry: retryUnlessClientError,
  });
