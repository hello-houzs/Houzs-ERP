// DeliveryOrderDetailV2 — Theme C ("Ink & Petrol") redesign of the Delivery
// Order detail page, mirroring SalesOrderDetailV2's read-first structure.
//
// Key departures from the SO detail template (all Nick / owner calls):
//   · DO is QUANTITY-only (Owner 2026-06-26) — the Order-total dark hero and
//     every unit-price / discount / amount column that lives on the SO detail
//     are dropped. In their place the aside carries a "Delivery" hero card
//     (driver + vehicle + expected date) since dispatch info IS the DO's
//     primary payload.
//   · Status flow is document-lifecycle-driven: Draft → Shipped → Invoiced →
//     Returned, plus Cancelled. Mirrors the DO listing V2 tone map.
//   · Origin doc is SO (not a quotation), so "From SO" ref is promoted into
//     the sticky header meta line + the People aside card.
//   · Header CTA switches by status:
//       Mark signed   — LOADED / DISPATCHED / IN_TRANSIT
//       Convert to SI — SIGNED / DELIVERED  (routes to the SI-from-DO flow)
//     Plus the shared History / Print / Cancel / Edit set.
//
// The old ledger-style DeliveryOrderDetail.tsx stays in the tree; App.tsx
// route swap on /scm/delivery-orders/:id decides which one users see.

import { useMemo, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  History,
  Printer,
  XCircle,
  Edit3,
  Warehouse,
  Truck,
  CircleDot,
  Phone as PhoneIcon,
  MoreHorizontal,
  CheckCircle2,
  Receipt,
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
  useMfgDeliveryOrderDetail,
  useUpdateMfgDeliveryOrderStatus,
} from "../../vendor/scm/lib/delivery-order-queries";
import { useSetBreadcrumbs } from "../../hooks/useBreadcrumbs";
import { cn } from "../../lib/utils";

// ─── Header + item shapes (subset — see DeliveryOrderDetail.tsx / the DO list
// V2 for the full 40-field row) ────────────────────────────────────────────

type DoLifecycle = "shipped" | "invoiced" | "returned";

type DoHeader = {
  id: string;
  do_number: string;
  so_doc_no: string | null;
  status: string;
  do_date: string;
  expected_delivery_at: string | null;
  customer_delivery_date: string | null;
  debtor_code: string | null;
  debtor_name: string;
  salesperson_id: string | null;
  agent: string | null;
  branding: string | null;
  venue: string | null;
  ref: string | null;
  customer_so_no: string | null;
  po_doc_no: string | null;
  sales_location: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  postcode: string | null;
  customer_state: string | null;
  customer_country: string | null;
  customer_type: string | null;
  building_type: string | null;
  phone: string | null;
  email: string | null;
  driver_id: string | null;
  driver_name: string | null;
  vehicle: string | null;
  note: string | null;
  notes: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  lifecycle_state?: DoLifecycle;
  currency: string;
};

type DoItem = {
  id: string;
  item_code: string;
  description: string | null;
  description2: string | null;
  uom: string;
  qty: number;
  cancelled?: boolean;
  item_group?: string;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const s = iso.replace(/T.*$/, "");
  const m = /^(\d{4})[-/](\d{2})[-/](\d{2})$/.exec(s);
  if (!m) return s;
  return `${m[3]}/${m[2]}/${m[1]}`;
};

// Ref chain matches the DO list V2: PO no > customer SO no > free-text ref.
const refOf = (h: DoHeader): string =>
  h.po_doc_no || h.customer_so_no || h.ref || "—";

const soOf = (h: DoHeader): string => h.so_doc_no || "—";

const brandOf = (h: DoHeader): string => h.branding || "—";

// Same reduce as the DO listing V2: the recorded status is a stage in the raw
// flow (LOADED/DISPATCHED/…) but display is lifecycle-based — Draft / Shipped
// / Invoiced / Returned / Cancelled. Keep the raw status in the Badge label
// so ops still see the exact stage; the effective bucket drives the tone.
type Effective = "draft" | "shipped" | "invoiced" | "returned" | "cancelled";
const effectiveOf = (h: DoHeader): Effective => {
  const s = (h.status || "").toUpperCase();
  if (s === "CANCELLED") return "cancelled";
  if (s === "DRAFT") return "draft";
  if (h.lifecycle_state === "returned") return "returned";
  if (h.lifecycle_state === "invoiced") return "invoiced";
  return "shipped";
};

