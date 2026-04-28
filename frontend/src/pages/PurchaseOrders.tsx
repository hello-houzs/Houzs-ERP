import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useNavigate, useParams, Navigate } from "react-router-dom";
import { RefreshCw, Send, ChevronDown, ChevronUp } from "lucide-react";
import { PageHeader } from "../components/Layout";
import {
  DetailLayout,
  Section,
  StatStrip,
  HeaderButton,
} from "../components/DetailLayout";
import { Button } from "../components/Button";
import { ExpandableText } from "../components/ExpandableText";
import { DataTable, type Column } from "../components/DataTable";
import { Pagination } from "../components/Pagination";
import { Panel, PanelSection } from "../components/Panel";
import { StatCard } from "../components/StatCard";
import { DashboardGrid, DashboardPanels, DashboardBreakdown } from "../components/Dashboard";
import { TabStrip } from "../components/TabStrip";
import { FilterPills } from "../components/FilterPills";
import { PnlCalendar } from "../components/PnlCalendar";
import { CreditorsTab } from "./Creditors";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useServerSort } from "../hooks/useServerSort";
import { api, buildQuery } from "../api/client";
import { formatCurrency, formatDate, formatNumber } from "../lib/utils";
import type { Paginated, PurchaseOrder, PurchaseOrderDoc, POSummary } from "../types";

type View = "list" | "creditors" | "pnl";
type StatusFilter = "all" | "outstanding" | "delivered" | "cancelled";

export function PurchaseOrders() {
  const toast = useToast();
  // View is URL-driven (?view=...) so global-search deep-links can land
  // on the right tab. localStorage holds the last viewed tab as fallback.
  const [params, setParams] = useSearchParams();
  const [storedView, setStoredView] = useLocalStorage<View>("po:view", "list");
  const urlView = params.get("view") as View | null;
  const view: View =
    urlView && ["list", "creditors", "pnl"].includes(urlView) ? urlView : storedView;
  const setView = (v: View) => {
    setStoredView(v);
    const next = new URLSearchParams(params);
    if (v === storedView) next.delete("view");
    else next.set("view", v);
    // Don't carry a focus param across tab switches — focus is scoped
    // to whichever record type the current tab renders.
    next.delete("focus");
    setParams(next, { replace: true });
  };

  const [docStatus, setDocStatus] = useLocalStorage<StatusFilter>(
    "po:doc-status",
    "outstanding"
  );
  const [docSearch, setDocSearch] = useState("");
  const [docPage, setDocPage] = useState(1);
  const [docPerPage, setDocPerPage] = useLocalStorage<number>("pp:purchase-order-docs", 50);
  const docSortHook = useServerSort(() => setDocPage(1));
  const [pulling, setPulling] = useState(false);
  const navigate = useNavigate();
  // Bumped on Refresh to force the embedded CreditorsTab to re-fetch.
  const [creditorsRefreshKey, setCreditorsRefreshKey] = useState(0);

  const docs = useQuery<Paginated<PurchaseOrderDoc>>(
    () =>
      api.get(
        `/api/po/docs${buildQuery({
          search: docSearch,
          page: docPage,
          per_page: docPerPage,
          status: docStatus,
          ...docSortHook.sortParams,
        })}`
      ),
    [docSearch, docPage, docPerPage, docStatus, docSortHook.sort?.key, docSortHook.sort?.dir]
  );

  const summary = useQuery<POSummary>(() => api.get("/api/po/summary"));

  async function refresh() {
    setPulling(true);
    try {
      type PoPullRes = {
        lines?: { message?: string; error?: string };
        docs?: { message?: string; error?: string };
      };
      type CredPullRes = { message?: string; fetched?: number; error?: string };
      const poPromise: Promise<PoPullRes> = api
        .post<PoPullRes>("/api/po/pull")
        .catch((e: any) => ({ lines: { error: e?.message || String(e) } }));
      const credPromise: Promise<CredPullRes> = api
        .post<CredPullRes>("/api/creditors/pull")
        .catch((e: any) => ({ error: e?.message || String(e) }));
      const [poRes, credRes] = await Promise.all([poPromise, credPromise]);
      const parts: string[] = [];
      if (poRes.lines?.message) parts.push(`Lines: ${poRes.lines.message}`);
      if (poRes.lines?.error) parts.push(`Lines failed: ${poRes.lines.error}`);
      if (poRes.docs?.message) parts.push(`Docs: ${poRes.docs.message}`);
      if (poRes.docs?.error) parts.push(`Docs failed: ${poRes.docs.error}`);
      if (credRes.message) parts.push(`Creditors: ${credRes.message}`);
      if (credRes.error) parts.push(`Creditors failed: ${credRes.error}`);
      toast.success(parts.join(" · ") || "Refreshed");
      docs.reload();
      summary.reload();
      setCreditorsRefreshKey((k) => k + 1);
    } catch (e: any) {
      toast.error(`Refresh failed: ${e?.message || e}`);
    } finally {
      setPulling(false);
    }
  }

  // Per-tab header config — each tab has its own title/description so
  // the page chrome reflects what you're actually looking at, not a
  // generic parent label.
  const TAB_HEADER: Record<View, { title: string; description: string }> = {
    list: {
      title: "Purchase Orders",
      description: "One row per PO. Click a row to view lines and edit supplier dates.",
    },
    creditors: {
      title: "Creditors",
      description:
        "Procurement suppliers from AutoCount. Read-only mirror — edit creditors in AutoCount, then click Refresh.",
    },
    pnl: {
      title: "Purchase Order Cost — P&L",
      description: "Monthly PO spend (LocalExTax) by doc_date. Cancelled docs excluded.",
    },
  };
  // Refresh pulls PO docs/lines + creditors. Hide it on the P&L tab
  // where there's nothing to pull from this view.
  const showRefresh = view !== "pnl";

  return (
    <div>
      <TabStrip
        value={view}
        onChange={(v) => setView(v)}
        options={[
          { value: "list", label: "Purchase Orders" },
          { value: "creditors", label: "Creditors" },
          { value: "pnl", label: "P&L" },
        ]}
      />

      <PageHeader
        eyebrow="Operations · Procurement"
        title={TAB_HEADER[view].title}
        description={TAB_HEADER[view].description}
        actions={
          showRefresh ? (
            <Button
              variant="primary"
              icon={<RefreshCw size={14} />}
              onClick={refresh}
              disabled={pulling}
            >
              {pulling ? "Refreshing…" : "Refresh"}
            </Button>
          ) : undefined
        }
      />

      {view === "list" && (
        <>
          {(() => {
            const s = summary.data;
            return (
              <>
                <DashboardGrid cols={4}>
                  <StatCard
                    label="Outstanding POs"
                    value={s ? (s.totals.outstanding_count ?? 0).toLocaleString() : "—"}
                    subtitle={
                      s
                        ? `${(s.totals.delivered_count ?? 0).toLocaleString()} delivered · ${(s.totals.cancelled_count ?? 0).toLocaleString()} cancelled`
                        : " "
                    }
                  />
                  <StatCard
                    label="Suppliers"
                    value={s ? s.totals.supplier_count.toLocaleString() : "—"}
                    subtitle="With outstanding lines"
                  />
                  <StatCard
                    label="Overdue"
                    value={s ? s.overdue.toLocaleString() : "—"}
                    subtitle="Outstanding past delivery date"
                    tone={s && s.overdue > 0 ? "error" : "default"}
                  />
                  <StatCard
                    label="Missing Supplier Date"
                    value={s ? s.missing_supplier_date.toLocaleString() : "—"}
                    subtitle="No date1/2/3 set"
                  />
                </DashboardGrid>

                <DashboardPanels cols={1}>
                  <DashboardBreakdown
                    title="Top Suppliers"
                    items={
                      s?.top_suppliers.map((t) => ({ label: t.name, count: t.count })) ?? []
                    }
                  />
                </DashboardPanels>
              </>
            );
          })()}

          <DocumentsView
            q={docs}
            status={docStatus}
            setStatus={(v) => {
              setDocStatus(v);
              setDocPage(1);
            }}
            search={docSearch}
            setSearch={(v) => {
              setDocSearch(v);
              setDocPage(1);
            }}
            page={docPage}
            setPage={setDocPage}
            perPage={docPerPage}
            setPerPage={setDocPerPage}
            onRowClick={(d) => navigate(`/po/${encodeURIComponent(d.doc_no)}`)}
            onSortChange={docSortHook.handleSortChange}
          />
        </>
      )}

      {view === "creditors" && (
        <CreditorsTab refreshKey={creditorsRefreshKey} />
      )}

      {view === "pnl" && (
        <PnlCalendar
          scope="po"
          title="Purchase Order Cost"
          subtitle="Monthly PO spend (LocalExTax) from purchase_order_docs by doc_date. Cancelled docs excluded."
        />
      )}

    </div>
  );
}

