// SalesOrderDetailV2 — Theme C ("Ink & Petrol") redesign of the Sales Order
// detail page. Read-first: the old page was a wall of empty inputs; this one
// treats an SO as an object you look at, and slides the edit / status
// mutations into the header action bar and (on Edit) into the existing
// SalesOrderDetail editor route.
//
// Scope of THIS file (Item B of the 4-part redesign):
//   · Sticky header (Back + customer name + status Badge + meta line + action
//     buttons: History · Relationship Map · Print PDF · Cancel SO · Edit)
//   · Two-column DetailGrid — main col of Section cards for Customer / Order
//     info (with amber Note callout) / Delivery address + Emergency contact /
//     Line items (DataTable with FOC badges); sticky aside with dark Order-
//     total card + Key dates + People + Recent activity.
//   · Wired to useMfgSalesOrderDetail; status mutation via useUpdateMfgSales-
//     OrderStatus. Edit navigates to the existing full editor (?edit=1).
//
// The old ledger-style SalesOrderDetail.tsx stays in the tree; App.tsx route
// swap on /scm/sales-orders/:docNo decides which one users see.

import { useMemo, useState, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  History,
  Share2,
  Printer,
  XCircle,
  Edit3,
  Warehouse,
  CircleDot,
  Phone as PhoneIcon,
  MoreHorizontal,
} from "lucide-react";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { DataTable, type Column } from "../../components/DataTable";
import {
  DetailGrid,
  DetailMain,
  DetailAside,
  Section,
} from "../../components/DetailLayout";
import {
  useMfgSalesOrderDetail,
  useUpdateMfgSalesOrderStatus,
} from "../../vendor/scm/lib/sales-order-queries";
import { useSetBreadcrumbs } from "../../hooks/useBreadcrumbs";
import {
  DocumentRelationshipMapModal,
  type ChainNode,
} from "../../components/scm-v2/DocumentRelationshipMapModal";
import { cn } from "../../lib/utils";

// ─── Row types (subset — see MfgSalesOrdersList.tsx for the full SoRow) ────

type SoHeader = {
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
  discount_centi?: number;
  phone: string | null;
  email: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  postcode: string | null;
  customer_state: string | null;
  customer_country: string | null;
  customer_type: string | null;
  building_type: string | null;
  venue: string | null;
  processing_date: string | null;
  customer_delivery_date: string | null;
  note: string | null;
  currency: string;
  payment_method: string | null;
  payment_methods_summary?: string;
};

