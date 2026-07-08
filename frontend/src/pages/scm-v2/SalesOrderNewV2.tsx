// SalesOrderNewV2 — Theme C ("Ink & Petrol") design of the New Sales Order
// create form, matching Nick's 2026-07-09 handoff prototype
// (New Sales Order - Redesign.dc.html).
//
// The form section order matches the Delivery Order form (Customer →
// Delivery address → Emergency contact → Order info → Line items →
// Payments) so both docs read as siblings. Section-specific angles:
//
//   Customer          — Customer SO ref + required Phone / Email; Salesperson
//                       defaults to the current logged-in staff (matched by
//                       name against /staff).
//   Delivery address  — "Fill in address later" checkbox card that dims +
//                       disables the 6 address fields when checked; Country
//                       is preset to Malaysia because 100% of Houzs orders
//                       ship inside MY.
//   Emergency contact — Name / Relationship / Phone; helper text.
//   Order info        — Building type / Venue / Processing date / Delivery
//                       date / Note (no driver/vehicle — those belong to
//                       the DO once one is issued).
//   Line items        — # · Item & variant · Remarks · Qty · Price (brass
//                       tinted) · Delivery · Amount (font-money) · delete
//                       with a per-line + Variant picker modal and a
//                       right-aligned Subtotal footer.
//   Payments          — Inline transactions table (Date / Method / Amount /
//                       Account sheet / Approval code / Collected by) with
//                       + Add Payment, empty state, and a Deposit paid /
//                       Balance footer (Balance = Subtotal × 1.06 for SST).
//
// Route: /scm/sales-orders/new (App.tsx flips ScmSalesOrderNewV2 here).

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Trash2,
  Plus,
  X as XIcon,
  Save,
  CheckCircle2,
  Check,
} from "lucide-react";
import { Button } from "../../components/Button";
import { Badge } from "../../components/Badge";
import {
  useCreateMfgSalesOrder,
  useMfgSalesOrderDetail,
} from "../../vendor/scm/lib/sales-order-queries";
import { useStaff } from "../../vendor/scm/lib/admin-queries";
import { useAuth } from "../../auth/AuthContext";
import { useSetBreadcrumbs } from "../../hooks/useBreadcrumbs";
import { cn } from "../../lib/utils";

// ─── Types ──────────────────────────────────────────────────────────────────

type LineDraft = {
  id: number;
  itemCode: string;
  description: string;
  remark: string;
  qty: string;
  priceRm: string;
  deliveryDate: string;
  uom: string;
  variants: Array<{ k: string; v: string }>;
  branding: string;
};

