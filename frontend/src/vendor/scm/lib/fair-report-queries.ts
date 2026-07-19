// ----------------------------------------------------------------------------
// fair-report-queries.ts — typed read hooks for the Fair Report endpoint
// (GET /scm/reports/fair-report + /scm/reports/fair-report/:docNo).
//
// The exhibition-performance report with THREE document-stage views selected by
// `stage` (so | do | invoice). Every field mirrors the server output shape 1:1
// (backend/src/scm/lib/fair-report.ts + routes/reports.ts) so the two cannot
// drift. Read-only, thin: the server does all the fair-anchoring, the money
// splits and the per-stage KPI summaries; these hooks only fetch + type.
//
// Same pattern as reports-queries.ts (useQuery + the vendored authedFetch, which
// prepends /api/scm). The 7 shared filters + the stage all ride the query
// string; the page keeps them in the URL (useSearchParams) so a report view is
// shareable.
// ----------------------------------------------------------------------------

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

export type FairStage = 'so' | 'do' | 'invoice';

/** The four Fair Report tender labels (mfg_sales_order_payments.method mapped:
 *  cash→Cash, merchant→Merchant, installment→Installment, transfer→Online). */
export type FairTenderLabel = 'Cash' | 'Merchant' | 'Installment' | 'Online';
export type FairTenderSplit = { Cash: number; Merchant: number; Installment: number; Online: number };

/** The 7 shared filters (all live on the SO header server-side). Empty / unset
 *  fields are omitted from the query string. */
export type FairFilters = {
  venue?: string;        // venue_id (uuid)
  state?: string;        // customer_state
  project?: number;      // project_id (int)
  branding?: string;
  salesperson?: string;  // salesperson_id (uuid)
  month?: string;        // YYYY-MM
  dateFrom?: string;     // YYYY-MM-DD (inclusive)
  dateTo?: string;       // YYYY-MM-DD (inclusive)
};

/** Fair-identity columns emitted on every stage row (fairDims). */
export type FairDims = {
  venue: string | null;
  venue_id: string | null;
  state: string | null;
  project_id: number | null;
  project: string | null;
  project_start_date: string | null;
  project_end_date: string | null;
  salesperson_id: string | null;
  salesperson: string | null;
  branding: string | null;
};

export type FairCostByCategory = {
  mattress_sofa_cost_centi: number;
  bedframe_cost_centi: number;
  accessories_cost_centi: number;
  others_cost_centi: number;
  service_cost_centi: number;
};

// ── stage=so ─────────────────────────────────────────────────────────────────
export type FairSoRow = FairDims & {
  so_date: string | null;
  so_no: string;
  order_form: string | null;      // ref (handwritten HC number)
  amount_centi: number;           // product + service
  selling_centi: number;          // product only
  service_rev_centi: number;
  cost_by_category: FairCostByCategory;
  total_so_cost_centi: number;
  margin_pct: number | null;
  balance_centi: number;
  paid_total_centi: number;
  deposit_centi: number;
  payment_methods: FairTenderLabel[];
  deposit_by_tender: FairTenderSplit;
  below_deposit: boolean;
};

export type FairSoSummary = {
  orders: number;
  total_amount_centi: number;
  total_selling_centi: number;
  total_service_rev_centi: number;
  total_so_cost_centi: number;
  total_margin_centi: number;
  margin_pct: number | null;
  total_balance_centi: number;
  below_deposit_count: number;
  tender_totals: FairTenderSplit;
};

// ── stage=do ─────────────────────────────────────────────────────────────────
export type FairDoRow = FairDims & {
  delivery_date: string | null;
  do_no: string;
  so_no: string | null;
  status: string | null;
  qty: number;
  total_so_cost_centi: number;
  total_do_cost_centi: number;
  do_cost_is_legacy: boolean;
  cost_delta_centi: number;       // do − so (positive = cost grew at delivery)
  so_margin_pct: number | null;
  do_margin_pct: number | null;
};

export type FairDoSummary = {
  deliveries: number;
  total_so_cost_centi: number;
  total_do_cost_centi: number;
  cost_delta_centi: number;
  legacy_count: number;
};

// ── stage=invoice ────────────────────────────────────────────────────────────
export type FairInvoiceRow = FairDims & {
  invoice_date: string | null;
  inv_no: string;
  so_no: string | null;
  do_id: string | null;
  status: string | null;
  invoiced_centi: number;
  so_cost_centi: number;
  do_cost_centi: number;
  si_cost_centi: number;          // landed
  margin_pct: number | null;      // invoiced vs landed
};

