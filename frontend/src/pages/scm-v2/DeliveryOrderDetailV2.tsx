// DeliveryOrderDetailV2 — Theme C ("Ink & Petrol") design of the Delivery
// Order detail page, matching the 2026-07-08 design handoff prototypes.
//
// The 4 primary actions in the sticky header all open real modal overlays:
//   · History         — change-history timeline
//   · Relationship Map — a node-graph modal showing the document chain
//     PO → SO → DO (current) → GRN → Invoice, NOT an inline pipeline
//   · Print PDF       — print-preview card + Download/Print
//   · Edit            — navigate to the New DO form
//
// Stateful DO transitions (Cancel DO / Mark signed / Convert to SI) are
// kept as CONDITIONAL secondary buttons within the same header, positioned
// between Print PDF and Edit so they don't hide from ops but also don't
// dominate the primary action bar.
//
// Aside dark hero flips from the earlier "Dispatch" (driver-info-forward)
// version to a "Delivery status" card — status label + scheduled date +
// Total items + Warehouse — because ops opens a DO detail asking "is it
// on the road yet?", not "who's driving". Driver info moves INTO the
// Delivery info section as an ink-tinted sub-card.
//
// Route: /scm/delivery-orders/:id. Data: useMfgDeliveryOrderDetail /
// useUpdateMfgDeliveryOrderStatus (unchanged from prior V2).

import { useMemo, useState, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  History,
  Printer,
  XCircle,
  Edit3,
  Warehouse,
  CircleDot,
  Phone as PhoneIcon,
  MoreHorizontal,
  CheckCircle2,
  Receipt,
  Share2,
  X as XIcon,
  Download,
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

// ─── Header + item shapes (subset — full 40-field row lives in the list V2) ─

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
  salesperson_name?: string | null;
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
  driver_ic: string | null;
  driver_phone: string | null;
  vehicle: string | null;
  note: string | null;
  notes: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  lifecycle_state?: DoLifecycle;
  currency: string;
  created_at?: string;
  created_by?: string | null;
  issued_by_name?: string | null;
};

type DoItem = {
  id: string;
  item_code: string;
  description: string | null;
  description2: string | null;
  uom: string;
  qty: number;
  unit_price_centi?: number;
  cancelled?: boolean;
  item_group?: string;
  variants?: Record<string, unknown> | null;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const s = iso.replace(/T.*$/, "");
  const m = /^(\d{4})[-/](\d{2})[-/](\d{2})$/.exec(s);
  if (!m) return s;
  return `${m[3]}/${m[2]}/${m[1]}`;
};

const refOf = (h: DoHeader): string =>
  h.po_doc_no || h.customer_so_no || h.ref || "—";

const soOf = (h: DoHeader): string => h.so_doc_no || "—";

const brandOf = (h: DoHeader): string => h.branding || "—";

type Effective = "draft" | "shipped" | "invoiced" | "returned" | "cancelled";
const effectiveOf = (h: DoHeader): Effective => {
  const s = (h.status || "").toUpperCase();
  if (s === "CANCELLED") return "cancelled";
  if (s === "DRAFT") return "draft";
  if (h.lifecycle_state === "returned") return "returned";
  if (h.lifecycle_state === "invoiced") return "invoiced";
  return "shipped";
};

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
    label: "Ready to dispatch",
    blurb: "Scheduled · goods on the road",
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

// Fine-grained stage label — kept for the sticky header Badge so ops sees
// the exact stored status (Loaded / Dispatched / In transit / Signed / …)
// even when the effective bucket collapses to "shipped".
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

const shipTo = (h: DoHeader): string[] =>
  [
    h.address1,
    h.address2,
    [h.city, h.postcode].filter(Boolean).join(" "),
    [h.customer_state, h.customer_country].filter(Boolean).join(", "),
  ].filter((s): s is string => !!s && s.trim().length > 0);

// ─── Field cell ────────────────────────────────────────────────────────────

function Field({
  label,
  value,
  muted,
  mono,
  accent,
}: {
  label: string;
  value: ReactNode;
  muted?: boolean;
  mono?: boolean;
  accent?: boolean;
}) {
  return (
    <div>
      <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 text-[14px] font-semibold leading-snug",
          muted ? "text-ink-muted" : accent ? "text-accent-ink" : "text-ink",
          mono && "font-mono"
        )}
      >
        {value}
      </div>
    </div>
  );
}