// ── Documents view ─────────────────────────────────────────────
// Doc-level table backed by /api/po/docs (purchase_order_docs).
// Shows status (outstanding / delivered / cancelled), creditor, and
// LocalExTax with inline edit so users can fix missing prices.

interface DocsViewProps {
  q: ReturnType<typeof useQuery<Paginated<PurchaseOrderDoc>>>;
  status: StatusFilter;
  setStatus: (v: StatusFilter) => void;
  search: string;
  setSearch: (v: string) => void;
  page: number;
  setPage: (n: number) => void;
  perPage: number;
  setPerPage: (n: number) => void;
  onRowClick: (doc: PurchaseOrderDoc) => void;
  onSortChange: (s: { key: string; dir: "asc" | "desc" } | null) => void;
}

/**
 * Type for a row enriched with the parsed AutoCount payload + the
 * line-level aggregate columns from the LEFT JOIN in /api/po/docs.
 * We parse `raw` once per row at the page level (rather than in every
 * column render) so the table stays cheap with hundreds of optional
 * columns.
 */
type EnrichedDoc = PurchaseOrderDoc & {
  _ext: Record<string, unknown>;
  outstanding_line_count?: number | null;
  next_delivery?: string | null;
  total_remaining_qty?: number | null;
};

/**
 * Computes the human status of a PO. Mirrors the SQL filter in
 * /api/po/docs so the badge always matches the active filter:
 *
 *   • Cancelled  — d.cancelled = 1
 *   • Outstanding — not cancelled, doc_status != 'C', AND has line(s)
 *                   in purchase_orders (outstanding_line_count > 0)
 *   • Delivered  — everything else (header closed, or all lines fully
 *                  transferred so /getOutstanding dropped them)
 */
function computeStatus(
  d: Pick<EnrichedDoc, "cancelled" | "doc_status" | "outstanding_line_count">
): "Cancelled" | "Delivered" | "Outstanding" {
  if (d.cancelled) return "Cancelled";
  const closed = (d.doc_status || "").toUpperCase() === "C";
  const hasOutstanding = (d.outstanding_line_count ?? 0) > 0;
  if (!closed && hasOutstanding) return "Outstanding";
  return "Delivered";
}

