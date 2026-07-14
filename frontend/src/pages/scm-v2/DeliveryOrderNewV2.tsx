// DeliveryOrderNewV2 — Theme C ("Ink & Petrol") design of the New Delivery
// Order form, matching the 2026-07-08 handoff prototype.
//
// Composition mirrors the DO detail V2 chrome (sticky header, section cards,
// same colour tokens) but every section is an editable form group. A DO is
// created by CONVERTING a Sales Order: when the user opens the page with
// ?fromSo=<SO-doc-no>, the SO detail hook prefills the customer, address,
// emergency contact, and line items. Editing an existing DO with ?edit=<id>
// prefills from the DO itself and switches the primary CTA to "Save changes".
//
// Section order (matches the prototype):
//   1. Document flow — inline node card (5-node chain, current DO is brass)
//   2. Customer info    — name / phone / email / customer type / salesperson +
//                          Customer SO ref
//   3. Delivery address — line1/2 + state/city/postcode/sales location
//   4. Emergency contact — name / relationship / phone
//   5. Delivery info     — DO date / driver / vehicle / building type + venue /
//                          expected / customer delivery / note
//   6. Line items        — Item & variant · Remarks · Qty · Delivery · delete
//                          with a per-line + Variant picker modal
//
// Header right actions (no-wrap, flex-shrink:0):
//   From Sales Order (ghost) · Cancel (ghost) · Save as Draft (secondary) ·
//   Create Delivery Order (primary)
//
// Route: /scm/delivery-orders/new (App.tsx flips ScmDeliveryOrderNewV2 here).

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight as ArrowRightIcon,
  Trash2,
  Plus,
  X as XIcon,
  Save,
  CheckCircle2,
  RefreshCw,
  ShoppingCart,
} from "lucide-react";
import { Button } from "../../components/Button";
import { Badge } from "../../components/Badge";
import {
  useCreateMfgDeliveryOrder,
  useMfgDeliveryOrderDetail,
} from "../../vendor/scm/lib/delivery-order-queries";
import { useMfgSalesOrderDetail } from "../../vendor/scm/lib/sales-order-queries";
import { useSoDropdownOptions, optionsOrFallback } from "../../vendor/scm/lib/so-dropdown-options-queries";
import { useSetBreadcrumbs } from "../../hooks/useBreadcrumbs";
import { cn } from "../../lib/utils";

// ─── Types ──────────────────────────────────────────────────────────────────

