// GoodsReceivedDetailV2 — Theme C redesign of the GRN detail page. Stock-in
// doc: goods land at a warehouse, PO's received_qty rolls up. Aside hero =
// Received value + qty landed, tinted green once posted.

import { useMemo, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  History,
  Printer,
  XCircle,
  Edit3,
  CircleDot,
  Phone as PhoneIcon,
  MoreHorizontal,
  Send,
  Receipt,
  RotateCcw,
} from "lucide-react";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { DataTable, type Column } from "../../components/DataTable";
import { DetailGrid, DetailMain, DetailAside, Section } from "../../components/DetailLayout";
import {
  useGrnDetail,
  usePostGrn,
  useCancelGrn,
} from "../../vendor/scm/lib/grn-queries";
import { useSetBreadcrumbs } from "../../hooks/useBreadcrumbs";
import { cn } from "../../lib/utils";

type GrnStatus = "DRAFT" | "POSTED" | "CANCELLED" | string;

type GrnHeader = {
  id: string;
  grn_number: string;
  status: GrnStatus;
  received_at: string | null;
  delivery_note_ref: string | null;
  warehouse_code?: string | null;
  warehouse_id?: string | null;
  total_centi: number;
  currency: string;
  notes?: string | null;
  supplier?: {
    id: string;
    code: string;
    name: string;
    contact_person?: string | null;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
  } | null;
  purchase_order?: { id: string; po_number: string } | null;
  fully_invoiced?: boolean;
  fully_returned?: boolean;
  posted_at?: string | null;
  cancelled_at?: string | null;
  created_at?: string;
};

type GrnItem = {
  id: string;
  material_code?: string | null;
  item_code?: string | null;
  description?: string | null;
  description2?: string | null;
  uom?: string;
  qty?: number;
  received_qty?: number;
  unit_price_centi?: number;
  line_total_centi?: number;
  warehouse_code?: string | null;
};