type PaymentDraft = {
  id: number;
  paidAt: string;
  method: "Cash" | "Merchant" | "Online";
  amountRm: string;
  accountSheet: string;
  approvalCode: string;
  collectedByStaffId: string;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const todayIso = (): string => {
  const d = new Date();
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
};

const fmtMoney = (n: number, currency = "MYR"): string =>
  `${currency} ${n.toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const emptyLine = (id: number): LineDraft => ({
  id,
  itemCode: "",
  description: "",
  remark: "",
  qty: "1",
  priceRm: "0.00",
  deliveryDate: "",
  uom: "UNIT",
  variants: [],
  branding: "",
});

const emptyPayment = (id: number, collectedByStaffId: string): PaymentDraft => ({
  id,
  paidAt: todayIso(),
  method: "Cash",
  amountRm: "0.00",
  accountSheet: "",
  approvalCode: "",
  collectedByStaffId,
});

const lineAmount = (l: LineDraft): number => {
  const q = parseFloat(l.qty);
  const p = parseFloat(l.priceRm);
  return (Number.isFinite(q) ? q : 0) * (Number.isFinite(p) ? p : 0);
};

// Per-product variant options for the picker modal. Same shape as DO form —
// looked up by branding / item code / description keyword; falls back to a
// generic Size / Colour / Material triple.
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

const brandTone = (
  brand: string
): "success" | "neutral" | "warning" => {
  const s = brand.toUpperCase();
  if (s.includes("SOFA") || s.includes("2990")) return "success";
  if (s.includes("AKEMI")) return "neutral";
  return "warning";
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
        {actions && <div className="text-[11.5px] text-ink-muted">{actions}</div>}
      </div>
      <div className="px-5 py-5">{children}</div>
    </section>
  );
}

// ─── Form controls ─────────────────────────────────────────────────────────

function Label({ text, required }: { text: string; required?: boolean }) {
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
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      disabled={disabled}
      className="w-full resize-y rounded-lg border border-border bg-surface px-3 py-2.5 text-[13.5px] leading-relaxed text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:shadow-[0_0_0_3px_rgba(22,105,95,.12)] disabled:opacity-50"
    />
  );
}

function SelectInput({
  value,
  onChange,
  options,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="h-10 w-full appearance-none rounded-lg border border-border bg-surface px-3 pr-8 text-[13.5px] text-ink outline-none transition-colors focus:border-primary focus:shadow-[0_0_0_3px_rgba(22,105,95,.12)] disabled:opacity-50"
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
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-stretch gap-1.5">
      <div
        className={cn(
          "inline-flex h-10 w-[86px] shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2 text-[12px] font-semibold text-ink-secondary",
          disabled && "opacity-50"
        )}
      >
        MY +60
      </div>
      <TextInput
        value={value}
        onChange={onChange}
        placeholder={placeholder || "11-6155 6133"}
        className="flex-1"
        disabled={disabled}
      />
    </div>
  );
}

// ─── "Fill in address later" checkbox card ─────────────────────────────────

function AddressLaterCard({
  checked,
  onToggle,
}: {
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "flex w-full items-start gap-3 rounded-xl border px-4 py-3.5 text-left transition-colors",
        checked
          ? "border-primary/60 bg-primary-soft"
          : "border-border-subtle bg-surface-2 hover:border-primary/30"
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-[1.5px] transition-colors",
          checked
            ? "border-primary bg-primary text-white"
            : "border-border-strong bg-surface"
        )}
      >
        {checked && <Check size={12} strokeWidth={3} />}
      </span>
      <div>
        <div className="text-[13px] font-bold text-ink">Fill in address later</div>
        <div className="mt-1 text-[12px] text-ink-muted">
          Customer hasn't confirmed delivery address yet — we'll capture it
          before dispatch.
        </div>
      </div>
    </button>
  );
}

// ─── Variant picker modal (portal to body) ─────────────────────────────────

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

// ─── Malaysian state / city / postcode option lists (compact seed set) ─────

const MY_STATES = [
  "Johor",
  "Kedah",
  "Kelantan",
  "Melaka",
  "Negeri Sembilan",
  "Pahang",
  "Penang",
  "Perak",
  "Perlis",
  "Sabah",
  "Sarawak",
  "Selangor",
  "Terengganu",
  "WP Kuala Lumpur",
  "WP Labuan",
  "WP Putrajaya",
];

// ─── Main page ─────────────────────────────────────────────────────────────

export function SalesOrderNewV2() {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  useSetBreadcrumbs([
    { label: "Sales Orders", to: "/scm/sales-orders" },
    { label: "New" },
  ]);

  const editDocNo = params.get("edit") ?? "";
  const soDetail = useMfgSalesOrderDetail(editDocNo || null);
  const createSo = useCreateMfgSalesOrder();
  const { user } = useAuth();
  const staffQ = useStaff();
  const staffOptions = useMemo(
    () =>
      (staffQ.data ?? [])
        .filter((s) => s.active)
        .map((s) => ({
          value: s.id,
          label: s.staffCode ? `${s.name} (${s.staffCode})` : s.name,
        })),
    [staffQ.data]
  );

  // Salesperson default → the currently logged-in Houzs user, matched by
  // name against /staff. Falls through to '' (= '—') if no staff record has
  // the same name — better than lying about who took the order.
  const defaultSalespersonId = useMemo(() => {
    const uname = (user?.name || "").trim().toLowerCase();
    if (!uname) return "";
    const hit = (staffQ.data ?? []).find(
      (s) => s.active && s.name && s.name.trim().toLowerCase() === uname
    );
    return hit?.id ?? "";
  }, [user?.name, staffQ.data]);

  // ── Form state ────────────────────────────────────────────────────
  const [customerName, setCustomerName] = useState("");
  const [customerSoRef, setCustomerSoRef] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [customerType, setCustomerType] = useState("");
  const [salespersonId, setSalespersonId] = useState("");
  const [addrLater, setAddrLater] = useState(false);
  const [addr1, setAddr1] = useState("");
  const [addr2, setAddr2] = useState("");
  const [addrState, setAddrState] = useState("");
  const [city, setCity] = useState("");
  const [postcode, setPostcode] = useState("");
  const [country, setCountry] = useState("Malaysia");
  const [salesLocation, setSalesLocation] = useState("");
  const [ecName, setEcName] = useState("");
  const [ecRelationship, setEcRelationship] = useState("");
  const [ecPhone, setEcPhone] = useState("");
  const [buildingType, setBuildingType] = useState("");
  const [venue, setVenue] = useState("");
  const [processingDate, setProcessingDate] = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([emptyLine(1)]);
  const [nextLineId, setNextLineId] = useState(2);
  const [payments, setPayments] = useState<PaymentDraft[]>([]);
  const [nextPaymentId, setNextPaymentId] = useState(1);
  const [variantPickerLine, setVariantPickerLine] = useState<LineDraft | null>(
    null
  );
  const [flash, setFlash] = useState<string | null>(null);
  const [asDraft, setAsDraft] = useState(false);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1900);
    return () => clearTimeout(t);
  }, [flash]);

  // Seed salesperson once the staff list resolves.
  useEffect(() => {
    if (!salespersonId && defaultSalespersonId) {
      setSalespersonId(defaultSalespersonId);
    }
  }, [defaultSalespersonId, salespersonId]);

  // Prefill from SO detail (edit mode)
  useEffect(() => {
    const so = (soDetail.data as { salesOrder?: Record<string, unknown> } | undefined)?.salesOrder;
    if (!so || !editDocNo) return;
    setCustomerName(String(so.debtor_name ?? ""));
    setCustomerSoRef(String(so.customer_so_no ?? so.po_doc_no ?? so.ref ?? ""));
    setPhone(String(so.phone ?? ""));
    setEmail(String(so.email ?? ""));
    setCustomerType(String(so.customer_type ?? ""));
    setSalespersonId(String((so.salesperson_id ?? "") as string));
    setAddr1(String(so.address1 ?? ""));
    setAddr2(String(so.address2 ?? ""));
    setAddrState(String(so.customer_state ?? ""));
    setCity(String(so.city ?? ""));
    setPostcode(String(so.postcode ?? ""));
    setCountry(String(so.customer_country ?? "Malaysia"));
    setSalesLocation(String(so.sales_location ?? ""));
    setBuildingType(String(so.building_type ?? ""));
    setVenue(String(so.venue ?? ""));
    setProcessingDate(String((so.processing_date ?? "") as string).slice(0, 10));
    setDeliveryDate(
      String((so.customer_delivery_date ?? "") as string).slice(0, 10)
    );
    setNote(String((so.note ?? "") as string));
    // Lines
    const items =
      (soDetail.data as { items?: Array<Record<string, unknown>> } | undefined)
        ?.items ?? [];
    if (items.length > 0) {
      let nid = 1;
      const newLines: LineDraft[] = items.map((it) => ({
        id: nid++,
        itemCode: String(it.item_code ?? ""),
        description: String(it.description ?? ""),
        remark: "",
        qty: String(it.qty ?? 1),
        priceRm: ((Number(it.unit_price_centi ?? 0)) / 100).toFixed(2),
        deliveryDate: "",
        uom: String(it.uom ?? "UNIT"),
        variants: [],
        branding: String(it.item_group ?? ""),
      }));
      setLines(newLines);
      setNextLineId(nid);
    }
    setFlash(`Prefilled from ${editDocNo}`);
  }, [soDetail.data, editDocNo]);

  // ── Totals ───────────────────────────────────────────────────────
  const subtotalRm = useMemo(
    () => lines.reduce((sum, l) => sum + lineAmount(l), 0),
    [lines]
  );
  const depositRm = useMemo(
    () =>
      payments.reduce((sum, p) => {
        const a = parseFloat(p.amountRm);
        return sum + (Number.isFinite(a) ? a : 0);
      }, 0),
    [payments]
  );
  // Balance = subtotal + SST 6% − deposit
  const balanceRm = useMemo(
    () => Math.max(0, subtotalRm * 1.06 - depositRm),
    [subtotalRm, depositRm]
  );

  // ── Line ops ────────────────────────────────────────────────────
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
        l.id === lineId
          ? { ...l, variants: l.variants.filter((v) => v.k !== k) }
          : l
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

  // ── Payment ops ─────────────────────────────────────────────────
  const addPayment = () => {
    setPayments((prev) => [
      ...prev,
      emptyPayment(nextPaymentId, defaultSalespersonId),
    ]);
    setNextPaymentId((n) => n + 1);
  };
  const removePayment = (id: number) => {
    setPayments((prev) => prev.filter((p) => p.id !== id));
  };
  const updatePayment = (id: number, patch: Partial<PaymentDraft>) => {
    setPayments((prev) =>
      prev.map((p) => (p.id === id ? { ...p, ...patch } : p))
    );
  };

  // ── Submit ──────────────────────────────────────────────────────
  const buildBody = () => ({
    debtorName: customerName,
    customerSoNo: customerSoRef,
    phone,
    email,
    customerType,
    salespersonId: salespersonId || undefined,
    address1: addrLater ? "" : addr1,
    address2: addrLater ? "" : addr2,
    customerState: addrLater ? "" : addrState,
    city: addrLater ? "" : city,
    postcode: addrLater ? "" : postcode,
    customerCountry: addrLater ? "" : country,
    salesLocation: addrLater ? "" : salesLocation,
    addressPending: addrLater,
    emergencyContactName: ecName,
    emergencyContactRelationship: ecRelationship,
    emergencyContactPhone: ecPhone,
    buildingType,
    venue,
    processingDate,
    customerDeliveryDate: deliveryDate,
    note,
    items: lines
      .filter((l) => l.itemCode.trim() || l.description.trim())
      .map((l) => ({
        itemCode: l.itemCode,
        description: l.description,
        uom: l.uom,
        qty: parseInt(l.qty, 10) || 0,
        unitPriceCenti: Math.round((parseFloat(l.priceRm) || 0) * 100),
        variants: Object.fromEntries(l.variants.map((v) => [v.k, v.v])),
        remark: l.remark,
        deliveryDate: l.deliveryDate,
      })),
    payments: payments.map((p) => ({
      paidAt: p.paidAt,
      method: p.method.toLowerCase(),
      amountCenti: Math.round((parseFloat(p.amountRm) || 0) * 100),
      accountSheet: p.accountSheet,
      approvalCode: p.approvalCode,
      collectedBy: p.collectedByStaffId || undefined,
    })),
  });

  const goCancel = () => {
    if (window.confirm("Discard this sales order?")) {
      navigate("/scm/sales-orders");
    }
  };
  const goList = () => navigate("/scm/sales-orders");

  const doCreate = (draft: boolean) => {
    if (!customerName.trim()) {
      window.alert("Customer name is required.");
      return;
    }
    if (!phone.trim()) {
      window.alert("Phone is required.");
      return;
    }
    if (!email.trim()) {
      window.alert("Email is required.");
      return;
    }
    if (buildBody().items.length === 0) {
      window.alert("Add at least one line item.");
      return;
    }
    setAsDraft(draft);
    createSo.mutate(
      { ...buildBody(), status: draft ? "DRAFT" : "CONFIRMED" },
      {
        onSuccess: (res) => {
          setFlash(draft ? "Saved as draft" : "Sales order created");
          const docNo = (res as { docNo?: string } | undefined)?.docNo;
          if (docNo) navigate(`/scm/sales-orders/${docNo}`);
          else navigate("/scm/sales-orders");
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

  const submitting = createSo.isPending;

  return (
    <div className="pb-20">
      {/* Sticky form header */}
      <div className="sticky top-0 z-10 -mx-4 border-b border-border bg-bg/95 px-4 py-4 backdrop-blur-sm sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <button
              type="button"
              onClick={goList}
              aria-label="Back to Sales Orders"
              className="mt-0.5 inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[13px] font-semibold text-ink-secondary hover:border-primary/50 hover:text-primary"
            >
              <ArrowLeft size={14} /> Sales Orders
            </button>
            <div className="min-w-0">
              <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">
                {editDocNo ? "Edit Sales Order" : "New Sales Order"}
              </h1>
              <div className="mt-1 text-[12.5px] text-ink-muted">
                Draft · not yet saved
              </div>
            </div>
          </div>
          {/* Right actions — no-wrap */}
          <div className="flex flex-shrink-0 flex-nowrap items-center gap-2">
            <Button
              variant="ghost"
              icon={<XIcon size={14} />}
              onClick={goCancel}
              className="whitespace-nowrap"
            >
              Cancel
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
                : editDocNo
                  ? "Save changes"
                  : "Create Sales Order"}
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
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="mx-auto flex max-w-[1180px] flex-col gap-5 px-1 py-6 sm:px-3">
        {/* Customer */}
        <SectionCard title="Customer">
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
              <Label text="Email" required />
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
                options={[
                  { value: "Walk-in", label: "Walk-in" },
                  { value: "Corporate", label: "Corporate" },
                  { value: "Dealer", label: "Dealer" },
                ]}
              />
            </div>
            <div>
              <Label text="Salesperson" />
              <SelectInput
                value={salespersonId}
                onChange={setSalespersonId}
                placeholder="—"
                options={staffOptions}
              />
            </div>
          </div>
        </SectionCard>

        {/* Delivery address */}
        <SectionCard title="Delivery address">
          <AddressLaterCard
            checked={addrLater}
            onToggle={() => setAddrLater((v) => !v)}
          />
          <div className={cn("mt-4 flex flex-col gap-4", addrLater && "pointer-events-none opacity-45")}>
            <div>
              <Label text="Address line 1" />
              <TextInput
                value={addr1}
                onChange={setAddr1}
                placeholder="Unit, street, area"
                disabled={addrLater}
              />
            </div>
            <div>
              <Label text="Address line 2" />
              <TextInput
                value={addr2}
                onChange={setAddr2}
                placeholder="Apt, floor, building (optional)"
                disabled={addrLater}
              />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
              <div>
                <Label text="State" />
                <SelectInput
                  value={addrState}
                  onChange={setAddrState}
                  placeholder="Pick state"
                  options={MY_STATES.map((s) => ({ value: s, label: s }))}
                  disabled={addrLater}
                />
              </div>
              <div>
                <Label text="City" />
                <TextInput
                  value={city}
                  onChange={setCity}
                  placeholder="City"
                  disabled={addrLater}
                />
              </div>
              <div>
                <Label text="Postcode" />
                <TextInput
                  value={postcode}
                  onChange={setPostcode}
                  placeholder="Postcode"
                  disabled={addrLater}
                />
              </div>
              <div>
                <Label text="Country" />
                <TextInput
                  value={country}
                  onChange={setCountry}
                  disabled={addrLater}
                />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
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
                  disabled={addrLater}
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

        {/* Order info */}
        <SectionCard title="Order info">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
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
            <div>
              <Label text="Venue" />
              <SelectInput
                value={venue}
                onChange={setVenue}
                placeholder="—"
                options={[
                  { value: "Residence", label: "Residence" },
                  { value: "Office", label: "Office" },
                  { value: "Site", label: "Site" },
                ]}
              />
            </div>
            <div>
              <Label text="Processing date" />
              <TextInput
                value={processingDate}
                onChange={setProcessingDate}
                type="date"
              />
            </div>
            <div>
              <Label text="Delivery date" />
              <TextInput
                value={deliveryDate}
                onChange={setDeliveryDate}
                type="date"
              />
            </div>
          </div>
          <div className="mt-4">
            <Label text="Note" />
            <TextArea
              value={note}
              onChange={setNote}
              placeholder="Internal notes — visible on the SO detail page only"
            />
          </div>
        </SectionCard>

        {/* Line items */}
        <SectionCard
          title={`Line items · ${lines.length}`}
          actions={<span>Pick a product, set its variant, then price</span>}
        >
          <div className="hidden grid-cols-[24px_1fr_140px_60px_100px_112px_100px_28px] gap-2 border-b border-border-subtle pb-2 font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted sm:grid">
            <span>#</span>
            <span>Item &amp; variant</span>
            <span>Remarks</span>
            <span className="text-right">Qty</span>
            <span className="text-right">Price</span>
            <span>Delivery</span>
            <span className="text-right">Amount</span>
            <span></span>
          </div>

          {lines.map((line, i) => (
            <div
              key={line.id}
              className="border-b border-border-subtle py-3.5 last:border-b-0"
            >
              <div className="grid grid-cols-[24px_1fr_140px_60px_100px_112px_100px_28px] items-center gap-2">
                <span className="font-mono text-[12px] font-semibold text-ink-muted">
                  {i + 1}
                </span>
                <TextInput
                  value={line.itemCode || line.description}
                  onChange={(v) =>
                    updateLine(line.id, { itemCode: v, description: v })
                  }
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
                {/* Price cell — brass tinted so it's impossible to miss */}
                <input
                  type="number"
                  step="0.01"
                  value={line.priceRm}
                  onChange={(e) =>
                    updateLine(line.id, { priceRm: e.target.value })
                  }
                  className="h-10 w-full rounded-lg border px-3 text-right font-money text-[13.5px] font-bold text-accent-ink outline-none transition-colors"
                  style={{
                    background:
                      "color-mix(in srgb, var(--accent-soft, #f5ecd8) 55%, var(--surface, #fcfdfb))",
                    borderColor:
                      "color-mix(in srgb, var(--accent, #a16a2e) 45%, var(--border, #d6d9d2))",
                    boxShadow: "inset 0 0 0 1px rgba(161, 106, 46, 0.14)",
                  }}
                />
                <TextInput
                  value={line.deliveryDate}
                  onChange={(v) => updateLine(line.id, { deliveryDate: v })}
                  placeholder="dd/mm/yyyy"
                  type="date"
                />
                <span className="text-right font-money text-[13px] font-bold text-ink">
                  {fmtMoney(lineAmount(line))}
                </span>
                <button
                  type="button"
                  onClick={() => removeLine(line.id)}
                  aria-label="Delete line"
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-muted hover:bg-err-soft hover:text-err"
                >
                  <Trash2 size={15} />
                </button>
              </div>
              {/* Variant chip row */}
              <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-[32px]">
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
                    <Badge tone={brandTone(line.branding)} size="xs">
                      {line.branding}
                    </Badge>
                  </span>
                )}
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={addLine}
            className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-xl border-[1.5px] border-dashed border-border-strong bg-surface text-[13px] font-semibold text-primary-ink hover:border-primary/60 hover:bg-primary-soft"
          >
            <Plus size={14} /> Add Line Item
          </button>

          <div className="mt-4 flex items-baseline justify-end gap-3 border-t border-border-subtle pt-4">
            <span className="text-[13px] font-bold text-primary-ink">
              Subtotal:
            </span>
            <span className="font-money text-[20px] font-bold text-primary-ink">
              {fmtMoney(subtotalRm)}
            </span>
          </div>
        </SectionCard>

        {/* Payments */}
        <SectionCard
          title={`Payments · ${payments.length} transaction${payments.length === 1 ? "" : "s"}`}
          actions={
            <button
              type="button"
              onClick={addPayment}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-primary/40 bg-primary-soft px-3 text-[12px] font-semibold text-primary hover:bg-primary-soft/70"
            >
              <Plus size={12} /> Add Payment
            </button>
          }
        >
          {payments.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border-subtle bg-surface-2 px-6 py-8 text-center text-[12.5px] text-ink-muted">
              No payments recorded yet · click "Add Payment" to log a deposit
            </div>
          ) : (
            <>
              <div className="hidden grid-cols-[112px_140px_minmax(100px,0.9fr)_minmax(120px,1fr)_minmax(120px,1fr)_140px_28px] gap-3 border-b border-border-subtle pb-2 font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted sm:grid">
                <span>Date</span>
                <span>Method</span>
                <span className="text-right">Amount</span>
                <span>Account sheet</span>
                <span>Approval code</span>
                <span>Collected by</span>
                <span></span>
              </div>
              {payments.map((p) => (
                <div
                  key={p.id}
                  className="grid grid-cols-[112px_140px_minmax(100px,0.9fr)_minmax(120px,1fr)_minmax(120px,1fr)_140px_28px] items-center gap-3 border-b border-border-subtle py-2.5 last:border-b-0"
                >
                  <TextInput
                    value={p.paidAt}
                    onChange={(v) => updatePayment(p.id, { paidAt: v })}
                    type="date"
                  />
                  <SelectInput
                    value={p.method}
                    onChange={(v) =>
                      updatePayment(p.id, {
                        method: (v as PaymentDraft["method"]) || "Cash",
                      })
                    }
                    options={[
                      { value: "Cash", label: "Cash" },
                      { value: "Merchant", label: "Merchant" },
                      { value: "Online", label: "Online" },
                    ]}
                  />
                  <input
                    type="number"
                    step="0.01"
                    value={p.amountRm}
                    onChange={(e) =>
                      updatePayment(p.id, { amountRm: e.target.value })
                    }
                    className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-right font-money text-[13px] font-bold text-ink outline-none focus:border-primary"
                  />
                  <TextInput
                    value={p.accountSheet}
                    onChange={(v) => updatePayment(p.id, { accountSheet: v })}
                    placeholder="HC1341"
                  />
                  <TextInput
                    value={p.approvalCode}
                    onChange={(v) => updatePayment(p.id, { approvalCode: v })}
                    placeholder="123456"
                  />
                  <SelectInput
                    value={p.collectedByStaffId}
                    onChange={(v) =>
                      updatePayment(p.id, { collectedByStaffId: v })
                    }
                    placeholder="—"
                    options={staffOptions}
                  />
                  <button
                    type="button"
                    onClick={() => removePayment(p.id)}
                    aria-label="Delete payment"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-muted hover:bg-err-soft hover:text-err"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </>
          )}

          <div className="mt-4 flex flex-col items-end gap-1.5 border-t border-border-subtle pt-4">
            <div className="flex items-baseline gap-4">
              <span className="text-[12px] text-ink-muted">Deposit paid</span>
              <span className="min-w-[140px] text-right font-money text-[13.5px] font-bold text-ink">
                {fmtMoney(depositRm)}
              </span>
            </div>
            <div className="flex items-baseline gap-4">
              <span className="text-[12px] text-ink-muted">Balance</span>
              <span className="min-w-[140px] text-right font-money text-[13.5px] font-bold text-err">
                {fmtMoney(balanceRm)}
              </span>
            </div>
            <div className="text-[10.5px] italic text-ink-muted">
              Balance = Subtotal × 1.06 (SST 6%) − Deposit
            </div>
          </div>
        </SectionCard>

        {/* Bottom action strip — mirrors sticky header, useful on tall forms */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <div className="text-[11.5px] text-ink-muted">
            {lines.length} line{lines.length === 1 ? "" : "s"} · Subtotal{" "}
            <span className="font-money font-semibold text-ink">
              {fmtMoney(subtotalRm)}
            </span>
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
              {editDocNo ? "Save changes" : "Create Sales Order"}
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

      {/* Flash toast */}
      {flash && (
        <div className="fixed bottom-6 left-1/2 z-[100] -translate-x-1/2 rounded-lg bg-sidebar px-4 py-2.5 text-[13px] font-semibold text-white shadow-slab">
          {flash}
        </div>
      )}
    </div>
  );
}

export default SalesOrderNewV2;