type LineDraft = {
  id: number;
  itemCode: string;
  description: string;
  remark: string;
  qty: string;
  deliveryDate: string;
  uom: string;
  variants: Array<{ k: string; v: string }>;
  branding: string;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const todayIso = (): string => {
  const d = new Date();
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
};

const isoToDmy = (iso: string): string => {
  if (!iso) return "";
  const m = /^(\d{4})[-/](\d{2})[-/](\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
};

const emptyLine = (id: number): LineDraft => ({
  id,
  itemCode: "",
  description: "",
  remark: "",
  qty: "1",
  deliveryDate: "",
  uom: "UNIT",
  variants: [],
  branding: "",
});

// Per-product variant options for the picker modal. In real life this comes
// from a mfg-products/models attribute service — for now the options are
// derived from the item's category, with sensible fallbacks.
const VARIANT_MENU: Record<string, Array<[string, string[]]>> = {
  AKEMI: [
    ["Size", ["Single", "Super-single", "Queen", "King"]],
    ["Firmness", ["Plush", "Medium", "Medium-firm", "Firm"]],
    ["Top", ["Standard", "Pillow-top", "Euro-top"]],
  ],
  SOFA: [
    ["Fabric", ["Charcoal linen", "Sand weave", "Forest velvet"]],
    ["Config", ["Straight", "L-shape", "U-shape"]],
    ["Legs", ["Walnut", "Black steel"]],
  ],
  BEDFRAME: [
    ["Size", ["Single", "Super-single", "Queen", "King"]],
    ["Style", ["Solid", "Divan", "Storage"]],
  ],
  _DEFAULT: [
    ["Size", ["S", "M", "L", "XL"]],
    ["Colour", ["Natural", "Charcoal", "White"]],
    ["Material", ["Fabric", "Leather", "PU"]],
  ],
};

const variantMenuFor = (line: LineDraft): Array<[string, string[]]> => {
  const s = `${line.branding} ${line.itemCode} ${line.description}`.toUpperCase();
  if (s.includes("AKEMI") || s.includes("MATTRESS")) return VARIANT_MENU.AKEMI!;
  if (s.includes("SOFA")) return VARIANT_MENU.SOFA!;
  if (s.includes("BED") || s.includes("BEDFRAME")) return VARIANT_MENU.BEDFRAME!;
  return VARIANT_MENU._DEFAULT!;
};

// ─── Section card shell ────────────────────────────────────────────────────

function SectionCard({
  title,
  actions,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface shadow-stone">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="inline-block h-3.5 w-1 rounded-sm bg-primary" />
          <span className="font-mono text-[11px] font-bold uppercase tracking-brand text-ink">
            {title}
          </span>
        </div>
        {actions && (
          <div className="text-[11.5px] text-ink-muted">{actions}</div>
        )}
      </div>
      <div className="px-5 py-5">{children}</div>
    </section>
  );
}

// ─── Form field ────────────────────────────────────────────────────────────

function Label({
  text,
  required,
}: {
  text: string;
  required?: boolean;
}) {
  return (
    <div className="mb-1.5 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
      {text}
      {required && <span className="ml-1 text-err">*</span>}
    </div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
  className,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className={cn(
        "h-10 w-full rounded-lg border border-border bg-surface px-3 text-[13.5px] text-ink outline-none transition-colors placeholder:text-ink-muted",
        "focus:border-primary focus:shadow-[0_0_0_3px_rgba(22,105,95,.12)]",
        "disabled:opacity-50",
        className
      )}
    />
  );
}

function TextArea({
  value,
  onChange,
  placeholder,
  rows = 2,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className="w-full resize-y rounded-lg border border-border bg-surface px-3 py-2.5 text-[13.5px] leading-relaxed text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:shadow-[0_0_0_3px_rgba(22,105,95,.12)]"
    />
  );
}

function SelectInput({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 w-full appearance-none rounded-lg border border-border bg-surface px-3 pr-8 text-[13.5px] text-ink outline-none transition-colors focus:border-primary focus:shadow-[0_0_0_3px_rgba(22,105,95,.12)]"
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-muted">
        ▾
      </span>
    </div>
  );
}

function PhoneInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="flex items-stretch gap-1.5">
      <div className="inline-flex h-10 w-[86px] shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2 text-[12px] font-semibold text-ink-secondary">
        MY +60
      </div>
      <TextInput
        value={value}
        onChange={onChange}
        placeholder={placeholder || "11-6155 6133"}
        className="flex-1"
      />
    </div>
  );
}

// ─── Document flow inline card (matches the detail Relationship Map modal
// layout scaled down for the form page's inline treatment) ─────────────────

