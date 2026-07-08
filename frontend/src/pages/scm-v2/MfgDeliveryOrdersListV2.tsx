// MfgDeliveryOrdersListV2 — Theme C redesign of the Delivery Orders listing.
// Mirrors the SO V2 template (MfgSalesOrdersListV2): PageHeader + StatCard
// grid + FilterPills + Table/Cards toggle + right slide-over detail drawer.
// See MfgSalesOrdersListV2.tsx for the deep dive on primitives + Theme C
// conventions — this file is deliberately structured the same way so the
// three-headed sales chain (DO / SI / DR) can share the template.
//
// Route: /scm/delivery-orders (App.tsx flips ScmDeliveryOrdersV2 here).
// Data: useMfgDeliveryOrders / useMfgDeliveryOrderDetail /
//       useUpdateMfgDeliveryOrderStatus (all live in the vendored SCM lib —
//       we don't re-derive them; the Theme C paint is chrome-only).

import { useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Plus,
  ChevronDown,
  Truck,
  Wrench,
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
  useMfgDeliveryOrders,
  useMfgDeliveryOrderDetail,
  useUpdateMfgDeliveryOrderStatus,
} from "../../vendor/scm/lib/delivery-order-queries";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "../../lib/utils";

// ─── Types ──────────────────────────────────────────────────────────────────
// Subset of the full DoRow (see MfgDeliveryOrdersList.tsx for the 40-field
// shape). Fields not listed here still exist on the API payload — they just
// aren't rendered by this V2 chrome.

type DoRow = {
  id: string;
  do_number: string;
  so_doc_no: string | null;
  do_date: string;
  expected_delivery_at: string | null;
  customer_delivery_date: string | null;
  debtor_name: string;
  debtor_code: string | null;
  salesperson_id: string | null;
  sales_location: string | null;
  customer_so_no: string | null;
  po_doc_no: string | null;
  ref: string | null;
  branding: string | null;
  driver_name: string | null;
  vehicle: string | null;
  phone: string | null;
  email: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  postcode: string | null;
  customer_state: string | null;
  status: string;
  currency: string;
  local_total_centi: number;
  line_count?: number;
  lifecycle_state?: "shipped" | "invoiced" | "returned";
  is_dropship?: boolean;
  isDropship?: boolean;
};

type StatusTab = "all" | "open" | "in_transit" | "delivered" | "cancelled";

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

// Customer's PO / Ref. Same fallback chain as the SO V2 template.
const refOf = (r: DoRow): string =>
  r.po_doc_no || r.customer_so_no || r.ref || "—";

// Origin SO number for the "SO Ref" column — the Delivery Order's most useful
// cross-doc anchor. Falls back to a dash for direct-issue DOs.
const soOf = (r: DoRow): string => r.so_doc_no || "—";

const brandOf = (r: DoRow): string => r.branding || "—";
const brandTone = (b: string): "success" | "neutral" | "warning" | "accent" => {
  const s = (b || "").toUpperCase();
  if (s.includes("2990") || s.includes("SOFA")) return "success";
  if (s.includes("AKEMI")) return "neutral";
  if (s === "—" || !s) return "neutral";
  return "warning";
};

// DO lifecycle: LOADED → DISPATCHED → IN_TRANSIT → SIGNED → DELIVERED →
// INVOICED, plus CANCELLED. Compress into 4 buckets for the filter pills
// (open / in_transit / delivered / cancelled) so the row of tabs stays
// scannable — the full status shows in each row's Badge.
const STATUS_TONE: Record<
  string,
  { tone: "success" | "warning" | "error" | "neutral"; label: string; bucket: StatusTab }