// Tone + label + blurb per effective bucket. Uses the same
// success/warning/error/neutral Badge tones as the DO listing V2.
const EFFECTIVE_TONE: Record<
  Effective,
  { tone: "success" | "warning" | "error" | "neutral"; label: string; blurb: string }
> = {
  draft: {
    tone: "warning",
    label: "Draft",
    blurb: "Draft · not yet shipped",
  },
  shipped: {
    tone: "warning",
    label: "Shipped",
    blurb: "Shipped · goods on the road",
  },
  invoiced: {
    tone: "success",
    label: "Invoiced",
    blurb: "Invoiced · SI issued",
  },
  returned: {
    tone: "error",
    label: "Returned",
    blurb: "Returned · goods came back",
  },
  cancelled: {
    tone: "error",
    label: "Cancelled",
    blurb: "Cancelled · no further action",
  },
};

// Fine-grained stage label — the DO row Badge in the SO/DO chrome; kept here
// so the sticky header reads "Signed" instead of collapsing to "Shipped".
const STAGE_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  LOADED: "Loaded",
  DISPATCHED: "Dispatched",
  IN_TRANSIT: "In transit",
  SIGNED: "Signed",
  DELIVERED: "Delivered",
  INVOICED: "Invoiced",
  RETURNED: "Returned",
  CANCELLED: "Cancelled",
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

// ─── Field cell (identical shape to SO detail V2) ──────────────────────────

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

// ─── Aside sub-primitives ───────────────────────────────────────────────────

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

// ─── Delivery hero (dark aside card replacing SO's Order-total) ─────────────
//
// The SO detail leans on a money hero because a sales order IS a money
// promise. A delivery order isn't — it's a dispatch promise. The dark
// aside slab here surfaces WHO's driving WHAT to the customer WHEN, so
// dispatch questions ("did DO XYZ ever leave the yard?") answer at a
// glance without opening a modal.

function DeliveryHeroCard({ header }: { header: DoHeader }) {
  const eff = effectiveOf(header);
  const t = EFFECTIVE_TONE[eff];
  const stageLabel =
    STAGE_LABEL[(header.status || "").toUpperCase()] ?? header.status;
  return (
    <div className="rounded-lg bg-sidebar px-5 py-5 text-sidebar-ink shadow-stone">
      <div className="font-mono text-[10px] font-semibold uppercase tracking-brand text-sidebar-ink-muted">
        Dispatch
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="font-display text-[24px] font-bold leading-none tracking-tight text-white">
          {stageLabel}
        </span>
        <span className="text-[12px] text-sidebar-ink-muted">
          · {t.label.toLowerCase()}
        </span>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span
          className={cn(
            "h-2 w-2 rounded-full",
            t.tone === "success"
              ? "bg-synced"
              : t.tone === "warning"
                ? "bg-accent-bright"
                : t.tone === "error"
                  ? "bg-err"
                  : "bg-sidebar-ink-muted"
          )}
        />
        <span className="text-[12.5px] text-sidebar-ink-muted">{t.blurb}</span>
      </div>

      <div className="mt-4 space-y-2 border-t border-white/10 pt-4">
        <HeroLine k="Driver" v={header.driver_name || "Unassigned"} />
        <HeroLine k="Vehicle" v={header.vehicle || "—"} />
        <HeroLine
          k="Expected"
          v={
            header.expected_delivery_at
              ? fmtDate(header.expected_delivery_at)
              : header.customer_delivery_date
                ? fmtDate(header.customer_delivery_date)
                : "Not scheduled"
          }
        />
      </div>
    </div>
  );
}