function DocumentFlowStrip({ soDocNo }: { soDocNo: string | null }) {
  const nodes: Array<{
    type: string;
    doc: string;
    meta: string;
    state: "done" | "current" | "pending";
  }> = [
    {
      type: "Customer PO",
      doc: soDocNo ? "Linked to SO" : "Not linked",
      meta: soDocNo ? "" : "—",
      state: soDocNo ? "done" : "pending",
    },
    {
      type: "Sales Order",
      doc: soDocNo || "Not linked",
      meta: soDocNo ? "Source doc" : "—",
      state: soDocNo ? "done" : "pending",
    },
    {
      type: "Delivery Order",
      doc: "This DO",
      meta: "Draft",
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
      doc: "Not created",
      meta: "On completion",
      state: "pending",
    },
  ];

  return (
    <SectionCard
      title="Document flow"
      actions={<span>PO → SO → DO → GRN → Invoice</span>}
    >
      <div className="flex items-stretch gap-0 overflow-x-auto pb-1">
        {nodes.map((n, i) => {
          const cur = n.state === "current";
          const done = n.state === "done";
          const last = i === nodes.length - 1;
          return (
            <div
              key={n.type}
              className="flex flex-1 items-center"
              style={{ minWidth: 160 }}
            >
              <div
                className={cn(
                  "flex-1 rounded-xl px-3.5 py-3",
                  cur
                    ? "border-2 border-accent bg-accent-soft"
                    : done
                      ? "border border-primary/30 bg-primary-soft"
                      : "border border-border bg-surface-2"
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
                    "mt-2 truncate font-mono text-[12.5px] font-bold",
                    cur ? "text-accent-ink" : done ? "text-primary-ink" : "text-ink-muted"
                  )}
                >
                  {n.doc}
                </div>
                <div
                  className={cn(
                    "mt-0.5 truncate text-[11px]",
                    cur ? "text-accent-ink/80" : "text-ink-muted"
                  )}
                >
                  {n.meta}
                </div>
              </div>
              {!last && (
                <span
                  className={cn(
                    "shrink-0 px-2 text-[16px]",
                    done ? "text-primary" : "text-border-strong"
                  )}
                >
                  →
                </span>
              )}
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

// ─── Variant picker modal ──────────────────────────────────────────────────

function VariantPickerModal({
  line,
  onClose,
  onPick,
}: {
  line: LineDraft | null;
  onClose: () => void;
  onPick: (attr: string, val: string) => void;
}) {
  const menu = line ? variantMenuFor(line) : [];
  const open = !!line;
  // Portal to <body> so `fixed` positioning latches to the viewport instead
  // of getting trapped inside an ancestor with `transform` / `filter` /
  // `will-change` (the Layout's overflow-hidden main pane triggers this on
  // mobile browsers). Without the portal the modal renders at the bottom of
  // its containing block — see 2026-07-08 bug report from Nick.
  return createPortal(
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
        aria-label="Add variant"
        className={cn(
          "fixed left-1/2 top-[8vh] z-[81] flex max-h-[84vh] w-[calc(100%-32px)] max-w-[460px] -translate-x-1/2 flex-col overflow-hidden rounded-2xl bg-surface shadow-slab transition-all duration-200",
          open ? "scale-100 opacity-100" : "pointer-events-none scale-[.97] opacity-0"
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border-subtle px-5 py-4">
          <div>
            <div className="text-[15px] font-bold text-ink">Add variant</div>
            <div className="mt-0.5 text-[12px] text-ink-muted">
              {line?.itemCode || line?.description || "New line"}
            </div>
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
        <div className="thin-scroll flex-1 overflow-y-auto p-5">
          {menu.map(([attr, values]) => (
            <div key={attr} className="mb-4 last:mb-0">
              <div className="mb-2 px-1 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                {attr}
              </div>
              <div className="flex flex-wrap gap-2">
                {values.map((val) => {
                  const active =
                    line?.variants.some((v) => v.k === attr && v.v === val) ??
                    false;
                  return (
                    <button
                      key={val}
                      type="button"
                      onClick={() => onPick(attr, val)}
                      className={cn(
                        "inline-flex h-8 items-center rounded-full px-3.5 text-[12.5px] font-semibold transition-colors",
                        active
                          ? "border border-primary bg-primary text-white"
                          : "border border-border bg-surface text-ink hover:border-primary/40 hover:bg-primary-soft"
                      )}
                    >
                      {val}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>,
    document.body
  );
}

// ─── From SO picker modal ──────────────────────────────────────────────────

function FromSoPickerModal({
  open,
  onClose,
  onPick,
  currentValue,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (soDocNo: string) => void;
  currentValue: string | null;
}) {
  const [value, setValue] = useState(currentValue ?? "");
  useEffect(() => {
    if (open) setValue(currentValue ?? "");
  }, [open, currentValue]);

  // Portal to <body> — see the VariantPickerModal note above; same fix.
  return createPortal(
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
        aria-label="Pull lines from a Sales Order"
        className={cn(
          "fixed left-1/2 top-[10vh] z-[81] flex w-[calc(100%-32px)] max-w-[440px] -translate-x-1/2 flex-col overflow-hidden rounded-2xl bg-surface shadow-slab transition-all duration-200",
          open ? "scale-100 opacity-100" : "pointer-events-none scale-[.97] opacity-0"
        )}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-5 py-4">
          <div className="text-[15px] font-bold text-ink">From Sales Order</div>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-muted hover:text-ink"
            aria-label="Close"
          >
            <XIcon size={18} />
          </button>
        </div>
        <div className="p-5">
          <Label text="SO doc no." />
          <TextInput
            value={value}
            onChange={setValue}
            placeholder="SO-2607-009"
          />
          <div className="mt-1.5 text-[11.5px] text-ink-muted">
            Enter a Sales Order doc no. to prefill customer + lines from that SO.
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border-subtle bg-surface-2 px-5 py-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<RefreshCw size={14} />}
            onClick={() => {
              if (value.trim()) onPick(value.trim());
            }}
          >
            Pull from SO
          </Button>
        </div>
      </div>
    </>,
    document.body
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────

export function DeliveryOrderNewV2() {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  useSetBreadcrumbs([
    { label: "Delivery Orders", to: "/scm/delivery-orders" },
    { label: "New" },
  ]);

  const fromSoParam = params.get("fromSo") ?? params.get("so") ?? "";
  const editId = params.get("edit") ?? "";

  const [soDocNo, setSoDocNo] = useState<string>(fromSoParam);
  const soDetail = useMfgSalesOrderDetail(soDocNo || null);
  const doDetail = useMfgDeliveryOrderDetail(editId || null);
  const createDo = useCreateMfgDeliveryOrder();

  // ── Form state ─────────────────────────────────────────────────────
  const [customerName, setCustomerName] = useState("");
  const [customerSoRef, setCustomerSoRef] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [customerType, setCustomerType] = useState("");
  // Customer type from the live maintenance catalog (same as SO), not hardcoded.
  const customerTypeOpts = optionsOrFallback("customer_type", useSoDropdownOptions("customer_type").data);
  const [salesperson, setSalesperson] = useState("");
  const [addr1, setAddr1] = useState("");
  const [addr2, setAddr2] = useState("");
  const [state, setState] = useState("");
  const [city, setCity] = useState("");
  const [postcode, setPostcode] = useState("");
  const [salesLocation, setSalesLocation] = useState("");
  const [ecName, setEcName] = useState("");
  const [ecRelationship, setEcRelationship] = useState("");
  const [ecPhone, setEcPhone] = useState("");
  const [doDate, setDoDate] = useState(todayIso());
  const [driver, setDriver] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [buildingType, setBuildingType] = useState("");
  const [venue, setVenue] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [customerDelDate, setCustomerDelDate] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([emptyLine(1)]);
  const [nextLineId, setNextLineId] = useState(2);
  const [variantPickerLine, setVariantPickerLine] = useState<LineDraft | null>(
    null
  );
  const [soPickerOpen, setSoPickerOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [asDraft, setAsDraft] = useState(false);

  // Flash toast
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1900);
    return () => clearTimeout(t);
  }, [flash]);

  // Prefill from SO detail (when converting)
  useEffect(() => {
    const so = (soDetail.data as { salesOrder?: Record<string, unknown> } | undefined)?.salesOrder;
    if (!so || !soDocNo) return;
    setCustomerName(String(so.debtor_name ?? ""));
    setCustomerSoRef(String(so.customer_so_no ?? so.po_doc_no ?? so.ref ?? ""));
    setPhone(String(so.phone ?? ""));
    setEmail(String(so.email ?? ""));
    setCustomerType(String(so.customer_type ?? ""));
    setSalesperson(String((so.agent ?? so.salesperson_id ?? "") as string));
    setAddr1(String(so.address1 ?? ""));
    setAddr2(String(so.address2 ?? ""));
    setState(String(so.customer_state ?? ""));
    setCity(String(so.city ?? ""));
    setPostcode(String(so.postcode ?? ""));
    setSalesLocation(String(so.sales_location ?? ""));
    setBuildingType(String(so.building_type ?? ""));
    setVenue(String(so.venue ?? ""));
    // Lines
    const items = (soDetail.data as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? [];
    if (items.length > 0) {
      let nid = 1;
      const newLines: LineDraft[] = items.map((it) => ({
        id: nid++,
        itemCode: String(it.item_code ?? ""),
        description: String(it.description ?? ""),
        remark: "",
        qty: String(it.qty ?? 1),
        deliveryDate: "",
        uom: String(it.uom ?? "UNIT"),
        variants: [],
        branding: String(it.item_group ?? ""),
      }));
      setLines(newLines);
      setNextLineId(nid);
    }
    setFlash(`Prefilled from ${soDocNo}`);
  }, [soDetail.data, soDocNo]);

  // Prefill from DO detail (when editing)
  useEffect(() => {
    const doo = (doDetail.data as { deliveryOrder?: Record<string, unknown> } | undefined)?.deliveryOrder;
    if (!doo || !editId) return;
    setCustomerName(String(doo.debtor_name ?? ""));
    setPhone(String(doo.phone ?? ""));
    setEmail(String(doo.email ?? ""));
    setAddr1(String(doo.address1 ?? ""));
    setAddr2(String(doo.address2 ?? ""));
    setState(String(doo.customer_state ?? ""));
    setCity(String(doo.city ?? ""));
    setPostcode(String(doo.postcode ?? ""));
    setSalesLocation(String(doo.sales_location ?? ""));
    setDoDate(String(doo.do_date ?? todayIso()).slice(0, 10));
    setDriver(String((doo.driver_name ?? "") as string));
    setVehicle(String(doo.vehicle ?? ""));
    setBuildingType(String(doo.building_type ?? ""));
    setVenue(String(doo.venue ?? ""));
    setNote(String((doo.note ?? doo.notes ?? "") as string));
    setSoDocNo(String((doo.so_doc_no ?? "") as string));
  }, [doDetail.data, editId]);

  // ── Totals ─────────────────────────────────────────────────────────
  const totalQty = useMemo(
    () =>
      lines.reduce((sum, l) => {
        const n = parseInt(l.qty, 10);
        return sum + (Number.isFinite(n) ? n : 0);
      }, 0),
    [lines]
  );

  // ── Line ops ───────────────────────────────────────────────────────
  const addLine = () => {
    setLines((prev) => [...prev, emptyLine(nextLineId)]);
    setNextLineId((n) => n + 1);
  };
  const removeLine = (id: number) => {
    setLines((prev) => prev.filter((l) => l.id !== id));
  };
  const updateLine = (id: number, patch: Partial<LineDraft>) => {
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  };
  const removeVariant = (lineId: number, k: string) => {
    setLines((prev) =>
      prev.map((l) =>
        l.id === lineId ? { ...l, variants: l.variants.filter((v) => v.k !== k) } : l
      )
    );
  };
  const pickVariant = (attr: string, val: string) => {
    if (!variantPickerLine) return;
    setLines((prev) =>
      prev.map((l) => {
        if (l.id !== variantPickerLine.id) return l;
        const vs = l.variants.filter((v) => v.k !== attr);
        vs.push({ k: attr, v: val });
        return { ...l, variants: vs };
      })
    );
    setFlash(`${attr}: ${val} added`);
    setVariantPickerLine(null);
  };

  // ── Submit ─────────────────────────────────────────────────────────
  const buildBody = () => ({
    soDocNo: soDocNo || undefined,
    debtorName: customerName,
    phone,
    email,
    customerType,
    agent: salesperson,
    address1: addr1,
    address2: addr2,
    customerState: state,
    city,
    postcode,
    salesLocation,
    emergencyContactName: ecName,
    emergencyContactRelationship: ecRelationship,
    emergencyContactPhone: ecPhone,
    doDate,
    driverName: driver,
    vehicle,
    buildingType,
    venue,
    expectedDeliveryAt: expectedDate,
    customerDeliveryDate: customerDelDate,
    note,
    customerSoNo: customerSoRef,
    items: lines
      .filter((l) => l.itemCode.trim() || l.description.trim())
      .map((l) => ({
        itemCode: l.itemCode,
        description: l.description,
        uom: l.uom,
        qty: parseInt(l.qty, 10) || 0,
        variants: Object.fromEntries(l.variants.map((v) => [v.k, v.v])),
        remark: l.remark,
        deliveryDate: l.deliveryDate,
      })),
  });

  const goCancel = () => {
    if (window.confirm("Discard this delivery order?")) {
      navigate("/scm/delivery-orders");
    }
  };
  const goList = () => navigate("/scm/delivery-orders");

  const doCreate = (draft: boolean) => {
    if (!customerName.trim()) {
      window.alert("Customer name is required.");
      return;
    }
    if (buildBody().items.length === 0) {
      window.alert("Add at least one line item.");
      return;
    }
    setAsDraft(draft);
    createDo.mutate(
      { ...buildBody(), status: draft ? "DRAFT" : "LOADED" },
      {
        onSuccess: (res) => {
          setFlash(draft ? "Saved as draft" : "Delivery order created");
          if (res?.id) {
            navigate(`/scm/delivery-orders/${res.id}`);
          } else {
            navigate("/scm/delivery-orders");
          }
        },
        onError: (err) => {
          window.alert(
            "Create failed: " +
              (err instanceof Error ? err.message : String(err))
          );
          setAsDraft(false);
        },
      }
    );
  };

  const submitting = createDo.isPending;

  return (
    <div className="pb-20">
      {/* Sticky form header */}
      <div className="sticky top-0 z-10 -mx-4 border-b border-border bg-bg/95 px-4 py-4 backdrop-blur-sm sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <button
              type="button"
              onClick={goList}
              aria-label="Back to Delivery Orders"
              className="mt-0.5 inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[13px] font-semibold text-ink-secondary hover:border-primary/50 hover:text-primary"
            >
              <ArrowLeft size={14} /> Delivery Orders
            </button>
            <div className="min-w-0">
              <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">
                {editId ? "Edit Delivery Order" : "New Delivery Order"}
              </h1>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-secondary">
                <span>Draft · not yet saved</span>
                {soDocNo && (
                  <>
                    <span className="text-border-strong">·</span>
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent-soft px-2.5 py-0.5 text-[11.5px] font-semibold text-accent-ink">
                      ⇄ Converted from{" "}
                      <b className="font-mono">{soDocNo}</b>
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
          {/* Right actions — no-wrap */}
          <div className="flex flex-shrink-0 flex-nowrap items-center gap-2">
            <Button
              variant="ghost"
              icon={<RefreshCw size={14} />}
              onClick={() => setSoPickerOpen(true)}
              className="whitespace-nowrap"
            >
              From Sales Order
            </Button>
            <Button
              variant="ghost"
              icon={<XIcon size={14} />}
              onClick={goCancel}
              className="whitespace-nowrap"
            >
              Cancel
            </Button>
            <Button
              variant="secondary"
              icon={<Save size={14} />}
              onClick={() => doCreate(true)}
              disabled={submitting}
              className="whitespace-nowrap"
            >
              {asDraft && submitting ? "Saving…" : "Save as Draft"}
            </Button>
            <Button
              variant="primary"
              icon={<CheckCircle2 size={14} />}
              onClick={() => doCreate(false)}
              disabled={submitting}
              className="whitespace-nowrap"
            >
              {!asDraft && submitting
                ? "Creating…"
                : editId
                  ? "Save changes"
                  : "Create Delivery Order"}
            </Button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="mx-auto flex max-w-[1180px] flex-col gap-5 px-1 py-6 sm:px-3">
        {/* Document flow */}
        <DocumentFlowStrip soDocNo={soDocNo || null} />

        {/* Customer info */}
        <SectionCard title="Customer info">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_340px]">
            <div>
              <Label text="Customer name" required />
              <TextInput
                value={customerName}
                onChange={setCustomerName}
                placeholder="e.g. Lim Mei Hua"
              />
            </div>
            <div>
              <Label text="Customer SO ref" />
              <TextInput
                value={customerSoRef}
                onChange={setCustomerSoRef}
                placeholder="Their PO / SO number"
              />
            </div>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-4">
            <div>
              <Label text="Phone" required />
              <PhoneInput value={phone} onChange={setPhone} />
            </div>
            <div>
              <Label text="Email" />
              <TextInput
                value={email}
                onChange={setEmail}
                placeholder="customer@example.com"
              />
            </div>
            <div>
              <Label text="Customer type" />
              <SelectInput
                value={customerType}
                onChange={setCustomerType}
                placeholder="—"
                options={customerTypeOpts}
              />
            </div>
            <div>
              <Label text="Salesperson" />
              <TextInput
                value={salesperson}
                onChange={setSalesperson}
                placeholder="Pick or type…"
              />
            </div>
          </div>
        </SectionCard>

        {/* Delivery address */}
        <SectionCard title="Delivery address">
          <div className="flex flex-col gap-4">
            <div>
              <Label text="Address line 1" />
              <TextInput
                value={addr1}
                onChange={setAddr1}
                placeholder="Unit, street, area"
              />
            </div>
            <div>
              <Label text="Address line 2" />
              <TextInput
                value={addr2}
                onChange={setAddr2}
                placeholder="Apt, floor, building (optional)"
              />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
              <div>
                <Label text="State" />
                <TextInput
                  value={state}
                  onChange={setState}
                  placeholder="Pick state"
                />
              </div>
              <div>
                <Label text="City" />
                <TextInput
                  value={city}
                  onChange={setCity}
                  placeholder="Pick city"
                />
              </div>
              <div>
                <Label text="Postcode" />
                <TextInput
                  value={postcode}
                  onChange={setPostcode}
                  placeholder="Pick postcode"
                />
              </div>
              <div>
                <Label text="Sales location" />
                <SelectInput
                  value={salesLocation}
                  onChange={setSalesLocation}
                  placeholder="—"
                  options={[
                    { value: "KL Warehouse", label: "KL Warehouse" },
                    { value: "Cheras DC", label: "Cheras DC" },
                  ]}
                />
              </div>
            </div>
          </div>
        </SectionCard>

        {/* Emergency contact */}
        <SectionCard
          title="Emergency contact"
          actions={
            <span>Used only if we cannot reach the customer on delivery day</span>
          }
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <Label text="Contact name" />
              <TextInput
                value={ecName}
                onChange={setEcName}
                placeholder="e.g. Lim Mei Hua"
              />
            </div>
            <div>
              <Label text="Relationship" />
              <SelectInput
                value={ecRelationship}
                onChange={setEcRelationship}
                placeholder="—"
                options={[
                  { value: "Spouse", label: "Spouse" },
                  { value: "Family", label: "Family" },
                  { value: "Colleague", label: "Colleague" },
                  { value: "Self", label: "Self (customer)" },
                ]}
              />
            </div>
            <div>
              <Label text="Phone" />
              <PhoneInput value={ecPhone} onChange={setEcPhone} />
            </div>
          </div>
        </SectionCard>

        {/* Delivery info */}
        <SectionCard title="Delivery info">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <div>
              <Label text="DO date" />
              <TextInput
                value={doDate}
                onChange={setDoDate}
                type="date"
              />
            </div>
            <div>
              <Label text="Driver" />
              <TextInput
                value={driver}
                onChange={setDriver}
                placeholder="Pick driver…"
              />
            </div>
            <div>
              <Label text="Vehicle" />
              <TextInput
                value={vehicle}
                onChange={setVehicle}
                placeholder="Lorry plate no."
              />
            </div>
            <div>
              <Label text="Building type" />
              <SelectInput
                value={buildingType}
                onChange={setBuildingType}
                placeholder="—"
                options={[
                  { value: "Landed", label: "Landed" },
                  { value: "High-rise (lift)", label: "High-rise (lift)" },
                  { value: "High-rise (no lift)", label: "High-rise (no lift)" },
                ]}
              />
            </div>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <Label text="Venue" />
              <TextInput
                value={venue}
                onChange={setVenue}
                placeholder="Residence / site"
              />
            </div>
            <div>
              <Label text="Expected delivery" />
              <TextInput
                value={expectedDate}
                onChange={setExpectedDate}
                type="date"
              />
            </div>
            <div>
              <Label text="Customer delivery date" />
              <TextInput
                value={customerDelDate}
                onChange={setCustomerDelDate}
                type="date"
              />
            </div>
          </div>
          <div className="mt-4">
            <Label text="Note" />
            <TextArea
              value={note}
              onChange={setNote}
              placeholder="Internal notes — visible on the DO detail page only"
            />
          </div>
        </SectionCard>

        {/* Line items */}
        <SectionCard
          title={`Line items · ${lines.length}`}
          actions={<span>Pick a product, then set its variant</span>}
        >
          <div className="grid grid-cols-[26px_1.5fr_1fr_70px_130px_34px] gap-2 border-b border-border-subtle pb-2 font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
            <span>#</span>
            <span>Item &amp; variant</span>
            <span>Remarks</span>
            <span className="text-right">Qty</span>
            <span>Delivery</span>
            <span></span>
          </div>

          {lines.map((line, i) => (
            <div
              key={line.id}
              className="border-b border-border-subtle py-3.5 last:border-b-0"
            >
              <div className="grid grid-cols-[26px_1.5fr_1fr_70px_130px_34px] items-center gap-2">
                <span className="font-mono text-[12px] font-semibold text-ink-muted">
                  {i + 1}
                </span>
                <TextInput
                  value={line.itemCode || line.description}
                  onChange={(v) => updateLine(line.id, { itemCode: v, description: v })}
                  placeholder="Click to pick or type to filter…"
                />
                <TextInput
                  value={line.remark}
                  onChange={(v) => updateLine(line.id, { remark: v })}
                  placeholder="Type remarks…"
                />
                <TextInput
                  value={line.qty}
                  onChange={(v) => updateLine(line.id, { qty: v })}
                  className="text-right font-money"
                />
                <TextInput
                  value={line.deliveryDate}
                  onChange={(v) => updateLine(line.id, { deliveryDate: v })}
                  placeholder="dd/mm/yyyy"
                  type="date"
                />
                <button
                  type="button"
                  onClick={() => removeLine(line.id)}
                  aria-label="Delete line"
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-muted hover:bg-err-soft hover:text-err"
                >
                  <Trash2 size={15} />
                </button>
              </div>
              {/* Variant row */}
              <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-[36px]">
                <span className="mr-1 font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
                  Variant
                </span>
                {line.variants.map((v) => (
                  <span
                    key={v.k}
                    className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border-subtle bg-surface-2 px-2.5"
                  >
                    <span className="font-mono text-[9px] font-semibold uppercase tracking-wider text-ink-muted">
                      {v.k}
                    </span>
                    <span className="text-[12px] font-semibold text-primary-ink">
                      {v.v}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeVariant(line.id, v.k)}
                      className="text-[11px] text-ink-muted hover:text-err"
                      aria-label={`Remove ${v.k}`}
                    >
                      ✕
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  onClick={() => setVariantPickerLine(line)}
                  className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-border-strong px-3 text-[12px] font-semibold text-ink-secondary hover:border-primary/60 hover:bg-primary-soft hover:text-primary"
                >
                  + Variant
                </button>
                {line.branding && (
                  <span className="ml-auto">
                    <Badge
                      tone={
                        line.branding.toUpperCase().includes("SOFA") ||
                        line.branding.toUpperCase().includes("2990")
                          ? "success"
                          : line.branding.toUpperCase().includes("AKEMI")
                            ? "neutral"
                            : "warning"
                      }
                      size="xs"
                    >
                      {line.branding}
                    </Badge>
                  </span>
                )}
              </div>
            </div>
          ))}

          <div className="mt-4 flex items-center justify-between">
            <button
              type="button"
              onClick={addLine}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-dashed border-border-strong bg-surface px-4 text-[13px] font-semibold text-primary-ink hover:border-primary/60 hover:bg-primary-soft"
            >
              <Plus size={14} /> Add line
            </button>
            <div className="text-right">
              <div className="font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                Total items
              </div>
              <div className="mt-0.5 font-money text-[18px] font-bold text-ink">
                {totalQty}
              </div>
            </div>
          </div>
        </SectionCard>

        {/* Bottom action strip — mirrors sticky header, for tall pages */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <div className="text-[11.5px] text-ink-muted">
            {lines.length} line{lines.length === 1 ? "" : "s"} · {totalQty} unit
            {totalQty === 1 ? "" : "s"}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              icon={<Save size={14} />}
              onClick={() => doCreate(true)}
              disabled={submitting}
            >
              Save as Draft
            </Button>
            <Button
              variant="primary"
              icon={<CheckCircle2 size={14} />}
              onClick={() => doCreate(false)}
              disabled={submitting}
            >
              {editId ? "Save changes" : "Create Delivery Order"}
            </Button>
          </div>
        </div>
      </div>

      {/* Variant picker modal */}
      <VariantPickerModal
        line={variantPickerLine}
        onClose={() => setVariantPickerLine(null)}
        onPick={pickVariant}
      />

      {/* From SO picker modal */}
      <FromSoPickerModal
        open={soPickerOpen}
        onClose={() => setSoPickerOpen(false)}
        onPick={(docNo) => {
          setSoDocNo(docNo);
          setSoPickerOpen(false);
        }}
        currentValue={soDocNo}
      />

      {/* Flash toast */}
      {flash && (
        <div className="fixed bottom-6 left-1/2 z-[100] -translate-x-1/2 rounded-lg bg-sidebar px-4 py-2.5 text-[13px] font-semibold text-white shadow-slab">
          {flash}
        </div>
      )}
    </div>
  );
}

// Unused imports guard — reference the icons that may not appear in every code
// path so tree-shaking doesn't turn them into TS "declared but not used"
// warnings if the code drifts.
void ArrowRightIcon;
void ShoppingCart;

export default DeliveryOrderNewV2;