> = {
  draft:       { tone: "warning", label: "Draft",       bucket: "open" },
  loaded:      { tone: "warning", label: "Loaded",      bucket: "open" },
  // "warning" (amber) doubles as the "in-transit" tone — Badge only ships
  // 4 tones (success/warning/error/neutral); the label carries the nuance.
  dispatched:  { tone: "warning", label: "Dispatched",  bucket: "in_transit" },
  in_transit:  { tone: "warning", label: "In transit",  bucket: "in_transit" },
  signed:      { tone: "success", label: "Signed",      bucket: "delivered" },
  delivered:   { tone: "success", label: "Delivered",   bucket: "delivered" },
  invoiced:    { tone: "success", label: "Invoiced",    bucket: "delivered" },
  completed:   { tone: "success", label: "Completed",   bucket: "delivered" },
  cancelled:   { tone: "error",   label: "Cancelled",   bucket: "cancelled" },
  cancel:      { tone: "error",   label: "Cancelled",   bucket: "cancelled" },
};

const statusFor = (
  s: string
): { tone: "success" | "warning" | "error" | "neutral"; label: string; bucket: StatusTab } =>
  STATUS_TONE[(s || "").toLowerCase()] ?? {
    tone: "neutral",
    label: s || "—",
    bucket: "open",
  };

// ─── Split-menu dropdown (mirrors SO V2) ───────────────────────────────────