// All AutoCount header fields surfaced as opt-in columns on the
// Documents tab. Default columns (PO No, Date, Ref, Supplier, Status,
// Cost, Final Total, Curr) are NOT in this list — they're rendered
// separately so they show by default.
const EXTENDED_FIELDS: Array<{ key: string; label: string; numeric?: boolean }> = [
  { key: "DocKey", label: "Doc Key", numeric: true },
  { key: "TaxRegisterNo", label: "Tax Register No" },
  { key: "Description", label: "Description" },
  { key: "ToDocKey", label: "To Doc Key", numeric: true },
  { key: "ToDocType", label: "To Doc Type" },
  { key: "DisplayTerm", label: "Display Term" },
  { key: "InvAddr1", label: "Invoice Addr 1" },
  { key: "InvAddr2", label: "Invoice Addr 2" },
  { key: "InvAddr3", label: "Invoice Addr 3" },
  { key: "InvAddr4", label: "Invoice Addr 4" },
  { key: "Phone1", label: "Phone 1" },
  { key: "Fax1", label: "Fax 1" },
  { key: "Attention", label: "Attention" },
  { key: "DeliverAddr1", label: "Deliver Addr 1" },
  { key: "DeliverAddr2", label: "Deliver Addr 2" },
  { key: "DeliverAddr3", label: "Deliver Addr 3" },
  { key: "DeliverAddr4", label: "Deliver Addr 4" },
  { key: "DeliverPhone1", label: "Deliver Phone 1" },
  { key: "DeliverFax1", label: "Deliver Fax 1" },
  { key: "DeliverContact", label: "Deliver Contact" },
  { key: "ShipVia", label: "Ship Via" },
  { key: "ShipInfo", label: "Ship Info" },
  { key: "Footer1Param", label: "Footer 1 Param" },
  { key: "Footer1Amt", label: "Footer 1 Amt", numeric: true },
  { key: "Footer1LocalAmt", label: "Footer 1 Local Amt", numeric: true },
  { key: "Footer1TaxCode", label: "Footer 1 Tax Code" },
  { key: "Footer1TaxRate", label: "Footer 1 Tax Rate", numeric: true },
  { key: "Footer1Tax", label: "Footer 1 Tax", numeric: true },
  { key: "Footer1LocalTax", label: "Footer 1 Local Tax", numeric: true },
  { key: "Footer2Param", label: "Footer 2 Param" },
  { key: "Footer2Amt", label: "Footer 2 Amt", numeric: true },
  { key: "Footer2LocalAmt", label: "Footer 2 Local Amt", numeric: true },
  { key: "Footer2TaxCode", label: "Footer 2 Tax Code" },
  { key: "Footer2TaxRate", label: "Footer 2 Tax Rate", numeric: true },
  { key: "Footer2Tax", label: "Footer 2 Tax", numeric: true },
  { key: "Footer2LocalTax", label: "Footer 2 Local Tax", numeric: true },
  { key: "Footer3Param", label: "Footer 3 Param" },
  { key: "Footer3Amt", label: "Footer 3 Amt", numeric: true },
  { key: "Footer3LocalAmt", label: "Footer 3 Local Amt", numeric: true },
  { key: "Footer3TaxCode", label: "Footer 3 Tax Code" },
  { key: "Footer3TaxRate", label: "Footer 3 Tax Rate", numeric: true },
  { key: "Footer3Tax", label: "Footer 3 Tax", numeric: true },
  { key: "Footer3LocalTax", label: "Footer 3 Local Tax", numeric: true },
  { key: "Total", label: "Total", numeric: true },
  { key: "TotalExTax", label: "Total Ex Tax", numeric: true },
  { key: "TotalWithTax", label: "Total With Tax", numeric: true },
  { key: "CurrencyWord", label: "Currency Word" },
  { key: "CurrencyWord2", label: "Currency Word 2" },
  { key: "CurrencySymbol", label: "Currency Symbol" },
  { key: "FCGainAccount", label: "FC Gain Account" },
  { key: "FCLossAccount", label: "FC Loss Account" },
  { key: "GainLossJournalType", label: "Gain/Loss Journal Type" },
  { key: "IsRoundAdj", label: "Round Adj?" },
  { key: "RoundAdj", label: "Round Adj", numeric: true },
  { key: "ToTaxCurrencyRate", label: "To Tax Currency Rate", numeric: true },
  { key: "TaxCurrencyExTax", label: "Tax Currency Ex Tax", numeric: true },
  { key: "NetTotal", label: "Net Total", numeric: true },
  { key: "LocalNetTotal", label: "Local Net Total", numeric: true },
  { key: "TaxableAmt", label: "Taxable Amt", numeric: true },
  { key: "LocalTaxableAmt", label: "Local Taxable Amt", numeric: true },
  { key: "TaxCurrencyTaxableAmt", label: "Tax Currency Taxable Amt", numeric: true },
  { key: "Tax", label: "Tax", numeric: true },
  { key: "TaxCurrencyTax", label: "Tax Currency Tax", numeric: true },
  { key: "ExTax", label: "Ex Tax", numeric: true },
  { key: "LocalExTax", label: "Local Ex Tax (raw)", numeric: true },
  { key: "Transferable", label: "Transferable" },
  { key: "Note", label: "Note" },
  { key: "Remark1", label: "Remark 1" },
  { key: "Remark2", label: "Remark 2" },
  { key: "Remark3", label: "Remark 3" },
  { key: "Remark4", label: "Remark 4" },
  { key: "DocStatus", label: "Doc Status (raw)" },
  { key: "Cancelled", label: "Cancelled (raw)" },
  { key: "LastModified", label: "Last Modified" },
  { key: "LastModifiedUserID", label: "Last Modified User ID" },
  { key: "LastModifiedUserName", label: "Last Modified User" },
  { key: "CreatedTimeStamp", label: "Created Timestamp" },
  { key: "CreatedUserID", label: "Created User ID" },
  { key: "CreatedUserName", label: "Created User" },
  { key: "ExternalLink", label: "External Link" },
  { key: "RefDocNo", label: "Ref Doc No" },
  { key: "CanSync", label: "Can Sync" },
  { key: "PrintCount", label: "Print Count", numeric: true },
  { key: "PurchaseLocation", label: "Purchase Location" },
  { key: "InclusiveTax", label: "Inclusive Tax" },
  // Creditor block
  { key: "CreditorCompanyName", label: "Creditor Company Name" },
  { key: "CreditorDesc2", label: "Creditor Desc 2" },
  { key: "CreditorAddress1", label: "Creditor Address 1" },
  { key: "CreditorAddress2", label: "Creditor Address 2" },
  { key: "CreditorAddress3", label: "Creditor Address 3" },
  { key: "CreditorAddress4", label: "Creditor Address 4" },
  { key: "CreditorDeliverAddress1", label: "Creditor Deliver Address 1" },
  { key: "CreditorDeliverAddress2", label: "Creditor Deliver Address 2" },
  { key: "CreditorDeliverAddress3", label: "Creditor Deliver Address 3" },
  { key: "CreditorDeliverAddress4", label: "Creditor Deliver Address 4" },
  { key: "CreditorAttention", label: "Creditor Attention" },
  { key: "CreditorPhone1", label: "Creditor Phone 1" },
  { key: "CreditorPhone2", label: "Creditor Phone 2" },
  { key: "CreditorMobile", label: "Creditor Mobile" },
  { key: "CreditorFax1", label: "Creditor Fax 1" },
  { key: "CreditorFax2", label: "Creditor Fax 2" },
  { key: "CreditorRoundingMethod", label: "Creditor Rounding Method" },
  { key: "CreditorTaxCode", label: "Creditor Tax Code" },
  { key: "CreditorInclusiveTax", label: "Creditor Inclusive Tax" },
  { key: "CreditorTaxRegisterNo", label: "Creditor Tax Register No" },
  { key: "CreditorGSTRegisterNo", label: "Creditor GST Register No" },
  { key: "CreditorSSTRegisterNo", label: "Creditor SST Register No" },
  { key: "CreditorSelfBilledApprovalNo", label: "Creditor Self-Billed Approval No" },
  { key: "CreditorExemptNo", label: "Creditor Exempt No" },
  { key: "CreditorExemptExpiryDate", label: "Creditor Exempt Expiry" },
  { key: "CreditorNote", label: "Creditor Note" },
  { key: "CreditorPriceCategory", label: "Creditor Price Category" },
  { key: "CreditorStatementType", label: "Creditor Statement Type" },
  { key: "CreditorAgingOn", label: "Creditor Aging On" },
  { key: "CreditorRegisterNo", label: "Creditor Register No" },
  { key: "CreditorNatureOfBusiness", label: "Creditor Nature of Business" },
  { key: "CreditorWebURL", label: "Creditor Web URL" },
  { key: "CreditorEmailAddress", label: "Creditor Email" },
  { key: "CreditorDisplayTerm", label: "Creditor Display Term" },
  { key: "CreditorContactInfo", label: "Creditor Contact Info" },
  { key: "CreditorCreditLimit", label: "Creditor Credit Limit", numeric: true },
  { key: "CreditorOverdueLimit", label: "Creditor Overdue Limit", numeric: true },
  { key: "CreditorCurrencyCode", label: "Creditor Currency Code" },
  { key: "CreditorPostCode", label: "Creditor Post Code" },
  { key: "CreditorDeliverPostCode", label: "Creditor Deliver Post Code" },
  { key: "CreditorLastModified", label: "Creditor Last Modified" },
  { key: "CreditorLastModifiedUserID", label: "Creditor Last Modified User ID" },
  { key: "CreditorCreatedTimestamp", label: "Creditor Created Timestamp" },
  { key: "CreditorCreatedUserID", label: "Creditor Created User ID" },
  { key: "CreditorGSTStatusVerifiedDate", label: "Creditor GST Status Verified" },
  { key: "CreditorAreaCode", label: "Creditor Area Code" },
  { key: "CreditorAreaDescription", label: "Creditor Area Description" },
  { key: "CreditorAreaDesc2", label: "Creditor Area Desc 2" },
  { key: "CreditorType", label: "Creditor Type" },
  { key: "CreditorTypeDescription", label: "Creditor Type Description" },
  { key: "CreditorTypeDesc2", label: "Creditor Type Desc 2" },
  { key: "CreditorPurchaseAgent", label: "Creditor Purchase Agent" },
  { key: "CreditorPurchaseAgentDescription", label: "Creditor Purchase Agent Description" },
  { key: "CreditorPurchaseAgentDesc2", label: "Creditor Purchase Agent Desc 2" },
  { key: "CreditorPurchaseAgentSignature", label: "Creditor Purchase Agent Signature" },
  { key: "CreditorParentAccNo", label: "Creditor Parent Acc No" },
  // Purchase Agent
  { key: "PurchaseAgent", label: "Purchase Agent" },
  { key: "PurchaseAgentDescription", label: "Purchase Agent Description" },
  { key: "PurchaseAgentDesc2", label: "Purchase Agent Desc 2" },
  { key: "PurchaseAgentSignature", label: "Purchase Agent Signature" },
  // Branch
  { key: "BranchAccNo", label: "Branch Acc No" },
  { key: "BranchCode", label: "Branch Code" },
  { key: "BranchName", label: "Branch Name" },
  { key: "BranchAddress1", label: "Branch Address 1" },
  { key: "BranchAddress2", label: "Branch Address 2" },
  { key: "BranchAddress3", label: "Branch Address 3" },
  { key: "BranchAddress4", label: "Branch Address 4" },
  { key: "BranchPostCode", label: "Branch Post Code" },
  { key: "BranchContact", label: "Branch Contact" },
  { key: "BranchPhone1", label: "Branch Phone 1" },
  { key: "BranchPhone2", label: "Branch Phone 2" },
  { key: "BranchMobile", label: "Branch Mobile" },
  { key: "BranchFax1", label: "Branch Fax 1" },
  { key: "BranchFax2", label: "Branch Fax 2" },
  { key: "BranchSalesAgent", label: "Branch Sales Agent" },
  { key: "BranchPurchaseAgent", label: "Branch Purchase Agent" },
  { key: "BranchAreaCode", label: "Branch Area Code" },
  { key: "BranchEmailAddress", label: "Branch Email" },
  { key: "BranchIsActive", label: "Branch Active?" },
  // PO UDFs
  { key: "POUDF_SODocKey", label: "PO UDF · SO Doc Key" },
  { key: "POUDF_PDate", label: "PO UDF · P Date" },
  { key: "POUDF_EDate", label: "PO UDF · E Date 1" },
  { key: "POUDF_EDate2", label: "PO UDF · E Date 2" },
  { key: "POUDF_EDate3", label: "PO UDF · E Date 3" },
  { key: "POUDF_PORemark", label: "PO UDF · PO Remark" },
  { key: "POUDF_Note", label: "PO UDF · Note" },
  { key: "TransferTo", label: "Transfer To" },
];

