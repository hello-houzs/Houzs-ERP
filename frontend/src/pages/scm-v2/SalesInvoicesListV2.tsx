// SalesInvoicesListV2 — Theme C redesign of the Sales Invoices listing.
// Mirrors the DO V2 template (which mirrors SO V2); the three-headed sales
// chain (DO / SI / DR) shares the same chrome so this file focuses on the
// SI-specific bits: money-centric stats (Outstanding / Paid), a status flow
// biased around payment (SENT → PARTIALLY_PAID → PAID → CANCELLED), and the
// SI-specific cross-doc anchors (From SO + From DO instead of just From SO).
//
// Route: /scm/sales-invoices.
// Data:  useSalesInvoices / useSalesInvoiceDetail / useUpdateSalesInvoiceStatus
//        (all live in the vendored SCM lib; useRecordSiPayment is available
//         for a follow-up drawer action, not wired here to keep this PR to
//         chrome only.)

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Plus,
  ChevronDown,
  Wrench,
  Truck,
  LayoutGrid,
  Table as TableIcon,
  X as XIcon,
  ExternalLink,
  Edit3,
  Printer,
  CheckCircle2,
  Receipt,
} from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { StatCard } from "../../components/StatCard";
import { FilterPills } from "../../components/FilterPills";
import { DataTable, type Column } from "../../components/DataTable";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { PullToRefresh } from "../../components/PullToRefresh";
import { useStaffLookup } from "../../hooks/useStaffLookup";
import {
  useSalesInvoicesPaged,
  useSalesInvoiceDetail,
  useUpdateSalesInvoiceStatus,
} from "../../vendor/scm/lib/sales-invoice-queries";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "../../lib/utils";

// ─── Types ──────────────────────────────────────────────────────────────────
// Subset of the full SiRow (see SalesInvoicesList.tsx for the 40-field shape).

type SiRow = {
  id: string;
  invoice_number: string;
  so_doc_no: string | null;
  delivery_order_id: string | null;
  invoice_date: string;
  due_date: string | null;
  debtor_name: string;
  debtor_code: string | null;
  salesperson_id: string | null;
  sales_location: string | null;
  customer_so_no: string | null;
  po_doc_no: string | null;
  ref: string | null;
  branding: string | null;
  phone: string | null;
  email: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  postcode: string | null;
  customer_state: string | null;
  local_total_centi: number;
  total_centi: number;
  paid_centi: number;
  status: string;
  currency: string;
  line_count?: number;
};

type StatusTab = "all" | "sent" | "partial" | "paid" | "cancelled";

// ─── Helpers ────────────────────────────────────────────────────────────────

