// MfgSalesOrdersListV2 — Theme C ("Ink & Petrol") redesign of the Sales Orders
// listing (Supply Chain). Composed with the real Houzs DS primitives:
// PageHeader / StatCard grid / FilterPills / DataTable / Badge / Button + a
// right slide-over detail drawer built with the same tokens.
//
// Scope of THIS file (Item A of the 4-part redesign):
//   · Desktop listing (table + cards toggle)
//   · Row/card click → quick-view detail drawer (dark header, meta grid,
//     order lines, totals, action buttons)
//   · Wired to the existing useMfgSalesOrders query so status tab / search
//     narrow the same data the old grid uses. Status mutations still route
//     through useUpdateMfgSalesOrderStatus.
//
// Follow-ups (separate PRs):
//   · Full Detail page (DetailLayout + two-col grid + sticky aside)
//   · Phone card list + FAB + PullToRefresh
//   · iPad 340px master-detail rail
//
// The old ledger-style page (MfgSalesOrdersList.tsx, DataGrid-based) stays in
// the tree; App.tsx route swap decides which one users see.

import { useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Plus,
  ChevronDown,
  ScanLine,
  Wrench,
  LayoutGrid,
  Table as TableIcon,
  X as XIcon,
  ExternalLink,
  Edit3,
  Printer,
  CheckCircle2,
  Truck,
} from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { StatCard } from "../../components/StatCard";
import { FilterPills } from "../../components/FilterPills";
import { DataTable, type Column } from "../../components/DataTable";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { PullToRefresh } from "../../components/PullToRefresh";
import {
  useMfgSalesOrders,
  useUpdateMfgSalesOrderStatus,
  useMfgSalesOrderDetail,
} from "../../vendor/scm/lib/sales-order-queries";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "../../lib/utils";

// ─── Types ──────────────────────────────────────────────────────────────────
// Minimal row shape the listing needs. The full SoRow (in MfgSalesOrdersList
// .tsx) has 60+ fields; we pluck what the redesign shows. Everything is
// typed loosely as any-safe (nullable) because the backend legacy fields.

type SoRow = {
  doc_no: string;
  so_date: string;
  debtor_name: string;
  debtor_code: string | null;
  agent: string | null;
  salesperson_id: string | null;
  sales_location: string | null;
  customer_so_no: string | null;
  po_doc_no: string | null;
  ref: string | null;
  branding: string | null;
  first_item_branding: string | null;
  status: string;
  local_total_centi: number;
  balance_centi: number;
  paid_centi: number;
  phone: string | null;
  email: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  postcode: string | null;
  customer_state: string | null;
  payment_method: string | null;
  payment_methods_summary?: string;
};

type StatusTab = "all" | "draft" | "confirmed" | "cancelled";

// ─── Helpers ────────────────────────────────────────────────────────────────