function DocumentsView(props: DocsViewProps) {
  const { q, status, setStatus, search, setSearch, page, setPage, perPage, setPerPage, onRowClick, onSortChange } = props;

  // Parse the AutoCount payload once per row.
  const enrichedRows: EnrichedDoc[] | null = useMemo(() => {
    if (!q.data?.data) return null;
    return q.data.data.map((r) => {
      let ext: Record<string, unknown> = {};
      if (r.raw) {
        try {
          ext = JSON.parse(r.raw);
        } catch {
          /* ignore — stale row from before raw was stored */
        }
      }
      return { ...r, _ext: ext };
    });
  }, [q.data]);

  const columns: Column<EnrichedDoc>[] = useMemo(() => {
    // Default columns — always shown unless the user hides them.
    const defaults: Column<EnrichedDoc>[] = [
      {
        key: "doc_no",
        label: "PO No",
        alwaysVisible: true,
        render: (r) => <span className="font-mono text-xs font-medium">{r.doc_no}</span>,
        getValue: (r) => r.doc_no,
      },
      {
        key: "doc_date",
        label: "Date",
        render: (r) => formatDate(r.doc_date),
        getValue: (r) => r.doc_date,
      },
      {
        key: "ref",
        label: "Ref",
        render: (r) => <span className="text-xs">{r.ref || "—"}</span>,
        getValue: (r) => r.ref,
      },
      {
        key: "creditor",
        label: "Supplier",
        alwaysVisible: true,
        render: (r) => r.creditor_name || r.creditor_code || "—",
        getValue: (r) => r.creditor_name,
      },
      {
        key: "status",
        label: "Status",
        render: (r) => {
          const s = computeStatus(r);
          if (s === "Cancelled") {
            return (
              <span className="rounded bg-err/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-err">
                Cancelled
              </span>
            );
          }
          if (s === "Delivered") {
            return (
              <span className="rounded bg-synced/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-synced">
                Delivered
              </span>
            );
          }
          return (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-800">
              Outstanding
            </span>
          );
        },
        getValue: (r) => computeStatus(r),
      },
      {
        key: "local_ex_tax",
        label: "Cost (RM ex-tax)",
        align: "right",
        alwaysVisible: true,
        render: (r) => (
          <span className="font-mono text-xs font-semibold text-ink">
            {formatCurrency(r.local_ex_tax)}
          </span>
        ),
        getValue: (r) => r.local_ex_tax,
      },
      {
        key: "final_total",
        label: "Final Total",
        align: "right",
        render: (r) => (
          <span className="font-mono text-xs text-ink-muted">{formatCurrency(r.final_total)}</span>
        ),
        getValue: (r) => r.final_total,
      },
      {
        key: "currency_code",
        label: "Curr",
        render: (r) => <span className="text-xs">{r.currency_code || "—"}</span>,
        getValue: (r) => r.currency_code,
      },
      {
        key: "outstanding_lines",
        label: "Outstanding Lines",
        align: "right",
        render: (r) => {
          const n = r.outstanding_line_count ?? 0;
          if (n === 0) return <span className="text-ink-muted">—</span>;
          return (
            <span className="font-mono text-xs font-semibold text-amber-800">
              {n}
              {r.total_remaining_qty != null && r.total_remaining_qty > 0 && (
                <span className="ml-1 text-ink-muted">
                  ({formatNumber(r.total_remaining_qty)} qty)
                </span>
              )}
            </span>
          );
        },
        getValue: (r) => r.outstanding_line_count ?? 0,
      },
      {
        key: "next_delivery",
        label: "Next Delivery",
        render: (r) => formatDate(r.next_delivery),
        getValue: (r) => r.next_delivery,
      },
    ];

    // Extended columns — sourced from the raw AutoCount payload, hidden
    // by default so the table stays readable. Users opt-in via Columns.
    const extended: Column<EnrichedDoc>[] = EXTENDED_FIELDS.map((f) => ({
      key: `ext:${f.key}`,
      label: f.label,
      align: f.numeric ? "right" : "left",
      defaultHidden: true,
      render: (r) => {
        const v = r._ext[f.key];
        if (v === null || v === undefined || v === "") {
          return <span className="text-ink-muted">—</span>;
        }
        if (f.numeric && typeof v === "number") {
          return <span className="font-mono text-xs">{v.toLocaleString("en-MY")}</span>;
        }
        return <span className="text-xs">{String(v)}</span>;
      },
      getValue: (r) => {
        const v = r._ext[f.key];
        if (v === null || v === undefined) return null;
        if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
        return JSON.stringify(v);
      },
    }));

    return [...defaults, ...extended];
  }, []);

  return (
    <>
      <div className="mb-3">
        <FilterPills<StatusFilter>
          value={status}
          onChange={setStatus}
          options={[
            { value: "outstanding", label: "Outstanding" },
            { value: "delivered", label: "Delivered" },
            { value: "cancelled", label: "Cancelled" },
            { value: "all", label: "All" },
          ]}
        />
      </div>
      <DataTable
        tableId="purchase-order-docs"
        exportName="purchase-order-docs"
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search PO no, supplier, ref…",
        }}
        columns={columns}
        rows={enrichedRows}
        loading={q.loading}
        error={q.error}
        emptyLabel="No PO documents — hit Refresh to pull from AutoCount"
        getRowKey={(r) => r.doc_no}
        onRowClick={(r) => onRowClick(r)}
        serverSort
        onSortChange={onSortChange}
      />
      {q.data && (
        <Pagination
          page={page}
          perPage={perPage}
          total={q.data.total}
          onPageChange={setPage}
          onPerPageChange={(n) => {
            setPerPage(n);
            setPage(1);
          }}
        />
      )}
    </>
  );
}