const fmtRm = (centi: number): string =>
  `RM ${(centi / 100).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const s = iso.replace(/T.*$/, "").replace(/-/g, "/");
  return s;
};

// Customer's PO / Ref — same fallback chain as SO/DO V2.
const refOf = (r: SiRow): string =>
  r.po_doc_no || r.customer_so_no || r.ref || "—";

const soOf = (r: SiRow): string => r.so_doc_no || "—";
const doOf = (r: SiRow): string => r.delivery_order_id || "—";

const brandOf = (r: SiRow): string => r.branding || "—";
const brandTone = (b: string): "success" | "neutral" | "warning" => {
  const s = (b || "").toUpperCase();
  if (s.includes("2990") || s.includes("SOFA")) return "success";
  if (s.includes("AKEMI")) return "neutral";
  if (s === "—" || !s) return "neutral";
  return "warning";
};

// SI status → filter bucket. Business flow: DRAFT → SENT → PARTIALLY_PAID →
// PAID → CANCELLED. Buckets: sent (Draft + Sent) / partial / paid / cancelled.
const STATUS_TONE: Record<
  string,
  { tone: "success" | "warning" | "error" | "neutral"; label: string; bucket: StatusTab }
> = {
  draft:           { tone: "warning", label: "Draft",       bucket: "sent" },
  sent:            { tone: "warning", label: "Sent",        bucket: "sent" },
  issued:          { tone: "warning", label: "Issued",      bucket: "sent" },
  partially_paid:  { tone: "warning", label: "Partial pay", bucket: "partial" },
  partial:         { tone: "warning", label: "Partial pay", bucket: "partial" },
  paid:            { tone: "success", label: "Paid",        bucket: "paid" },
  completed:       { tone: "success", label: "Paid",        bucket: "paid" },
  cancelled:       { tone: "error",   label: "Cancelled",   bucket: "cancelled" },
  cancel:          { tone: "error",   label: "Cancelled",   bucket: "cancelled" },
};

const statusFor = (
  s: string
): { tone: "success" | "warning" | "error" | "neutral"; label: string; bucket: StatusTab } =>
  STATUS_TONE[(s || "").toLowerCase()] ?? {
    tone: "neutral",
    label: s || "—",
    bucket: "sent",
  };

// Derived outstanding (Total − Paid). Guards against negative from over-payment.
const outstandingOf = (r: SiRow): number =>
  Math.max(0, (r.total_centi || r.local_total_centi || 0) - (r.paid_centi || 0));

// ─── Split-menu dropdown ────────────────────────────────────────────────────

function SplitDropdown({
  onFromDo,
  onFromSo,
  onImport,
}: {
  onFromDo: () => void;
  onFromSo: () => void;
  onImport: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex h-9 items-center rounded-md border border-primary/60 bg-primary/10 px-2.5 text-primary hover:bg-primary/20"
      >
        <ChevronDown size={14} />
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-[80]"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            role="menu"
            className="absolute right-0 top-full z-[81] mt-1.5 min-w-[220px] rounded-md border border-border bg-surface py-1 shadow-slab"
          >
            <button
              type="button"
              className="block w-full px-3.5 py-2 text-left text-[12.5px] text-ink hover:bg-primary-soft"
              onClick={() => {
                setOpen(false);
                onFromDo();
              }}
            >
              New from Delivery Order
            </button>
            <button
              type="button"
              className="block w-full px-3.5 py-2 text-left text-[12.5px] text-ink hover:bg-primary-soft"
              onClick={() => {
                setOpen(false);
                onFromSo();
              }}
            >
              New from Sales Order
            </button>
            <button
              type="button"
              className="block w-full px-3.5 py-2 text-left text-[12.5px] text-ink hover:bg-primary-soft"
              onClick={() => {
                setOpen(false);
                onImport();
              }}
            >
              Import from file
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ViewToggle({
  value,
  onChange,
}: {
  value: "table" | "cards";
  onChange: (v: "table" | "cards") => void;
}) {
  const btn = (which: "table" | "cards", label: string, Icon: typeof TableIcon) => {
    const active = value === which;
    return (
      <button
        type="button"
        onClick={() => onChange(which)}
        aria-pressed={active}
        className={cn(
          "inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors",
          active
            ? "bg-primary text-white shadow-sm"
            : "text-ink-secondary hover:bg-primary-soft hover:text-primary"
        )}
      >
        <Icon size={13} />
        {label}
      </button>
    );
  };
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md border border-border bg-surface p-1 shadow-stone">
      {btn("table", "Table", TableIcon)}
      {btn("cards", "Cards", LayoutGrid)}
    </div>
  );
}

// ─── Cards grid ─────────────────────────────────────────────────────────────

function CardsGrid({ rows, onOpen }: { rows: SiRow[]; onOpen: (r: SiRow) => void }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface px-6 py-16 text-center shadow-stone">
        <div className="text-[13px] font-semibold text-ink">No sales invoices</div>
        <div className="mt-1 text-[12px] text-ink-muted">
          No invoices match the current filters. Try Reset layout to clear the
          search and status tabs.
        </div>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
      {rows.map((r) => {
        const st = statusFor(r.status);
        const brand = brandOf(r);
        const outstanding = outstandingOf(r);
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onOpen(r)}
            className="group relative overflow-hidden rounded-lg border border-border bg-surface px-4 py-4 text-left shadow-stone transition-all duration-200 hover:-translate-y-px hover:border-primary/40 hover:shadow-slab focus:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[12.5px] font-semibold text-ink">
                {r.invoice_number}
              </span>
              <Badge tone={st.tone} size="xs">{st.label}</Badge>
            </div>
            <div className="mt-2 truncate text-[15px] font-semibold text-ink">
              {r.debtor_name || "—"}
            </div>
            <div className="mt-1 flex items-center gap-2">
              <Badge tone={brandTone(brand)} variant="soft" size="xs">
                {brand}
              </Badge>
              <span className="text-[11.5px] text-ink-muted">
                {fmtDate(r.invoice_date)}
              </span>
            </div>
            <div className="mt-3.5 flex items-end justify-between border-t border-border-subtle pt-3">
              <div className="min-w-0">
                <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                  Outstanding
                </div>
                <div
                  className={cn(
                    "mt-0.5 font-money text-[12.5px] font-semibold",
                    outstanding > 0 ? "text-err" : "text-synced"
                  )}
                >
                  {outstanding > 0 ? fmtRm(outstanding) : "Cleared"}
                </div>
              </div>
              <span className="font-money text-[15px] font-bold text-ink">
                {fmtRm(r.total_centi || r.local_total_centi)}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ─── Detail drawer ─────────────────────────────────────────────────────────

function DetailDrawer({
  row,
  onClose,
  onOpenFull,
  onEdit,
  onPrint,
  onMarkPaid,
  onRecordPayment,
  salespersonName,
}: {
  row: SiRow | null;
  onClose: () => void;
  onOpenFull: () => void;
  onEdit: () => void;
  onPrint: () => void;
  onMarkPaid: () => void;
  onRecordPayment: () => void;
  salespersonName: string;
}) {
  const detailQ = useSalesInvoiceDetail(row?.id ?? null);
  const items: Array<{
    product_code?: string;
    product_name?: string;
    description?: string;
    qty?: number;
    unit_price_centi?: number;
    amount_centi?: number;
    total_centi?: number;
  }> =
    ((detailQ.data as { items?: unknown[] } | undefined)?.items as Array<{
      product_code?: string;
      product_name?: string;
      description?: string;
      qty?: number;
      unit_price_centi?: number;
      amount_centi?: number;
      total_centi?: number;
    }>) ?? [];

  const open = !!row;
  const st = row ? statusFor(row.status) : null;

  const totalCenti = row?.total_centi ?? row?.local_total_centi ?? 0;
  const paidCenti = row?.paid_centi ?? 0;
  const outstanding = Math.max(0, totalCenti - paidCenti);

  return (
    <>
      {/* Scrim — mobile only. On desktop the outer wrapper reflows via
          md:pr-[540px] so the underlying content stays fully visible next
          to the drawer; no need to dim it. */}
      <div
        onClick={onClose}
        aria-hidden
        className={cn(
          "fixed inset-0 z-[90] bg-ink/40 backdrop-blur-[1px] transition-opacity duration-200 md:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={row ? `Sales invoice ${row.invoice_number}` : "Sales invoice details"}
        className={cn(
          "fixed right-0 top-0 z-[91] flex h-full w-full max-w-[520px] flex-col border-l border-border bg-surface shadow-slab transition-transform duration-200",
          open ? "translate-x-0" : "translate-x-full"
        )}
      >
        {row && st && (
          <>
            <div className="flex h-[60px] shrink-0 items-center gap-3 bg-sidebar px-5 text-sidebar-ink">
              <button
                type="button"
                onClick={onClose}
                className="text-sidebar-ink-muted hover:text-sidebar-ink"
                aria-label="Close details"
              >
                <XIcon size={18} />
              </button>
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[14px] font-bold tracking-wide">
                  {row.invoice_number}
                </div>
                <div className="mt-0.5 text-[11px] text-sidebar-ink-muted">Sales Invoice</div>
              </div>
              <button
                type="button"
                onClick={onOpenFull}
                className="inline-flex items-center gap-1.5 rounded-md border border-accent-bright/40 px-2.5 py-1.5 text-[11.5px] font-semibold text-accent-bright hover:bg-accent-bright/10"
              >
                Open full page <ExternalLink size={12} />
              </button>
              <Badge tone={st.tone} variant="solid" size="xs">
                {st.label}
              </Badge>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-5">
              <div className="text-[19px] font-bold text-ink">{row.debtor_name || "—"}</div>
              <div className="mt-1.5 flex items-center gap-2.5">
                <Badge tone={brandTone(brandOf(row))} variant="soft" size="xs">
                  {brandOf(row)}
                </Badge>
                <span className="text-[12.5px] text-ink-muted">
                  Issued {fmtDate(row.invoice_date)}
                </span>
              </div>

              <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border bg-surface-2 px-4 py-4">
                <MetaItem k="From SO" v={soOf(row)} mono />
                <MetaItem k="From DO" v={doOf(row)} mono />
                <MetaItem k="Customer ref" v={refOf(row)} mono />
                <MetaItem k="Due date" v={fmtDate(row.due_date)} />
                <MetaItem k="Location" v={row.sales_location || "—"} />
                <MetaItem k="Salesperson" v={salespersonName} />
              </dl>

              <SectionHeading>Customer</SectionHeading>
              <div className="overflow-hidden rounded-lg border border-border bg-surface">
                <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3.5">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[13px] font-bold text-accent-ink">
                    {(row.debtor_name || "C")
                      .split(/\s+/)
                      .filter(Boolean)
                      .slice(0, 2)
                      .map((w) => w[0]?.toUpperCase())
                      .join("") || "C"}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[14px] font-bold text-ink">{row.debtor_name}</div>
                    {row.debtor_code && (
                      <div className="mt-0.5 font-mono text-[11.5px] text-ink-muted">
                        {row.debtor_code}
                      </div>
                    )}
                  </div>
                </div>
                <RowKV k="Phone" v={row.phone || "—"} />
                <RowKV k="Email" v={row.email || "—"} />
                <RowKV
                  k="Address"
                  v={
                    [row.address1, row.address2, row.city, row.postcode, row.customer_state]
                      .filter(Boolean)
                      .join(", ") || "—"
                  }
                />
              </div>

              <SectionHeading>Line items</SectionHeading>
              <div className="overflow-hidden rounded-lg border border-border">
                <div className="grid grid-cols-[1fr_52px_92px] gap-2 border-b border-border-subtle bg-surface-2 px-4 py-2 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                  <span>Item</span>
                  <span className="text-right">Qty</span>
                  <span className="text-right">Amount</span>
                </div>
                {detailQ.isLoading && (
                  <div className="px-4 py-8 text-center text-[12px] text-ink-muted">
                    Loading lines…
                  </div>
                )}
                {!detailQ.isLoading && items.length === 0 && (
                  <div className="px-4 py-8 text-center text-[12px] text-ink-muted">
                    No lines
                  </div>
                )}
                {items.map((l, i) => {
                  const amt =
                    l.amount_centi ??
                    l.total_centi ??
                    (l.qty ?? 0) * (l.unit_price_centi ?? 0);
                  return (
                    <div
                      key={i}
                      className="grid grid-cols-[1fr_52px_92px] items-center gap-2 border-b border-border-subtle px-4 py-3 last:border-b-0"
                    >
                      <div>
                        <div className="text-[13px] font-semibold text-ink">
                          {l.description || l.product_name || "—"}
                        </div>
                        {l.product_code && (
                          <div className="mt-0.5 font-mono text-[11px] text-ink-muted">
                            {l.product_code}
                          </div>
                        )}
                      </div>
                      <span className="text-right font-money text-[12.5px] text-ink-secondary">
                        {l.qty ?? 0}
                      </span>
                      <span className="text-right font-money text-[12.5px] font-semibold text-ink">
                        {fmtRm(amt)}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* SI totals — payment-forward: Total / Paid / Outstanding are
                  what the operator actually reads on this doc. Subtotal / SST
                  are 6%-inclusive in Malaysia so we don't split them out. */}
              <div className="mt-4 rounded-lg border border-border bg-surface px-5 py-4">
                <TotalRow k="Invoice total" v={fmtRm(totalCenti)} strong />
                <TotalRow k="Paid" v={fmtRm(paidCenti)} tone="success" />
                <TotalRow
                  k="Outstanding"
                  v={outstanding > 0 ? fmtRm(outstanding) : "Cleared"}
                  tone={outstanding > 0 ? "error" : "success"}
                />
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2 border-t border-border bg-surface px-5 py-3">
              <Button variant="ghost" icon={<Edit3 size={14} />} onClick={onEdit}>
                Edit
              </Button>
              <Button variant="ghost" icon={<Printer size={14} />} onClick={onPrint}>
                Print
              </Button>
              <div className="flex-1" />
              {(() => {
                const s = (row.status || "").toLowerCase();
                if (["draft", "sent", "issued", "partially_paid", "partial"].includes(s)) {
                  if (outstanding > 0) {
                    return (
                      <Button
                        variant="primary"
                        icon={<Receipt size={14} />}
                        onClick={onRecordPayment}
                      >
                        Record payment
                      </Button>
                    );
                  }
                  return (
                    <Button
                      variant="primary"
                      icon={<CheckCircle2 size={14} />}
                      onClick={onMarkPaid}
                    >
                      Mark paid
                    </Button>
                  );
                }
                return null;
              })()}
            </div>
          </>
        )}
      </aside>
    </>
  );
}

function MetaItem({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div>
      <dt className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
        {k}
      </dt>
      <dd
        className={cn(
          "mt-0.5 text-[13px] font-semibold text-ink",
          mono && "font-mono"
        )}
      >
        {v}
      </dd>
    </div>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2.5 mt-6 font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
      {children}
    </div>
  );
}

function RowKV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-start gap-3 border-b border-border-subtle px-4 py-2.5 last:border-b-0">
      <span className="w-20 shrink-0 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
        {k}
      </span>
      <span className="flex-1 text-[13px] font-semibold leading-relaxed text-ink">
        {v}
      </span>
    </div>
  );
}

function TotalRow({
  k,
  v,
  strong,
  tone,
}: {
  k: string;
  v: string;
  strong?: boolean;
  tone?: "success" | "error";
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between py-1.5",
        strong && "border-b border-border-subtle pb-2.5 mb-1"
      )}
    >
      <span
        className={cn(
          "text-[12px] text-ink-muted",
          strong && "text-[13px] font-semibold text-ink"
        )}
      >
        {k}
      </span>
      <span
        className={cn(
          "font-money text-[13px] font-semibold",
          strong && "text-[15px] font-bold text-ink",
          tone === "success" && "text-synced",
          tone === "error" && "text-err"
        )}
      >
        {v}
      </span>
    </div>
  );
}

// ─── Pagination footer ──────────────────────────────────────────────────────

function PaginationFooter({
  page,
  pageSize,
  total,
  onPrev,
  onNext,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min((page + 1) * pageSize, total);
  const atStart = page === 0;
  const atEnd = (page + 1) * pageSize >= total;
  return (
    <div className="mt-4 flex items-center justify-between gap-3">
      <span className="text-[12px] text-ink-muted">
        Showing {from}
        {to > from ? `–${to}` : ""} of {total}
      </span>
      <div className="flex items-center gap-2">
        <Button variant="secondary" onClick={onPrev} disabled={atStart}>
          Prev
        </Button>
        <Button variant="secondary" onClick={onNext} disabled={atEnd}>
          Next
        </Button>
      </div>
    </div>
  );
}

// Table column key → backend sort-whitelist column. SI backend whitelist is
// { invoice_date, invoice_number, debtor_name, status, total_centi }; only the
// `amount` (Total) column key differs from its backend name. Non-whitelisted
// columns carry `disableSort`.
const SORT_COL_MAP: Record<string, string> = {
  amount: "total_centi",
};

// Filter-pill bucket → single sales_invoices.status DB value. Only `cancelled`
// is a single DB status; sent / partial / paid are MULTI-status buckets (sent =
// DRAFT+SENT+ISSUED, partial = PARTIALLY_PAID+PARTIAL, paid = PAID+COMPLETED)
// that the backend's single `.eq('status', …)` can't express — those send NO
// status (list shows all rows, still paginated; pill COUNTS stay correct from
// statusCounts). Flagged limitation, per "never return wrong rows".
const SI_BUCKET_STATUS: Partial<Record<StatusTab, string>> = {
  cancelled: "CANCELLED",
};

// ─── Main page ──────────────────────────────────────────────────────────────

export function SalesInvoicesListV2() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { nameOf: salespersonNameOf } = useStaffLookup();

  const status = (params.get("status") ?? "all") as StatusTab;
  const view = (params.get("view") ?? "table") as "table" | "cards";
  const search = params.get("q") ?? "";
  const page = Math.max(0, parseInt(params.get("page") ?? "0", 10) || 0);
  const pageSize = 50;

  const [selected, setSelected] = useState<SiRow | null>(null);
  const [sort, setSort] = useState<string | undefined>(undefined);
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // sent / partial / paid are multi-status buckets the backend's single
  // `.eq('status', …)` can't express, so send NO status for them (all rows,
  // still paginated + counted) rather than an incomplete/empty page.
  const apiStatus = status === "all" ? undefined : SI_BUCKET_STATUS[status];

  const { data, isLoading, error } = useSalesInvoicesPaged({
    page,
    pageSize,
    status: apiStatus,
    q: debouncedSearch,
    sort,
  });
  const updateStatus = useUpdateSalesInvoiceStatus();

  // Server already filtered + sorted this page — render verbatim.
  const rows = (data?.salesInvoices ?? []) as SiRow[];
  const total = data?.total ?? 0;
  const counts = data?.statusCounts ?? {
    all: 0,
    sent: 0,
    partial: 0,
    paid: 0,
    cancelled: 0,
  };

  // Money KPIs are summed over the CURRENT page only (paginated contract has no
  // full-set money sums), so their cards are labelled "on this page".
  const money = useMemo(() => {
    let revenueCenti = 0;
    let outstandingCenti = 0;
    let paidCenti = 0;
    for (const r of rows) {
      const t = r.total_centi ?? r.local_total_centi ?? 0;
      const paid = r.paid_centi ?? 0;
      revenueCenti += t;
      paidCenti += paid;
      outstandingCenti += Math.max(0, t - paid);
    }
    return { revenueCenti, outstandingCenti, paidCenti };
  }, [rows]);

  const setPageParam = (p: number) => {
    const next = new URLSearchParams(params);
    if (p <= 0) next.delete("page");
    else next.set("page", String(p));
    setParams(next, { replace: true });
  };
  const setStatusChip = (s: StatusTab) => {
    const next = new URLSearchParams(params);
    if (s === "all") next.delete("status");
    else next.set("status", s);
    next.delete("page");
    setParams(next, { replace: true });
  };
  const setView = (v: "table" | "cards") => {
    const next = new URLSearchParams(params);
    if (v === "table") next.delete("view");
    else next.set("view", v);
    setParams(next, { replace: true });
  };
  const setSearch = (q: string) => {
    const next = new URLSearchParams(params);
    if (!q.trim()) next.delete("q");
    else next.set("q", q);
    next.delete("page");
    setParams(next, { replace: true });
  };
  const sortSyncedRef = useRef(false);
  const setSortAndReset = (s: { key: string; dir: "asc" | "desc" } | null) => {
    setSort(s ? `${SORT_COL_MAP[s.key] ?? s.key}:${s.dir}` : undefined);
    if (!sortSyncedRef.current) {
      sortSyncedRef.current = true;
      return;
    }
    setPageParam(0);
  };
  const resetLayout = () => {
    setSort(undefined);
    setParams(new URLSearchParams(), { replace: true });
  };
  const filtersActive =
    status !== "all" || view !== "table" || search.trim().length > 0;

  const onPullToRefresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["sales-invoices"] });
  };

  const goNewSi = () => navigate("/scm/sales-invoices/new");
  const goFromDo = () => navigate("/scm/sales-invoices/from-do");
  const goFromSo = () => navigate("/scm/sales-invoices/from-so");
  const goImport = () => navigate("/scm/sales-invoices?import=1");
  const goDoList = () => navigate("/scm/delivery-orders");
  const goOutstanding = () => navigate("/scm/outstanding");
  const goEdit = (r: SiRow) => navigate(`/scm/sales-invoices/${r.id}?edit=1`);
  const goPrint = (r: SiRow) => navigate(`/scm/sales-invoices/${r.id}?print=1`);
  const goFullPage = (r: SiRow) => navigate(`/scm/sales-invoices/${r.id}`);
  const doMarkPaid = (r: SiRow) =>
    updateStatus.mutate(
      { id: r.id, status: "paid" },
      { onSuccess: () => setSelected(null) }
    );
  const goRecordPayment = (r: SiRow) =>
    navigate(`/scm/sales-invoices/${r.id}?tab=payments&record=1`);

  const columns: Column<SiRow>[] = [
    {
      key: "invoice_number",
      label: "SI No.",
      width: "132px",
      alwaysVisible: true,
      getValue: (r) => r.invoice_number,
      render: (r) => (
        <span className="font-mono text-[12.5px] font-semibold text-ink">
          {r.invoice_number}
        </span>
      ),
    },
    {
      key: "invoice_date",
      label: "Date",
      width: "108px",
      getValue: (r) => r.invoice_date,
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{fmtDate(r.invoice_date)}</span>
      ),
    },
    {
      key: "due_date",
      label: "Due",
      width: "108px",
      disableSort: true,
      getValue: (r) => r.due_date ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{fmtDate(r.due_date)}</span>
      ),
    },
    {
      key: "so_doc_no",
      label: "From SO",
      width: "128px",
      disableSort: true,
      getValue: (r) => r.so_doc_no ?? "",
      render: (r) => (
        <span className="font-mono text-[12px] text-ink-secondary">{soOf(r)}</span>
      ),
    },
    {
      key: "debtor_name",
      label: "Customer",
      getValue: (r) => r.debtor_name,
      render: (r) => (
        <span className="text-[13px] font-semibold text-ink">
          {r.debtor_name || "—"}
        </span>
      ),
    },
    {
      key: "reference",
      label: "Customer ref",
      width: "132px",
      disableSort: true,
      getValue: (r) => refOf(r),
      render: (r) => (
        <span className="font-mono text-[12px] text-ink-secondary">{refOf(r)}</span>
      ),
    },
    {
      key: "status",
      label: "Status",
      width: "116px",
      getValue: (r) => r.status,
      render: (r) => {
        const st = statusFor(r.status);
        return (
          <Badge tone={st.tone} size="xs">
            {st.label}
          </Badge>
        );
      },
    },
    {
      key: "outstanding",
      label: "Outstanding",
      width: "128px",
      align: "right",
      // Derived (Total − Paid) — not a backend-sortable column.
      disableSort: true,
      getValue: (r) => outstandingOf(r),
      render: (r) => {
        const outstanding = outstandingOf(r);
        return (
          <span
            className={cn(
              "font-money text-[13px] font-semibold",
              outstanding > 0 ? "text-err" : "text-synced"
            )}
          >
            {outstanding > 0 ? fmtRm(outstanding) : "Cleared"}
          </span>
        );
      },
    },
    {
      key: "amount",
      label: "Total",
      width: "128px",
      align: "right",
      getValue: (r) => r.total_centi ?? r.local_total_centi,
      render: (r) => (
        <span className="font-money text-[13px] font-semibold text-ink">
          {fmtRm(r.total_centi || r.local_total_centi)}
        </span>
      ),
    },
  ];

  const statusPillOptions: Array<{ value: StatusTab; label: string }> = [
    { value: "all", label: `All · ${counts.all}` },
    { value: "sent", label: `Sent · ${counts.sent}` },
    { value: "partial", label: `Partial · ${counts.partial}` },
    { value: "paid", label: `Paid · ${counts.paid}` },
    { value: "cancelled", label: `Cancelled · ${counts.cancelled}` },
  ];

  return (
    <PullToRefresh onRefresh={onPullToRefresh}>
      {/* When the drawer is open the desktop shell reflows into the left
          520 + gutter so stats/table are cleanly visible next to it instead
          of being half-covered. Mobile keeps the full-width overlay. */}
      <div
        className={cn(
          "transition-[padding] duration-200",
          selected ? "md:pr-[540px]" : ""
        )}
      >
      <div className="mb-3 flex items-start justify-between gap-3 md:hidden">
        <div className="min-w-0">
          <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">
            Sales Invoices
          </h1>
          <div className="mt-0.5 text-[12.5px] text-ink-muted">
            {total} invoice{total === 1 ? "" : "s"} ·{" "}
            <span className="font-money">{fmtRm(money.revenueCenti)}</span> billed
          </div>
        </div>
      </div>

      {/* Desktop sticky page chrome — matches SO/DO listing pattern. */}
      <div className="sticky top-0 z-20 -mx-4 hidden bg-bg/95 pb-3 backdrop-blur-sm sm:-mx-6 md:block">
        <div className="px-4 sm:px-6">
          <PageHeader
            eyebrow="Supply Chain"
            title="Sales Invoices"
            description="Every Houzs sales invoice — Sent to Paid. Click any row for the quick view; open the full page to edit or record a payment."
            primaryAction={
              <div className="flex items-stretch">
                <Button
                  variant="primary"
                  icon={<Plus size={14} />}
                  onClick={goNewSi}
                  className="rounded-r-none"
                >
                  New Sales Invoice
                </Button>
                <SplitDropdown
                  onFromDo={goFromDo}
                  onFromSo={goFromSo}
                  onImport={goImport}
                />
              </div>
            }
            secondaryActions={[
              { label: "Delivery Orders", icon: Truck, onClick: goDoList },
              { label: "Outstanding Ledger", icon: Wrench, onClick: goOutstanding },
            ]}
          />

          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              label="Total Invoices"
              value={total.toLocaleString("en-MY")}
              subtitle="All matching invoices"
              rail="bg-primary"
              active
            />
            <StatCard
              label="Billed"
              value={fmtRm(money.revenueCenti)}
              subtitle="Sum on this page"
              rail="bg-accent"
            />
            <StatCard
              label="Outstanding"
              value={fmtRm(money.outstandingCenti)}
              subtitle="Balance on this page"
              tone="error"
              rail="bg-err"
            />
            <StatCard
              label="Paid"
              value={fmtRm(money.paidCenti)}
              subtitle="Receipts on this page"
              tone="success"
              rail="bg-synced"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <FilterPills
              options={statusPillOptions}
              value={status}
              onChange={(v) => setStatusChip(v)}
            />
            <div className="flex-1" />
            <ViewToggle value={view} onChange={setView} />
          </div>
        </div>
      </div>

      <div className="sticky top-0 z-10 -mx-4 mb-3 bg-bg/95 px-4 py-2 backdrop-blur-sm md:hidden">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search SI, customer, ref…"
          className="h-10 w-full rounded-lg border border-border bg-surface px-3.5 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3 md:hidden">
        <FilterPills
          options={statusPillOptions}
          value={status}
          onChange={(v) => setStatusChip(v)}
        />
      </div>

      <div className="md:hidden">
        <CardsGrid rows={rows} onOpen={(r) => setSelected(r)} />
        <div className="pb-24">
          <PaginationFooter
            page={page}
            pageSize={pageSize}
            total={total}
            onPrev={() => setPageParam(page - 1)}
            onNext={() => setPageParam(page + 1)}
          />
        </div>
      </div>

      <div className="hidden md:block">
        {view === "table" ? (
          <>
            <DataTable<SiRow>
              tableId="sales-invoices-v2"
              rows={rows}
              loading={isLoading}
              error={error ? (error as Error).message ?? "Failed to load" : null}
              columns={columns}
              getRowKey={(r) => r.id}
              onRowClick={(r) => setSelected(r)}
              exportName="sales-invoices"
              serverSort
              onSortChange={setSortAndReset}
              emptyLabel={
                filtersActive
                  ? "No invoices match — try Reset layout to clear filters."
                  : "No sales invoices yet."
              }
              search={{
                value: search,
                onChange: setSearch,
                placeholder: "Search SI no, customer, ref…",
              }}
              resetFilters={{
                active: filtersActive,
                onReset: resetLayout,
                label: "Reset layout",
              }}
            />
            <PaginationFooter
              page={page}
              pageSize={pageSize}
              total={total}
              onPrev={() => setPageParam(page - 1)}
              onNext={() => setPageParam(page + 1)}
            />
          </>
        ) : (
          <>
            <div className="mb-3 flex items-center justify-between">
              <div className="flex flex-1 items-center gap-2">
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search SI no, customer, ref…"
                  className="h-9 max-w-[320px] flex-1 rounded-md border border-border bg-surface px-3.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
                {filtersActive && (
                  <button
                    type="button"
                    onClick={resetLayout}
                    className="text-[12px] font-semibold text-primary hover:underline"
                  >
                    Reset layout
                  </button>
                )}
              </div>
            </div>
            <CardsGrid rows={rows} onOpen={(r) => setSelected(r)} />
            <PaginationFooter
              page={page}
              pageSize={pageSize}
              total={total}
              onPrev={() => setPageParam(page - 1)}
              onNext={() => setPageParam(page + 1)}
            />
          </>
        )}
      </div>
      </div>

      <DetailDrawer
        row={selected}
        onClose={() => setSelected(null)}
        onOpenFull={() => selected && goFullPage(selected)}
        onEdit={() => selected && goEdit(selected)}
        onPrint={() => selected && goPrint(selected)}
        onMarkPaid={() => selected && doMarkPaid(selected)}
        onRecordPayment={() => selected && goRecordPayment(selected)}
        salespersonName={
          selected ? salespersonNameOf(null, selected.salesperson_id) : "—"
        }
      />
    </PullToRefresh>
  );
}

export default SalesInvoicesListV2;