const fmtMoney = (centi: number, currency = "MYR"): string =>
  `${currency} ${(centi / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const s = iso.replace(/T.*$/, "");
  const m = /^(\d{4})[-/](\d{2})[-/](\d{2})$/.exec(s);
  if (!m) return s;
  return `${m[3]}/${m[2]}/${m[1]}`;
};

const supplierNameOf = (h: GrnHeader): string => h.supplier?.name || "—";
const supplierCodeOf = (h: GrnHeader): string => h.supplier?.code || "—";
const poOf = (h: GrnHeader): string => h.purchase_order?.po_number || "—";

type Effective = "draft" | "posted" | "cancelled";
const effectiveOf = (h: GrnHeader): Effective => {
  const s = (h.status || "").toUpperCase();
  if (s === "CANCELLED") return "cancelled";
  if (s === "POSTED") return "posted";
  return "draft";
};

const EFFECTIVE_TONE: Record<Effective, { tone: "success" | "warning" | "error" | "neutral"; label: string; blurb: string }> = {
  draft: { tone: "warning", label: "Draft", blurb: "Draft · not yet posted" },
  posted: { tone: "success", label: "Posted", blurb: "Posted · inventory received" },
  cancelled: { tone: "error", label: "Cancelled", blurb: "Cancelled · receipt reversed" },
};

const STAGE_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  POSTED: "Posted",
  CANCELLED: "Cancelled",
};

const initialsOf = (name: string | null | undefined): string => {
  if (!name) return "—";
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "—";
};

const receivedOf = (items: GrnItem[]) => {
  let orderedQty = 0;
  let receivedQty = 0;
  for (const l of items) {
    orderedQty += Number(l.qty ?? 0);
    receivedQty += Number(l.received_qty ?? 0);
  }
  return { orderedQty, receivedQty };
};

function Field({ label, value, span = 1, muted, mono }: { label: string; value: ReactNode; span?: 1 | 2 | 3 | 4; muted?: boolean; mono?: boolean }) {
  const spanCls = span === 1 ? "" : span === 2 ? "sm:col-span-2" : span === 3 ? "sm:col-span-3" : "sm:col-span-4";
  return (
    <div className={spanCls}>
      <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">{label}</div>
      <div className={cn("mt-1 text-[14px] font-semibold leading-snug", muted ? "text-ink-muted" : "text-ink", mono && "font-mono")}>{value}</div>
    </div>
  );
}

function AsideCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-stone">
      <div className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{title}</div>
      {children}
    </div>
  );
}

function KeyDateRow({ k, v, muted }: { k: string; v: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-border-subtle py-2 last:border-b-0">
      <span className="text-[12.5px] text-ink-muted">{k}</span>
      <span className={cn("text-[13px] font-semibold", muted ? "text-ink-muted" : "text-ink")}>{v}</span>
    </div>
  );
}

function PersonRow({ initials, name, role, tone = "accent" }: { initials: string; name: string; role: string; tone?: "accent" | "neutral" }) {
  return (
    <div className="flex items-center gap-3 border-b border-border-subtle py-3 last:border-b-0">
      <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[12px] font-bold", tone === "accent" ? "bg-accent-soft text-accent-ink" : "bg-border-subtle text-ink-secondary")}>
        {initials}
      </span>
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold text-ink">{name}</div>
        <div className="truncate text-[11.5px] text-ink-muted">{role}</div>
      </div>
    </div>
  );
}

function ReceivedHeroCard({ header, items }: { header: GrnHeader; items: GrnItem[] }) {
  const eff = effectiveOf(header);
  const t = EFFECTIVE_TONE[eff];
  const total = header.total_centi ?? 0;
  const { orderedQty, receivedQty } = receivedOf(items);
  const isPosted = eff === "posted";
  return (
    <div className="rounded-lg bg-sidebar px-5 py-5 text-sidebar-ink shadow-stone">
      <div className="font-mono text-[10px] font-semibold uppercase tracking-brand text-sidebar-ink-muted">
        Received value
      </div>
      <div className={cn("mt-1.5 font-money text-[28px] font-bold leading-none tracking-tight", isPosted ? "text-synced" : "text-white")}>
        {fmtMoney(total, header.currency)}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span className={cn("h-2 w-2 rounded-full", t.tone === "success" ? "bg-synced" : t.tone === "warning" ? "bg-accent-bright" : t.tone === "error" ? "bg-err" : "bg-sidebar-ink-muted")} />
        <span className="text-[12.5px] text-sidebar-ink-muted">{t.blurb}</span>
      </div>

      <div className="mt-4 space-y-2 border-t border-white/10 pt-4">
        <HeroLine k="Qty received" v={String(receivedQty)} />
        <HeroLine k="Qty on PO" v={String(orderedQty)} />
        <HeroLine k="Total value" v={fmtMoney(total, header.currency)} strong />
      </div>

      {header.warehouse_code && (
        <div className="mt-4 border-t border-white/10 pt-4">
          <div className="text-[12.5px] text-sidebar-ink-muted">Received into</div>
          <div className="mt-1 text-[13px] font-semibold text-sidebar-ink">{header.warehouse_code}</div>
        </div>
      )}
    </div>
  );
}

function HeroLine({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={cn("text-[12.5px] text-sidebar-ink-muted", strong && "font-semibold text-white")}>{k}</span>
      <span className={cn("font-money text-[13px] font-semibold text-sidebar-ink", strong && "text-[16px] font-bold text-accent-bright")}>{v}</span>
    </div>
  );
}

export function GoodsReceivedDetailV2() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const detail = useGrnDetail(id ?? null);
  const postGrn = usePostGrn();
  const cancelGrn = useCancelGrn();

  const grn = (detail.data as { grn?: GrnHeader } | undefined)?.grn ?? null;
  const items: GrnItem[] = useMemo(
    () => ((detail.data as { items?: GrnItem[] } | undefined)?.items ?? []),
    [detail.data]
  );

  useSetBreadcrumbs([
    { label: "Goods Received", to: "/scm/grns" },
    { label: grn?.grn_number ?? id ?? "GRN" },
  ]);

  const eff = grn ? effectiveOf(grn) : null;
  const stageLabel = grn ? STAGE_LABEL[(grn.status || "").toUpperCase()] ?? grn.status : "";
  const badgeTone = eff ? EFFECTIVE_TONE[eff].tone : "neutral";

  const goBack = () => {
    if (params.get("from") === "list") navigate("/scm/grns");
    else navigate(-1);
  };
  const goEdit = () => id && navigate(`/scm/grns/${id}?edit=1`);
  const goHistory = () => id && navigate(`/scm/grns/${id}?tab=history`);
  const goPrintPdf = () => id && navigate(`/scm/grns/${id}?print=1`);
  const goConvertToPi = () => id && navigate(`/scm/purchase-invoices/from-grn?grn=${id}`);
  const goConvertToPr = () => id && navigate(`/scm/purchase-returns/new?fromGrn=${id}`);
  const doPost = () => {
    if (!grn) return;
    if (window.confirm(`Post GRN ${grn.grn_number}? Inventory will be received into the warehouse.`)) {
      postGrn.mutate(grn.id);
    }
  };
  const doCancel = () => {
    if (!grn) return;
    if (window.confirm(`Cancel GRN ${grn.grn_number}? Inventory receipt will be reversed.`)) {
      cancelGrn.mutate(grn.id);
    }
  };

  const lineColumns: Column<GrnItem>[] = [
    {
      key: "item",
      label: "Item",
      alwaysVisible: true,
      getValue: (l) => l.material_code || l.item_code || "",
      render: (l) => (
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-ink">
            {l.description || l.material_code || l.item_code || "—"}
          </div>
          <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-ink-muted">
            <span>{l.material_code || l.item_code}</span>
            {l.warehouse_code && <span className="inline-flex items-center gap-0.5 rounded bg-primary-soft px-1.5 py-0 text-[10px] font-semibold text-primary-ink">{l.warehouse_code}</span>}
          </div>
        </div>
      ),
    },
    {
      key: "qty_po",
      label: "Ordered",
      width: "84px",
      align: "right",
      getValue: (l) => l.qty ?? 0,
      render: (l) => (
        <span className="font-money text-[13px] text-ink-secondary">
          {l.qty ?? 0} <span className="text-[10.5px] text-ink-muted">{l.uom || ""}</span>
        </span>
      ),
    },
    {
      key: "received",
      label: "Received",
      width: "92px",
      align: "right",
      getValue: (l) => l.received_qty ?? 0,
      render: (l) => {
        const rec = Number(l.received_qty ?? 0);
        const ordered = Number(l.qty ?? 0);
        const full = ordered > 0 && rec >= ordered;
        return <span className={cn("font-money text-[13px] font-semibold", full ? "text-synced" : "text-ink")}>{rec}</span>;
      },
    },
    {
      key: "unit",
      label: "Unit cost",
      width: "108px",
      align: "right",
      getValue: (l) => l.unit_price_centi ?? 0,
      render: (l) => (
        <span className="font-money text-[13px] text-ink-secondary">{fmtMoney(l.unit_price_centi ?? 0, grn?.currency)}</span>
      ),
    },
    {
      key: "total",
      label: "Amount",
      width: "132px",
      align: "right",
      getValue: (l) => l.line_total_centi ?? 0,
      render: (l) => <span className="font-money text-[13px] font-semibold text-ink">{fmtMoney(l.line_total_centi ?? 0, grn?.currency)}</span>,
    },
  ];

  if (!id) {
    return <div className="p-8 text-center text-ink-muted">No GRN specified.</div>;
  }
  if (detail.isLoading) {
    return <div className="animate-fade-in p-8 text-center text-ink-muted">Loading GRN…</div>;
  }
  if (detail.error || !grn) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <div className="mb-2 font-display text-[18px] font-extrabold text-err">Couldn't load GRN</div>
        <p className="text-[13px] text-ink-muted">{(detail.error as Error | undefined)?.message ?? "The GRN was not found."}</p>
        <div className="mt-4">
          <Button variant="secondary" onClick={goBack} icon={<ArrowLeft size={14} />}>
            Back to Goods Received
          </Button>
        </div>
      </div>
    );
  }

  const goCall = () => {
    if (!grn.supplier?.phone) return;
    window.location.href = `tel:${grn.supplier.phone.replace(/\s+/g, "")}`;
  };

  const rawStatus = (grn.status || "").toUpperCase();
  const canPost = rawStatus === "DRAFT";
  const canConvertToPi = rawStatus === "POSTED" && !grn.fully_invoiced;
  const canConvertToPr = rawStatus === "POSTED" && !grn.fully_returned;
  const canCancel = rawStatus !== "CANCELLED";
  const isCancelled = rawStatus === "CANCELLED";

  return (
    <div className="pb-24 md:pb-0">
      <div className="sticky top-0 z-20 -mx-4 -mt-4 bg-sidebar text-sidebar-ink shadow-slab md:hidden">
        <div className="flex items-center justify-between gap-3 px-4 pt-3">
          <button type="button" onClick={goBack} className="inline-flex items-center gap-1 text-[14px] font-semibold text-accent-bright" aria-label="Back to Goods Received">
            <ArrowLeft size={16} /> GRNs
          </button>
          <span className="font-mono text-[12.5px] font-semibold text-sidebar-ink">{grn.grn_number}</span>
          <button type="button" className="text-sidebar-ink-muted" aria-label="More actions">
            <MoreHorizontal size={18} />
          </button>
        </div>
        <div className="px-4 pb-4 pt-3">
          <h1 className="font-display text-[19px] font-bold leading-tight text-white">{supplierNameOf(grn)}</h1>
          <div className="mt-2">
            <Badge tone={badgeTone} variant="solid" size="xs">{stageLabel}</Badge>
          </div>
        </div>
      </div>

      <div className="sticky top-0 z-10 -mx-4 hidden border-b border-border bg-bg/95 px-4 py-4 backdrop-blur-sm sm:-mx-6 sm:px-6 md:block">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <button type="button" onClick={goBack} aria-label="Back to Goods Received" className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-ink-secondary hover:border-primary/50 hover:text-primary">
              <ArrowLeft size={16} />
            </button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">{supplierNameOf(grn)}</h1>
                <Badge tone={badgeTone} size="sm">{stageLabel}</Badge>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-secondary">
                <span className="font-mono font-semibold text-primary-ink">{grn.grn_number}</span>
                <Divider />
                <span>Received {fmtDate(grn.received_at)}</span>
                <Divider />
                <span>{items.length} line{items.length === 1 ? "" : "s"}</span>
                {poOf(grn) !== "—" && (
                  <>
                    <Divider />
                    <span>From PO <span className="font-mono font-semibold text-ink-secondary">{poOf(grn)}</span></span>
                  </>
                )}
                {grn.delivery_note_ref && (
                  <>
                    <Divider />
                    <span>DN <span className="font-mono font-semibold text-ink-secondary">{grn.delivery_note_ref}</span></span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" icon={<History size={14} />} onClick={goHistory}>History</Button>
            <Button variant="secondary" icon={<Printer size={14} />} onClick={goPrintPdf}>Print PDF</Button>
            {canCancel && <Button variant="danger" icon={<XCircle size={14} />} onClick={doCancel}>Cancel GRN</Button>}
            {canPost && <Button variant="secondary" icon={<Send size={14} />} onClick={doPost}>Post</Button>}
            {canConvertToPi && <Button variant="secondary" icon={<Receipt size={14} />} onClick={goConvertToPi}>Convert to PI</Button>}
            {canConvertToPr && <Button variant="secondary" icon={<RotateCcw size={14} />} onClick={goConvertToPr}>Convert to PR</Button>}
            <Button variant="primary" icon={<Edit3 size={14} />} onClick={goEdit}>Edit</Button>
          </div>
        </div>
      </div>

      <div className="py-5">
        <div className="mb-3 rounded-lg border border-border bg-surface p-4 shadow-stone md:hidden">
          <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">Received value</div>
          <div className={cn("mt-1 font-money text-[26px] font-bold leading-none tracking-tight", effectiveOf(grn) === "posted" ? "text-synced" : "text-ink")}>
            {fmtMoney(grn.total_centi, grn.currency)}
          </div>
          <div className="mt-1.5 text-[12px] text-ink-muted">
            {items.length} line{items.length === 1 ? "" : "s"} · {EFFECTIVE_TONE[effectiveOf(grn)].blurb}
          </div>
        </div>

        <DetailGrid>
          <DetailMain>
            <Section title="Supplier">
              <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-3">
                <Field label="Supplier" value={supplierNameOf(grn)} />
                <Field label="Supplier code" value={supplierCodeOf(grn)} mono />
                <Field label="Contact" value={grn.supplier?.contact_person || "—"} muted={!grn.supplier?.contact_person} />
                <Field label="Phone" value={grn.supplier?.phone || "Not provided"} muted={!grn.supplier?.phone} mono={!!grn.supplier?.phone} />
                <Field label="Email" value={grn.supplier?.email || "Not provided"} muted={!grn.supplier?.email} />
                <Field label="Address" value={grn.supplier?.address || "—"} muted={!grn.supplier?.address} />
              </div>
            </Section>

            <Section title="Receipt info">
              <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-4">
                <Field label="Received at" value={fmtDate(grn.received_at)} />
                <Field label="From PO" value={poOf(grn)} mono={poOf(grn) !== "—"} muted={poOf(grn) === "—"} />
                <Field label="Delivery note" value={grn.delivery_note_ref || "—"} muted={!grn.delivery_note_ref} mono={!!grn.delivery_note_ref} />
                <Field label="Warehouse" value={grn.warehouse_code || "—"} muted={!grn.warehouse_code} mono={!!grn.warehouse_code} />
                <Field label="Currency" value={grn.currency} />
              </div>
              {grn.notes && (
                <div className="mt-4 rounded-lg border border-warning-text/25 bg-warning-bg px-4 py-3">
                  <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-warning-text">Note</div>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-warning-text">{grn.notes}</p>
                </div>
              )}
            </Section>

            <Section title={`Received items · ${items.length}`}>
              <DataTable<GrnItem>
                tableId={`grn-lines-${id}`}
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
              <ReceivedHeroCard header={grn} items={items} />

              <AsideCard title="Key dates">
                <KeyDateRow k="Received" v={fmtDate(grn.received_at)} />
                {grn.posted_at && <KeyDateRow k="Posted" v={fmtDate(grn.posted_at)} />}
                {grn.cancelled_at && <KeyDateRow k="Cancelled" v={fmtDate(grn.cancelled_at)} />}
              </AsideCard>

              <AsideCard title="People">
                <PersonRow initials={initialsOf(supplierNameOf(grn))} name={supplierNameOf(grn)} role={`Supplier · ${supplierCodeOf(grn)}`} tone="accent" />
                {grn.supplier?.contact_person && (
                  <PersonRow initials={initialsOf(grn.supplier.contact_person)} name={grn.supplier.contact_person} role={grn.supplier.phone || "Contact"} tone="neutral" />
                )}
              </AsideCard>
            </div>
          </DetailAside>
        </DetailGrid>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 px-3 pb-6 pt-2.5 shadow-slab backdrop-blur-sm md:hidden">
        <div className="flex items-center gap-2">
          {canPost ? (
            <button type="button" onClick={doPost} className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary text-[13.5px] font-bold text-white shadow-sm hover:bg-primary-ink">
              <Send size={16} /> Post
            </button>
          ) : canConvertToPi ? (
            <button type="button" onClick={goConvertToPi} className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary text-[13.5px] font-bold text-white shadow-sm hover:bg-primary-ink">
              <Receipt size={16} /> Convert to PI
            </button>
          ) : (
            <button type="button" onClick={goEdit} className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary text-[13.5px] font-bold text-white shadow-sm hover:bg-primary-ink">
              <Edit3 size={16} /> Edit
            </button>
          )}
          <button type="button" onClick={goPrintPdf} className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-surface-2 text-primary-ink hover:bg-primary-soft" aria-label="Print PDF">
            <Printer size={17} />
          </button>
          <button type="button" onClick={goCall} disabled={!grn.supplier?.phone} className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-surface-2 text-primary-ink hover:bg-primary-soft disabled:opacity-40" aria-label={grn.supplier?.phone ? `Call ${grn.supplier.phone}` : "No phone on file"}>
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

export default GoodsReceivedDetailV2;