type SoItem = {
  id: string;
  item_code: string;
  description: string | null;
  description2: string | null;
  uom: string;
  qty: number;
  unit_price_centi: number;
  discount_centi: number;
  total_centi: number;
  cancelled: boolean;
  item_group?: string;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const fmtMoney = (centi: number, currency = "MYR"): string =>
  `${currency} ${(centi / 100).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const s = iso.replace(/T.*$/, "");
  // Present as dd/mm/yyyy per Malaysian convention.
  const m = /^(\d{4})[-/](\d{2})[-/](\d{2})$/.exec(s);
  if (!m) return s;
  return `${m[3]}/${m[2]}/${m[1]}`;
};

const refOf = (h: SoHeader): string =>
  h.po_doc_no || h.customer_so_no || h.ref || "—";

const brandOf = (h: SoHeader): string =>
  h.branding || h.first_item_branding || "—";

const STATUS_TONE: Record<
  string,
  { tone: "success" | "warning" | "error" | "neutral"; label: string; blurb: string }
> = {
  draft: {
    tone: "warning",
    label: "Draft",
    blurb: "Draft · not yet confirmed",
  },
  confirmed: {
    tone: "success",
    label: "Confirmed",
    blurb: "Confirmed · awaiting payment",
  },
  cancelled: {
    tone: "error",
    label: "Cancelled",
    blurb: "Cancelled · no further action",
  },
  cancel: {
    tone: "error",
    label: "Cancelled",
    blurb: "Cancelled · no further action",
  },
  delivered: {
    tone: "success",
    label: "Delivered",
    blurb: "Delivered · goods handed over",
  },
  invoiced: {
    tone: "success",
    label: "Invoiced",
    blurb: "Invoiced · payment logged",
  },
  completed: {
    tone: "success",
    label: "Completed",
    blurb: "Completed",
  },
};
const statusFor = (
  s: string
): { tone: "success" | "warning" | "error" | "neutral"; label: string; blurb: string } =>
  STATUS_TONE[(s || "").toLowerCase()] ?? {
    tone: "neutral",
    label: s || "—",
    blurb: s || "—",
  };

const initialsOf = (name: string | null | undefined): string => {
  if (!name) return "—";
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("") || "—"
  );
};

// ─── Field cell ────────────────────────────────────────────────────────────

function Field({
  label,
  value,
  span = 1,
  muted,
  mono,
}: {
  label: string;
  value: ReactNode;
  span?: 1 | 2 | 3 | 4;
  muted?: boolean;
  mono?: boolean;
}) {
  const spanCls = span === 1 ? "" : span === 2 ? "sm:col-span-2" : span === 3 ? "sm:col-span-3" : "sm:col-span-4";
  return (
    <div className={spanCls}>
      <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 text-[14px] font-semibold leading-snug",
          muted ? "text-ink-muted" : "text-ink",
          mono && "font-mono"
        )}
      >
        {value}
      </div>
    </div>
  );
}

// ─── Sub-primitives for the aside cards ────────────────────────────────────

function AsideCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-stone">
      <div className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        {title}
      </div>
      {children}
    </div>
  );
}

function KeyDateRow({ k, v, muted }: { k: string; v: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-border-subtle py-2 last:border-b-0">
      <span className="text-[12.5px] text-ink-muted">{k}</span>
      <span
        className={cn(
          "text-[13px] font-semibold",
          muted ? "text-ink-muted" : "text-ink"
        )}
      >
        {v}
      </span>
    </div>
  );
}

function PersonRow({
  initials,
  name,
  role,
  tone = "accent",
}: {
  initials: string;
  name: string;
  role: string;
  tone?: "accent" | "neutral";
}) {
  return (
    <div className="flex items-center gap-3 border-b border-border-subtle py-3 last:border-b-0">
      <span
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[12px] font-bold",
          tone === "accent"
            ? "bg-accent-soft text-accent-ink"
            : "bg-border-subtle text-ink-secondary"
        )}
      >
        {initials}
      </span>
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold text-ink">{name}</div>
        <div className="truncate text-[11.5px] text-ink-muted">{role}</div>
      </div>
    </div>
  );
}

// ─── Recent activity timeline ─────────────────────────────────────────────
type ActivityDot = "success" | "primary" | "muted";
const DOT_CLS: Record<ActivityDot, string> = {
  success: "bg-synced",
  primary: "bg-primary",
  muted: "bg-border-strong",
};
function ActivityRow({
  title,
  meta,
  dot,
  isLast,
}: {
  title: string;
  meta: string;
  dot: ActivityDot;
  isLast?: boolean;
}) {
  return (
    <div className="flex gap-3 pb-3.5">
      <div className="flex flex-col items-center">
        <span className={cn("mt-1 h-2 w-2 rounded-full", DOT_CLS[dot])} />
        {!isLast && <span className="mt-1 w-[2px] flex-1 bg-border-subtle" />}
      </div>
      <div className="min-w-0">
        <div className="text-[12.5px] font-semibold text-ink">{title}</div>
        <div className="mt-0.5 text-[11px] text-ink-muted">{meta}</div>
      </div>
    </div>
  );
}

// ─── Order total card (dark aside hero) ────────────────────────────────────

function OrderTotalCard({
  header,
  subtotalCenti,
  discountCenti,
  totalCenti,
}: {
  header: SoHeader;
  subtotalCenti: number;
  discountCenti: number;
  totalCenti: number;
}) {
  const st = statusFor(header.status);
  return (
    <div className="rounded-lg bg-sidebar px-5 py-5 text-sidebar-ink shadow-stone">
      <div className="font-mono text-[10px] font-semibold uppercase tracking-brand text-sidebar-ink-muted">
        Order total
      </div>
      <div className="mt-1.5 font-money text-[30px] font-bold leading-none tracking-tight text-white">
        {fmtMoney(totalCenti, header.currency)}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span
          className={cn(
            "h-2 w-2 rounded-full",
            st.tone === "success"
              ? "bg-synced"
              : st.tone === "warning"
                ? "bg-accent-bright"
                : st.tone === "error"
                  ? "bg-err"
                  : "bg-sidebar-ink-muted"
          )}
        />
        <span className="text-[12.5px] text-sidebar-ink-muted">{st.blurb}</span>
      </div>

      <div className="mt-4 space-y-2 border-t border-white/10 pt-4">
        <TotalLine k="Subtotal" v={fmtMoney(subtotalCenti, header.currency)} />
        <TotalLine k="Discount" v={fmtMoney(discountCenti, header.currency)} />
        <TotalLine k="SST" v="Inclusive" muted />
        <TotalLine
          k="Total"
          v={fmtMoney(totalCenti, header.currency)}
          strong
        />
      </div>
    </div>
  );
}

function TotalLine({
  k,
  v,
  muted,
  strong,
}: {
  k: string;
  v: string;
  muted?: boolean;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span
        className={cn(
          "text-[12.5px] text-sidebar-ink-muted",
          strong && "text-white font-semibold"
        )}
      >
        {k}
      </span>
      <span
        className={cn(
          "font-money text-[13px] font-semibold text-sidebar-ink",
          muted && "text-sidebar-ink-muted",
          strong && "text-[16px] font-bold text-accent-bright"
        )}
      >
        {v}
      </span>
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────

export function SalesOrderDetailV2() {
  const { docNo } = useParams<{ docNo: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const detail = useMfgSalesOrderDetail(docNo ?? null);
  const updateStatus = useUpdateMfgSalesOrderStatus();

  // Replace the auto-derived "Scm" module crumb with the actual SO doc no.
  // Falls back to the raw route param while detail is loading so the top bar
  // never flashes back to "Scm".
  useSetBreadcrumbs([
    { label: "Sales Orders", to: "/scm/sales-orders" },
    { label: docNo ?? "Sales Order" },
  ]);

  const salesOrder = (detail.data as { salesOrder?: SoHeader } | undefined)?.salesOrder ?? null;
  const items: SoItem[] =
    ((detail.data as { items?: SoItem[] } | undefined)?.items ?? []).filter(
      (l) => !l.cancelled
    );

  const st = salesOrder ? statusFor(salesOrder.status) : null;

  // Totals — subtotal from live items; discount from header (aggregate); total
  // = header.local_total_centi if the API stamped it, else recomputed.
  const subtotalCenti = useMemo(
    () => items.reduce((s, l) => s + l.total_centi + l.discount_centi, 0),
    [items]
  );
  const discountCenti = useMemo(
    () =>
      salesOrder?.discount_centi ??
      items.reduce((s, l) => s + l.discount_centi, 0),
    [items, salesOrder?.discount_centi]
  );
  const totalCenti =
    salesOrder?.local_total_centi ?? subtotalCenti - discountCenti;

  const focCount = useMemo(
    () => items.filter((l) => l.unit_price_centi === 0 && l.total_centi === 0).length,
    [items]
  );

  const goBack = () => {
    if (params.get("from") === "list") navigate("/scm/sales-orders");
    else navigate(-1);
  };
  const goEdit = () => docNo && navigate(`/scm/sales-orders/${docNo}?edit=1`);
  const doCancel = () => {
    if (!salesOrder) return;
    if (
      window.confirm(
        `Cancel sales order ${salesOrder.doc_no}? This cannot be undone.`
      )
    ) {
      updateStatus.mutate({ docNo: salesOrder.doc_no, status: "cancelled" });
    }
  };
  const goHistory = () => docNo && navigate(`/scm/sales-orders/${docNo}?tab=history`);
  const [relMapOpen, setRelMapOpen] = useState(false);
  const goRelationshipMap = () => setRelMapOpen(true);
  const goPrintPdf = () =>
    docNo && navigate(`/scm/sales-orders/${docNo}?print=1`);

  // Build the 5-node document chain for this SO. The SO is CURRENT; upstream
  // (Customer PO) is "done" when a PO ref exists; downstream (DO / GRN / SI)
  // are Pending until they're actually generated. Live lookup of downstream
  // docs would need extra API — for now show them as Pending with a helpful
  // meta string, matching the design handoff prototype.
  const chainNodes: ChainNode[] = useMemo(() => {
    if (!salesOrder) return [];
    const poRef =
      salesOrder.po_doc_no || salesOrder.customer_so_no || salesOrder.ref || "";
    return [
      {
        type: "Customer PO",
        doc: poRef || "Not linked",
        meta: poRef ? "Customer's own doc" : "—",
        state: poRef ? "done" : "pending",
      },
      {
        type: "Sales Order",
        doc: salesOrder.doc_no,
        meta: "This document",
        state: "current",
      },
      {
        type: "Delivery Order",
        doc: "Not created",
        meta: "After confirmation",
        state: "pending",
      },
      {
        type: "GRN",
        doc: "Not created",
        meta: "After delivery",
        state: "pending",
      },
      {
        type: "Sales Invoice",
        doc: "Not created",
        meta: "On completion",
        state: "pending",
      },
    ];
  }, [salesOrder]);

  // ── Line item columns ────────────────────────────────────────────────
  const lineColumns: Column<SoItem>[] = [
    {
      key: "item",
      label: "Item",
      alwaysVisible: true,
      getValue: (l) => l.item_code,
      render: (l) => (
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-ink">
            {l.description || l.item_code}
          </div>
          <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-ink-muted">
            <span>{l.item_code}</span>
            {l.description2 && (
              <span className="truncate text-ink-secondary">
                · {l.description2}
              </span>
            )}
          </div>
        </div>
      ),
    },
    {
      key: "qty",
      label: "Qty",
      width: "72px",
      align: "right",
      getValue: (l) => l.qty,
      render: (l) => (
        <span className="font-money text-[13px] text-ink-secondary">
          {l.qty} <span className="text-[10.5px] text-ink-muted">{l.uom}</span>
        </span>
      ),
    },
    {
      key: "unit",
      label: "Unit price",
      width: "108px",
      align: "right",
      getValue: (l) => l.unit_price_centi,
      render: (l) => (
        <span className="font-money text-[13px] text-ink-secondary">
          {fmtMoney(l.unit_price_centi, salesOrder?.currency)}
        </span>
      ),
    },
    {
      key: "disc",
      label: "Disc",
      width: "88px",
      align: "right",
      getValue: (l) => l.discount_centi,
      render: (l) => {
        const isFoc = l.unit_price_centi === 0 && l.total_centi === 0;
        if (isFoc) {
          return (
            <Badge tone="warning" size="xs">
              FOC
            </Badge>
          );
        }
        if (l.discount_centi > 0) {
          return (
            <span className="font-money text-[13px] text-ink-secondary">
              {fmtMoney(l.discount_centi, salesOrder?.currency)}
            </span>
          );
        }
        return <span className="text-ink-muted">—</span>;
      },
    },
    {
      key: "total",
      label: "Amount",
      width: "132px",
      align: "right",
      getValue: (l) => l.total_centi,
      render: (l) => (
        <span className="font-money text-[13px] font-semibold text-ink">
          {fmtMoney(l.total_centi, salesOrder?.currency)}
        </span>
      ),
    },
  ];

  // ── Loading / error states ───────────────────────────────────────────
  if (!docNo) {
    return (
      <div className="p-8 text-center text-ink-muted">No sales order specified.</div>
    );
  }
  if (detail.isLoading) {
    return (
      <div className="animate-fade-in p-8 text-center text-ink-muted">
        Loading {docNo}…
      </div>
    );
  }
  if (detail.error || !salesOrder) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <div className="mb-2 font-display text-[18px] font-extrabold text-err">
          Couldn't load {docNo}
        </div>
        <p className="text-[13px] text-ink-muted">
          {(detail.error as Error | undefined)?.message ??
            "The sales order was not found."}
        </p>
        <div className="mt-4">
          <Button variant="secondary" onClick={goBack} icon={<ArrowLeft size={14} />}>
            Back to Sales Orders
          </Button>
        </div>
      </div>
    );
  }

  // Bottom-bar CTA on phone opens tel: with the customer's phone if present.
  const goCall = () => {
    if (!salesOrder?.phone) return;
    window.location.href = `tel:${salesOrder.phone.replace(/\s+/g, "")}`;
  };

  return (
    <div className="pb-24 md:pb-0">
      {/* ─── Mobile-only dark sticky header ─────────────────────────── */}
      <div className="sticky top-0 z-20 -mx-4 -mt-4 bg-sidebar text-sidebar-ink shadow-slab md:hidden">
        <div className="flex items-center justify-between gap-3 px-4 pt-3">
          <button
            type="button"
            onClick={goBack}
            className="inline-flex items-center gap-1 text-[14px] font-semibold text-accent-bright"
            aria-label="Back to Sales Orders"
          >
            <ArrowLeft size={16} /> Orders
          </button>
          <span className="font-mono text-[12.5px] font-semibold text-sidebar-ink">
            {salesOrder.doc_no}
          </span>
          <button
            type="button"
            className="text-sidebar-ink-muted"
            aria-label="More actions"
          >
            <MoreHorizontal size={18} />
          </button>
        </div>
        <div className="px-4 pb-4 pt-3">
          <h1 className="font-display text-[19px] font-bold leading-tight text-white">
            {salesOrder.debtor_name || "—"}
          </h1>
          {st && (
            <div className="mt-2">
              <Badge tone={st.tone} variant="solid" size="xs">
                {st.label}
              </Badge>
            </div>
          )}
        </div>
      </div>

      {/* ─── Desktop sticky header (hidden on phone) ────────────────── */}
      <div className="sticky top-0 z-10 -mx-4 hidden border-b border-border bg-bg/95 px-4 py-4 backdrop-blur-sm sm:-mx-6 sm:px-6 md:block">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <button
              type="button"
              onClick={goBack}
              aria-label="Back to Sales Orders"
              className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-ink-secondary hover:border-primary/50 hover:text-primary"
            >
              <ArrowLeft size={16} />
            </button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">
                  {salesOrder.debtor_name || "—"}
                </h1>
                {st && (
                  <Badge tone={st.tone} size="sm">
                    {st.label}
                  </Badge>
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-secondary">
                <span className="font-mono font-semibold text-primary-ink">
                  {salesOrder.doc_no}
                </span>
                <Divider />
                <span>SO date {fmtDate(salesOrder.so_date)}</span>
                <Divider />
                <span>{items.length} line{items.length === 1 ? "" : "s"}</span>
                {refOf(salesOrder) !== "—" && (
                  <>
                    <Divider />
                    <span>
                      Ref{" "}
                      <span className="font-mono font-semibold text-ink-secondary">
                        {refOf(salesOrder)}
                      </span>
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              icon={<History size={14} />}
              onClick={goHistory}
            >
              History
            </Button>
            <Button
              variant="ghost"
              icon={<Share2 size={14} />}
              onClick={goRelationshipMap}
            >
              Relationship Map
            </Button>
            <Button
              variant="secondary"
              icon={<Printer size={14} />}
              onClick={goPrintPdf}
            >
              Print PDF
            </Button>
            {salesOrder.status?.toLowerCase() !== "cancelled" && (
              <Button
                variant="danger"
                icon={<XCircle size={14} />}
                onClick={doCancel}
              >
                Cancel SO
              </Button>
            )}
            <Button
              variant="primary"
              icon={<Edit3 size={14} />}
              onClick={goEdit}
            >
              Edit
            </Button>
          </div>
        </div>
      </div>

      {/* ─── Detail body ────────────────────────────────────────────── */}
      <div className="py-5">
        {/* Mobile-only Order total hero — sits at the very top of the scroll
            body, above the Customer section. On md+ the dark Order total lives
            in the sticky aside instead (below). */}
        <div className="mb-3 rounded-lg border border-border bg-surface p-4 shadow-stone md:hidden">
          <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
            Order total
          </div>
          <div className="mt-1 font-money text-[26px] font-bold leading-none tracking-tight text-ink">
            {fmtMoney(totalCenti, salesOrder.currency)}
          </div>
          <div className="mt-1.5 text-[12px] text-ink-muted">
            {items.length} line{items.length === 1 ? "" : "s"} · {st?.blurb}
          </div>
        </div>
        <DetailGrid>
          <DetailMain>
            {/* Customer */}
            <Section title="Customer">
              <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-3">
                <Field
                  label="Customer name"
                  value={salesOrder.debtor_name || "—"}
                />
                <Field
                  label="Phone"
                  value={salesOrder.phone || "Not provided"}
                  muted={!salesOrder.phone}
                  mono={!!salesOrder.phone}
                />
                <Field
                  label="Email"
                  value={salesOrder.email || "Not provided"}
                  muted={!salesOrder.email}
                />
                <Field
                  label="Customer type"
                  value={salesOrder.customer_type || "—"}
                  muted={!salesOrder.customer_type}
                />
                <Field
                  label="Customer SO ref"
                  value={refOf(salesOrder)}
                  mono={refOf(salesOrder) !== "—"}
                  muted={refOf(salesOrder) === "—"}
                />
                <Field
                  label="Salesperson"
                  value={
                    salesOrder.agent ||
                    salesOrder.salesperson_id ||
                    "Unassigned"
                  }
                  muted={
                    !salesOrder.agent && !salesOrder.salesperson_id
                  }
                />
              </div>
            </Section>

            {/* Order info + optional amber Note callout */}
            <Section title="Order info">
              <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-4">
                <Field
                  label="Building type"
                  value={salesOrder.building_type || "—"}
                  muted={!salesOrder.building_type}
                />
                <Field
                  label="Venue"
                  value={salesOrder.venue || "—"}
                  muted={!salesOrder.venue}
                />
                <Field
                  label="Processing date"
                  value={fmtDate(salesOrder.processing_date)}
                  muted={!salesOrder.processing_date}
                />
                <Field
                  label="Delivery date"
                  value={
                    salesOrder.customer_delivery_date
                      ? fmtDate(salesOrder.customer_delivery_date)
                      : "Not scheduled"
                  }
                  muted={!salesOrder.customer_delivery_date}
                />
                <Field
                  label="Branding"
                  value={brandOf(salesOrder)}
                  muted={brandOf(salesOrder) === "—"}
                />
                <Field
                  label="Payment"
                  value={
                    salesOrder.payment_methods_summary ||
                    salesOrder.payment_method ||
                    "—"
                  }
                  muted={
                    !salesOrder.payment_methods_summary &&
                    !salesOrder.payment_method
                  }
                />
              </div>

              {salesOrder.note && (
                <div className="mt-4 rounded-lg border border-warning-text/25 bg-warning-bg px-4 py-3">
                  <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-warning-text">
                    Note
                  </div>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-warning-text">
                    {salesOrder.note}
                  </p>
                </div>
              )}
            </Section>

            {/* Delivery address + Emergency contact */}
            <Section title="Delivery address">
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-[1.4fr_1fr] sm:divide-x sm:divide-border-subtle">
                <div className="sm:pr-6">
                  <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                    Ship to
                  </div>
                  <div className="mt-1.5 text-[14px] font-semibold leading-relaxed text-ink">
                    {[
                      salesOrder.address1,
                      salesOrder.address2,
                      [salesOrder.city, salesOrder.postcode]
                        .filter(Boolean)
                        .join(" "),
                      [salesOrder.customer_state, salesOrder.customer_country]
                        .filter(Boolean)
                        .join(", "),
                    ]
                      .filter(Boolean)
                      .map((line, i) => (
                        <div key={i}>{line}</div>
                      ))}
                    {!salesOrder.address1 && !salesOrder.city && (
                      <span className="text-ink-muted">Not provided</span>
                    )}
                  </div>
                  {salesOrder.sales_location && (
                    <div className="mt-3 inline-flex items-center gap-2 rounded-md bg-primary-soft px-2.5 py-1 text-[11.5px] font-semibold text-primary-ink">
                      <Warehouse size={12} />
                      {salesOrder.sales_location}
                    </div>
                  )}
                </div>
                <div className="sm:pl-6">
                  <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                    Emergency contact
                  </div>
                  <div className="mt-1.5 text-[12.5px] text-ink-muted">
                    Only if unreachable on delivery day
                  </div>
                  <div className="mt-2.5 text-[14px] font-semibold text-ink">
                    {salesOrder.phone || "Not provided"}
                  </div>
                  <div className="mt-1 text-[12px] text-ink-muted">
                    Contact — relationship not set
                  </div>
                </div>
              </div>
            </Section>

            {/* Line items */}
            <Section
              title={`Line items · ${items.length}`}
              actions={
                focCount > 0 ? (
                  <span className="text-[11.5px] text-ink-muted">
                    {focCount} FOC line{focCount === 1 ? "" : "s"} included
                  </span>
                ) : undefined
              }
            >
              <DataTable<SoItem>
                tableId={`so-lines-${docNo}`}
                rows={items}
                loading={false}
                columns={lineColumns}
                getRowKey={(l) => l.id}
                emptyLabel="No line items"
              />
            </Section>
          </DetailMain>

          <DetailAside>
            {/* Aside is hidden on phone (Order total is a light card at the
                top of main; Key dates / People / Recent activity are omitted
                on mobile per the design). Reappears from md up. */}
            <div className="hidden lg:sticky lg:top-[124px] space-y-3 md:block">
              <OrderTotalCard
                header={salesOrder}
                subtotalCenti={subtotalCenti}
                discountCenti={discountCenti}
                totalCenti={totalCenti}
              />

              <AsideCard title="Key dates">
                <KeyDateRow k="SO date" v={fmtDate(salesOrder.so_date)} />
                <KeyDateRow
                  k="Processing"
                  v={fmtDate(salesOrder.processing_date)}
                  muted={!salesOrder.processing_date}
                />
                <KeyDateRow
                  k="Delivery"
                  v={
                    salesOrder.customer_delivery_date
                      ? fmtDate(salesOrder.customer_delivery_date)
                      : "Not set"
                  }
                  muted={!salesOrder.customer_delivery_date}
                />
              </AsideCard>

              <AsideCard title="People">
                <PersonRow
                  initials={
                    salesOrder.agent || salesOrder.salesperson_id
                      ? initialsOf(
                          salesOrder.agent || salesOrder.salesperson_id
                        )
                      : "?"
                  }
                  name={
                    salesOrder.agent ||
                    salesOrder.salesperson_id ||
                    "Salesperson"
                  }
                  role={
                    salesOrder.agent || salesOrder.salesperson_id
                      ? "Salesperson"
                      : "Not yet assigned"
                  }
                  tone={
                    salesOrder.agent || salesOrder.salesperson_id
                      ? "accent"
                      : "neutral"
                  }
                />
                <PersonRow
                  initials={initialsOf(salesOrder.debtor_name)}
                  name={salesOrder.debtor_name || "—"}
                  role={`Customer${
                    refOf(salesOrder) !== "—"
                      ? ` · ${refOf(salesOrder)}`
                      : ""
                  }`}
                  tone="accent"
                />
              </AsideCard>

              <AsideCard title="Recent activity">
                <ActivityRow
                  title={`Order ${statusFor(salesOrder.status).label.toLowerCase()}`}
                  meta={fmtDate(salesOrder.so_date)}
                  dot={
                    statusFor(salesOrder.status).tone === "success"
                      ? "success"
                      : "primary"
                  }
                />
                <ActivityRow
                  title={`Lines added (${items.length})`}
                  meta={fmtDate(salesOrder.so_date)}
                  dot="primary"
                />
                <ActivityRow
                  title="Created"
                  meta={`${fmtDate(salesOrder.so_date)}${
                    salesOrder.customer_type
                      ? ` · ${salesOrder.customer_type}`
                      : ""
                  }`}
                  dot="muted"
                  isLast
                />
              </AsideCard>
            </div>
          </DetailAside>
        </DetailGrid>
      </div>

      {/* ─── Fixed bottom action bar (phone only) ───────────────────── */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 px-3 pb-6 pt-2.5 shadow-slab backdrop-blur-sm md:hidden">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={goEdit}
            className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary text-[13.5px] font-bold text-white shadow-sm hover:bg-primary-ink"
          >
            <Edit3 size={16} /> Edit
          </button>
          <button
            type="button"
            onClick={goPrintPdf}
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-surface-2 text-primary-ink hover:bg-primary-soft"
            aria-label="Print PDF"
          >
            <Printer size={17} />
          </button>
          <button
            type="button"
            onClick={goCall}
            disabled={!salesOrder.phone}
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-surface-2 text-primary-ink hover:bg-primary-soft disabled:opacity-40"
            aria-label={salesOrder.phone ? `Call ${salesOrder.phone}` : "No phone on file"}
          >
            <PhoneIcon size={17} />
          </button>
        </div>
      </div>

      {/* Relationship map modal — 5-node graph per Nick's 2026-07-08 handoff */}
      <DocumentRelationshipMapModal
        open={relMapOpen}
        onClose={() => setRelMapOpen(false)}
        nodes={chainNodes}
        onNodeClick={(n) => {
          // Non-current nodes with a linked doc could navigate to that doc
          // — for now only the current SO exists, so noop.
          void n;
        }}
      />
    </div>
  );
}

// ─── Small utility dot separator ──────────────────────────────────────────

function Divider() {
  return (
    <span className="inline-flex items-center text-border-strong">
      <CircleDot size={4} className="mx-0.5 opacity-40" />
    </span>
  );
}

export default SalesOrderDetailV2;