function HeroLine({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[12.5px] text-sidebar-ink-muted">{k}</span>
      <span className="text-[13px] font-semibold text-sidebar-ink">{v}</span>
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────

export function DeliveryOrderDetailV2() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const detail = useMfgDeliveryOrderDetail(id ?? null);
  const updateStatus = useUpdateMfgDeliveryOrderStatus();

  const deliveryOrder =
    (detail.data as { deliveryOrder?: DoHeader } | undefined)?.deliveryOrder ??
    null;
  const items: DoItem[] =
    ((detail.data as { items?: DoItem[] } | undefined)?.items ?? []).filter(
      (l) => !l.cancelled
    );

  // Replace the auto-derived "Delivery Orders" crumb (fine at the top level)
  // with the actual DO number as the trailing crumb, matching SO detail V2.
  useSetBreadcrumbs([
    { label: "Delivery Orders", to: "/scm/delivery-orders" },
    { label: deliveryOrder?.do_number ?? id ?? "Delivery Order" },
  ]);

  const eff = deliveryOrder ? effectiveOf(deliveryOrder) : null;
  const stageLabel = deliveryOrder
    ? STAGE_LABEL[(deliveryOrder.status || "").toUpperCase()] ??
      deliveryOrder.status
    : "";
  const badgeTone = eff ? EFFECTIVE_TONE[eff].tone : "neutral";

  const foldedNote = useMemo(
    () => deliveryOrder?.note || deliveryOrder?.notes || null,
    [deliveryOrder?.note, deliveryOrder?.notes]
  );

  const goBack = () => {
    if (params.get("from") === "list") navigate("/scm/delivery-orders");
    else navigate(-1);
  };
  const goEdit = () => id && navigate(`/scm/delivery-orders/${id}?edit=1`);
  const doCancel = () => {
    if (!deliveryOrder) return;
    if (
      window.confirm(
        `Cancel delivery order ${deliveryOrder.do_number}? Stock allocated to this DO will be released back to the SO.`
      )
    ) {
      updateStatus.mutate({ id: deliveryOrder.id, status: "cancelled" });
    }
  };
  const goHistory = () => id && navigate(`/scm/delivery-orders/${id}?tab=history`);
  const goPrintPdf = () => id && navigate(`/scm/delivery-orders/${id}?print=1`);
  const doMarkSigned = () => {
    if (!deliveryOrder) return;
    updateStatus.mutate({ id: deliveryOrder.id, status: "delivered" });
  };
  const goConvertToSi = () =>
    deliveryOrder &&
    navigate(`/scm/sales-invoices/from-do?do=${deliveryOrder.id}`);

  // ── DO line item columns — qty only, no money (owner 2026-06-26) ──────
  const lineColumns: Column<DoItem>[] = [
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
      width: "108px",
      align: "right",
      getValue: (l) => l.qty,
      render: (l) => (
        <span className="font-money text-[13.5px] font-semibold text-ink">
          {l.qty}{" "}
          <span className="text-[10.5px] font-normal text-ink-muted">
            {l.uom}
          </span>
        </span>
      ),
    },
  ];

  // ── Loading / error states ───────────────────────────────────────────
  if (!id) {
    return (
      <div className="p-8 text-center text-ink-muted">
        No delivery order specified.
      </div>
    );
  }
  if (detail.isLoading) {
    return (
      <div className="animate-fade-in p-8 text-center text-ink-muted">
        Loading delivery order…
      </div>
    );
  }
  if (detail.error || !deliveryOrder) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <div className="mb-2 font-display text-[18px] font-extrabold text-err">
          Couldn't load delivery order
        </div>
        <p className="text-[13px] text-ink-muted">
          {(detail.error as Error | undefined)?.message ??
            "The delivery order was not found."}
        </p>
        <div className="mt-4">
          <Button variant="secondary" onClick={goBack} icon={<ArrowLeft size={14} />}>
            Back to Delivery Orders
          </Button>
        </div>
      </div>
    );
  }

  const goCall = () => {
    if (!deliveryOrder?.phone) return;
    window.location.href = `tel:${deliveryOrder.phone.replace(/\s+/g, "")}`;
  };

  // Header CTA switch — same logic as the list V2 drawer, promoted to the
  // sticky bar so a status advance from Detail matches the drawer's shape.
  const rawStatus = (deliveryOrder.status || "").toLowerCase();
  const canMarkSigned =
    rawStatus === "loaded" ||
    rawStatus === "dispatched" ||
    rawStatus === "in_transit";
  const canConvertToSi =
    rawStatus === "signed" || rawStatus === "delivered";
  const isCancelled = rawStatus === "cancelled";

  return (
    <div className="pb-24 md:pb-0">
      {/* ─── Mobile-only dark sticky header ─────────────────────────── */}
      <div className="sticky top-0 z-20 -mx-4 -mt-4 bg-sidebar text-sidebar-ink shadow-slab md:hidden">
        <div className="flex items-center justify-between gap-3 px-4 pt-3">
          <button
            type="button"
            onClick={goBack}
            className="inline-flex items-center gap-1 text-[14px] font-semibold text-accent-bright"
            aria-label="Back to Delivery Orders"
          >
            <ArrowLeft size={16} /> DOs
          </button>
          <span className="font-mono text-[12.5px] font-semibold text-sidebar-ink">
            {deliveryOrder.do_number}
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
            {deliveryOrder.debtor_name || "—"}
          </h1>
          <div className="mt-2">
            <Badge tone={badgeTone} variant="solid" size="xs">
              {stageLabel}
            </Badge>
          </div>
        </div>
      </div>

      {/* ─── Desktop sticky header ─────────────────────────────────── */}
      <div className="sticky top-0 z-10 -mx-4 hidden border-b border-border bg-bg/95 px-4 py-4 backdrop-blur-sm sm:-mx-6 sm:px-6 md:block">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <button
              type="button"
              onClick={goBack}
              aria-label="Back to Delivery Orders"
              className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-ink-secondary hover:border-primary/50 hover:text-primary"
            >
              <ArrowLeft size={16} />
            </button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">
                  {deliveryOrder.debtor_name || "—"}
                </h1>
                <Badge tone={badgeTone} size="sm">
                  {stageLabel}
                </Badge>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-secondary">
                <span className="font-mono font-semibold text-primary-ink">
                  {deliveryOrder.do_number}
                </span>
                <Divider />
                <span>DO date {fmtDate(deliveryOrder.do_date)}</span>
                <Divider />
                <span>{items.length} line{items.length === 1 ? "" : "s"}</span>
                {soOf(deliveryOrder) !== "—" && (
                  <>
                    <Divider />
                    <span>
                      From SO{" "}
                      <span className="font-mono font-semibold text-ink-secondary">
                        {soOf(deliveryOrder)}
                      </span>
                    </span>
                  </>
                )}
                {refOf(deliveryOrder) !== "—" && (
                  <>
                    <Divider />
                    <span>
                      Ref{" "}
                      <span className="font-mono font-semibold text-ink-secondary">
                        {refOf(deliveryOrder)}
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
              variant="secondary"
              icon={<Printer size={14} />}
              onClick={goPrintPdf}
            >
              Print PDF
            </Button>
            {!isCancelled && (
              <Button
                variant="danger"
                icon={<XCircle size={14} />}
                onClick={doCancel}
              >
                Cancel DO
              </Button>
            )}
            {canMarkSigned && (
              <Button
                variant="secondary"
                icon={<CheckCircle2 size={14} />}
                onClick={doMarkSigned}
              >
                Mark signed
              </Button>
            )}
            {canConvertToSi && (
              <Button
                variant="secondary"
                icon={<Receipt size={14} />}
                onClick={goConvertToSi}
              >
                Convert to SI
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
        {/* Mobile-only Dispatch hero — sits at the top of the scroll body.
            On md+ the dark Delivery hero lives in the sticky aside instead. */}
        <div className="mb-3 rounded-lg border border-border bg-surface p-4 shadow-stone md:hidden">
          <div className="flex items-baseline gap-2">
            <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
              Dispatch
            </div>
          </div>
          <div className="mt-1 font-display text-[22px] font-bold leading-none tracking-tight text-ink">
            {stageLabel}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-muted">
            <span>
              <Truck size={11} className="mr-1 inline" />
              {deliveryOrder.driver_name || "Unassigned"}
              {deliveryOrder.vehicle ? ` · ${deliveryOrder.vehicle}` : ""}
            </span>
            <span>
              Expected{" "}
              {deliveryOrder.expected_delivery_at
                ? fmtDate(deliveryOrder.expected_delivery_at)
                : deliveryOrder.customer_delivery_date
                  ? fmtDate(deliveryOrder.customer_delivery_date)
                  : "TBD"}
            </span>
          </div>
        </div>
        <DetailGrid>
          <DetailMain>
            {/* Customer */}
            <Section title="Customer">
              <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-3">
                <Field
                  label="Customer name"
                  value={deliveryOrder.debtor_name || "—"}
                />
                <Field
                  label="Phone"
                  value={deliveryOrder.phone || "Not provided"}
                  muted={!deliveryOrder.phone}
                  mono={!!deliveryOrder.phone}
                />
                <Field
                  label="Email"
                  value={deliveryOrder.email || "Not provided"}
                  muted={!deliveryOrder.email}
                />
                <Field
                  label="Customer type"
                  value={deliveryOrder.customer_type || "—"}
                  muted={!deliveryOrder.customer_type}
                />
                <Field
                  label="From SO"
                  value={soOf(deliveryOrder)}
                  mono={soOf(deliveryOrder) !== "—"}
                  muted={soOf(deliveryOrder) === "—"}
                />
                <Field
                  label="Customer ref"
                  value={refOf(deliveryOrder)}
                  mono={refOf(deliveryOrder) !== "—"}
                  muted={refOf(deliveryOrder) === "—"}
                />
              </div>
            </Section>

            {/* Dispatch info — DO's editorial primary section (SO detail's
                Order-info equivalent). Driver / vehicle / expected date /
                customer delivery date + branding + venue. Foot-of-section
                amber Note if there's one. */}
            <Section title="Dispatch">
              <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-4">
                <Field
                  label="Driver"
                  value={deliveryOrder.driver_name || "Unassigned"}
                  muted={!deliveryOrder.driver_name}
                />
                <Field
                  label="Vehicle"
                  value={deliveryOrder.vehicle || "—"}
                  muted={!deliveryOrder.vehicle}
                  mono={!!deliveryOrder.vehicle}
                />
                <Field
                  label="Expected at"
                  value={fmtDate(deliveryOrder.expected_delivery_at)}
                  muted={!deliveryOrder.expected_delivery_at}
                />
                <Field
                  label="Customer delivery"
                  value={
                    deliveryOrder.customer_delivery_date
                      ? fmtDate(deliveryOrder.customer_delivery_date)
                      : "Not scheduled"
                  }
                  muted={!deliveryOrder.customer_delivery_date}
                />
                <Field
                  label="Branding"
                  value={brandOf(deliveryOrder)}
                  muted={brandOf(deliveryOrder) === "—"}
                />
                <Field
                  label="Venue"
                  value={deliveryOrder.venue || "—"}
                  muted={!deliveryOrder.venue}
                />
                <Field
                  label="Salesperson"
                  value={
                    deliveryOrder.agent ||
                    deliveryOrder.salesperson_id ||
                    "Unassigned"
                  }
                  muted={
                    !deliveryOrder.agent && !deliveryOrder.salesperson_id
                  }
                />
                <Field
                  label="Building type"
                  value={deliveryOrder.building_type || "—"}
                  muted={!deliveryOrder.building_type}
                />
              </div>

              {foldedNote && (
                <div className="mt-4 rounded-lg border border-warning-text/25 bg-warning-bg px-4 py-3">
                  <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-warning-text">
                    Note
                  </div>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-warning-text">
                    {foldedNote}
                  </p>
                </div>
              )}
            </Section>

            {/* Delivery address + Emergency contact — identical layout to SO
                detail V2 but the emergency-contact side reads the DO's own
                emergency_contact_* fields (they're distinct from the phone
                on the customer record, per the SO/DO editable schema). */}
            <Section title="Delivery address">
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-[1.4fr_1fr] sm:divide-x sm:divide-border-subtle">
                <div className="sm:pr-6">
                  <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                    Ship to
                  </div>
                  <div className="mt-1.5 text-[14px] font-semibold leading-relaxed text-ink">
                    {[
                      deliveryOrder.address1,
                      deliveryOrder.address2,
                      [deliveryOrder.city, deliveryOrder.postcode]
                        .filter(Boolean)
                        .join(" "),
                      [deliveryOrder.customer_state, deliveryOrder.customer_country]
                        .filter(Boolean)
                        .join(", "),
                    ]
                      .filter(Boolean)
                      .map((line, i) => (
                        <div key={i}>{line}</div>
                      ))}
                    {!deliveryOrder.address1 && !deliveryOrder.city && (
                      <span className="text-ink-muted">Not provided</span>
                    )}
                  </div>
                  {deliveryOrder.sales_location && (
                    <div className="mt-3 inline-flex items-center gap-2 rounded-md bg-primary-soft px-2.5 py-1 text-[11.5px] font-semibold text-primary-ink">
                      <Warehouse size={12} />
                      {deliveryOrder.sales_location}
                    </div>
                  )}
                </div>
                <div className="sm:pl-6">
                  <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                    Emergency contact
                  </div>
                  <div className="mt-1.5 text-[12.5px] text-ink-muted">
                    Called if driver can't reach the customer
                  </div>
                  <div className="mt-2.5 text-[14px] font-semibold text-ink">
                    {deliveryOrder.emergency_contact_name || "Not provided"}
                  </div>
                  <div className="mt-1 font-mono text-[12.5px] text-ink-secondary">
                    {deliveryOrder.emergency_contact_phone || "—"}
                  </div>
                  {deliveryOrder.emergency_contact_relationship && (
                    <div className="mt-1 text-[12px] text-ink-muted">
                      {deliveryOrder.emergency_contact_relationship}
                    </div>
                  )}
                </div>
              </div>
            </Section>

            {/* Line items — qty only, no money (owner 2026-06-26). */}
            <Section title={`Line items · ${items.length}`}>
              <DataTable<DoItem>
                tableId={`do-lines-${id}`}
                rows={items}
                loading={false}
                columns={lineColumns}
                getRowKey={(l) => l.id}
                emptyLabel="No line items"
              />
            </Section>
          </DetailMain>

          <DetailAside>
            {/* Aside is hidden on phone (Dispatch hero is a light card at
                the top of main; Key dates / People / Recent activity are
                omitted on mobile). Reappears from md up. */}
            <div className="hidden lg:sticky lg:top-[124px] space-y-3 md:block">
              <DeliveryHeroCard header={deliveryOrder} />

              <AsideCard title="Key dates">
                <KeyDateRow k="DO date" v={fmtDate(deliveryOrder.do_date)} />
                <KeyDateRow
                  k="Expected"
                  v={fmtDate(deliveryOrder.expected_delivery_at)}
                  muted={!deliveryOrder.expected_delivery_at}
                />
                <KeyDateRow
                  k="Customer delivery"
                  v={
                    deliveryOrder.customer_delivery_date
                      ? fmtDate(deliveryOrder.customer_delivery_date)
                      : "Not set"
                  }
                  muted={!deliveryOrder.customer_delivery_date}
                />
              </AsideCard>

              <AsideCard title="People">
                <PersonRow
                  initials={
                    deliveryOrder.driver_name
                      ? initialsOf(deliveryOrder.driver_name)
                      : "?"
                  }
                  name={deliveryOrder.driver_name || "Driver"}
                  role={
                    deliveryOrder.driver_name
                      ? `Driver${deliveryOrder.vehicle ? ` · ${deliveryOrder.vehicle}` : ""}`
                      : "Not yet assigned"
                  }
                  tone={deliveryOrder.driver_name ? "accent" : "neutral"}
                />
                <PersonRow
                  initials={
                    deliveryOrder.agent || deliveryOrder.salesperson_id
                      ? initialsOf(
                          deliveryOrder.agent || deliveryOrder.salesperson_id
                        )
                      : "?"
                  }
                  name={
                    deliveryOrder.agent ||
                    deliveryOrder.salesperson_id ||
                    "Salesperson"
                  }
                  role={
                    deliveryOrder.agent || deliveryOrder.salesperson_id
                      ? "Salesperson"
                      : "Not yet assigned"
                  }
                  tone={
                    deliveryOrder.agent || deliveryOrder.salesperson_id
                      ? "accent"
                      : "neutral"
                  }
                />
                <PersonRow
                  initials={initialsOf(deliveryOrder.debtor_name)}
                  name={deliveryOrder.debtor_name || "—"}
                  role={`Customer${
                    soOf(deliveryOrder) !== "—"
                      ? ` · SO ${soOf(deliveryOrder)}`
                      : ""
                  }`}
                  tone="accent"
                />
              </AsideCard>

              <AsideCard title="Recent activity">
                <ActivityRow
                  title={`DO ${EFFECTIVE_TONE[effectiveOf(deliveryOrder)].label.toLowerCase()}`}
                  meta={fmtDate(deliveryOrder.do_date)}
                  dot={
                    EFFECTIVE_TONE[effectiveOf(deliveryOrder)].tone === "success"
                      ? "success"
                      : "primary"
                  }
                />
                <ActivityRow
                  title={`Lines loaded (${items.length})`}
                  meta={fmtDate(deliveryOrder.do_date)}
                  dot="primary"
                />
                <ActivityRow
                  title="Created"
                  meta={`${fmtDate(deliveryOrder.do_date)}${
                    deliveryOrder.sales_location
                      ? ` · ${deliveryOrder.sales_location}`
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
            disabled={!deliveryOrder.phone}
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-surface-2 text-primary-ink hover:bg-primary-soft disabled:opacity-40"
            aria-label={
              deliveryOrder.phone
                ? `Call ${deliveryOrder.phone}`
                : "No phone on file"
            }
          >
            <PhoneIcon size={17} />
          </button>
        </div>
      </div>
    </div>
  );
}

function Divider() {
  return (
    <span className="inline-flex items-center text-border-strong">
      <CircleDot size={4} className="mx-0.5 opacity-40" />
    </span>
  );
}

export default DeliveryOrderDetailV2;