function SplitDropdown({
  onFromSo,
  onImport,
  onDuplicate,
}: {
  onFromSo: () => void;
  onImport: () => void;
  onDuplicate: () => void;
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
            <button
              type="button"
              className="block w-full px-3.5 py-2 text-left text-[12.5px] text-ink hover:bg-primary-soft"
              onClick={() => {
                setOpen(false);
                onDuplicate();
              }}
            >
              Duplicate last DO
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

// ─── Cards grid (shared shape with SO V2 — only fields differ) ─────────────

function CardsGrid({ rows, onOpen }: { rows: DoRow[]; onOpen: (r: DoRow) => void }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface px-6 py-16 text-center shadow-stone">
        <div className="text-[13px] font-semibold text-ink">No delivery orders</div>
        <div className="mt-1 text-[12px] text-ink-muted">
          No orders match the current filters. Try Reset layout to clear the search
          and status tabs.
        </div>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
      {rows.map((r) => {
        const st = statusFor(r.status);
        const brand = brandOf(r);
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onOpen(r)}
            className="group relative overflow-hidden rounded-lg border border-border bg-surface px-4 py-4 text-left shadow-stone transition-all duration-200 hover:-translate-y-px hover:border-primary/40 hover:shadow-slab focus:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[12.5px] font-semibold text-ink">
                {r.do_number}
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
              <span className="text-[11.5px] text-ink-muted">{fmtDate(r.do_date)}</span>
            </div>
            <div className="mt-3.5 flex items-end justify-between border-t border-border-subtle pt-3">
              <div className="min-w-0">
                <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                  From SO
                </div>
                <div className="mt-0.5 truncate font-mono text-[12px] font-semibold text-ink-secondary">
                  {soOf(r)}
                </div>
              </div>
              <span className="font-money text-[15px] font-bold text-ink">
                {fmtRm(r.local_total_centi)}
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
  onMarkSigned,
  onConvertToSi,
  salespersonName,
}: {
  row: DoRow | null;
  onClose: () => void;
  onOpenFull: () => void;
  onEdit: () => void;
  onPrint: () => void;
  onMarkSigned: () => void;
  onConvertToSi: () => void;
  salespersonName: string;
}) {
  const detailQ = useMfgDeliveryOrderDetail(row?.id ?? null);
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

  const totalCenti = row?.local_total_centi ?? 0;

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
        aria-label={row ? `Delivery order ${row.do_number}` : "Delivery order details"}
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
                  {row.do_number}
                </div>
                <div className="mt-0.5 text-[11px] text-sidebar-ink-muted">Delivery Order</div>
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
                  Issued {fmtDate(row.do_date)}
                </span>
              </div>

              <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border bg-surface-2 px-4 py-4">
                <MetaItem k="From SO" v={soOf(row)} mono />
                <MetaItem k="Customer ref" v={refOf(row)} mono />
                <MetaItem k="Delivery date" v={fmtDate(row.customer_delivery_date)} />
                <MetaItem k="Expected at" v={fmtDate(row.expected_delivery_at)} />
                <MetaItem k="Driver" v={row.driver_name || "—"} />
                <MetaItem k="Vehicle" v={row.vehicle || "—"} />
                <MetaItem k="Location" v={row.sales_location || "—"} />
                <MetaItem k="Salesperson" v={salespersonName} />
              </dl>

              <SectionHeading>Customer &amp; delivery</SectionHeading>
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

              <div className="mt-4 rounded-lg border border-border bg-surface px-5 py-4">
                <TotalRow k="DO total" v={fmtRm(totalCenti)} strong />
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
                if (["loaded", "dispatched", "in_transit"].includes(s)) {
                  return (
                    <Button
                      variant="primary"
                      icon={<CheckCircle2 size={14} />}
                      onClick={onMarkSigned}
                    >
                      Mark signed
                    </Button>
                  );
                }
                if (["signed", "delivered"].includes(s)) {
                  return (
                    <Button
                      variant="primary"
                      icon={<Receipt size={14} />}
                      onClick={onConvertToSi}
                    >
                      Convert to SI
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
}: {
  k: string;
  v: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-1.5">
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
          strong && "text-[15px] font-bold text-ink"
        )}
      >
        {v}
      </span>
    </div>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────

export function MfgDeliveryOrdersListV2() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { nameOf: salespersonNameOf } = useStaffLookup();

  const status = (params.get("status") ?? "all") as StatusTab;
  const view = (params.get("view") ?? "table") as "table" | "cards";
  const search = params.get("q") ?? "";

  const [selected, setSelected] = useState<DoRow | null>(null);

  // The backend delivery-orders endpoint doesn't accept our compressed bucket
  // names — pass `undefined` and filter client-side on the bucket.
  const { data, isLoading, error } = useMfgDeliveryOrders(undefined);
  const updateStatus = useUpdateMfgDeliveryOrderStatus();

  const allRows = useMemo<DoRow[]>(
    () => ((data?.deliveryOrders ?? []) as DoRow[]),
    [data]
  );

  // Apply the status bucket first (drops from tab), then the search filter.
  const scopedByBucket = useMemo(() => {
    if (status === "all") return allRows;
    return allRows.filter((r) => statusFor(r.status).bucket === status);
  }, [allRows, status]);

  const filtered = useMemo(() => {
    if (!search.trim()) return scopedByBucket;
    const q = search.toLowerCase();
    return scopedByBucket.filter((r) => {
      const hay = [
        r.do_number,
        r.so_doc_no,
        r.debtor_name,
        r.debtor_code,
        r.salesperson_id,
        refOf(r),
        r.branding,
        r.sales_location,
        r.driver_name,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [scopedByBucket, search]);

  // Filter-pill counts scoped to the FULL query result (unfiltered by search).
  const counts = useMemo(() => {
    const acc = { all: allRows.length, open: 0, in_transit: 0, delivered: 0, cancelled: 0 };
    for (const r of allRows) {
      const b = statusFor(r.status).bucket;
      if (b === "open") acc.open += 1;
      else if (b === "in_transit") acc.in_transit += 1;
      else if (b === "delivered") acc.delivered += 1;
      else if (b === "cancelled") acc.cancelled += 1;
    }
    return acc;
  }, [allRows]);

  // KPI stats — scoped to the search-filtered rows (same idiom as SO V2).
  const stats = useMemo(() => {
    let revenueCenti = 0;
    let inTransitCount = 0;
    let deliveredCount = 0;
    for (const r of filtered) {
      revenueCenti += r.local_total_centi ?? 0;
      const b = statusFor(r.status).bucket;
      if (b === "in_transit") inTransitCount += 1;
      if (b === "delivered") deliveredCount += 1;
    }
    return {
      total: filtered.length,
      revenueCenti,
      inTransitCount,
      deliveredCount,
    };
  }, [filtered]);

  const setStatusChip = (s: StatusTab) => {
    const next = new URLSearchParams(params);
    if (s === "all") next.delete("status");
    else next.set("status", s);
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
    setParams(next, { replace: true });
  };
  const resetLayout = () => {
    setParams(new URLSearchParams(), { replace: true });
  };
  const filtersActive =
    status !== "all" || view !== "table" || search.trim().length > 0;

  const onPullToRefresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["mfg-delivery-orders"] });
  };

  // Wired actions
  const goNewDo = () => navigate("/scm/delivery-orders/new");
  const goFromSo = () => navigate("/scm/delivery-orders/from-so");
  const goImport = () => navigate("/scm/delivery-orders?import=1");
  const goDuplicate = () => navigate("/scm/delivery-orders?duplicate=1");
  const goSoList = () => navigate("/scm/sales-orders");
  const goPlanning = () => navigate("/scm/delivery-planning");
  const goEdit = (r: DoRow) => navigate(`/scm/delivery-orders/${r.id}?edit=1`);
  const goPrint = (r: DoRow) => navigate(`/scm/delivery-orders/${r.id}?print=1`);
  const goFullPage = (r: DoRow) => navigate(`/scm/delivery-orders/${r.id}`);
  const doMarkSigned = (r: DoRow) =>
    updateStatus.mutate(
      { id: r.id, status: "delivered" },
      { onSuccess: () => setSelected(null) }
    );
  const doConvertToSi = (r: DoRow) =>
    navigate(`/scm/sales-invoices/from-do?do=${r.id}`);

  // Table columns
  const columns: Column<DoRow>[] = [
    {
      key: "do_number",
      label: "DO No.",
      width: "132px",
      alwaysVisible: true,
      getValue: (r) => r.do_number,
      render: (r) => (
        <span className="font-mono text-[12.5px] font-semibold text-ink">
          {r.do_number}
        </span>
      ),
    },
    {
      key: "do_date",
      label: "Date",
      width: "108px",
      getValue: (r) => r.do_date,
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{fmtDate(r.do_date)}</span>
      ),
    },
    {
      key: "so_doc_no",
      label: "From SO",
      width: "128px",
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
      key: "delivery_date",
      label: "Delivery date",
      width: "128px",
      getValue: (r) => r.customer_delivery_date ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">
          {fmtDate(r.customer_delivery_date)}
        </span>
      ),
    },
    {
      key: "driver",
      label: "Driver",
      width: "128px",
      getValue: (r) => r.driver_name ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">
          {r.driver_name || "—"}
        </span>
      ),
    },
    {
      key: "reference",
      label: "Customer ref",
      width: "132px",
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
      key: "amount",
      label: "Amount",
      width: "128px",
      align: "right",
      getValue: (r) => r.local_total_centi,
      render: (r) => (
        <span className="font-money text-[13px] font-semibold text-ink">
          {fmtRm(r.local_total_centi)}
        </span>
      ),
    },
  ];

  const statusPillOptions: Array<{ value: StatusTab; label: string }> = [
    { value: "all", label: `All · ${counts.all}` },
    { value: "open", label: `Open · ${counts.open}` },
    { value: "in_transit", label: `In transit · ${counts.in_transit}` },
    { value: "delivered", label: `Delivered · ${counts.delivered}` },
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
      {/* Mobile-only compact header — hides at md+. */}
      <div className="mb-3 flex items-start justify-between gap-3 md:hidden">
        <div className="min-w-0">
          <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">
            Delivery Orders
          </h1>
          <div className="mt-0.5 text-[12.5px] text-ink-muted">
            {stats.total} order{stats.total === 1 ? "" : "s"} ·{" "}
            <span className="font-money">{fmtRm(stats.revenueCenti)}</span>
          </div>
        </div>
      </div>

      {/* Desktop chrome */}
      <div className="hidden md:block">
        <PageHeader
          eyebrow="Supply Chain"
          title="Delivery Orders"
          description="Every Houzs delivery order — Loaded to Delivered. Click any row for the quick view; open the full page to edit."
          primaryAction={
            <div className="flex items-stretch">
              <Button
                variant="primary"
                icon={<Plus size={14} />}
                onClick={goNewDo}
                className="rounded-r-none"
              >
                New Delivery Order
              </Button>
              <SplitDropdown
                onFromSo={goFromSo}
                onImport={goImport}
                onDuplicate={goDuplicate}
              />
            </div>
          }
          secondaryActions={[
            { label: "Sales Orders", icon: Wrench, onClick: goSoList },
            { label: "Delivery Planning", icon: Truck, onClick: goPlanning },
          ]}
        />
      </div>

      {/* Stat strip */}
      <div className="mb-5 hidden grid-cols-2 gap-3 md:grid lg:grid-cols-4">
        <StatCard
          label="Total DOs"
          value={stats.total.toLocaleString("en-MY")}
          subtitle="Scoped to current filter"
          rail="bg-primary"
          active
        />
        <StatCard
          label="Revenue"
          value={fmtRm(stats.revenueCenti)}
          subtitle="Sum of local total"
          rail="bg-accent"
        />
        <StatCard
          label="In transit"
          value={stats.inTransitCount.toLocaleString("en-MY")}
          subtitle="Dispatched · en route"
          tone="warning"
          rail="bg-accent-bright"
        />
        <StatCard
          label="Delivered"
          value={stats.deliveredCount.toLocaleString("en-MY")}
          subtitle="Signed / delivered / invoiced"
          tone="success"
          rail="bg-synced"
        />
      </div>

      {/* Mobile sticky search */}
      <div className="sticky top-0 z-10 -mx-4 mb-3 bg-bg/95 px-4 py-2 backdrop-blur-sm md:hidden">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search DO, customer, driver…"
          className="h-10 w-full rounded-lg border border-border bg-surface px-3.5 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
      </div>

      {/* Filter row */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <FilterPills
          options={statusPillOptions}
          value={status}
          onChange={(v) => setStatusChip(v)}
        />
        <div className="flex-1" />
        <div className="hidden md:block">
          <ViewToggle value={view} onChange={setView} />
        </div>
      </div>

      {/* Phone → Cards */}
      <div className="md:hidden">
        <CardsGrid rows={filtered} onOpen={(r) => setSelected(r)} />
        {filtered.length > 0 && (
          <div className="mt-4 pb-24 text-center text-[11.5px] text-ink-muted">
            {filtered.length} order{filtered.length === 1 ? "" : "s"}
          </div>
        )}
      </div>

      {/* Desktop → Table / Cards */}
      <div className="hidden md:block">
        {view === "table" ? (
          <DataTable<DoRow>
            tableId="delivery-orders-v2"
            rows={filtered}
            loading={isLoading}
            error={error ? (error as Error).message ?? "Failed to load" : null}
            columns={columns}
            getRowKey={(r) => r.id}
            onRowClick={(r) => setSelected(r)}
            exportName="delivery-orders"
            emptyLabel={
              filtersActive
                ? "No delivery orders match — try Reset layout to clear filters."
                : "No delivery orders yet."
            }
            search={{
              value: search,
              onChange: setSearch,
              placeholder: "Search DO no, customer, driver, ref…",
            }}
            resetFilters={{
              active: filtersActive,
              onReset: resetLayout,
              label: "Reset layout",
            }}
          />
        ) : (
          <>
            <div className="mb-3 flex items-center justify-between">
              <div className="flex flex-1 items-center gap-2">
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search DO no, customer, driver, ref…"
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
              <span className="text-[12px] text-ink-muted">
                {filtered.length} order{filtered.length === 1 ? "" : "s"}
              </span>
            </div>
            <CardsGrid rows={filtered} onOpen={(r) => setSelected(r)} />
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
        onMarkSigned={() => selected && doMarkSigned(selected)}
        onConvertToSi={() => selected && doConvertToSi(selected)}
        salespersonName={
          selected ? salespersonNameOf(null, selected.salesperson_id) : "—"
        }
      />
    </PullToRefresh>
  );
}

export default MfgDeliveryOrdersListV2;