// ─── Aside primitives ──────────────────────────────────────────────────────

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

// ─── Delivery-status aside hero (dark slab) ────────────────────────────────
//
// Replaces the earlier "Dispatch" driver-focused hero. Now surfaces the four
// signals ops opens a DO for: state label · scheduled date · total items ·
// warehouse. Matches the design handoff card exactly.

function DeliveryStatusCard({
  header,
  totalQty,
}: {
  header: DoHeader;
  totalQty: number;
}) {
  const eff = effectiveOf(header);
  const t = EFFECTIVE_TONE[eff];
  return (
    <div className="rounded-lg bg-sidebar px-5 py-5 text-sidebar-ink shadow-stone">
      <div className="font-mono text-[10px] font-semibold uppercase tracking-brand text-sidebar-ink-muted">
        Delivery status
      </div>
      <div className="mt-2 font-display text-[22px] font-bold leading-tight tracking-tight text-white">
        {t.label}
      </div>
      <div className="mt-2.5 flex items-center gap-2">
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
        <span className="text-[12.5px] text-sidebar-ink-muted">
          {header.customer_delivery_date
            ? `Scheduled ${fmtDate(header.customer_delivery_date)}`
            : header.expected_delivery_at
              ? `Expected ${fmtDate(header.expected_delivery_at)}`
              : "Not yet scheduled"}
        </span>
      </div>

      <div className="mt-4 space-y-2.5 border-t border-white/10 pt-4">
        <div className="flex items-center justify-between">
          <span className="text-[12.5px] text-sidebar-ink-muted">Total items</span>
          <span className="font-money text-[14px] font-bold text-white">
            {totalQty}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[12.5px] text-sidebar-ink-muted">Warehouse</span>
          <span className="text-[13px] font-semibold text-sidebar-ink">
            {header.sales_location || "—"}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Driver sub-card (embedded inside Delivery info) ───────────────────────

function DriverSubCard({ header }: { header: DoHeader }) {
  return (
    <div className="mt-4 rounded-lg border border-border-subtle bg-surface-2 px-4 py-4">
      <div className="mb-3 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-secondary">
        Driver
      </div>
      <div className="grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-4">
        <Field label="Driver name" value={header.driver_name || "Unassigned"} muted={!header.driver_name} />
        <Field label="IC number" value={header.driver_ic || "—"} mono={!!header.driver_ic} muted={!header.driver_ic} />
        <Field
          label="Phone"
          value={header.driver_phone || "—"}
          mono={!!header.driver_phone}
          muted={!header.driver_phone}
        />
        <Field label="Vehicle" value={header.vehicle || "—"} mono={!!header.vehicle} muted={!header.vehicle} />
      </div>
    </div>
  );
}

// ─── Modal shell ───────────────────────────────────────────────────────────

function ModalOverlay({
  open,
  onClose,
  title,
  icon,
  size = "sm",
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  icon?: ReactNode;
  size?: "sm" | "lg";
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <>
      <div
        onClick={onClose}
        aria-hidden
        className={cn(
          "fixed inset-0 z-[80] bg-ink/45 backdrop-blur-[1px] transition-opacity duration-200",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "fixed left-1/2 top-1/2 z-[81] flex max-h-[82vh] w-[calc(100%-32px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl bg-surface shadow-slab transition-all duration-200",
          size === "lg" ? "max-w-[760px]" : "max-w-[480px]",
          open ? "scale-100 opacity-100" : "pointer-events-none scale-[.97] opacity-0"
        )}
      >
        <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-5">
          <div className="flex items-center gap-2.5">
            {icon && <span className="text-accent-ink">{icon}</span>}
            <span className="text-[15px] font-bold text-ink">{title}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-muted hover:text-ink"
            aria-label="Close"
          >
            <XIcon size={18} />
          </button>
        </div>
        <div className="thin-scroll flex-1 overflow-y-auto p-5">{children}</div>
        {footer && (
          <div className="flex shrink-0 items-center gap-2 border-t border-border-subtle bg-surface-2 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </>
  );
}

// ─── Modal · Change history timeline ───────────────────────────────────────

function HistoryModal({
  open,
  onClose,
  header,
  itemsCount,
}: {
  open: boolean;
  onClose: () => void;
  header: DoHeader;
  itemsCount: number;
}) {
  // Derived timeline from the header's timestamps + status. A future backend
  // history endpoint can replace this with a proper audit log; for now the
  // detail endpoint doesn't return one, so we synthesize from what we know.
  const events: Array<{ title: string; at: string; by: string; dot: "success" | "primary" | "muted" }> =
    useMemo(() => {
      const list: Array<{ title: string; at: string; by: string; dot: "success" | "primary" | "muted" }> = [];
      list.push({
        title: header.so_doc_no
          ? `DO created from ${header.so_doc_no}`
          : "DO created",
        at: fmtDate(header.created_at || header.do_date),
        by: header.issued_by_name || header.created_by || "System",
        dot: "success",
      });
      if (header.driver_name) {
        list.push({
          title: `Driver ${header.driver_name} assigned`,
          at: fmtDate(header.do_date),
          by: header.issued_by_name || "System",
          dot: "primary",
        });
      }
      if (header.customer_delivery_date) {
        list.push({
          title: `Delivery scheduled ${fmtDate(header.customer_delivery_date)}`,
          at: fmtDate(header.do_date),
          by: header.issued_by_name || "System",
          dot: "primary",
        });
      }
      list.push({
        title: `Status → ${EFFECTIVE_TONE[effectiveOf(header)].label}`,
        at: fmtDate(header.do_date),
        by: "System",
        dot: "muted",
      });
      list.push({
        title: `${itemsCount} line item${itemsCount === 1 ? "" : "s"} on this DO`,
        at: fmtDate(header.do_date),
        by: "System",
        dot: "muted",
      });
      return list;
    }, [header, itemsCount]);

  const DOT_CLS: Record<"success" | "primary" | "muted", string> = {
    success: "bg-synced",
    primary: "bg-primary",
    muted: "bg-border-strong",
  };

  return (
    <ModalOverlay open={open} onClose={onClose} title="Change history" icon={<History size={16} />}>
      <div className="flex flex-col">
        {events.map((e, i) => {
          const isLast = i === events.length - 1;
          return (
            <div key={i} className="flex gap-3 pb-4 last:pb-0">
              <div className="flex flex-col items-center">
                <span className={cn("mt-1 h-2.5 w-2.5 rounded-full", DOT_CLS[e.dot])} />
                {!isLast && <span className="mt-1 w-[2px] flex-1 bg-border-subtle" />}
              </div>
              <div className="min-w-0 flex-1 pb-1">
                <div className="text-[13px] font-semibold text-ink">{e.title}</div>
                <div className="mt-0.5 text-[11.5px] text-ink-muted">
                  {e.at} · {e.by}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </ModalOverlay>
  );
}

// ─── Modal · Relationship Map (node graph) ─────────────────────────────────
//
// Renders the document chain as a node-graph on an SVG canvas — NOT an
// inline pipeline. Upstream nodes (Customer PO → Sales Order) sit on the
// top row; the current DO is the brass-highlighted node; downstream nodes
// (GRN → Sales Invoice) branch off the bottom row in muted grey until they
// exist. Each node card carries a Linked/Current/Pending badge.

type ChainNode = {
  type: string;
  doc: string;
  meta: string;
  state: "done" | "current" | "pending";
};

function RelationshipMapModal({
  open,
  onClose,
  header,
  navigate,
}: {
  open: boolean;
  onClose: () => void;
  header: DoHeader;
  navigate: (path: string) => void;
}) {
  const nodes: ChainNode[] = [
    {
      type: "Customer PO",
      doc: header.po_doc_no || header.customer_so_no || "Not linked",
      meta: header.po_doc_no || header.customer_so_no ? fmtDate(header.do_date) : "—",
      state: header.po_doc_no || header.customer_so_no ? "done" : "pending",
    },
    {
      type: "Sales Order",
      doc: header.so_doc_no || "Not linked",
      meta: header.so_doc_no ? fmtDate(header.do_date) : "—",
      state: header.so_doc_no ? "done" : "pending",
    },
    {
      type: "Delivery Order",
      doc: header.do_number,
      meta: "This document",
      state: "current",
    },
    {
      type: "GRN",
      doc: "Not created",
      meta: "After delivery",
      state: "pending",
    },
    {
      type: "Sales Invoice",
      doc: header.lifecycle_state === "invoiced" ? "Issued" : "Not created",
      meta: header.lifecycle_state === "invoiced" ? fmtDate(header.do_date) : "On completion",
      state: header.lifecycle_state === "invoiced" ? "done" : "pending",
    },
  ];

  const onNodeClick = (type: string) => {
    if (type === "Sales Order" && header.so_doc_no) {
      navigate(`/scm/sales-orders/${header.so_doc_no}`);
      onClose();
    } else if (type === "Sales Invoice" && header.lifecycle_state === "invoiced") {
      // No direct SI id on the DO detail payload — punt to the SI listing
      // scoped to this DO.
      navigate(`/scm/sales-invoices?q=${encodeURIComponent(header.do_number)}`);
      onClose();
    }
  };

  const nodeCard = (n: ChainNode, opts: { left: number; top: number }) => {
    const cur = n.state === "current";
    const done = n.state === "done";
    return (
      <button
        key={n.type}
        type="button"
        onClick={() => onNodeClick(n.type)}
        style={{ position: "absolute", left: opts.left, top: opts.top, width: 148 }}
        className={cn(
          "rounded-xl px-3 py-2.5 text-left transition-all",
          cur
            ? "border-2 border-accent bg-accent-soft shadow-[0_10px_22px_-12px_rgba(161,133,47,.55)]"
            : done
              ? "border border-primary/30 bg-primary-soft"
              : "border border-border bg-surface-2",
          (n.type === "Sales Order" && header.so_doc_no) || (n.type === "Sales Invoice" && done)
            ? "cursor-pointer hover:-translate-y-px hover:shadow-slab"
            : "cursor-default"
        )}
      >
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
              cur
                ? "bg-accent text-white"
                : done
                  ? "bg-primary text-white"
                  : "border border-border-strong bg-surface"
            )}
          >
            {cur ? "◉" : done ? "✓" : ""}
          </span>
          <span
            className={cn(
              "font-mono text-[9px] font-bold uppercase tracking-brand",
              cur ? "text-accent-ink" : done ? "text-primary-ink" : "text-ink-muted"
            )}
          >
            {n.type}
          </span>
        </div>
        <div
          className={cn(
            "mt-1.5 truncate font-mono text-[12.5px] font-bold",
            cur ? "text-accent-ink" : done ? "text-primary-ink" : "text-ink-muted"
          )}
        >
          {n.doc}
        </div>
        <div
          className={cn(
            "mt-0.5 truncate text-[10.5px]",
            cur ? "text-accent-ink/80" : "text-ink-muted"
          )}
        >
          {n.meta}
        </div>
      </button>
    );
  };

  // Canvas layout — top row: PO → SO → DO (current). Bottom row: GRN → SI
  // branching down from the current DO.
  const layout = {
    row1Top: 40,
    row2Top: 190,
    x0: 12,
    xStep: 176,
  };
  const positions = [
    { left: layout.x0 + layout.xStep * 0, top: layout.row1Top },
    { left: layout.x0 + layout.xStep * 1, top: layout.row1Top },
    { left: layout.x0 + layout.xStep * 2, top: layout.row1Top },
    { left: layout.x0 + layout.xStep * 2, top: layout.row2Top },
    { left: layout.x0 + layout.xStep * 3, top: layout.row2Top },
  ];

  return (
    <ModalOverlay
      open={open}
      onClose={onClose}
      title="Relationship map"
      icon={<Share2 size={16} />}
      size="lg"
    >
      <div className="mb-3 text-[12.5px] leading-relaxed text-ink-secondary">
        How this delivery order links to its source documents and the documents
        generated downstream.
      </div>
      <div
        className="relative h-[320px] overflow-hidden rounded-xl border border-border-subtle"
        style={{
          backgroundImage: "radial-gradient(rgba(180, 185, 175, .45) 1px, transparent 1px)",
          backgroundSize: "16px 16px",
          backgroundColor: "var(--surface, #fbfcfa)",
        }}
      >
        {/* Row labels */}
        <span className="absolute left-3 top-2 font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
          Upstream
        </span>
        <span
          className="absolute font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted"
          style={{ left: 360, top: 168 }}
        >
          Generated after delivery
        </span>

        {/* SVG connectors */}
        <svg
          width="100%"
          height="100%"
          className="pointer-events-none absolute inset-0"
          preserveAspectRatio="none"
        >
          {/* PO → SO arrow (row 1) */}
          <line
            x1={layout.x0 + 150}
            y1={layout.row1Top + 42}
            x2={layout.x0 + layout.xStep}
            y2={layout.row1Top + 42}
            stroke="var(--primary, #16695f)"
            strokeWidth="2"
            markerEnd="url(#arrowP)"
          />
          {/* SO → DO arrow (row 1) */}
          <line
            x1={layout.x0 + layout.xStep + 150}
            y1={layout.row1Top + 42}
            x2={layout.x0 + layout.xStep * 2}
            y2={layout.row1Top + 42}
            stroke="var(--primary, #16695f)"
            strokeWidth="2"
            markerEnd="url(#arrowP)"
          />
          {/* DO → GRN branch (down) */}
          <line
            x1={layout.x0 + layout.xStep * 2 + 74}
            y1={layout.row1Top + 88}
            x2={layout.x0 + layout.xStep * 2 + 74}
            y2={layout.row2Top}
            stroke="var(--border-strong, #b3b8ac)"
            strokeWidth="2"
            strokeDasharray="4 4"
            markerEnd="url(#arrowM)"
          />
          {/* GRN → SI arrow */}
          <line
            x1={layout.x0 + layout.xStep * 2 + 148}
            y1={layout.row2Top + 40}
            x2={layout.x0 + layout.xStep * 3}
            y2={layout.row2Top + 40}
            stroke="var(--border-strong, #b3b8ac)"
            strokeWidth="2"
            strokeDasharray="4 4"
            markerEnd="url(#arrowM)"
          />
          <defs>
            <marker
              id="arrowP"
              markerWidth="7"
              markerHeight="7"
              refX="6"
              refY="3.5"
              orient="auto"
              markerUnits="strokeWidth"
            >
              <path d="M0,0 L7,3.5 L0,7 z" fill="var(--primary, #16695f)" />
            </marker>
            <marker
              id="arrowM"
              markerWidth="7"
              markerHeight="7"
              refX="6"
              refY="3.5"
              orient="auto"
              markerUnits="strokeWidth"
            >
              <path d="M0,0 L7,3.5 L0,7 z" fill="var(--border-strong, #b3b8ac)" />
            </marker>
          </defs>
        </svg>

        {/* Cards */}
        {nodes.map((n, i) => nodeCard(n, positions[i]!))}
      </div>

      {/* Legend */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-primary" /> Linked
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-accent" /> Current
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full border border-border-strong bg-surface" /> Pending
        </span>
      </div>
    </ModalOverlay>
  );
}

// ─── Modal · Print PDF preview ─────────────────────────────────────────────

function PrintPdfModal({
  open,
  onClose,
  header,
  items,
  onDownload,
  onPrint,
}: {
  open: boolean;
  onClose: () => void;
  header: DoHeader;
  items: DoItem[];
  onDownload: () => void;
  onPrint: () => void;
}) {
  const totalQty = items.reduce((sum, l) => sum + Number(l.qty ?? 0), 0);
  return (
    <ModalOverlay
      open={open}
      onClose={onClose}
      title="Print preview"
      icon={<Printer size={16} />}
      footer={
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="secondary"
            icon={<Printer size={14} />}
            onClick={onPrint}
          >
            Print now
          </Button>
          <Button
            variant="primary"
            icon={<Download size={14} />}
            onClick={onDownload}
          >
            Download PDF
          </Button>
        </div>
      }
    >
      <div className="overflow-hidden rounded-xl border border-border-subtle">
        <div className="flex items-start justify-between gap-3 bg-sidebar px-5 py-4 text-sidebar-ink">
          <div>
            <div className="font-display text-[14px] font-bold tracking-wider text-white">
              HOUZS CENTURY
            </div>
            <div className="mt-0.5 text-[10.5px] uppercase tracking-brand text-sidebar-ink-muted">
              Delivery Order
            </div>
          </div>
          <div className="text-right font-mono text-[13px] font-bold text-accent-bright">
            {header.do_number}
          </div>
        </div>
        <div className="space-y-2 px-5 py-4 text-[12.5px] leading-relaxed text-ink">
          <div>
            <span className="font-semibold text-ink-secondary">Deliver to: </span>
            {header.debtor_name}
          </div>
          <div className="text-ink-secondary">
            {shipTo(header).join(", ") || "No address on file"}
          </div>
          <div>
            <span className="font-semibold text-ink-secondary">Driver: </span>
            {header.driver_name || "Unassigned"}
            {header.vehicle ? ` · ${header.vehicle}` : ""}
          </div>
          <div>
            <span className="font-semibold text-ink-secondary">DO date: </span>
            {fmtDate(header.do_date)}
            {header.customer_delivery_date
              ? ` · Scheduled ${fmtDate(header.customer_delivery_date)}`
              : ""}
          </div>
          <div>
            <span className="font-semibold text-ink-secondary">Items: </span>
            {items.length} line{items.length === 1 ? "" : "s"} · {totalQty} unit{totalQty === 1 ? "" : "s"}
          </div>
        </div>
      </div>
    </ModalOverlay>
  );
}

// ─── Line item variant chip helper ─────────────────────────────────────────

function VariantChip({ k, v }: { k: string; v: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-surface-2 px-2 py-0.5">
      <span className="font-mono text-[9px] font-semibold uppercase tracking-wider text-ink-muted">
        {k}
      </span>
      <span className="text-[11px] font-semibold text-ink-secondary">{v}</span>
    </span>
  );
}

// Best-effort extraction of variant chips from the item's variants JSON blob.
function variantsOf(item: DoItem): Array<{ k: string; v: string }> {
  const raw = item.variants;
  if (!raw || typeof raw !== "object") return [];
  const out: Array<{ k: string; v: string }> = [];
  for (const [k, val] of Object.entries(raw)) {
    if (val == null || val === "") continue;
    if (typeof val === "string" || typeof val === "number") {
      out.push({ k, v: String(val) });
    }
  }
  return out;
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

  const totalQty = useMemo(
    () => items.reduce((sum, l) => sum + Number(l.qty ?? 0), 0),
    [items]
  );

  useSetBreadcrumbs([
    { label: "Delivery Orders", to: "/scm/delivery-orders" },
    { label: deliveryOrder?.do_number ?? id ?? "Delivery Order" },
  ]);

  const [modal, setModal] = useState<"history" | "relmap" | "print" | null>(null);
  const closeModal = () => setModal(null);

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
  const goEdit = () => id && navigate(`/scm/delivery-orders/new?edit=${id}`);
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
  const doMarkSigned = () => {
    if (!deliveryOrder) return;
    updateStatus.mutate({ id: deliveryOrder.id, status: "delivered" });
  };
  const goConvertToSi = () =>
    deliveryOrder &&
    navigate(`/scm/sales-invoices/from-do?do=${deliveryOrder.id}`);

  const doDownloadPdf = () => {
    closeModal();
    id && navigate(`/scm/delivery-orders/${id}?print=1`);
  };
  const doPrintNow = () => {
    window.print();
  };

  // ── DO line item columns — Item (with variant chips) · Type (FOC/Sale) · Qty ─
  const lineColumns: Column<DoItem>[] = [
    {
      key: "item",
      label: "Item",
      alwaysVisible: true,
      getValue: (l) => l.item_code,
      render: (l) => {
        const vs = variantsOf(l);
        return (
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-ink">
              {l.description || l.item_code}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-ink-muted">
              <span>{l.item_code}</span>
              {l.description2 && (
                <span className="truncate text-ink-secondary">
                  · {l.description2}
                </span>
              )}
            </div>
            {vs.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {vs.map((c) => (
                  <VariantChip key={c.k} k={c.k} v={c.v} />
                ))}
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: "type",
      label: "Type",
      width: "88px",
      getValue: (l) => (Number(l.unit_price_centi ?? 0) === 0 ? "FOC" : "Sale"),
      render: (l) => {
        const isFoc = Number(l.unit_price_centi ?? 0) === 0;
        return (
          <Badge tone={isFoc ? "warning" : "neutral"} size="xs">
            {isFoc ? "FOC" : "Sale"}
          </Badge>
        );
      },
    },
    {
      key: "qty",
      label: "Qty to deliver",
      width: "132px",
      align: "right",
      getValue: (l) => l.qty,
      render: (l) => (
        <span className="font-money text-[14px] font-semibold text-ink">
          {l.qty}
          <span className="ml-1 text-[10.5px] font-normal text-ink-muted">
            {l.uom || ""}
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

  const rawStatus = (deliveryOrder.status || "").toLowerCase();
  const canMarkSigned =
    rawStatus === "loaded" ||
    rawStatus === "dispatched" ||
    rawStatus === "in_transit";
  const canConvertToSi =
    rawStatus === "signed" || rawStatus === "delivered";
  const isCancelled = rawStatus === "cancelled";

  const soNo = deliveryOrder.so_doc_no;

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
          <div className="flex min-w-0 items-start gap-3">
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
                <span className="font-mono font-semibold text-accent-ink">
                  {deliveryOrder.do_number}
                </span>
                <Divider />
                <span>DO date {fmtDate(deliveryOrder.do_date)}</span>
                <Divider />
                <span>
                  {items.length} line{items.length === 1 ? "" : "s"}
                </span>
                {soNo && (
                  <>
                    <Divider />
                    <span className="inline-flex items-center gap-1">
                      ⇄ from{" "}
                      <span className="font-mono font-semibold text-ink-secondary">
                        {soNo}
                      </span>
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              icon={<History size={14} />}
              onClick={() => setModal("history")}
            >
              History
            </Button>
            <Button
              variant="ghost"
              icon={<Share2 size={14} />}
              onClick={() => setModal("relmap")}
            >
              Relationship Map
            </Button>
            <Button
              variant="secondary"
              icon={<Printer size={14} />}
              onClick={() => setModal("print")}
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
        {/* Mobile-only Delivery status hero */}
        <div className="mb-3 rounded-lg border border-border bg-surface p-4 shadow-stone md:hidden">
          <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
            Delivery status
          </div>
          <div className="mt-1 font-display text-[22px] font-bold leading-tight text-ink">
            {EFFECTIVE_TONE[effectiveOf(deliveryOrder)].label}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-muted">
            <span>
              {deliveryOrder.customer_delivery_date
                ? `Scheduled ${fmtDate(deliveryOrder.customer_delivery_date)}`
                : deliveryOrder.expected_delivery_at
                  ? `Expected ${fmtDate(deliveryOrder.expected_delivery_at)}`
                  : "Not scheduled"}
            </span>
            <span>· {totalQty} items</span>
            {deliveryOrder.sales_location && (
              <span>· {deliveryOrder.sales_location}</span>
            )}
          </div>
        </div>

        <DetailGrid>
          <DetailMain>
            {/* Customer info — Customer SO No. first, per design */}
            <Section title="Customer info">
              <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
                <Field
                  label="Customer SO No."
                  value={soOf(deliveryOrder)}
                  mono={soOf(deliveryOrder) !== "—"}
                  accent={soOf(deliveryOrder) !== "—"}
                  muted={soOf(deliveryOrder) === "—"}
                />
                <Field
                  label="Customer name"
                  value={deliveryOrder.debtor_name || "—"}
                />
                <Field
                  label="Customer SO ref"
                  value={refOf(deliveryOrder)}
                  mono={refOf(deliveryOrder) !== "—"}
                  accent={refOf(deliveryOrder) !== "—"}
                  muted={refOf(deliveryOrder) === "—"}
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
                  label="Salesperson"
                  value={
                    deliveryOrder.agent ||
                    deliveryOrder.salesperson_name ||
                    deliveryOrder.salesperson_id ||
                    "Unassigned"
                  }
                  muted={
                    !deliveryOrder.agent &&
                    !deliveryOrder.salesperson_name &&
                    !deliveryOrder.salesperson_id
                  }
                />
                <Field
                  label="Branding"
                  value={brandOf(deliveryOrder)}
                  muted={brandOf(deliveryOrder) === "—"}
                />
                <Field
                  label="Building / venue"
                  value={
                    [deliveryOrder.building_type, deliveryOrder.venue]
                      .filter(Boolean)
                      .join(" · ") || "—"
                  }
                  muted={!deliveryOrder.building_type && !deliveryOrder.venue}
                />
              </div>
            </Section>

            {/* Delivery address + Emergency contact */}
            <Section title="Delivery address">
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-[1.4fr_1fr] sm:divide-x sm:divide-border-subtle">
                <div className="sm:pr-6">
                  <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                    Ship to
                  </div>
                  <div className="mt-1.5 text-[14px] font-semibold leading-relaxed text-ink">
                    {shipTo(deliveryOrder).length > 0 ? (
                      shipTo(deliveryOrder).map((line, i) => (
                        <div key={i}>{line}</div>
                      ))
                    ) : (
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
                    Only if unreachable on delivery day
                  </div>
                  <div className="mt-2.5 text-[14px] font-semibold text-ink">
                    {deliveryOrder.emergency_contact_name ||
                      deliveryOrder.emergency_contact_phone ||
                      "Not provided"}
                  </div>
                  {deliveryOrder.emergency_contact_phone && (
                    <div className="mt-1 font-mono text-[12.5px] text-ink-secondary">
                      {deliveryOrder.emergency_contact_phone}
                    </div>
                  )}
                  {deliveryOrder.emergency_contact_relationship && (
                    <div className="mt-1 text-[12px] text-ink-muted">
                      {deliveryOrder.emergency_contact_relationship}
                    </div>
                  )}
                </div>
              </div>
            </Section>

            {/* Delivery info (with embedded Driver sub-card) */}
            <Section title="Delivery info">
              <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
                <Field label="DO date" value={fmtDate(deliveryOrder.do_date)} />
                <Field
                  label="Expected delivery"
                  value={fmtDate(deliveryOrder.expected_delivery_at)}
                  muted={!deliveryOrder.expected_delivery_at}
                />
                <Field
                  label="Customer delivery date"
                  value={
                    deliveryOrder.customer_delivery_date
                      ? fmtDate(deliveryOrder.customer_delivery_date)
                      : "Not scheduled"
                  }
                  muted={!deliveryOrder.customer_delivery_date}
                />
              </div>

              {/* Driver sub-card — moved into Delivery info per the new design */}
              <DriverSubCard header={deliveryOrder} />

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

            {/* Line items */}
            <Section
              title={`Line items · ${items.length}`}
              actions={
                <span className="text-[11.5px] text-ink-muted">
                  Delivery quantities — no pricing
                </span>
              }
            >
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
            <div className="hidden lg:sticky lg:top-[124px] space-y-3 md:block">
              <DeliveryStatusCard header={deliveryOrder} totalQty={totalQty} />

              <AsideCard title="Key dates">
                <KeyDateRow k="DO date" v={fmtDate(deliveryOrder.do_date)} />
                <KeyDateRow
                  k="Scheduled"
                  v={
                    deliveryOrder.customer_delivery_date
                      ? fmtDate(deliveryOrder.customer_delivery_date)
                      : deliveryOrder.expected_delivery_at
                        ? fmtDate(deliveryOrder.expected_delivery_at)
                        : "Not set"
                  }
                  muted={
                    !deliveryOrder.customer_delivery_date &&
                    !deliveryOrder.expected_delivery_at
                  }
                />
                <KeyDateRow
                  k="Delivered"
                  v={effectiveOf(deliveryOrder) === "shipped" ? "Pending" : EFFECTIVE_TONE[effectiveOf(deliveryOrder)].label}
                  muted={effectiveOf(deliveryOrder) === "shipped" || effectiveOf(deliveryOrder) === "draft"}
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
                  initials={initialsOf(
                    deliveryOrder.issued_by_name ||
                      deliveryOrder.agent ||
                      deliveryOrder.salesperson_name ||
                      deliveryOrder.salesperson_id
                  )}
                  name={
                    deliveryOrder.issued_by_name ||
                    deliveryOrder.agent ||
                    deliveryOrder.salesperson_name ||
                    deliveryOrder.salesperson_id ||
                    "Issued by"
                  }
                  role={
                    deliveryOrder.issued_by_name
                      ? "Issued by"
                      : deliveryOrder.agent || deliveryOrder.salesperson_id
                        ? "Salesperson"
                        : "Not recorded"
                  }
                  tone="neutral"
                />
              </AsideCard>
            </div>
          </DetailAside>
        </DetailGrid>
      </div>

      {/* Fixed bottom action bar (phone only) */}
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
            onClick={() => setModal("print")}
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

      {/* Modals */}
      <HistoryModal
        open={modal === "history"}
        onClose={closeModal}
        header={deliveryOrder}
        itemsCount={items.length}
      />
      <RelationshipMapModal
        open={modal === "relmap"}
        onClose={closeModal}
        header={deliveryOrder}
        navigate={navigate}
      />
      <PrintPdfModal
        open={modal === "print"}
        onClose={closeModal}
        header={deliveryOrder}
        items={items}
        onDownload={doDownloadPdf}
        onPrint={doPrintNow}
      />
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