// ── PO Lines side panel ────────────────────────────────────────
// Opens when a PO row is clicked. Lists the line-level outstanding
// items pulled from /getOutstanding (purchase_orders) so users can
// edit supplier dates and push them back to AutoCount.

function PoLinesContent({
  doc,
  onChanged,
}: {
  doc: PurchaseOrderDoc;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [lines, setLines] = useState<PurchaseOrder[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [pushing, setPushing] = useState(false);
  // Live AutoCount line details from /PurchaseOrder/getDetail.
  const [details, setDetails] = useState<Array<Record<string, any>> | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(true);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [showHeader, setShowHeader] = useState(false);
  const [showRawDetail, setShowRawDetail] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDetailsLoading(true);
    setDetailsError(null);

    // Cached outstanding lines (D1) — used for inline supplier date edit.
    api
      .get<{ data: PurchaseOrder[] }>(`/api/po/lines/${encodeURIComponent(doc.doc_no)}`)
      .then((r) => {
        if (!cancelled) setLines(r.data);
      })
      .catch((e: any) => {
        if (!cancelled) toast.error(`Failed to load lines: ${e?.message || e}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    // Live AutoCount line details (read-through, not cached).
    api
      .get<{ data: Array<Record<string, any>> }>(
        `/api/po/details/${encodeURIComponent(doc.doc_no)}`
      )
      .then((r) => {
        if (!cancelled) setDetails(r.data);
      })
      .catch((e: any) => {
        if (!cancelled) setDetailsError(e?.message || String(e));
      })
      .finally(() => {
        if (!cancelled) setDetailsLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.doc_no]);

  // Header fields parsed once per doc — same pattern as the table.
  const headerFields: Record<string, unknown> = useMemo(() => {
    if (!doc.raw) return {};
    try {
      return JSON.parse(doc.raw);
    } catch {
      return {};
    }
  }, [doc.raw]);

  async function patchLine(line: PurchaseOrder, body: Record<string, any>) {
    try {
      await api.patch(
        `/api/po/${encodeURIComponent(line.doc_no)}/${encodeURIComponent(line.item_code)}`,
        body
      );
      const r = await api.get<{ data: PurchaseOrder[] }>(
        `/api/po/lines/${encodeURIComponent(doc.doc_no)}`
      );
      setLines(r.data);
      onChanged();
    } catch (e: any) {
      toast.error(`Save failed: ${e?.message || e}`);
    }
  }

  async function pushDates() {
    setPushing(true);
    try {
      await api.post(`/api/po/${encodeURIComponent(doc.doc_no)}/sync-dates`);
      toast.success(`Pushed dates for ${doc.doc_no}`);
    } catch (e: any) {
      toast.error(`Push failed: ${e?.message || e}`);
    } finally {
      setPushing(false);
    }
  }

  // Side panel infers outstanding from whether /api/po/lines returned
  // anything — that endpoint reads purchase_orders, which is the same
  // line table the table view's join uses.
  const status = computeStatus({
    cancelled: doc.cancelled,
    doc_status: doc.doc_status,
    outstanding_line_count: lines?.length ?? 0,
  });
  const isOutstanding = status === "Outstanding";

  return (
    <DetailLayout
      breadcrumbs={[
        { label: "Purchase Orders", to: "/po" },
        { label: doc.doc_no },
      ]}
      eyebrow={`PO · ${doc.doc_no}`}
      title={doc.creditor_name || doc.creditor_code || "Supplier"}
      description={`Doc date ${formatDate(doc.doc_date)}${doc.creditor_code ? ` · Creditor ${doc.creditor_code}` : ""}`}
      backTo="/po"
      actions={
        isOutstanding && lines && lines.length > 0 ? (
          <HeaderButton variant="primary" onClick={pushDates} disabled={pushing}>
            <Send size={12} /> {pushing ? "Pushing…" : "Push Dates"}
          </HeaderButton>
        ) : null
      }
    >
      <StatStrip
        items={[
          {
            label: "Status",
            value: status,
            tone:
              status === "Outstanding"
                ? "warn"
                : status === "Cancelled"
                ? "default"
                : "ok",
          },
          { label: "Cost (RM ex-tax)", value: formatCurrency(doc.local_ex_tax) },
          { label: "Final Total", value: formatCurrency(doc.final_total) },
          { label: "Currency", value: doc.currency_code || "—" },
        ]}
      />

      {/* Header Fields — promoted from the right aside to a full-width
          row at the top so the 150-key AutoCount payload has room to
          breathe (groups still split into 2-col sub-grids inside). */}
      <div className="mt-5">
        <Section
          title={`Header Fields · ${Object.keys(headerFields).length}`}
          actions={
            <button
              onClick={() => setShowHeader((s) => !s)}
              className="inline-flex items-center gap-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-accent hover:underline"
            >
              {showHeader ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
              {showHeader ? "Hide" : "Show"}
            </button>
          }
        >
          {showHeader ? (
            <FieldGrid fields={headerFields} groups={HEADER_GROUPS} />
          ) : (
            <div className="text-[11.5px] text-ink-muted">
              Tap “Show” to expand the AutoCount header payload.
            </div>
          )}
        </Section>
      </div>

      <div className="mt-3 space-y-3">
            {/* Line item details from AutoCount /getDetail */}
            <Section
              title={`Line Item Details${details ? ` · ${details.length}` : ""}`}
              dense
              actions={
                details && details.length > 0 ? (
                  <button
                    onClick={() => setShowRawDetail((s) => !s)}
                    className="inline-flex items-center gap-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-accent hover:underline"
                  >
                    {showRawDetail ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                    {showRawDetail ? "Hide raw" : "Raw fields"}
                  </button>
                ) : null
              }
            >
        {detailsLoading && (
          <div className="px-4 py-4 text-[12px] text-ink-muted">Loading from AutoCount…</div>
        )}
        {detailsError && (
          <div className="m-4 rounded-md border border-err/30 bg-err/5 px-3 py-2 text-[12px] text-err">
            {detailsError}
          </div>
        )}
        {details && details.length === 0 && !detailsLoading && (
          <div className="px-4 py-4 text-[12px] text-ink-muted">
            AutoCount returned no line details.
          </div>
        )}
        {details && details.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead className="bg-bg/50 text-[9px] font-semibold uppercase tracking-wider text-ink-muted">
                  <tr>
                    <th className="px-2 py-2 text-left">#</th>
                    <th className="px-2 py-2 text-left">Item</th>
                    <th className="px-2 py-2 text-right">Qty</th>
                    <th className="px-2 py-2 text-right">Transferred</th>
                    <th className="px-2 py-2 text-right">UOM Rate</th>
                    <th className="px-2 py-2 text-right">Unit Price</th>
                    <th className="px-2 py-2 text-right">Disc</th>
                    <th className="px-2 py-2 text-right">SubTotal (RM)</th>
                    <th className="px-2 py-2 text-right">Tax (RM)</th>
                    <th className="px-2 py-2 text-left">Tax Code</th>
                    <th className="px-2 py-2 text-left">Delivery</th>
                  </tr>
                </thead>
                <tbody>
                  {details.map((d, i) => (
                    <tr key={d.DtlKey ?? `${d.ItemCode}-${i}`} className="border-t border-border-subtle">
                      <td className="px-2 py-1.5 font-mono text-ink-muted">
                        {d.Seq ?? d.Numbering ?? i + 1}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="font-mono">{d.ItemCode || "—"}</div>
                        <div className="text-[10px] text-ink-muted">
                          {d.Description || d.ItemDescription || ""}
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono">
                        {fmtNum(d.Qty)}{" "}
                        <span className="text-ink-muted">{d.UOM || ""}</span>
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono">
                        {fmtNum(d.TransferedQty)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-ink-muted">
                        {fmtNum(d.UOMRate)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono">
                        {fmtNum(d.UnitPrice)}
                        {d.UnitPriceAfterDiscount !== d.UnitPrice && d.UnitPriceAfterDiscount != null && (
                          <div className="text-[10px] text-ink-muted">
                            after disc {fmtNum(d.UnitPriceAfterDiscount)}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono">
                        {d.Discount || (d.DiscountAmt ? fmtNum(d.DiscountAmt) : "—")}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono font-semibold">
                        {formatCurrency(d.LocalSubTotal ?? d.SubTotal)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono">
                        {formatCurrency(d.LocalTax ?? d.Tax)}
                      </td>
                      <td className="px-2 py-1.5">
                        {d.TaxCode || "—"}
                        {d.TaxRate != null && (
                          <span className="ml-1 text-ink-muted">{fmtNum(d.TaxRate)}%</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5">{formatDate(d.DeliveryDate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {showRawDetail && (
              <div className="space-y-3 border-t border-border-subtle bg-bg/30 p-4">
                {details.map((d, i) => (
                  <div
                    key={`raw-${d.DtlKey ?? i}`}
                    className="rounded-md border border-border bg-surface p-3"
                  >
                    <div className="mb-2 font-mono text-[10px] font-bold uppercase tracking-wider text-accent">
                      Line {d.Seq ?? i + 1} · {d.ItemCode || "—"}
                    </div>
                    <FieldGrid fields={d} />
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        </Section>

        <Section title={`Outstanding Lines${lines ? ` · ${lines.length}` : ""}`} dense>
        {loading && <div className="px-4 py-4 text-[12px] text-ink-muted">Loading lines…</div>}
        {!loading && (!lines || lines.length === 0) && (
          <div className="m-4 rounded-md border border-dashed border-border bg-bg/60 px-4 py-6 text-center text-[12px] text-ink-muted">
            No outstanding lines for this PO.
            {!isOutstanding && " (Header is closed/delivered.)"}
          </div>
        )}
        {lines && lines.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead className="bg-bg/50 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                <tr>
                  <th className="px-2 py-2 text-left">Item</th>
                  <th className="px-2 py-2 text-right">Qty Rem</th>
                  <th className="px-2 py-2 text-left">Delivery</th>
                  <th className="px-2 py-2 text-left">Sup 1</th>
                  <th className="px-2 py-2 text-left">Sup 2</th>
                  <th className="px-2 py-2 text-left">Sup 3</th>
                  <th className="px-2 py-2 text-left">Overdue</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id} className="border-t border-border-subtle align-top">
                    <td className="px-2 py-2">
                      <div className="font-mono text-[11px]">{l.item_code}</div>
                      <ExpandableText
                        text={l.item_description || ""}
                        lines={1}
                        emptyLabel=""
                        className="text-[11px] text-ink-muted"
                      />
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-[11px]">
                      {formatNumber(l.remaining_qty)}
                    </td>
                    <td className="px-2 py-2 text-[11px]">{formatDate(l.delivery_date)}</td>
                    <td className="px-2 py-2">
                      <DateInput line={l} field="supplier_date1" onSave={patchLine} />
                    </td>
                    <td className="px-2 py-2">
                      <DateInput line={l} field="supplier_date2" onSave={patchLine} />
                    </td>
                    <td className="px-2 py-2">
                      <DateInput line={l} field="supplier_date3" onSave={patchLine} />
                    </td>
                    <td className="px-2 py-2">
                      <input
                        type="text"
                        defaultValue={l.overdue_days || ""}
                        onBlur={(e) => {
                          if (e.target.value !== (l.overdue_days || "")) {
                            patchLine(l, { overdue_days: e.target.value || null });
                          }
                        }}
                        className="h-7 w-16 rounded-md border border-border bg-surface px-2 text-[11px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
            </Section>
      </div>
    </DetailLayout>
  );
}

/**
 * Page wrapper — mounted at /po/:docNo. Fetches the doc by number and
 * mounts the existing PO content view. Direct URL loads (deep link
 * from creditors page) work via the new GET /api/po/docs/:docNo route.
 */
export function PurchaseOrderDetail() {
  const { docNo = "" } = useParams<{ docNo: string }>();
  const [doc, setDoc] = useState<PurchaseOrderDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  useEffect(() => {
    if (!docNo) return;
    let cancelled = false;
    setLoading(true);
    api
      .get<{ data: PurchaseOrderDoc }>(`/api/po/docs/${encodeURIComponent(docNo)}`)
      .then((r) => {
        if (!cancelled) setDoc(r.data);
      })
      .catch((e: any) => toast.error(`Failed to load PO: ${e?.message || e}`))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docNo]);

  if (loading) return <div className="text-[12px] text-ink-muted">Loading…</div>;
  if (!doc) return <Navigate to="/po" replace />;
  return <PoLinesContent doc={doc} onChanged={() => {}} />;
}

function DateInput({
  line,
  field,
  onSave,
}: {
  line: PurchaseOrder;
  field: "supplier_date1" | "supplier_date2" | "supplier_date3";
  onSave: (l: PurchaseOrder, body: Record<string, any>) => void;
}) {
  return (
    <input
      type="date"
      defaultValue={line[field] || ""}
      onBlur={(e) => {
        const v = e.target.value || null;
        if (v !== line[field]) onSave(line, { [field]: v });
      }}
      className="h-7 w-32 rounded-md border border-border bg-surface px-2 text-[11px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
    />
  );
}

// Number formatter for line-detail values (Qty, UOM Rate, etc.).
// Returns "—" for null/undefined; trims trailing zeros for cleaner reads.
function fmtNum(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number") {
    if (Number.isInteger(v)) return v.toLocaleString("en-MY");
    return v.toLocaleString("en-MY", { maximumFractionDigits: 4 });
  }
  return String(v);
}

// Header field grouping — keeps the 150-field dump readable. Anything
// not in a group lands in "Other" at the bottom.
const HEADER_GROUPS: Array<{ title: string; prefix?: string; keys?: string[] }> = [
  {
    title: "Document",
    keys: [
      "DocNo", "DocDate", "Ref", "RefDocNo", "Description", "Note",
      "Remark1", "Remark2", "Remark3", "Remark4", "DocStatus", "Cancelled",
      "DisplayTerm", "Attention", "PrintCount", "Transferable", "ToDocKey", "ToDocType",
      "LastModified", "LastModifiedUserName", "CreatedTimeStamp", "CreatedUserName",
    ],
  },
  {
    title: "Amounts",
    keys: [
      "Total", "TotalExTax", "TotalWithTax", "NetTotal", "LocalNetTotal",
      "ExTax", "LocalExTax", "Tax", "LocalTax", "TaxableAmt", "LocalTaxableAmt",
      "FinalTotal", "RoundAdj", "IsRoundAdj", "InclusiveTax",
      "CurrencyCode", "CurrencyRate", "CurrencySymbol",
    ],
  },
  {
    title: "Footers",
    keys: [
      "Footer1Param", "Footer1Amt", "Footer1LocalAmt", "Footer1TaxCode", "Footer1Tax", "Footer1LocalTax",
      "Footer2Param", "Footer2Amt", "Footer2LocalAmt", "Footer2TaxCode", "Footer2Tax", "Footer2LocalTax",
      "Footer3Param", "Footer3Amt", "Footer3LocalAmt", "Footer3TaxCode", "Footer3Tax", "Footer3LocalTax",
    ],
  },
  {
    title: "Addresses",
    keys: [
      "InvAddr1", "InvAddr2", "InvAddr3", "InvAddr4", "Phone1", "Fax1",
      "DeliverAddr1", "DeliverAddr2", "DeliverAddr3", "DeliverAddr4",
      "DeliverPhone1", "DeliverFax1", "DeliverContact", "ShipVia", "ShipInfo",
    ],
  },
  { title: "Creditor", prefix: "Creditor" },
  { title: "Branch", prefix: "Branch" },
  { title: "Purchase Agent", prefix: "PurchaseAgent" },
  { title: "PO UDFs", prefix: "POUDF_" },
];

function FieldGrid({
  fields,
  groups,
}: {
  fields: Record<string, unknown>;
  groups?: typeof HEADER_GROUPS;
}) {
  // If groups provided, partition the fields. Otherwise just dump.
  if (!groups) {
    const entries = Object.entries(fields).filter(
      ([, v]) => v !== null && v !== undefined && v !== ""
    );
    if (entries.length === 0) {
      return <div className="text-[11px] text-ink-muted">No fields.</div>;
    }
    return (
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
        {entries.map(([k, v]) => (
          <FieldRow key={k} label={k} value={v} />
        ))}
      </dl>
    );
  }

  const used = new Set<string>();
  const sections: Array<{ title: string; entries: Array<[string, unknown]> }> = [];
  for (const g of groups) {
    const entries: Array<[string, unknown]> = [];
    if (g.keys) {
      for (const k of g.keys) {
        if (k in fields) {
          entries.push([k, fields[k]]);
          used.add(k);
        }
      }
    }
    if (g.prefix) {
      for (const k of Object.keys(fields)) {
        if (k.startsWith(g.prefix) && !used.has(k)) {
          entries.push([k, fields[k]]);
          used.add(k);
        }
      }
    }
    if (entries.length > 0) sections.push({ title: g.title, entries });
  }
  // Anything left
  const other: Array<[string, unknown]> = [];
  for (const k of Object.keys(fields)) {
    if (!used.has(k)) other.push([k, fields[k]]);
  }
  if (other.length > 0) sections.push({ title: "Other", entries: other });

  return (
    <div className="space-y-3">
      {sections.map((s) => (
        <div key={s.title}>
          <div className="mb-1 text-[9px] font-bold uppercase tracking-wider text-accent">
            {s.title}
          </div>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
            {s.entries
              .filter(([, v]) => v !== null && v !== undefined && v !== "")
              .map(([k, v]) => (
                <FieldRow key={k} label={k} value={v} />
              ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

function FieldRow({ label, value }: { label: string; value: unknown }) {
  let display: string;
  if (value === true) display = "true";
  else if (value === false) display = "false";
  else if (typeof value === "object") display = JSON.stringify(value);
  else display = String(value);
  return (
    <div className="flex items-baseline gap-2 border-b border-border-subtle/60 py-0.5">
      <dt
        className="min-w-[140px] truncate font-mono text-[10px] text-ink-muted"
        title={label}
      >
        {label}
      </dt>
      <dd className="min-w-0 flex-1">
        <ExpandableText
          text={display}
          lines={1}
          className="font-mono text-[11px] text-ink"
        />
      </dd>
    </div>
  );
}