const fmtRm = (centi: number): string =>
  `RM ${(centi / 100).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const fmtDate = (iso: string | null): string => {
  if (!iso) return "—";
  // Accept "2026-07-04" / "2026/07/04" / ISO datetime — normalise to yyyy/mm/dd.
  const s = iso.replace(/T.*$/, "").replace(/-/g, "/");
  return s;
};

// Customer's PO / Ref number — spec: "Every list must show the customer SO
// Ref number". Prefer po_doc_no (populated by the SO New form's "Customer
// PO #"), then customer_so_no, then the legacy `ref` column, then dash.
const refOf = (r: SoRow): string =>
  r.po_doc_no || r.customer_so_no || r.ref || "—";

// Branding badge tone. Spec: 2990 SOFA = success (green), AKEMI = neutral,
// other brands = warning (amber). Falls back to first_item_branding when the
// header brand is blank (mixed-line SOs).
const brandOf = (r: SoRow): string => r.branding || r.first_item_branding || "—";
const brandTone = (b: string): "success" | "neutral" | "warning" | "accent" => {
  const s = (b || "").toUpperCase();
  if (s.includes("2990") || s.includes("SOFA")) return "success";
  if (s.includes("AKEMI")) return "neutral";
  if (s === "—" || !s) return "neutral";
  return "warning";
};

// Status → tone + label. The upstream `status` string is one of the SO
// lifecycle values plus a couple of AutoCount-legacy synonyms. Anything not
// matched falls through as neutral.
const STATUS_TONE: Record<string, { tone: "success" | "warning" | "error" | "neutral"; label: string }> = {
  draft: { tone: "warning", label: "Draft" },
  confirmed: { tone: "success", label: "Confirmed" },
  cancelled: { tone: "error", label: "Cancelled" },
  cancel: { tone: "error", label: "Cancelled" },
  invoiced: { tone: "success", label: "Invoiced" },
  delivered: { tone: "success", label: "Delivered" },
  completed: { tone: "success", label: "Completed" },
};

const statusFor = (s: string): { tone: "success" | "warning" | "error" | "neutral"; label: string } =>
  STATUS_TONE[s?.toLowerCase() ?? ""] ?? { tone: "neutral", label: s || "—" };

// ─── Salesperson dropdown / split-menu ──────────────────────────────────────

/** Small controlled dropdown that renders under the "New Sales Order" split
 *  button. Simple menu — no portal, no keyboard-nav layer; the target this
 *  redesign is showing off is the visual composition, not menu wizardry. */
function SplitDropdown({
  onFromQuotation,
  onImport,
  onDuplicate,
}: {
  onFromQuotation: () => void;
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
                onFromQuotation();
              }}
            >
              New from quotation
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
              Duplicate last SO
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Table / Cards view toggle ──────────────────────────────────────────────

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

function CardsGrid({ rows, onOpen }: { rows: SoRow[]; onOpen: (r: SoRow) => void }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface px-6 py-16 text-center shadow-stone">
        <div className="text-[13px] font-semibold text-ink">No sales orders</div>
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
            key={r.doc_no}
            type="button"
            onClick={() => onOpen(r)}
            className="group relative overflow-hidden rounded-lg border border-border bg-surface px-4 py-4 text-left shadow-stone transition-all duration-200 hover:-translate-y-px hover:border-primary/40 hover:shadow-slab focus:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[12.5px] font-semibold text-ink">
                {r.doc_no}
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
              <span className="text-[11.5px] text-ink-muted">{fmtDate(r.so_date)}</span>
            </div>
            <div className="mt-3.5 flex items-end justify-between border-t border-border-subtle pt-3">
              <div className="min-w-0">
                <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                  Ref
                </div>
                <div className="mt-0.5 truncate font-mono text-[12px] font-semibold text-ink-secondary">
                  {refOf(r)}
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

// ─── Detail drawer ──────────────────────────────────────────────────────────

function DetailDrawer({
  row,
  onClose,
  onOpenFull,
  onEdit,
  onPrint,
  onConfirm,
  onDeliver,
}: {
  row: SoRow | null;
  onClose: () => void;
  onOpenFull: () => void;
  onEdit: () => void;
  onPrint: () => void;
  onConfirm: () => void;
  onDeliver: () => void;
}) {
  const detailQ = useMfgSalesOrderDetail(row?.doc_no ?? null);
  const items: Array<{ product_code?: string; product_name?: string; qty?: number; unit_price_centi?: number; amount_centi?: number }> =
    (detailQ.data as { items?: unknown[] } | undefined)?.items as Array<{
      product_code?: string;
      product_name?: string;
      qty?: number;
      unit_price_centi?: number;
      amount_centi?: number;
    }> ?? [];

  const open = !!row;
  const st = row ? statusFor(row.status) : null;

  // Totals from live line items when the detail query has resolved; fall back
  // to header totals otherwise so the drawer still reads immediately.
  const subtotalCenti =
    items.length > 0
      ? items.reduce((sum, l) => sum + (l.amount_centi ?? (l.qty ?? 0) * (l.unit_price_centi ?? 0)), 0)
      : row?.local_total_centi ?? 0;
  const sstCenti = Math.round(subtotalCenti * 0.06);
  const totalCenti = subtotalCenti + sstCenti;
  const paidCenti = row?.paid_centi ?? 0;
  const outstandingCenti = totalCenti - paidCenti;

  return (
    <>
      {/* scrim — mobile only. On desktop the outer wrapper reflows via
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
      {/* slide-over */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={row ? `Sales order ${row.doc_no}` : "Sales order details"}
        className={cn(
          "fixed right-0 top-0 z-[91] flex h-full w-full max-w-[520px] flex-col border-l border-border bg-surface shadow-slab transition-transform duration-200",
          open ? "translate-x-0" : "translate-x-full"
        )}
      >
        {row && st && (
          <>
            {/* dark header */}
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
                  {row.doc_no}
                </div>
                <div className="mt-0.5 text-[11px] text-sidebar-ink-muted">Sales Order</div>
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

            {/* scroll body */}
            <div className="flex-1 overflow-y-auto px-5 py-5">
              {/* customer + brand + date */}
              <div className="text-[19px] font-bold text-ink">{row.debtor_name || "—"}</div>
              <div className="mt-1.5 flex items-center gap-2.5">
                <Badge tone={brandTone(brandOf(row))} variant="soft" size="xs">
                  {brandOf(row)}
                </Badge>
                <span className="text-[12.5px] text-ink-muted">
                  Ordered {fmtDate(row.so_date)}
                </span>
              </div>

              {/* meta grid */}
              <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border bg-surface-2 px-4 py-4">
                <MetaItem k="Salesperson" v={row.agent || row.salesperson_id || "—"} />
                <MetaItem k="Location" v={row.sales_location || "—"} />
                <MetaItem k="Reference" v={refOf(row)} mono />
                <MetaItem k="Branding" v={brandOf(row)} />
                <MetaItem k="Order date" v={fmtDate(row.so_date)} />
                <MetaItem
                  k="Payment"
                  v={row.payment_methods_summary || row.payment_method || "—"}
                />
              </dl>

              {/* customer & delivery card */}
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

              {/* order lines */}
              <SectionHeading>Order lines</SectionHeading>
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
                  const amt = l.amount_centi ?? (l.qty ?? 0) * (l.unit_price_centi ?? 0);
                  return (
                    <div
                      key={i}
                      className="grid grid-cols-[1fr_52px_92px] items-center gap-2 border-b border-border-subtle px-4 py-3 last:border-b-0"
                    >
                      <div>
                        <div className="text-[13px] font-semibold text-ink">
                          {l.product_name || "—"}
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

              {/* totals */}
              <div className="mt-4 rounded-lg border border-border bg-surface px-5 py-4">
                <TotalRow k="Subtotal" v={fmtRm(subtotalCenti)} />
                <TotalRow k="SST · 6%" v={fmtRm(sstCenti)} />
                <TotalRow k="Total" v={fmtRm(totalCenti)} strong />
                {paidCenti > 0 ? (
                  <TotalRow k="Paid" v={fmtRm(paidCenti)} tone="success" />
                ) : null}
                {outstandingCenti > 0 ? (
                  <TotalRow k="Outstanding" v={fmtRm(outstandingCenti)} tone="error" />
                ) : null}
              </div>
            </div>

            {/* footer actions */}
            <div className="flex shrink-0 items-center gap-2 border-t border-border bg-surface px-5 py-3">
              <Button variant="ghost" icon={<Edit3 size={14} />} onClick={onEdit}>
                Edit
              </Button>
              <Button variant="ghost" icon={<Printer size={14} />} onClick={onPrint}>
                Print
              </Button>
              <div className="flex-1" />
              {(() => {
                // Backend can hand back status in any case ("Draft" / "draft" /
                // "DRAFT"); normalise once so the CTA switch works regardless.
                const s = (row.status || "").toLowerCase();
                if (s === "draft") {
                  return (
                    <Button
                      variant="primary"
                      icon={<CheckCircle2 size={14} />}
                      onClick={onConfirm}
                    >
                      Confirm
                    </Button>
                  );
                }
                if (s === "confirmed") {
                  return (
                    <Button
                      variant="primary"
                      icon={<Truck size={14} />}
                      onClick={onDeliver}
                    >
                      Deliver
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

// ─── Drawer sub-primitives ──────────────────────────────────────────────────

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
        strong && "border-t border-border-subtle pt-2.5 mt-1"
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

// ─── Main page ──────────────────────────────────────────────────────────────

export function MfgSalesOrdersListV2() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();

  const status = (params.get("status") ?? "all") as StatusTab;
  // View toggle applies at md+; on phones we always render the card list
  // regardless of the URL param (a 9-col DataTable is unreadable on 360dpi).
  const view = (params.get("view") ?? "table") as "table" | "cards";
  const search = params.get("q") ?? "";

  const [selected, setSelected] = useState<SoRow | null>(null);

  const { data, isLoading, error } = useMfgSalesOrders(
    status === "all" ? undefined : status
  );
  const updateStatus = useUpdateMfgSalesOrderStatus();

  const allRows = useMemo<SoRow[]>(
    () => ((data?.salesOrders ?? []) as SoRow[]),
    [data]
  );

  // Client-side search filter — matches doc_no, customer name, ref number,
  // and salesperson. Server hits still respect status (query param above).
  const filtered = useMemo(() => {
    if (!search.trim()) return allRows;
    const q = search.toLowerCase();
    return allRows.filter((r) => {
      const hay = [
        r.doc_no,
        r.debtor_name,
        r.debtor_code,
        r.agent,
        r.salesperson_id,
        refOf(r),
        r.branding,
        r.sales_location,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [allRows, search]);

  // Status tab counts — computed on the FULL query result (unfiltered by
  // search), so the pill counts stay stable while the user types.
  const counts = useMemo(() => {
    const byStatus = { all: allRows.length, draft: 0, confirmed: 0, cancelled: 0 };
    for (const r of allRows) {
      const s = (r.status || "").toLowerCase();
      if (s === "draft") byStatus.draft += 1;
      else if (s === "confirmed") byStatus.confirmed += 1;
      else if (s === "cancelled" || s === "cancel") byStatus.cancelled += 1;
    }
    return byStatus;
  }, [allRows]);

  // KPI stats — scoped to the SEARCH-FILTERED rows so narrowing the filter
  // row re-scopes the headline numbers (matches the interactive feel we've
  // established elsewhere in the app).
  const stats = useMemo(() => {
    let revenueCenti = 0;
    let outstandingCenti = 0;
    let paidCenti = 0;
    for (const r of filtered) {
      revenueCenti += r.local_total_centi ?? 0;
      outstandingCenti += r.balance_centi ?? 0;
      paidCenti += r.paid_centi ?? 0;
    }
    return {
      total: filtered.length,
      revenueCenti,
      outstandingCenti,
      paidCenti,
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

  // ── Actions wired to real routes / mutations ──────────────────────────
  const goNewSo = () => navigate("/scm/sales-orders/new");
  const goScanOrder = () => navigate("/scm/sales-orders/new/from-products");
  const goSoMaintenance = () => navigate("/scm/sales-orders/maintenance");
  const goFromQuotation = () => navigate("/scm/sales-orders/new/guided");
  const goImport = () => navigate("/scm/sales-orders/maintenance?tab=import");
  const goDuplicate = () => navigate("/scm/sales-orders/maintenance?tab=duplicate");
  const goEdit = (r: SoRow) => navigate(`/scm/sales-orders/${r.doc_no}?edit=1`);
  const goPrint = (r: SoRow) => navigate(`/scm/sales-orders/${r.doc_no}?print=1`);
  const goFullPage = (r: SoRow) => navigate(`/scm/sales-orders/${r.doc_no}`);
  const doConfirm = (r: SoRow) =>
    updateStatus.mutate(
      { docNo: r.doc_no, status: "confirmed" },
      { onSuccess: () => setSelected(null) }
    );
  const doDeliver = (r: SoRow) => navigate(`/scm/delivery-orders/from-so?so=${r.doc_no}`);

  // ── Table columns ─────────────────────────────────────────────────────
  const columns: Column<SoRow>[] = [
    {
      key: "doc_no",
      label: "Doc No.",
      width: "132px",
      alwaysVisible: true,
      getValue: (r) => r.doc_no,
      render: (r) => (
        <span className="font-mono text-[12.5px] font-semibold text-ink">
          {r.doc_no}
        </span>
      ),
    },
    {
      key: "so_date",
      label: "Date",
      width: "108px",
      getValue: (r) => r.so_date,
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{fmtDate(r.so_date)}</span>
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
      key: "salesperson",
      label: "Salesperson",
      width: "128px",
      getValue: (r) => r.agent || r.salesperson_id || "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">
          {r.agent || r.salesperson_id || "—"}
        </span>
      ),
    },
    {
      key: "sales_location",
      label: "Location",
      width: "132px",
      getValue: (r) => r.sales_location ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{r.sales_location || "—"}</span>
      ),
    },
    {
      key: "reference",
      label: "Reference",
      width: "132px",
      getValue: (r) => refOf(r),
      render: (r) => (
        <span className="font-mono text-[12px] text-ink-secondary">{refOf(r)}</span>
      ),
    },
    {
      key: "branding",
      label: "Branding",
      width: "112px",
      getValue: (r) => brandOf(r),
      render: (r) => {
        const b = brandOf(r);
        return (
          <Badge tone={brandTone(b)} variant="soft" size="xs">
            {b}
          </Badge>
        );
      },
    },
    {
      key: "status",
      label: "Status",
      width: "108px",
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
    { value: "draft", label: `Draft · ${counts.draft}` },
    { value: "confirmed", label: `Confirmed · ${counts.confirmed}` },
    { value: "cancelled", label: `Cancelled · ${counts.cancelled}` },
  ];

  const onPullToRefresh = async () => {
    // Wipe the SO list cache for every status tab so the pull's spinner
    // reflects a real network round-trip. Detail queries stay warm.
    await queryClient.invalidateQueries({ queryKey: ["mfg-sales-orders"] });
  };

  return (
    <PullToRefresh onRefresh={onPullToRefresh}>
      {/* When the drawer is open the desktop shell reflows into the left
          520 + gutter, so stats/table are cleanly visible next to it instead
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
            Sales Orders
          </h1>
          <div className="mt-0.5 text-[12.5px] text-ink-muted">
            {stats.total} order{stats.total === 1 ? "" : "s"} ·{" "}
            <span className="font-money">{fmtRm(stats.revenueCenti)}</span>
          </div>
        </div>
      </div>

      {/* Desktop chrome — hidden on phone (compact header + FAB take over). */}
      <div className="hidden md:block">
        <PageHeader
          eyebrow="Supply Chain"
          title="Sales Orders"
          description="Every Houzs sales order — Draft to Delivered. Click any row for the quick view; open the full page to edit."
          primaryAction={
            <div className="flex items-stretch">
              <Button
                variant="primary"
                icon={<Plus size={14} />}
                onClick={goNewSo}
                className="rounded-r-none"
              >
                New Sales Order
              </Button>
              <SplitDropdown
                onFromQuotation={goFromQuotation}
                onImport={goImport}
                onDuplicate={goDuplicate}
              />
            </div>
          }
          secondaryActions={[
            { label: "Scan Order", icon: ScanLine, onClick: goScanOrder },
            { label: "SO Maintenance", icon: Wrench, onClick: goSoMaintenance },
          ]}
        />
      </div>

      {/* Stat strip — 4 StatCards on md+. On phone we drop the strip and rely
          on the compact header's "17 orders · RM 89k" line instead — mobile
          screens don't have space for four separate KPI slabs. */}
      <div className="mb-5 hidden grid-cols-2 gap-3 md:grid lg:grid-cols-4">
        <StatCard
          label="Total Orders"
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
          label="Outstanding"
          value={fmtRm(stats.outstandingCenti)}
          subtitle="Balance across visible rows"
          tone="error"
          rail="bg-err"
        />
        <StatCard
          label="Paid"
          value={fmtRm(stats.paidCenti)}
          subtitle="Receipts logged"
          tone="success"
          rail="bg-synced"
        />
      </div>

      {/* Mobile-only sticky search — sits above the pill row on phones. */}
      <div className="sticky top-0 z-10 -mx-4 mb-3 bg-bg/95 px-4 py-2 backdrop-blur-sm md:hidden">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search SO, customer, ref…"
          className="h-10 w-full rounded-lg border border-border bg-surface px-3.5 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
      </div>

      {/* Filter row — pills scroll horizontally on phone; toggle hidden. */}
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

      {/* Phone → CardsGrid ALWAYS. Desktop → the view toggle decides. */}
      <div className="md:hidden">
        <CardsGrid rows={filtered} onOpen={(r) => setSelected(r)} />
        {filtered.length > 0 && (
          <div className="mt-4 pb-24 text-center text-[11.5px] text-ink-muted">
            {filtered.length} order{filtered.length === 1 ? "" : "s"}
          </div>
        )}
      </div>

      {/* Table / Cards (md+) */}
      <div className="hidden md:block">
      {view === "table" ? (
        <DataTable<SoRow>
          tableId="sales-orders-v2"
          rows={filtered}
          loading={isLoading}
          error={error ? (error as Error).message ?? "Failed to load" : null}
          columns={columns}
          getRowKey={(r) => r.doc_no}
          onRowClick={(r) => setSelected(r)}
          exportName="sales-orders"
          emptyLabel={
            filtersActive
              ? "No sales orders match — try Reset layout to clear filters."
              : "No sales orders yet."
          }
          search={{
            value: search,
            onChange: setSearch,
            placeholder: "Search doc no, customer, ref…",
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
                placeholder="Search doc no, customer, ref…"
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
        onConfirm={() => selected && doConfirm(selected)}
        onDeliver={() => selected && doDeliver(selected)}
      />
    </PullToRefresh>
  );
}

export default MfgSalesOrdersListV2;