export type FairInvoiceSummary = {
  invoices: number;
  total_invoiced_centi: number;
  total_so_cost_centi: number;
  total_do_cost_centi: number;
  total_si_cost_centi: number;
  margin_pct: number | null;
};

export type FairFiltersEcho = {
  stage: FairStage;
  venue: string | null;
  state: string | null;
  project: number | null;
  branding: string | null;
  salesperson: string | null;
  month: string | null;
  date_from: string | null;
  date_to: string | null;
};

export type FairSoResponse = {
  stage: 'so';
  rows: FairSoRow[];
  summary: FairSoSummary;
  filters: FairFiltersEcho;
  meta: { access_tier: 'management' | 'sales_director' | 'none' };
};
export type FairDoResponse = {
  stage: 'do';
  rows: FairDoRow[];
  summary: FairDoSummary;
  filters: FairFiltersEcho;
  meta: { access_tier: 'management' | 'sales_director' | 'none' };
};
export type FairInvoiceResponse = {
  stage: 'invoice';
  rows: FairInvoiceRow[];
  summary: FairInvoiceSummary;
  filters: FairFiltersEcho;
  meta: { access_tier: 'management' | 'sales_director' | 'none' };
};
export type FairReportResponse = FairSoResponse | FairDoResponse | FairInvoiceResponse;

function buildFairQs(stage: FairStage, f: FairFilters): string {
  const params = new URLSearchParams();
  params.set('stage', stage);
  if (f.venue)       params.set('venue', f.venue);
  if (f.state)       params.set('state', f.state);
  if (f.project != null) params.set('project', String(f.project));
  if (f.branding)    params.set('branding', f.branding);
  if (f.salesperson) params.set('salesperson', f.salesperson);
  if (f.month)       params.set('month', f.month);
  if (f.dateFrom)    params.set('date_from', f.dateFrom);
  if (f.dateTo)      params.set('date_to', f.dateTo);
  return params.toString();
}

/**
 * The per-stage list read. `enabled` lets the page hold a stage's query until
 * its tab is actually selected AND the caller is allowed to see it (a Sales
 * Director must never fire the do/invoice queries the backend would 403).
 */
export const useFairReport = (stage: FairStage, filters: FairFilters, enabled = true) => {
  const qs = buildFairQs(stage, filters);
  return useQuery({
    queryKey: ['reports', 'fair-report', qs],
    queryFn: () => authedFetch<FairReportResponse>(`/reports/fair-report?${qs}`),
    enabled,
    placeholderData: (prev) => prev,  // TanStack v5 equivalent of keepPreviousData
    staleTime: 30_000,
  });
};

// ── per-order detail (quick-view drawer) ─────────────────────────────────────
export type FairDetailLine = {
  item_code: string | null;
  description: string | null;
  qty: number | null;
  unit_price_centi: number | null;
  amount_centi: number | null;
  unit_cost_centi: number | null;
  line_cost_centi: number | null;
  cancelled: boolean | null;
};

export type FairDetailPayment = {
  tender: string | null;
  amount_centi: number | null;
  merchant_provider: string | null;
  installment_months: number | null;
  approval_code: string | null;
  paid_at: string | null;
  is_deposit: boolean | null;
};

export type FairDetailResponse = FairDims & {
  so_no: string;
  order_form: string | null;
  so_date: string | null;
  amount_centi: number;
  selling_centi: number;
  service_rev_centi: number;
  cost_by_category: FairCostByCategory;
  total_so_cost_centi: number;
  margin_pct: number | null;
  balance_centi: number;
  deposit_centi: number;
  paid_total_centi: number;
  below_deposit: boolean;
  payment_methods: FairTenderLabel[];
  deposit_by_tender: FairTenderSplit;
  payments: FairDetailPayment[];
  lines: FairDetailLine[];
  linkage: { so_no: string; do_nos: string[]; invoice_nos: string[] };
  meta: { access_tier: 'management' | 'sales_director' | 'none' };
};

/** Per-order detail for the quick-view drawer, keyed by SO doc_no. `docNo` null
 *  (drawer closed) keeps the query idle. */
export const useFairReportDetail = (docNo: string | null) => {
  return useQuery({
    queryKey: ['reports', 'fair-report-detail', docNo],
    queryFn: () => authedFetch<FairDetailResponse>(`/reports/fair-report/${encodeURIComponent(docNo ?? '')}`),
    enabled: !!docNo,
    staleTime: 30_000,
  });
};
