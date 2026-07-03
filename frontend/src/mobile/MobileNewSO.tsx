import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { uploadSlipFull } from "../vendor/scm/lib/slip";
import { useStaff } from "../vendor/scm/lib/admin-queries";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import type { ExtractedSlip } from "../vendor/scm/components/ScanOrderModal";
import type { MobileScanPrefill } from "./MobileScan";
import { MobileSkuPicker, type PickedSku } from "./MobileSkuPicker";
import {
  useMaintenanceConfig,
  useSpecialAddons,
  useModelAllowedOptionsByCode,
  type MaintenanceConfig,
  type ModelAllowedOptions,
} from "../vendor/scm/lib/mfg-products-queries";
import { useFabricColoursActive, type FabricColourRow } from "../vendor/scm/lib/fabric-queries";
import { useFabricLibrary } from "../vendor/scm/lib/queries";
import { activeOptions, maintPickerValues } from "../vendor/shared/maintenance-pools";
import { missingVariantAxes } from "../vendor/shared/so-variant-rule";
import "./mobile.css";

/* ---------------------------------------------------------------------------
 * MobileNewSO — mobile New / Edit Sales Order as the Spec's 5-STEP WIZARD
 * (Build Spec §"New / Edit Sales Order"): 1 Customer · 2 Order info · 3 Items ·
 * 4 Payment · 5 Review, with a "Step N of 5" progress bar and step-gated
 * validation. Presentation stays under the .hz-m scope with the design's card /
 * field / button classes from mobile.css.
 *
 * WIRED TO THE REAL BACKEND (unchanged contract from the prior build):
 *   • CREATE  POST  /mfg-sales-orders            (new / edit-draft) → { docNo }
 *   • EDIT    PATCH /mfg-sales-orders/:docNo      (header fields only)
 *   • ITEMS   POST/PATCH/DELETE /mfg-sales-orders/:docNo/items
 *   • PREFILL GET   /mfg-sales-orders/:docNo      (header + items)
 *             GET   /mfg-sales-orders/:docNo/payments
 *   • PAY     POST  /mfg-sales-orders/:docNo/payments (slip-backed rows)
 * The backend recomputes honest pricing and mints the doc_no server-side, so we
 * never send a doc_no and money crosses the wire as *_centi integers.
 *
 * CATEGORY-AWARE LINE VARIANTS — wired to the SAME real hooks the desktop
 * SoLineCard uses (NOT hardcoded arrays). This is the fix the owner asked for:
 *   • Fabrics  ← useFabricColoursActive()  (GET /fabric-colours) + fabric_library
 *               series label via useFabricLibrary() (GET /fabric-library)
 *   • Sofa     Seat height ← maintenanceConfig.sofaSizes
 *              Leg height  ← maintenanceConfig.sofaLegHeights
 *   • Bedframe Gap   ← maintenanceConfig.gaps
 *              Divan ← maintenanceConfig.divanHeights
 *              Leg   ← maintenanceConfig.legHeights
 *              Total height = divan + leg + gap inches (computed, read-only)
 * The maintenance pools come from useMaintenanceConfig('master') (GET
 * /maintenance-config/resolved). Per-SKU allowed_options (Modular ON/OFF) filter
 * every pool via useModelAllowedOptionsByCode, exactly as SoLineCard does. The
 * REQUIRED axes per category are the shared so-variant-rule (sofa: seatHeight +
 * legHeight + fabricCode; bedframe: divanHeight + legHeight + gap + fabricCode);
 * mattress / accessory / others carry NO mandatory variants — the same rule the
 * server 409-gates on. Save is blocked when any line is missing a required axis.
 * ------------------------------------------------------------------------- */

type Mode = "new" | "edit" | "edit-draft";

/* Per-line scan meta — the verbatim slip row, the SKU Claude suggested + its
   confidence, and the itemCode the scan seeded. Keyed by the seeded line's
   `key` so the on-save learning POST can pair the operator's final line against
   the AI original. */
type ScanLineMetaSeed = { rawText: string; suggestedCode: string; confidence: number; seededCode: string; seededName: string };

/* Line category — drives which variant panel shows (matches the desktop
   SoLineCard). Only sofa/bedframe have mandatory variant panels; every other
   group (mattress/accessory/others) is a plain line. */
type LineCat = "" | "sofa" | "bedframe" | "mattress";

type LineItem = {
  key: string;
  // Catalog identity — set by the SKU picker. itemCode drives the backend's
  // honest-pricing recompute + inventory linkage; a blank code is an unpicked
  // line (blocked at save). itemGroup is the lowercase catalog category the
  // backend variant rule reads (sofa/bedframe/mattress/accessory/others).
  itemCode: string;
  itemGroup: string;
  // In edit mode, the persisted mfg_sales_order_items.id (blank = a line the
  // operator added this session → POST on save).
  itemId: string;
  name: string;
  qty: string;
  price: string; // RM, as typed (e.g. "1,450.00") — display/default only; server recomputes
  ddate: string; // per-line delivery date (ISO yyyy-mm-dd)
  remark: string;
  photo: boolean; // per-line delivery/reference photo captured (display-only)
  cat: LineCat;
  /* variants — the canonical variant blob, SAME keys the desktop SoLineCard /
     POST /mfg-sales-orders write. A fabric pick lands fabricCode + colourId +
     fabricId + labels together; sofa fills seatHeight + legHeight; bedframe
     fills divanHeight + legHeight + gap (+ totalHeight computed). We keep this
     as ONE map (not scattered flat fields) so the create/edit body + the
     required-axis rule read the exact structure the server expects. */
  variants: Record<string, unknown>;
};

type Payment = {
  key: string;
  method: string; // Cash / Merchant / Online / Installment
  date: string;
  amount: string; // RM as typed
  account: string; // account sheet ref
  approval: string; // approval code
  collectedBy: string; // staff.id (uuid) | ""
  // Method-aware sub-fields
  bank: string; // Merchant provider
  plan: string; // Merchant / Installment plan
  online: string; // Online sub-type
  // Slip capture — a row is only RECORDED (POSTed after create) once it has an
  // uploaded slip session; a slip-less row stays a display-only "planned" row.
  slipName: string; // captured file name (display only)
  slipSession: string; // uploadSessionId once the slip finishes uploading
  slipPhase: "" | "uploading" | "done" | "error"; // upload lifecycle for the row UI
};

// Existing (prefill) shapes — raw snake_case columns from the detail endpoints.
type SoHeader = {
  doc_no: string;
  debtor_name: string | null;
  status: string | null;
  phone: string | null;
  email: string | null;
  ref: string | null;
  customer_so_no: string | null;
  customer_type: string | null;
  building_type: string | null;
  venue: string | null;
  note: string | null;
  address1: string | null;
  address2: string | null;
  customer_state: string | null;
  city: string | null;
  postcode: string | null;
  internal_expected_dd: string | null;
  customer_delivery_date: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
};
type SoItem = {
  id: string;
  description: string | null;
  item_code: string | null;
  item_group: string | null;
  qty: number | null;
  unit_price_centi: number | null;
  discount_centi: number | null;
  line_delivery_date: string | null;
  remark: string | null;
  variants: Record<string, unknown> | null;
  cancelled: boolean | null;
};
/* has_children / status ride on the header (stamped by GET /:docNo) so the
   edit form can lock line mutations once the SO is SHIPPED+ or has a
   downstream DO/SI, mirroring the desktop SO Detail lock rules. */
type DetailResp = { salesOrder: SoHeader & { has_children?: boolean | null; status?: string | null }; items: SoItem[] };
type SoPayment = {
  id: string;
  paid_at: string | null;
  method: string | null;
  amount_centi: number | null;
  approval_code: string | null;
  account_sheet: string | null;
  collected_by_name: string | null;
};
type PaymentsResp = { payments: SoPayment[] };

const CUSTOMER_TYPES = ["", "Walk-in", "Repeat", "Dealer", "Designer"];
const BUILDING_TYPES = ["", "Landed", "Condominium", "Apartment", "Office", "Commercial"];
const RELATIONSHIPS = ["", "Spouse", "Parent", "Sibling", "Friend", "Colleague"];
const STATES = ["", "Selangor", "Kuala Lumpur", "Penang", "Johor", "Melaka", "Perak", "Negeri Sembilan", "Kedah", "Pahang", "Sabah", "Sarawak"];
const PAY_METHODS = ["Cash", "Merchant", "Online", "Installment"];
const LINE_CATS: Array<{ value: LineCat; label: string }> = [
  { value: "", label: "General item" },
  { value: "sofa", label: "Sofa" },
  { value: "bedframe", label: "Bedframe" },
  { value: "mattress", label: "Mattress" },
];
/* Payment method-aware sub-field option lists. These are payment-terminal /
   merchant metadata (bank names, installment plans, online rails), NOT product
   variants — they have no product-config table, so they stay literal here.
   (Only the product VARIANT lists were hardcoded-in-error; those now come from
   the real Maintenance / fabric hooks.) */
const BANK_OPTS = ["Maybank", "CIMB", "Public Bank", "HSBC", "RHB"];
const PLAN_OPTS = ["One Shot", "6 months", "12 months", "24 months", "36 months"];
const ONLINE_OPTS = ["Bank Transfer", "TNG eWallet", "DuitNow", "Cheque"];

const uid = () => Math.random().toString(36).slice(2, 10);
const num = (s: string) => parseFloat(String(s).replace(/,/g, "")) || 0;
const toCenti = (s: string) => Math.round(num(s) * 100);
const fromCenti = (c: number | null | undefined) =>
  ((c ?? 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (n: number) => n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/* Inches parser — mirrors SoLineCard.parseInches (handles `10"`, `10`, `-2`). */
const parseInches = (s: unknown): number => {
  if (s == null) return 0;
  const m = String(s).match(/(-?\d+(?:\.\d+)?)/);
  return m && m[1] ? Number(m[1]) : 0;
};

function newLine(): LineItem {
  return {
    key: uid(), itemCode: "", itemGroup: "", itemId: "",
    name: "", qty: "1", price: "0.00", ddate: "", remark: "", photo: false, cat: "",
    variants: {},
  };
}

/* item_group (catalog category, lowercase) → the line's `cat` axis, which
   drives the sofa/bedframe/mattress panels. sofa/bedframe have mandatory
   variant panels; mattress shows an info note (no required axes); everything
   else (accessory/others/service) is a plain line. */
function catForGroup(group: string | null | undefined): LineCat {
  const g = (group ?? "").toLowerCase();
  return g === "sofa" ? "sofa" : g === "bedframe" ? "bedframe" : g === "mattress" ? "mattress" : "";
}

/* Build a line's outgoing `variants` blob for the create/edit body. The blob is
   already the canonical shape (kept live in LineItem.variants via the variant
   pickers), so we just fold in the remark + a fresh computed totalHeight for
   bedframes. Mirrors the desktop SoLineCard writes: bedframe carries
   divanHeight/legHeight/gap/fabricCode(+colourId/fabricId/labels)/totalHeight;
   sofa carries seatHeight/legHeight/fabricCode(+…). remark also rides the
   dedicated column. */
function buildVariants(l: LineItem): Record<string, unknown> {
  const variants: Record<string, unknown> = { ...(l.variants ?? {}) };
  if (l.remark.trim()) variants.remark = l.remark.trim();
  else delete variants.remark;
  if (l.cat === "bedframe") {
    const th = parseInches(variants.divanHeight) + parseInches(variants.legHeight) + parseInches(variants.gap);
    if (th > 0) variants.totalHeight = `${th}"`;
  }
  return variants;
}

/* Map a persisted SoItem (edit prefill) back into an editable LineItem. The
   variants blob is a free-form JSON column (NOT driver-camelCased), so we carry
   it through verbatim — the variant pickers below read the canonical keys off
   it. remark falls back from the dedicated column to variants.remark. */
function lineFromItem(it: SoItem): LineItem {
  const base = newLine();
  const v = { ...((it.variants ?? {}) as Record<string, unknown>) };
  const cat = catForGroup(it.item_group);
  return {
    ...base,
    itemId: it.id,
    itemCode: it.item_code ?? "",
    itemGroup: (it.item_group ?? "").toLowerCase(),
    name: it.description ?? it.item_code ?? "",
    qty: String(it.qty ?? 1),
    price: fromCenti(it.unit_price_centi),
    ddate: (it.line_delivery_date ?? "").slice(0, 10),
    remark: it.remark ?? (typeof v.remark === "string" ? v.remark : ""),
    cat,
    variants: v,
  };
}
function newPayment(): Payment {
  const today = new Date().toISOString().slice(0, 10);
  return {
    key: uid(), method: "Cash", date: today, amount: "0.00", account: "", approval: "", collectedBy: "",
    bank: BANK_OPTS[0], plan: PLAN_OPTS[0], online: ONLINE_OPTS[0],
    slipName: "", slipSession: "", slipPhase: "",
  };
}

// Payment-row method label → backend enum (transfer surfaces as "Online").
const PAY_METHOD_CODE: Record<string, "cash" | "transfer" | "merchant" | "installment"> = {
  Cash: "cash", Online: "transfer", Merchant: "merchant", Installment: "installment",
};
// 'One Shot' → null (no installment term); 'N months' → N.
const planToMonths = (label: string): number | null => {
  const m = /^(\d+)\s*month/i.exec(String(label).trim());
  return m ? Number(m[1]) : null;
};

/* ── Variant option pools (REAL hooks) — resolved once in MobileNewSO and
   threaded to each LineCard. Each pool is { value, label } for a plain <select>.
   fabricColours + fabricLib feed the multi-key fabric patch. */
type Opt = { value: string; label: string };
type VariantPools = {
  ready: boolean; // maintenance config loaded (pools meaningful)
  fabricColours: FabricColourRow[];
  fabricSeries: Map<string, string>; // fabricId → series label
  maint: MaintenanceConfig | null;
};

/* Wizard steps. */
const STEPS = ["Customer", "Order info", "Items", "Payment", "Review"] as const;

/* Method label → the backend's payment method enum (merchant | transfer | cash
 * | installment). Kept here for reference; payment ROWS are not POSTed on
 * create (each needs an uploaded slip session — see recordSlipBackedPayments),
 * so this map is applied only when the slip-upload flow is wired. */
export function MobileNewSO({
  mode,
  docNo,
  scanPrefill,
  onBack,
  onSaved,
}: {
  mode: Mode;
  docNo?: string;
  /* Scan handoff (from MobileScan) — the extracted slip mapped to this form's
     shape. Present only for a new SO opened from a scan; seeds every field on
     mount and drives the on-save learning POST. */
  scanPrefill?: MobileScanPrefill;
  onBack: () => void;
  onSaved?: (docNo: string) => void;
}) {
  const qc = useQueryClient();
  const notify = useNotify();
  const confirm = useConfirm();
  const staffQ = useStaff();
  const isEdit = mode === "edit" || mode === "edit-draft";

  /* ── Real variant sources (the fix) ─────────────────────────────────────
     The SAME hooks the desktop SoLineCard reads. Maintenance config supplies
     the sofa/bedframe height + gap pools; fabric_colours + fabric_library
     supply the Fabrics dropdown; special-addons is fetched so the pool is warm
     for the required-axis parity (specials are optional, not gated here). */
  const maintQ = useMaintenanceConfig("master");
  const maint = maintQ.data?.data ?? null;
  const fabricColoursQ = useFabricColoursActive();
  const fabricLibQ = useFabricLibrary();
  useSpecialAddons(); // warm the pool (SoLineCard reads it; mobile keeps specials optional)

  const pools: VariantPools = useMemo(() => {
    const fabricSeries = new Map<string, string>();
    for (const f of fabricLibQ.data ?? []) fabricSeries.set(f.id, f.label);
    return {
      ready: Boolean(maint),
      fabricColours: fabricColoursQ.data ?? [],
      fabricSeries,
      maint,
    };
  }, [maint, fabricColoursQ.data, fabricLibQ.data]);

  /* One-shot seed derived from the scan handoff (new-from-scan only). Fields the
     mobile form binds to a fixed dropdown list (State / Customer Type / Building
     Type / payment method) only seed when the scanned value is IN that list —
     an off-list value is left blank for the operator to pick (never a bogus
     option). Everything else (free-text) seeds verbatim. */
  const scanLines: Array<{ line: LineItem; meta: ScanLineMetaSeed }> = (scanPrefill?.lines ?? []).map((l) => {
    const line: LineItem = { ...newLine(), name: l.name, qty: l.qty || "1", price: l.price || "0.00", remark: l.remark };
    return { line, meta: { rawText: l.rawText, suggestedCode: l.suggestedCode, confidence: l.confidence, seededCode: l.itemCode, seededName: l.name } };
  });
  const seededLineMeta: Record<string, ScanLineMetaSeed> = {};
  for (const { line, meta } of scanLines) seededLineMeta[line.key] = meta;
  const inList = (v: string, list: string[]) => (list.includes(v) ? v : "");

  /* Seed ONE payment row per captured payment slip (scanPrefill.payments[]),
     each carrying its OCR'd method/amount/approval. */
  const scanPaymentSlips = scanPrefill?.payments ?? [];
  const scanSlipFilesInit: Record<string, File> = {};
  const seededPays: Payment[] = scanPaymentSlips.length
    ? scanPaymentSlips.map((ps) => {
        const row: Payment = {
          ...newPayment(),
          method: inList(ps.method, PAY_METHODS),
          amount: ps.amount || "0.00",
          approval: ps.approval ?? "",
          slipName: ps.file.name,
          slipPhase: "uploading",
        };
        scanSlipFilesInit[row.key] = ps.file;
        return row;
      })
    : scanPrefill?.payment
      ? [{ ...newPayment(), method: inList(scanPrefill.payment.method, PAY_METHODS), amount: scanPrefill.payment.amount || "0.00", approval: scanPrefill.payment.approval ?? "" }]
      : [];

  // Customer
  const [name, setName] = useState(scanPrefill?.name ?? "");
  const [custRef, setCustRef] = useState(scanPrefill?.custRef ?? "");
  const [phone, setPhone] = useState(scanPrefill?.phone ?? "");
  const [email, setEmail] = useState("");
  const [custType, setCustType] = useState(inList(scanPrefill?.customerType ?? "", CUSTOMER_TYPES));
  // Salesperson (staff.id). Blank = the backend stamps the logged-in caller.
  const [salespersonId, setSalespersonId] = useState(scanPrefill?.salesperson ?? "");

  // Order info
  const [buildingType, setBuildingType] = useState(inList(scanPrefill?.buildingType ?? "", BUILDING_TYPES));
  const [venue, setVenue] = useState(scanPrefill?.venue ?? "");
  const [procDate, setProcDate] = useState(scanPrefill?.processingDate ?? "");
  const [delivDate, setDelivDate] = useState(scanPrefill?.deliveryDate ?? "");
  const [note, setNote] = useState(scanPrefill?.note ?? "");

  // Emergency contact — the slip's SECOND phone goes to the emergency contact.
  const [ecName, setEcName] = useState("");
  const [ecRel, setEcRel] = useState("");
  const [ecPhone, setEcPhone] = useState(scanPrefill?.emergencyPhone ?? "");

  // Delivery address
  const [addressLater, setAddressLater] = useState(false);
  const [addr1, setAddr1] = useState(scanPrefill?.address1 ?? "");
  const [addr2, setAddr2] = useState("");
  const [state, setState] = useState(inList(scanPrefill?.state ?? "", STATES));
  const [city, setCity] = useState(scanPrefill?.city ?? "");
  const [postcode, setPostcode] = useState(scanPrefill?.postcode ?? "");

  // Lines + payments
  const [lines, setLines] = useState<LineItem[]>(() =>
    scanLines.length > 0 ? scanLines.map((s) => s.line) : [newLine()],
  );
  const [pays, setPays] = useState<Payment[]>(() => seededPays);
  const scanSlipFilesRef = useRef<Record<string, File>>(scanSlipFilesInit);
  // In edit mode: the ORIGINAL persisted items (frozen snapshot) used to diff
  // against the editable `lines` on save — POST added, PATCH changed, DELETE
  // removed. Payments stay read-only here (own screen).
  const [origItems, setOrigItems] = useState<SoItem[]>([]);
  const [existingPays, setExistingPays] = useState<SoPayment[]>([]);
  const [lineLocked, setLineLocked] = useState(false);
  // SKU picker sheet — the line key it was opened for, or null when closed.
  const [pickerFor, setPickerFor] = useState<string | null>(null);

  // Wizard step (0..4). Edit mode still walks the same 5 steps.
  const [step, setStep] = useState(0);

  const [loading, setLoading] = useState(isEdit);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  /* ── Scan-Order review state (scanPrefill only) ───────────────────────── */
  const [scanSampleId] = useState<string | null>(scanPrefill?.sampleId ?? null);
  const [scanSalesperson] = useState<string | null>(scanPrefill?.salesperson ?? null);
  const [scanAiOriginal] = useState<ExtractedSlip | null>(scanPrefill?.aiOriginal ?? null);
  type ScanBaseline = {
    name?: string; custRef?: string; phone?: string;
    custType?: string; buildingType?: string; venue?: string; note?: string;
    procDate?: string; delivDate?: string;
    addr1?: string; state?: string; city?: string; postcode?: string;
  };
  const [scanBaseline] = useState<ScanBaseline | null>(
    scanPrefill
      ? {
          name: scanPrefill.name, custRef: scanPrefill.custRef, phone: scanPrefill.phone,
          custType: custType, buildingType: buildingType,
          venue: scanPrefill.venue, note: scanPrefill.note,
          procDate: scanPrefill.processingDate, delivDate: scanPrefill.deliveryDate,
          addr1: scanPrefill.address1, state: state,
          city: scanPrefill.city, postcode: scanPrefill.postcode,
        }
      : null,
  );
  const [scanLineMeta] = useState<Record<string, ScanLineMetaSeed>>(seededLineMeta);
  const fromScan = !!scanPrefill;

  // ---- Prefill (edit / edit-draft) -----------------------------------------
  useEffect(() => {
    if (!isEdit || !docNo) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [detail, payResp] = await Promise.all([
          authedFetch<DetailResp>(`/mfg-sales-orders/${encodeURIComponent(docNo)}`),
          authedFetch<PaymentsResp>(`/mfg-sales-orders/${encodeURIComponent(docNo)}/payments`).catch(() => ({ payments: [] })),
        ]);
        if (cancelled) return;
        const h = detail.salesOrder;
        setName(h.debtor_name ?? "");
        setCustRef(h.customer_so_no ?? h.ref ?? "");
        setPhone(stripPrefix(h.phone));
        setEmail(h.email ?? "");
        setCustType(h.customer_type ?? "");
        setBuildingType(h.building_type ?? "");
        setVenue(h.venue ?? "");
        setProcDate((h.internal_expected_dd ?? "").slice(0, 10));
        setDelivDate((h.customer_delivery_date ?? "").slice(0, 10));
        setNote(h.note ?? "");
        setEcName(h.emergency_contact_name ?? "");
        setEcRel(h.emergency_contact_relationship ?? "");
        setEcPhone(stripPrefix(h.emergency_contact_phone));
        setAddr1(h.address1 ?? "");
        setAddr2(h.address2 ?? "");
        setState(h.customer_state ?? "");
        setCity(h.city ?? "");
        setPostcode(h.postcode ?? "");
        const liveItems = (detail.items ?? []).filter((it) => !it.cancelled);
        setOrigItems(liveItems);
        const editable = liveItems.map(lineFromItem);
        setLines(editable.length ? editable : [newLine()]);
        setExistingPays(payResp.payments ?? []);
        const st = (detail.salesOrder.status ?? "").toUpperCase();
        const LOCKED = ["SHIPPED", "DELIVERED", "INVOICED", "CLOSED", "CANCELLED"];
        setLineLocked(LOCKED.includes(st) || Boolean(detail.salesOrder.has_children));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load this order.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isEdit, docNo]);

  /* ── Pre-upload scan-seeded payment slips (new-from-scan only) ─────────── */
  useEffect(() => {
    const files = scanSlipFilesRef.current;
    const keys = Object.keys(files);
    if (keys.length === 0) return;
    scanSlipFilesRef.current = {}; // consume once — guard against re-runs
    let cancelled = false;
    for (const key of keys) {
      const file = files[key];
      void (async () => {
        try {
          const { uploadSessionId } = await uploadSlipFull({ file });
          if (cancelled) return;
          setPays((prev) => prev.map((p) => (p.key === key ? { ...p, slipSession: uploadSessionId, slipPhase: "done" } : p)));
        } catch {
          if (cancelled) return;
          setPays((prev) => prev.map((p) => (p.key === key ? { ...p, slipPhase: "error" } : p)));
        }
      })();
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Totals ---------------------------------------------------------------
  const subtotal = useMemo(
    () => lines.reduce((a, l) => a + toCenti(l.price) * num(l.qty), 0),
    [lines],
  );

  const title = mode === "edit-draft" ? "Edit Draft" : mode === "edit" ? "Edit Sales Order" : "New Sales Order";

  // ---- Validation -----------------------------------------------------------
  const emailOk = !email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const nameErr = !name.trim();
  const phoneErr = !phone.trim();
  const emailErr = !email.trim() || !emailOk;
  const dateXorErr = Boolean(procDate) !== Boolean(delivDate); // set together or both empty

  /* Lines that carry identity (a picked SKU or a typed name). */
  const namedLines = useMemo(() => lines.filter((l) => l.name.trim() || l.itemCode.trim()), [lines]);
  const unpickedLines = useMemo(() => namedLines.filter((l) => !l.itemCode.trim()), [namedLines]);
  /* Required-variant gate (shared so-variant-rule = server 409 parity). A line
     with a picked SKU whose category has mandatory axes must fill them all. */
  const linesMissingVariants = useMemo(
    () => namedLines.filter((l) => l.itemCode.trim() && missingVariantAxes(l.itemGroup, l.variants).length > 0),
    [namedLines],
  );

  /* Per-step "can advance" gate. Step 4 (Review, index 4) is terminal. */
  const stepValid = (s: number): boolean => {
    if (s === 0) return !nameErr && !phoneErr && !emailErr;
    if (s === 1) return mode === "edit-draft" ? true : !dateXorErr;
    if (s === 2) return namedLines.length >= 1 && unpickedLines.length === 0 && linesMissingVariants.length === 0;
    return true; // payment (3) + review (4) impose no gate
  };
  const stepError = (s: number): string | null => {
    if (s === 0 && !stepValid(0)) return "Fill in customer name, phone and a valid email.";
    if (s === 1 && !stepValid(1)) return "Processing Date and Delivery Date must be set together, or both left empty.";
    if (s === 2) {
      if (namedLines.length < 1) return "Add at least one line item.";
      if (unpickedLines.length > 0) return `Pick a product from the catalog for every line (${unpickedLines.length} still unpicked).`;
      if (linesMissingVariants.length > 0) {
        const l = linesMissingVariants[0];
        const miss = missingVariantAxes(l.itemGroup, l.variants).map((a) => a.label).join(", ");
        return `Complete the required options (${miss}) on "${l.name || l.itemCode}".`;
      }
    }
    return null;
  };

  const goNext = () => {
    setTouched(true);
    const e = stepError(step);
    if (e) { setError(e); return; }
    setError(null);
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  };
  const goBack = () => { setError(null); setStep((s) => Math.max(0, s - 1)); };

  /* Scanned hint — a field the scan filled shows a subtle "scanned" tag until
     the operator changes it. */
  const scanned = (key: keyof ScanBaseline, current: string): boolean => {
    if (!scanBaseline) return false;
    const base = scanBaseline[key];
    if (base === undefined || base === "") return false;
    return current === base;
  };

  /* ── Edit-gate learning (scan-seeded SO only) ────────────────────────── */
  const maybeLearnFromScan = () => {
    if (!fromScan || !scanSampleId || !scanAiOriginal) return;
    const ai = scanAiOriginal;
    const optMatch = (v: string) => (v ? { value: v, confidence: 1, reason: "operator-confirmed" } : null);
    const norm = (s: string | null | undefined) => (s ?? "").trim();
    const digits = (s: string) => s.replace(/\D+/g, "");
    const aiFirstPhoneDigits = digits(ai.phones?.[0] ?? "");
    const finalLines = lines.filter((l) => l.name.trim());

    let changed = false;
    const mark = (a: string, b: string) => { if (a !== b) changed = true; };
    mark(norm(name), norm(ai.customerName));
    mark(digits(phone), aiFirstPhoneDigits.replace(/^60/, "").replace(/^0/, ""));
    mark(norm(addr1), norm(ai.addressLine1 ?? ai.address));
    mark(norm(state), norm(ai.addressStateMatch?.value));
    mark(norm(city), norm(ai.city));
    mark(norm(postcode), norm(ai.postcode));
    mark(norm(custRef), norm(ai.customerSoRef));
    mark(norm(custType), norm(ai.customerTypeMatch?.value));
    mark(norm(buildingType), norm(ai.buildingTypeMatch?.value));
    mark(norm(pays[0]?.method), norm(ai.paymentMethodMatch?.value === "Installment" ? "Merchant" : ai.paymentMethodMatch?.value));
    if (finalLines.length !== ai.lines.length) changed = true;
    for (const l of finalLines) {
      const meta = scanLineMeta[l.key];
      if (!meta || norm(l.name) !== norm(meta.seededName)) changed = true;
    }

    if (!changed) return;

    const corrected: ExtractedSlip = {
      customerName: name.trim() || null,
      address: addr1.trim() || null,
      addressLine1: addr1.trim() || null,
      city: city.trim() || null,
      postcode: postcode.trim() || null,
      addressStateMatch: optMatch(state),
      phones: phone.trim() ? ["+60" + phone.replace(/\s+/g, "")] : ai.phones,
      location: ai.location,
      deliveryDate: delivDate || ai.deliveryDate,
      processingDate: procDate || ai.processingDate,
      salesRep: scanSalesperson || ai.salesRep,
      customerSoRef: custRef.trim() || ai.customerSoRef,
      paymentMethod: ai.paymentMethod,
      depositRm: ai.depositRm,
      totalRm: ai.totalRm,
      remarks: note.trim() || ai.remarks,
      approvalCode: pays[0]?.approval || ai.approvalCode,
      paymentMethodMatch: optMatch(pays[0]?.method ?? "") ?? ai.paymentMethodMatch,
      bankMatch: ai.bankMatch,
      onlineTypeMatch: ai.onlineTypeMatch,
      installmentPlanMatch: ai.installmentPlanMatch,
      customerTypeMatch: optMatch(custType),
      buildingTypeMatch: optMatch(buildingType),
      locationMatch: ai.locationMatch,
      lines: finalLines.map((l) => {
        const meta = scanLineMeta[l.key];
        return {
          rawText: meta?.rawText || l.name,
          qtyGuess: num(l.qty) || 1,
          priceRmGuess: toCenti(l.price) > 0 ? toCenti(l.price) / 100 : null,
          skuMatch: null,
          fabricMatch: null,
          specialsMatch: [],
          notes: l.name.trim() || null,
        };
      }),
    };

    void authedFetch(`/scan-so/samples/${scanSampleId}/confirm`, {
      method: "POST",
      body: JSON.stringify({ corrected, salesperson: scanSalesperson || null }),
    }).catch(() => { /* few-shot learning is best-effort — never blocks save */ });
  };

  /* Post-create payment recording — records each SLIP-BACKED row AFTER the SO
     exists, through the same POST /:docNo/payments the SO-detail screen uses. */
  async function recordSlipBackedPayments(createdDocNo: string) {
    const rows = pays.filter((p) => p.slipSession && toCenti(p.amount) > 0);
    if (rows.length === 0) return;
    let failed = 0;
    for (const p of rows) {
      const code = PAY_METHOD_CODE[p.method] ?? "cash";
      const body: Record<string, unknown> = {
        paidAt: p.date,
        method: code,
        amountCenti: toCenti(p.amount),
        accountSheet: p.account.trim() || null,
        approvalCode: p.approval.trim() || null,
        collectedBy: p.collectedBy || null,
        uploadSessionId: p.slipSession,
      };
      if (code === "merchant") { body.merchantProvider = p.bank || null; body.installmentMonths = planToMonths(p.plan); }
      else if (code === "installment") { body.installmentMonths = planToMonths(p.plan); }
      else if (code === "transfer") { body.onlineType = p.online || null; }
      try {
        await authedFetch(`/mfg-sales-orders/${encodeURIComponent(createdDocNo)}/payments`, {
          method: "POST", body: JSON.stringify(body),
        });
      } catch {
        failed += 1;
      }
    }
    if (failed > 0) {
      void notify({ title: "Some payments weren't recorded", body: `${failed} of ${rows.length} payment slip(s) failed to post. Record them again from the SO detail screen.`, tone: "error" });
    }
  }

  /* Line-item body for POST /:docNo/items and the create body's items[]. */
  const itemBody = (l: LineItem): Record<string, unknown> => ({
    itemCode: l.itemCode,
    itemGroup: l.itemGroup || "others",
    description: l.name.trim(),
    qty: num(l.qty) || 1,
    unitPriceCenti: toCenti(l.price),
    lineDeliveryDate: l.ddate || null,
    ...(Object.keys(buildVariants(l)).length ? { variants: buildVariants(l) } : {}),
  });

  /* PATCH body for an existing line. */
  const itemPatchBody = (l: LineItem): Record<string, unknown> => ({
    itemCode: l.itemCode,
    itemGroup: l.itemGroup || "others",
    description: l.name.trim(),
    qty: num(l.qty) || 1,
    unitPriceCenti: toCenti(l.price),
    lineDeliveryDate: l.ddate || null,
    variants: buildVariants(l),
  });

  const canonJson = (o: unknown): string => {
    if (o == null) return "null";
    if (typeof o !== "object") return JSON.stringify(o);
    if (Array.isArray(o)) return "[" + o.map(canonJson).join(",") + "]";
    return "{" + Object.keys(o as Record<string, unknown>).sort()
      .map((k) => JSON.stringify(k) + ":" + canonJson((o as Record<string, unknown>)[k]))
      .join(",") + "}";
  };
  const lineChanged = (l: LineItem, snap: SoItem): boolean => {
    if (l.itemCode !== (snap.item_code ?? "")) return true;
    if ((l.itemGroup || "others") !== ((snap.item_group ?? "others").toLowerCase())) return true;
    if ((num(l.qty) || 1) !== (snap.qty ?? 1)) return true;
    if (toCenti(l.price) !== (snap.unit_price_centi ?? 0)) return true;
    if (l.name.trim() !== (snap.description ?? "").trim()) return true;
    if ((l.ddate || "") !== ((snap.line_delivery_date ?? "").slice(0, 10))) return true;
    if (canonJson(buildVariants(l)) !== canonJson(snap.variants ?? {})) return true;
    return false;
  };

  async function applyLineDiff(soDocNo: string): Promise<number> {
    const base = `/mfg-sales-orders/${encodeURIComponent(soDocNo)}/items`;
    let failed = 0;
    const liveIds = new Set(lines.map((l) => l.itemId).filter(Boolean));
    for (const snap of origItems) {
      if (liveIds.has(snap.id)) continue;
      try { await authedFetch(`${base}/${encodeURIComponent(snap.id)}`, { method: "DELETE" }); }
      catch { failed += 1; }
    }
    const snapById = new Map(origItems.map((s) => [s.id, s]));
    for (const l of lines) {
      if (!l.itemCode.trim()) continue;
      if (!l.itemId) {
        try { await authedFetch(base, { method: "POST", body: JSON.stringify(itemBody(l)) }); }
        catch { failed += 1; }
        continue;
      }
      const snap = snapById.get(l.itemId);
      if (snap && lineChanged(l, snap)) {
        try { await authedFetch(`${base}/${encodeURIComponent(l.itemId)}`, { method: "PATCH", body: JSON.stringify(itemPatchBody(l)) }); }
        catch { failed += 1; }
      }
    }
    return failed;
  }

  // ---- Mutations ------------------------------------------------------------
  async function save(asDraft = false) {
    setTouched(true);
    if (nameErr || phoneErr || emailErr) {
      setError("Please fill in the required fields: customer name, phone and a valid email.");
      setStep(0);
      return;
    }
    if (namedLines.length < 1) { setError("Add at least one line item."); setStep(2); return; }
    if (unpickedLines.length > 0) {
      setError(`Pick a product from the catalog for every line (${unpickedLines.length} line${unpickedLines.length === 1 ? "" : "s"} still ha${unpickedLines.length === 1 ? "s" : "ve"} no product selected).`);
      setStep(2);
      return;
    }
    if (linesMissingVariants.length > 0) {
      const l = linesMissingVariants[0];
      const miss = missingVariantAxes(l.itemGroup, l.variants).map((a) => a.label).join(", ");
      setError(`Complete the required options (${miss}) on "${l.name || l.itemCode}".`);
      setStep(2);
      return;
    }
    const procOut = asDraft ? "" : procDate;
    const delivOut = asDraft ? "" : delivDate;
    if (!asDraft && Boolean(procDate) !== Boolean(delivDate)) {
      setError("Processing Date and Delivery Date must be set together, or both left empty.");
      setStep(1);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const phoneOut = "+60" + phone.replace(/\s+/g, "");
      const ecPhoneOut = ecPhone.trim() ? "+60" + ecPhone.replace(/\s+/g, "") : null;

      if (isEdit && docNo) {
        const patch: Record<string, unknown> = {
          debtorName: name.trim(),
          customerSoNo: custRef.trim() || null,
          phone: phoneOut,
          email: email.trim(),
          customerType: custType || null,
          buildingType: buildingType || null,
          venue: venue.trim() || null,
          note: note.trim() || null,
          address1: addressLater ? null : addr1.trim() || null,
          address2: addressLater ? null : addr2.trim() || null,
          customerState: state || null,
          city: city.trim() || null,
          postcode: postcode.trim() || null,
          internalExpectedDd: procOut || null,
          customerDeliveryDate: delivOut || null,
          emergencyContactName: ecName.trim() || null,
          emergencyContactPhone: ecPhoneOut,
          emergencyContactRelationship: ecRel || null,
          salespersonId: salespersonId || null,
        };
        await authedFetch(`/mfg-sales-orders/${encodeURIComponent(docNo)}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        });

        if (!lineLocked) {
          const failed = await applyLineDiff(docNo);
          if (failed > 0) {
            void notify({ title: "Some line changes didn't save", body: `${failed} line change(s) failed. Re-open the order and check the items.`, tone: "error" });
          }
        }

        await qc.invalidateQueries({ queryKey: ["mobile-so-detail", docNo] });
        await qc.invalidateQueries({ queryKey: ["mobile-so-list"] });
        if (onSaved) onSaved(docNo);
        else onBack();
        return;
      }

      // CREATE (new / edit-draft treated as create — mints a fresh doc_no).
      const items = namedLines.map((l) => itemBody(l));

      const body: Record<string, unknown> = {
        customerName: name.trim(),
        debtorName: name.trim(),
        customerSoNo: custRef.trim() || null,
        phone: phoneOut,
        email: email.trim() || null,
        customerType: custType || null,
        buildingType: buildingType || null,
        venue: venue.trim() || null,
        note: note.trim() || null,
        address1: addressLater ? null : addr1.trim() || null,
        address2: addressLater ? null : addr2.trim() || null,
        customerState: state || null,
        city: city.trim() || null,
        postcode: postcode.trim() || null,
        internalExpectedDd: procOut || null,
        customerDeliveryDate: delivOut || null,
        emergencyContactName: ecName.trim() || null,
        emergencyContactPhone: ecPhoneOut,
        emergencyContactRelationship: ecRel || null,
        salespersonId: salespersonId || null,
        items,
      };

      const res = await authedFetch<{ docNo: string }>(`/mfg-sales-orders`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (res?.docNo) await recordSlipBackedPayments(res.docNo);
      maybeLearnFromScan();
      await qc.invalidateQueries({ queryKey: ["mobile-so-list"] });
      if (res?.docNo && onSaved) onSaved(res.docNo);
      else onBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the sales order. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // ---- Render ---------------------------------------------------------------
  const onLastStep = step === STEPS.length - 1;
  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      {/* Header — "Cancel" text button, Draft/Editing pill, title, and the
          "Step N of 5 · {step name}" sub-line the Spec calls for. */}
      <header className="hdr">
        <div className="hdr-row">
          <button type="button" onClick={onBack} style={{ background: "none", border: "none", color: "var(--mut)", fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit", padding: 0 }}>Cancel</button>
          <span className="badge b-grey">{mode === "edit" ? "Editing" : "Draft"}</span>
        </div>
        <div id="nso-title" className="scr-title" style={{ marginTop: 6 }}>{title}</div>
        {!loading && (
          <div style={{ marginTop: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 5 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#16695f" }}>Step {step + 1} of {STEPS.length}</span>
              <span style={{ fontSize: 11, color: "#767b6e" }}>{STEPS[step]}</span>
            </div>
            {/* Progress bar — 5 segments, filled up to the current step. */}
            <div style={{ display: "flex", gap: 4 }}>
              {STEPS.map((s, i) => (
                <span key={s} style={{ flex: 1, height: 4, borderRadius: 999, background: i <= step ? "#16695f" : "#e3e6e0" }} />
              ))}
            </div>
          </div>
        )}
      </header>

      <div className="scroll hz-scroll" style={{ padding: 12, paddingBottom: 24 }}>
        {loading ? (
          <div style={{ textAlign: "center", color: "#9aa093", fontSize: 12, padding: "40px 0" }}>Loading{"…"}</div>
        ) : (
          <>
            {fromScan && step === 0 && (
              <div style={{ display: "flex", alignItems: "flex-start", gap: 9, marginBottom: 9, padding: "10px 12px", background: "#eaf2f0", border: "1px solid #cfe1dc", borderRadius: 12 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none", marginTop: 1 }}><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" /><circle cx="12" cy="13" r="3" /></svg>
                <div style={{ fontSize: 11.5, color: "#16695f", lineHeight: 1.5 }}>
                  Prefilled from your scan. Review every field marked <b>Scanned</b>, correct anything the reader missed, then create the order.
                </div>
              </div>
            )}

            {/* ── STEP 1 · Customer ─────────────────────────────────────── */}
            {step === 0 && (
              <>
                <div className="card" style={{ marginBottom: 11 }}>
                  <div className="card-h"><span className="card-t">Customer</span></div>
                  <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                    <Field label="Customer Name *" error={touched && nameErr} scanned={scanned("name", name)}>
                      <input className="fld-i" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Lim Mei Hua" />
                    </Field>
                    <div style={{ display: "flex", gap: 9 }}>
                      <Field label="Phone *" style={{ flex: 1 }} error={touched && phoneErr} scanned={scanned("phone", phone)}>
                        <span style={{ display: "flex", alignItems: "stretch" }}>
                          <span style={prefixBox}>+60</span>
                          <input className="fld-i" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="1X-XXX XXXX" style={{ borderRadius: "0 9px 9px 0" }} />
                        </span>
                      </Field>
                      <Field label="Email *" style={{ flex: 1 }} error={touched && emailErr}>
                        <input className="fld-i" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="customer@example.com" />
                      </Field>
                    </div>
                    <div style={{ display: "flex", gap: 9 }}>
                      <Field label="Customer Type" style={{ flex: 1 }} scanned={scanned("custType", custType)}>
                        <select className="fld-i" value={custType} onChange={(e) => setCustType(e.target.value)}>
                          {CUSTOMER_TYPES.map((t) => <option key={t} value={t}>{t || "—"}</option>)}
                        </select>
                      </Field>
                      <Field label="Salesperson" style={{ flex: 1 }}>
                        <select className="fld-i" value={salespersonId} onChange={(e) => setSalespersonId(e.target.value)}>
                          <option value="">{staffQ.isLoading ? "Loading…" : "Me (default)"}</option>
                          {(staffQ.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      </Field>
                    </div>
                    <Field label="Customer SO Ref" scanned={scanned("custRef", custRef)}>
                      <input className="fld-i" value={custRef} onChange={(e) => setCustRef(e.target.value)} placeholder="Their PO / SO number" />
                    </Field>
                  </div>
                </div>

                <div className="card" style={{ marginBottom: 11 }}>
                  <div className="card-h"><span className="card-t">Emergency Contact</span><span className="card-sub">If we can't reach the customer</span></div>
                  <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                    <Field label="Contact Name">
                      <input className="fld-i" value={ecName} onChange={(e) => setEcName(e.target.value)} placeholder="e.g. Lim Mei Hua" />
                    </Field>
                    <Field label="Relationship">
                      <select className="fld-i" value={ecRel} onChange={(e) => setEcRel(e.target.value)}>
                        {RELATIONSHIPS.map((t) => <option key={t} value={t}>{t || "—"}</option>)}
                      </select>
                    </Field>
                    <Field label="Phone">
                      <span style={{ display: "flex", alignItems: "stretch" }}>
                        <span style={prefixBox}>+60</span>
                        <input className="fld-i" type="tel" value={ecPhone} onChange={(e) => setEcPhone(e.target.value)} placeholder="1X-XXX XXXX" style={{ borderRadius: "0 9px 9px 0" }} />
                      </span>
                    </Field>
                  </div>
                </div>
              </>
            )}

            {/* ── STEP 2 · Order info ───────────────────────────────────── */}
            {step === 1 && (
              <>
                <div className="card" style={{ marginBottom: 11 }}>
                  <div className="card-h"><span className="card-t">Order info</span></div>
                  <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                    <div style={{ display: "flex", gap: 9 }}>
                      <Field label="Building Type" style={{ flex: 1 }} scanned={scanned("buildingType", buildingType)}>
                        <select className="fld-i" value={buildingType} onChange={(e) => setBuildingType(e.target.value)}>
                          {BUILDING_TYPES.map((t) => <option key={t} value={t}>{t || "—"}</option>)}
                        </select>
                      </Field>
                      {/* Venue is derived server-side from the salesperson's active
                          project; shown read-only (Spec: derived). */}
                      <Field label="Venue (auto)" style={{ flex: 1 }}>
                        <input className="fld-i" value={venue} disabled placeholder="From salesperson" />
                      </Field>
                    </div>
                    <div style={{ display: "flex", gap: 9 }}>
                      <Field label="Processing Date" style={{ flex: 1 }} error={touched && dateXorErr} scanned={scanned("procDate", procDate)}>
                        <input className="fld-i" type="date" value={procDate} onChange={(e) => setProcDate(e.target.value)} />
                      </Field>
                      <Field label="Delivery Date" style={{ flex: 1 }} error={touched && dateXorErr} scanned={scanned("delivDate", delivDate)}>
                        <input className="fld-i" type="date" value={delivDate} onChange={(e) => setDelivDate(e.target.value)} />
                      </Field>
                    </div>
                    <div style={{ fontSize: 10, color: "#9aa093", marginTop: -3 }}>Set both dates together, or leave both empty to keep this a draft.</div>
                    <Field label="Note" scanned={scanned("note", note)}>
                      <input className="fld-i" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Internal notes — SO detail only" />
                    </Field>
                    {/* Sales Location derives server-side from state → warehouse. */}
                    <div style={{ display: "flex", gap: 9 }}>
                      <Field label="Country" style={{ flex: 1 }}>
                        <input className="fld-i" value="Malaysia" disabled />
                      </Field>
                      <Field label="Sales Location" style={{ flex: 1 }}>
                        <input className="fld-i" value="Auto (from state)" disabled />
                      </Field>
                    </div>
                  </div>
                </div>

                <div className="card" style={{ marginBottom: 11 }}>
                  <div className="card-h"><span className="card-t">Delivery address</span></div>
                  <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                    <label style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: 11, background: "#f4f6f3", border: "1px solid rgba(34,31,32,.12)", borderRadius: 12, cursor: "pointer" }}>
                      <input type="checkbox" checked={addressLater} onChange={(e) => setAddressLater(e.target.checked)} style={{ marginTop: 2, width: 16, height: 16, accentColor: "#16695f" }} />
                      <span>
                        <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#11140f" }}>Fill in address later</span>
                        <span style={{ fontSize: 11, color: "#767b6e" }}>Customer hasn't confirmed delivery address yet.</span>
                      </span>
                    </label>
                    {!addressLater && (
                      <>
                        <Field label="Address Line 1" scanned={scanned("addr1", addr1)}>
                          <input className="fld-i" value={addr1} onChange={(e) => setAddr1(e.target.value)} placeholder="Unit, street, area" />
                        </Field>
                        <Field label="Address Line 2">
                          <input className="fld-i" value={addr2} onChange={(e) => setAddr2(e.target.value)} placeholder="Apt, floor, building (optional)" />
                        </Field>
                        <Field label="State" scanned={scanned("state", state)}>
                          <select className="fld-i" value={state} onChange={(e) => setState(e.target.value)}>
                            {STATES.map((s) => <option key={s} value={s}>{s || "Pick state"}</option>)}
                          </select>
                        </Field>
                        <div style={{ display: "flex", gap: 11 }}>
                          <Field label="City" style={{ flex: 1 }} scanned={scanned("city", city)}>
                            <input className="fld-i" value={city} onChange={(e) => setCity(e.target.value)} placeholder="City" />
                          </Field>
                          <Field label="Postcode" style={{ flex: 1 }} scanned={scanned("postcode", postcode)}>
                            <input className="fld-i" inputMode="numeric" value={postcode} onChange={(e) => setPostcode(e.target.value)} placeholder="00000" />
                          </Field>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </>
            )}

            {/* ── STEP 3 · Items ────────────────────────────────────────── */}
            {step === 2 && (
              <div className="card" style={{ marginBottom: 11 }}>
                <div className="card-h"><span className="card-t">Line items</span><span className="card-sub">{`${lines.length} ${lines.length === 1 ? "line" : "lines"}`}</span></div>
                <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                  {lineLocked ? (
                    <>
                      {lines.length ? lines.map((l) => (
                        <div key={l.key} style={roItemBox}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                            <span style={{ fontSize: 12.5, fontWeight: 600, color: "#11140f" }}>{l.name || l.itemCode || "—"} <span style={{ color: "#9aa093" }}>{"×"}{num(l.qty)}</span></span>
                            <span className="money" style={{ fontSize: 12.5, fontWeight: 800, color: "#0c3f39" }}>RM {fmt((toCenti(l.price) * num(l.qty)) / 100)}</span>
                          </div>
                        </div>
                      )) : <div style={{ fontSize: 11.5, color: "#9aa093", padding: "8px 0" }}>No items.</div>}
                      <div style={{ fontSize: 10, color: "#9aa093", marginTop: 4 }}>This order is shipped or has downstream documents — line items can no longer be changed.</div>
                    </>
                  ) : (
                    <>
                      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                        {lines.map((l, i) => (
                          <LineCard
                            key={l.key}
                            line={l}
                            index={i}
                            pools={pools}
                            removable={lines.length > 1}
                            showErrors={touched}
                            onOpenPicker={() => setPickerFor(l.key)}
                            onChange={(patch) => setLines((prev) => prev.map((x) => (x.key === l.key ? { ...x, ...patch } : x)))}
                            onRemove={async () => {
                              if (!(await confirm({ title: "Remove this line?", body: l.name ? `"${l.name}" will be removed from the order.` : undefined, confirmLabel: "Remove", danger: true }))) return;
                              setLines((prev) => prev.filter((x) => x.key !== l.key));
                            }}
                          />
                        ))}
                      </div>
                      <button className="addline" onClick={() => setLines((p) => [...p, newLine()])}>+ Add Line Item</button>
                    </>
                  )}
                  <div className="so-sub-row"><span style={{ fontSize: 11, color: "var(--mut)" }}>Subtotal</span><span className="money" style={{ fontSize: 17, fontWeight: 800, color: "var(--brand-d)" }}>RM {fmt(subtotal / 100)}</span></div>
                  <div style={{ fontSize: 10, color: "#9aa093" }}>Prices are recomputed by the system when you save.</div>
                </div>
              </div>
            )}

            {/* ── STEP 4 · Payment ──────────────────────────────────────── */}
            {step === 3 && (
              <div className="card" style={{ marginBottom: 11 }}>
                <div className="card-h"><span className="card-t">Payments</span><span className="card-sub">Method · amount · slip</span></div>
                <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                  {isEdit ? (
                    <>
                      {existingPays.length ? existingPays.map((p) => (
                        <div key={p.id} style={roItemBox}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                            <span style={{ fontSize: 12, color: "#414539" }}>{(p.paid_at ?? "").slice(0, 10) || "—"} {"·"} {p.method || "—"}</span>
                            <span className="money" style={{ fontSize: 12.5, fontWeight: 700, color: "#0c3f39" }}>RM {fromCenti(p.amount_centi)}</span>
                          </div>
                        </div>
                      )) : <div style={{ fontSize: 11.5, color: "#9aa093", padding: "8px 0" }}>No payments recorded.</div>}
                      <div style={{ fontSize: 10, color: "#9aa093", marginTop: 4 }}>Payments are recorded from the SO detail screen.</div>
                    </>
                  ) : (
                    <>
                      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                        {pays.map((p) => (
                          <PayCard
                            key={p.key}
                            pay={p}
                            staff={staffQ.data ?? []}
                            onChange={(patch) => setPays((prev) => prev.map((x) => (x.key === p.key ? { ...x, ...patch } : x)))}
                            onRemove={() => setPays((prev) => prev.filter((x) => x.key !== p.key))}
                          />
                        ))}
                      </div>
                      <button className="addline" onClick={() => setPays((p) => [...p, newPayment()])}>+ Add Payment</button>
                      {!!pays.length && (
                        <div style={{ fontSize: 10, color: "#a16a2e", marginTop: 6 }}>
                          Each payment needs a slip to be recorded. Slip-backed rows are saved to the order on Create; rows without a slip stay as planned entries — add their slip here or from the SO detail screen.
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}

            {/* ── STEP 5 · Review ───────────────────────────────────────── */}
            {step === 4 && (
              <ReviewStep
                name={name} phone={phone} email={email} custType={custType} custRef={custRef}
                buildingType={buildingType} venue={venue} procDate={procDate} delivDate={delivDate} note={note}
                addressLater={addressLater} addr1={addr1} addr2={addr2} state={state} city={city} postcode={postcode}
                lines={lines} pays={pays} isEdit={isEdit} subtotal={subtotal}
                docNo={docNo}
              />
            )}

            {error && <div style={{ marginTop: 4, fontSize: 12, color: "#b23a3a", textAlign: "center", padding: "0 4px" }}>{error}</div>}
          </>
        )}
      </div>

      {/* Action bar — wizard nav. Steps 1-4: [Back][Next]. Step 5 (Review):
          [Back] + (edit → [Save changes]) / (new → [Save draft][Create]). */}
      {!loading && (
        <footer id="nso-footer" className="actbar" style={{ display: "flex", gap: 9 }}>
          {step > 0 ? (
            <button className="btn-ghost" disabled={submitting} onClick={goBack} style={{ flex: 1, opacity: submitting ? 0.6 : 1 }}>Back</button>
          ) : (
            <button className="btn-ghost" disabled={submitting} onClick={onBack} style={{ flex: 1 }}>Cancel</button>
          )}
          {!onLastStep ? (
            <button className="btn" disabled={submitting} onClick={goNext} style={{ flex: 1.3 }}>Next</button>
          ) : mode === "edit" ? (
            <button className="btn" disabled={submitting} onClick={() => save(false)} style={{ flex: 1.3, opacity: submitting ? 0.6 : 1 }}>
              {submitting ? "Saving…" : "Save Changes"}
            </button>
          ) : (
            <>
              <button className="btn-ghost" disabled={submitting} onClick={() => save(true)} style={{ flex: 1, opacity: submitting ? 0.6 : 1 }}>
                {submitting ? "Saving…" : "Save draft"}
              </button>
              <button className="btn" disabled={submitting} onClick={() => save(false)} style={{ flex: 1.3, opacity: submitting ? 0.6 : 1 }}>
                {submitting ? "Saving…" : "Create Sales Order"}
              </button>
            </>
          )}
        </footer>
      )}

      {pickerFor && (
        <MobileSkuPicker
          initialCat={mapPickerCat(lines.find((l) => l.key === pickerFor)?.cat)}
          onClose={() => setPickerFor(null)}
          onPick={(sku: PickedSku) => {
            /* Seed the line with the real catalog identity. `cat` derives from
               the picked group so the right variant panel shows; the unit price
               defaults from the catalog SELLING price (server recomputes on
               save). Changing the SKU resets the variant blob (a bedframe's
               divan pool differs from a sofa's) — mirrors SoLineCard.pickProduct
               which reseeds variants on a fresh pick. We keep the operator's
               typed qty / remark. */
            setLines((prev) => prev.map((x) => {
              if (x.key !== pickerFor) return x;
              const nextCat = catForGroup(sku.itemGroup);
              return {
                ...x,
                itemCode: sku.itemCode,
                itemGroup: sku.itemGroup,
                name: sku.name,
                cat: nextCat,
                price: fromCenti(sku.unitPriceCenti),
                variants: nextCat === x.cat ? x.variants : {},
              };
            }));
            setPickerFor(null);
          }}
        />
      )}
    </div>
  );
}

/* LineCat → the SKU picker's category chip seed. */
function mapPickerCat(c: LineCat | undefined): "" | "sofa" | "bedframe" {
  return c === "sofa" ? "sofa" : c === "bedframe" ? "bedframe" : "";
}

/* Prefill helper — the stored phone is "+60xxxxxxxx"; the form's +60 prefix box
 * owns the country code, so strip it (and any leading zero) for the input. */
function stripPrefix(p: string | null): string {
  if (!p) return "";
  let s = p.trim();
  if (s.startsWith("+60")) s = s.slice(3);
  else if (s.startsWith("60") && s.length > 9) s = s.slice(2);
  return s.replace(/^0/, "");
}

// ---- Sub-components ---------------------------------------------------------

function Field({ label, error, scanned, style, children }: { label: string; error?: boolean; scanned?: boolean; style?: React.CSSProperties; children: React.ReactNode }) {
  return (
    <label className="fld" style={style}>
      <span className="fld-l" style={{ display: "flex", alignItems: "center", gap: 6, ...(error ? { color: "#b23a3a" } : null) }}>
        {label}
        {scanned && <ScannedTag />}
      </span>
      {children}
    </label>
  );
}

function ScannedTag() {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "1px 6px", borderRadius: 999, background: "#eaf2f0", color: "#16695f", fontSize: 8, fontWeight: 700, letterSpacing: ".04em" }}>
      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" /><circle cx="12" cy="13" r="3" /></svg>
      SCANNED
    </span>
  );
}

/* ── Variant pool → option list builders (REAL sources) ───────────────────
   These mirror SoLineCard's dropdown construction exactly: string pools
   (gaps/sofaSizes) via maintPickerValues, priced pools (divan/leg/sofaLeg
   heights) via activeOptions, both filtered by the Model's allowed_options.
   `current` is the line's saved value so a value that fell out of the live
   pool still renders (never blanks the select). */
function restrictS(opts: string[], pool?: string[] | null): string[] {
  return Array.isArray(pool) && pool.length > 0 ? opts.filter((o) => pool.includes(o)) : opts;
}
function restrictP<T extends { value: string }>(opts: T[], pool?: string[] | null): T[] {
  return Array.isArray(pool) && pool.length > 0 ? opts.filter((o) => pool.includes(o.value)) : opts;
}
/* Numeric-aware sort (matches SoLineCard's sortByNumeric intent for height/gap
   pools: 4" < 6" < 10"). Falls back to locale compare for non-numeric. */
function sortNumeric<T extends { value: string }>(opts: T[]): T[] {
  return [...opts].sort((a, b) => {
    const na = parseInches(a.value), nb = parseInches(b.value);
    if (na !== nb) return na - nb;
    return a.value.localeCompare(b.value, undefined, { sensitivity: "base" });
  });
}

/* Fabrics dropdown options — active fabric_colours filtered by the Model's
   allowed_options.fabrics, plus the line's current value as "(current)" so an
   edit never blanks. Mirrors SoLineCard.fabricOptions. */
function fabricOptions(pools: VariantPools, allow: ModelAllowedOptions | null, current: string): Opt[] {
  const pool = allow?.fabrics;
  const colours = (Array.isArray(pool) && pool.length > 0)
    ? pools.fabricColours.filter((c) => pool.includes(c.colourId))
    : pools.fabricColours;
  const opts: Opt[] = colours.map((c) => ({ value: c.colourId, label: c.colourId }));
  opts.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  if (current && !opts.some((o) => o.value === current)) opts.unshift({ value: current, label: `${current} (current)` });
  return opts;
}

function LineCard({
  line,
  index,
  pools,
  removable,
  showErrors,
  onOpenPicker,
  onChange,
  onRemove,
}: {
  line: LineItem;
  index: number;
  pools: VariantPools;
  removable: boolean;
  showErrors: boolean;
  onOpenPicker: () => void;
  onChange: (patch: Partial<LineItem>) => void;
  onRemove: () => void;
}) {
  const amt = fmt(num(line.qty) * num(line.price));
  const picked = Boolean(line.itemCode.trim());
  const v = line.variants;

  /* Per-SKU allowed_options (Modular ON/OFF), resolved by code exactly like
     SoLineCard's useModelAllowedOptionsByCode. Empty/absent = no restriction. */
  const allowQ = useModelAllowedOptionsByCode(line.itemCode || undefined);
  const allow = allowQ.data ?? null;

  const setVar = (patch: Record<string, unknown>) => onChange({ variants: { ...line.variants, ...patch } });

  /* Fabric pick writes the SAME multi-key patch SoLineCard.pickFabricColour
     sends: fabricCode + colourId + fabricId + series/colour labels. This is
     what the server's allowed-fabric gate + cost/fabric-tier lookup key on. */
  const pickFabric = (colourId: string) => {
    const c = pools.fabricColours.find((x) => x.colourId === colourId);
    const seriesLabel = c ? pools.fabricSeries.get(c.fabricId) ?? null : null;
    setVar({
      fabricCode: colourId,
      colourId,
      ...(c ? { fabricId: c.fabricId } : {}),
      ...(seriesLabel ? { fabricLabel: seriesLabel } : {}),
      ...(c?.label ? { colourLabel: c.label } : {}),
      ...(c?.swatchHex ? { colourHex: c.swatchHex } : {}),
    });
  };

  const maint = pools.maint;
  const fabVal = String(v.fabricCode ?? "");
  const fabOpts = fabricOptions(pools, allow, fabVal);

  // Sofa pools (real): seat = sofaSizes (string), leg = sofaLegHeights (priced)
  const sofaSeatOpts = maint
    ? restrictS(maintPickerValues(maint.sofaSizes, String(v.seatHeight ?? "")), allow?.sizes).map((s) => ({ value: s, label: s }))
    : [];
  const sofaLegOpts = maint
    ? sortNumeric(restrictP(activeOptions(maint.sofaLegHeights, String(v.legHeight ?? "")), allow?.leg_heights)).map((o) => ({ value: o.value, label: o.value }))
    : [];

  // Bedframe pools (real): gap (string), divan + leg (priced)
  const bfGapOpts = maint
    ? restrictS(maintPickerValues(maint.gaps, String(v.gap ?? "")), allow?.gaps).map((g) => ({ value: g, label: g }))
    : [];
  const bfDivanOpts = maint
    ? sortNumeric(restrictP(activeOptions(maint.divanHeights, String(v.divanHeight ?? "")), allow?.divan_heights)).map((o) => ({ value: o.value, label: o.value }))
    : [];
  const bfLegOpts = maint
    ? sortNumeric(restrictP(activeOptions(maint.legHeights, String(v.legHeight ?? "")), allow?.leg_heights)).map((o) => ({ value: o.value, label: o.value }))
    : [];

  const totalHeight = parseInches(v.divanHeight) + parseInches(v.legHeight) + parseInches(v.gap);
  const missing = new Set(missingVariantAxes(line.itemGroup, line.variants).map((a) => a.key));

  return (
    <div style={{ border: "1px solid rgba(34,31,32,.12)", borderRadius: 11, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "#f4f6f3", borderBottom: "1px solid rgba(34,31,32,.1)" }}>
        <span style={{ width: 19, height: 19, flex: "none", borderRadius: 6, background: "#16695f", color: "#fff", fontSize: 10.5, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>{index + 1}</span>
        <button
          type="button"
          onClick={onOpenPicker}
          style={{
            flex: 1, minWidth: 0, textAlign: "left", fontFamily: "inherit", cursor: "pointer",
            background: "#fff", border: picked ? "1px solid #bcdcd7" : "1px dashed #c2c6bd",
            borderRadius: 9, padding: "6px 9px", display: "flex", alignItems: "center", gap: 7,
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            {picked ? (
              <>
                <span style={{ display: "block", fontSize: 12.5, fontWeight: 700, color: "#11140f", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{line.name}</span>
                <span style={{ display: "block", fontSize: 10, color: "#16695f", fontWeight: 700, marginTop: 1 }}>{line.itemCode}</span>
              </>
            ) : (
              <span style={{ fontSize: 12.5, fontWeight: 600, color: "#9aa093" }}>Pick a product{"…"}</span>
            )}
          </span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}><polyline points="9 6 15 12 9 18" /></svg>
        </button>
        {removable && <span onClick={onRemove} style={{ fontSize: 14, color: "#9aa093", cursor: "pointer", padding: "0 2px" }}>{"✕"}</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7, padding: 10 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <Field label="Qty" style={{ flex: 0.55 }}>
            <input className="fld-i" inputMode="numeric" value={line.qty} onChange={(e) => onChange({ qty: e.target.value })} />
          </Field>
          <Field label="Unit Price" style={{ flex: 1.1 }}>
            <input className="fld-i money" value={line.price} onChange={(e) => onChange({ price: e.target.value })} />
          </Field>
          <Field label="Delivery date" style={{ flex: 1.1 }}>
            <input className="fld-i" type="date" value={line.ddate} onChange={(e) => onChange({ ddate: e.target.value })} />
          </Field>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11, color: "#9aa093" }}>
            {LINE_CATS.find((c) => c.value === line.cat)?.label ?? "General item"}
            {picked ? "" : " — pick a product"}
          </span>
          <span style={{ fontSize: 11, color: "#9aa093" }}>
            Amount <b className="money" style={{ fontSize: 13, fontWeight: 800, color: "#0c3f39" }}>RM {amt}</b>
          </span>
        </div>

        {/* Category-aware variant panels — REAL hooks. Only render once a SKU is
            picked and the maintenance pools have loaded. */}
        {picked && !pools.ready && (
          <div style={{ fontSize: 10.5, color: "#9aa093", padding: "4px 0" }}>Loading options{"…"}</div>
        )}

        {picked && pools.ready && line.cat === "sofa" && (
          <>
            <SpecSel label="Fabric / colour" required invalid={showErrors && missing.has("fabricCode")}
              value={fabVal} opts={fabOpts} onChange={pickFabric} emptyHint="No fabrics configured" />
            <div style={{ display: "flex", gap: 9 }}>
              <SpecSel label="Seat height" required invalid={showErrors && missing.has("seatHeight")}
                value={String(v.seatHeight ?? "")} opts={sofaSeatOpts} onChange={(x) => setVar({ seatHeight: x })} />
              <SpecSel label="Leg height" required invalid={showErrors && missing.has("legHeight")}
                value={String(v.legHeight ?? "")} opts={sofaLegOpts} onChange={(x) => setVar({ legHeight: x })} />
            </div>
          </>
        )}

        {picked && pools.ready && line.cat === "bedframe" && (
          <>
            <SpecSel label="Fabric / colour" required invalid={showErrors && missing.has("fabricCode")}
              value={fabVal} opts={fabOpts} onChange={pickFabric} emptyHint="No fabrics configured" />
            <div style={{ background: "#f4f6f3", border: "1px solid #e3e6e0", borderRadius: 10, padding: "9px 10px" }}>
              <div className="fld-l" style={{ marginBottom: 7 }}>Bedframe build</div>
              <div style={{ display: "flex", gap: 8 }}>
                <SpecSel label="Divan" required invalid={showErrors && missing.has("divanHeight")}
                  value={String(v.divanHeight ?? "")} opts={bfDivanOpts} onChange={(x) => setVar({ divanHeight: x })} />
                <SpecSel label="Leg" required invalid={showErrors && missing.has("legHeight")}
                  value={String(v.legHeight ?? "")} opts={bfLegOpts} onChange={(x) => setVar({ legHeight: x })} />
                <SpecSel label="Gap" required invalid={showErrors && missing.has("gap")}
                  value={String(v.gap ?? "")} opts={bfGapOpts} onChange={(x) => setVar({ gap: x })} />
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8, paddingTop: 8, borderTop: "1px solid #e3e6e0", fontSize: 11, color: "#767b6e" }}>
                Total height <strong className="money" style={{ color: "#0c3f39", fontSize: 13 }}>{totalHeight > 0 ? `${totalHeight}"` : "—"}</strong>
              </div>
            </div>
          </>
        )}

        {picked && pools.ready && line.cat === "mattress" && (
          <div style={{ fontSize: 10.5, color: "#767b6e", background: "#f4f6f3", border: "1px solid #e3e6e0", borderRadius: 9, padding: "7px 9px" }}>
            Mattress SKUs carry their spec in the item itself — no per-line variants to pick.
          </div>
        )}

        <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
          <Field label="Remark" style={{ flex: 1 }}>
            <input className="fld-i" value={line.remark} onChange={(e) => onChange({ remark: e.target.value })} placeholder="e.g. LHF chaise facing window" />
          </Field>
          {line.photo ? (
            <button
              type="button"
              onClick={() => onChange({ photo: false })}
              title="Reference photo captured"
              style={{ width: 46, flex: "none", alignSelf: "flex-end", height: 38, border: "1.5px solid #16695f", borderRadius: 9, background: "#e1efed", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2f8a5b" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onChange({ photo: true })}
              title="Attach a reference photo"
              style={{ width: 46, flex: "none", alignSelf: "flex-end", height: 38, border: "1px solid #d6d9d2", borderRadius: 9, background: "#f4f6f3", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" /><circle cx="12" cy="13" r="3" /></svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* SpecSel — a labelled <select> bound to a real option list. `required`
   renders a red ring when empty (missing axis); `emptyHint` shows when the real
   pool returned no options (e.g. no fabric_colours seeded) so the operator
   isn't staring at an empty dropdown wondering why. */
function SpecSel({ label, value, opts, onChange, required = false, invalid = false, emptyHint }: {
  label: string; value: string; opts: Opt[]; onChange: (v: string) => void;
  required?: boolean; invalid?: boolean; emptyHint?: string;
}) {
  const hasCurrent = Boolean(value) && opts.some((o) => o.value === value);
  return (
    <Field label={label + (required ? " *" : "")} style={{ flex: 1 }}>
      <select
        className="fld-i"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={invalid ? { borderColor: "#b23a3a", boxShadow: "0 0 0 2px rgba(178,58,58,.12)" } : undefined}
      >
        <option value="" disabled>{opts.length === 0 && emptyHint ? emptyHint : "Select…"}</option>
        {value && !hasCurrent && <option value={value}>{value} (current)</option>}
        {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Field>
  );
}

function PayCard({ pay, staff, onChange, onRemove }: { pay: Payment; staff: Array<{ id: string; name: string }>; onChange: (patch: Partial<Payment>) => void; onRemove: () => void }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const onPickSlip = async (f: File | null) => {
    if (!f) return;
    onChange({ slipName: f.name, slipSession: "", slipPhase: "uploading" });
    try {
      const { uploadSessionId } = await uploadSlipFull({ file: f });
      onChange({ slipSession: uploadSessionId, slipPhase: "done" });
    } catch {
      onChange({ slipPhase: "error" });
    }
  };
  return (
    <div style={{ border: "1px solid rgba(34,31,32,.12)", borderRadius: 11, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "#f4f6f3", borderBottom: "1px solid rgba(34,31,32,.1)" }}>
        <span style={{ fontSize: 9, fontWeight: 700, color: "#767b6e", textTransform: "uppercase", letterSpacing: ".06em" }}>Method</span>
        <select className="fld-i" style={{ flex: 1, fontWeight: 600 }} value={pay.method} onChange={(e) => onChange({ method: e.target.value })}>
          {PAY_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <span onClick={onRemove} style={{ fontSize: 14, color: "#9aa093", cursor: "pointer", padding: "0 2px" }}>{"✕"}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7, padding: 10 }}>
        <div style={{ display: "flex", gap: 9, alignItems: "flex-end" }}>
          <Field label="Date" style={{ flex: 1.1 }}>
            <input className="fld-i" type="date" value={pay.date} onChange={(e) => onChange({ date: e.target.value })} />
          </Field>
          <Field label="Amount" style={{ flex: 1.1 }}>
            <input className="fld-i money" value={pay.amount} onChange={(e) => onChange({ amount: e.target.value })} />
          </Field>
        </div>
        {pay.method === "Merchant" && (
          <div style={{ display: "flex", gap: 9 }}>
            <SpecSel label="Bank" value={pay.bank} opts={BANK_OPTS.map((o) => ({ value: o, label: o }))} onChange={(vv) => onChange({ bank: vv })} />
            <SpecSel label="Plan" value={pay.plan} opts={PLAN_OPTS.map((o) => ({ value: o, label: o }))} onChange={(vv) => onChange({ plan: vv })} />
          </div>
        )}
        {pay.method === "Installment" && (
          <SpecSel label="Installment plan" value={pay.plan} opts={PLAN_OPTS.map((o) => ({ value: o, label: o }))} onChange={(vv) => onChange({ plan: vv })} />
        )}
        {pay.method === "Online" && (
          <SpecSel label="Sub-type" value={pay.online} opts={ONLINE_OPTS.map((o) => ({ value: o, label: o }))} onChange={(vv) => onChange({ online: vv })} />
        )}
        <div style={{ display: "flex", gap: 9 }}>
          <Field label="Account Sheet" style={{ flex: 1 }}>
            <input className="fld-i" value={pay.account} onChange={(e) => onChange({ account: e.target.value })} placeholder="Sheet ref" />
          </Field>
          <Field label="Approval Code" style={{ flex: 1 }}>
            <input className="fld-i" value={pay.approval} onChange={(e) => onChange({ approval: e.target.value })} placeholder="Terminal no" />
          </Field>
        </div>
        <div style={{ display: "flex", gap: 9, alignItems: "flex-end" }}>
          <Field label="Collected By" style={{ flex: 1 }}>
            <select className="fld-i" value={pay.collectedBy} onChange={(e) => onChange({ collectedBy: e.target.value })}>
              <option value="">—</option>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <div style={{ flex: 1 }}>
            <div className="fld-l" style={{ color: "#9aa093" }}>Slip</div>
            <input ref={fileRef} type="file" accept="image/*,application/pdf" style={{ display: "none" }} onChange={(e) => { void onPickSlip(e.target.files?.[0] ?? null); e.target.value = ""; }} />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={pay.slipPhase === "uploading"}
              title={pay.slipName || "Attach a payment slip"}
              style={{
                width: "100%", boxSizing: "border-box", height: 38, borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700,
                border: pay.slipPhase === "done" ? "1px solid #bcdcd7" : "1px solid #d6d9d2",
                background: pay.slipPhase === "done" ? "#e1efed" : "#f4f6f3",
                color: pay.slipPhase === "done" ? "#16695f" : "#414539",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6, overflow: "hidden",
              }}
            >
              {pay.slipPhase === "uploading" ? "Uploading…"
                : pay.slipPhase === "done" ? "Slip attached ✓"
                : pay.slipPhase === "error" ? "Retry upload"
                : "Upload slip"}
            </button>
          </div>
        </div>
        {pay.slipPhase !== "done" && (
          <div style={{ fontSize: 10, color: "#a16a2e" }}>Planned — add a slip to record this payment on the order.</div>
        )}
      </div>
    </div>
  );
}

/* ── Review step (Step 5) — a read-only summary of every card before submit.
   Money is an ESTIMATE (server recomputes on save). doc_no is server-minted, so
   it reads "Assigned on save" until the SO exists. */
function ReviewStep({
  name, phone, email, custType, custRef, buildingType, venue, procDate, delivDate, note,
  addressLater, addr1, addr2, state, city, postcode, lines, pays, isEdit, subtotal, docNo,
}: {
  name: string; phone: string; email: string; custType: string; custRef: string;
  buildingType: string; venue: string; procDate: string; delivDate: string; note: string;
  addressLater: boolean; addr1: string; addr2: string; state: string; city: string; postcode: string;
  lines: LineItem[]; pays: Payment[]; isEdit: boolean; subtotal: number; docNo?: string;
}) {
  const R = ({ l, v }: { l: string; v: string }) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "3px 0" }}>
      <span style={{ fontSize: 11, color: "#767b6e" }}>{l}</span>
      <span style={{ fontSize: 12, color: "#11140f", fontWeight: 600, textAlign: "right" }}>{v || "—"}</span>
    </div>
  );
  const named = lines.filter((l) => l.name.trim() || l.itemCode.trim());
  const variantLine = (l: LineItem): string => {
    const v = l.variants;
    const parts: string[] = [];
    if (l.cat === "sofa") {
      if (v.fabricCode) parts.push(`Fabric ${v.fabricCode}`);
      if (v.seatHeight) parts.push(`Seat ${v.seatHeight}`);
      if (v.legHeight) parts.push(`Leg ${v.legHeight}`);
    } else if (l.cat === "bedframe") {
      if (v.fabricCode) parts.push(`Fabric ${v.fabricCode}`);
      if (v.divanHeight) parts.push(`Divan ${v.divanHeight}`);
      if (v.legHeight) parts.push(`Leg ${v.legHeight}`);
      if (v.gap) parts.push(`Gap ${v.gap}`);
      if (v.totalHeight) parts.push(`Total ${v.totalHeight}`);
    }
    return parts.join(" · ");
  };
  return (
    <>
      <div className="card" style={{ marginBottom: 11 }}>
        <div className="card-h"><span className="card-t">Review</span><span className="card-sub">{isEdit ? "Confirm changes" : "Confirm before create"}</span></div>
        <div className="card-b">
          <div style={{ fontSize: 10, color: "#9aa093", marginBottom: 6 }}>Doc No · {docNo || "Assigned on save"}</div>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", color: "#11140f", margin: "6px 0 2px" }}>Customer</div>
          <R l="Name" v={name} />
          <R l="Phone" v={phone ? `+60 ${phone}` : ""} />
          <R l="Email" v={email} />
          <R l="Type" v={custType} />
          <R l="SO Ref" v={custRef} />
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", color: "#11140f", margin: "10px 0 2px" }}>Order info</div>
          <R l="Building" v={buildingType} />
          <R l="Venue" v={venue} />
          <R l="Processing" v={procDate} />
          <R l="Delivery" v={delivDate} />
          <R l="Note" v={note} />
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", color: "#11140f", margin: "10px 0 2px" }}>Delivery address</div>
          {addressLater ? (
            <R l="Address" v="Fill in later" />
          ) : (
            <R l="Address" v={[addr1, addr2, city, state, postcode].filter(Boolean).join(", ")} />
          )}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 11 }}>
        <div className="card-h"><span className="card-t">Line items</span><span className="card-sub">{`${named.length} ${named.length === 1 ? "line" : "lines"}`}</span></div>
        <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {named.map((l) => (
            <div key={l.key} style={roItemBox}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: "#11140f" }}>{l.name || l.itemCode} <span style={{ color: "#9aa093" }}>{"×"}{num(l.qty)}</span></span>
                <span className="money" style={{ fontSize: 12.5, fontWeight: 800, color: "#0c3f39" }}>RM {fmt((toCenti(l.price) * num(l.qty)) / 100)}</span>
              </div>
              {variantLine(l) && <div style={{ fontSize: 10.5, color: "#767b6e", marginTop: 3 }}>{variantLine(l)}</div>}
              {l.remark.trim() && <div style={{ fontSize: 10.5, color: "#9aa093", marginTop: 2 }}>{l.remark.trim()}</div>}
            </div>
          ))}
          <div className="so-sub-row"><span style={{ fontSize: 11, color: "var(--mut)" }}>Subtotal (estimate)</span><span className="money" style={{ fontSize: 17, fontWeight: 800, color: "var(--brand-d)" }}>RM {fmt(subtotal / 100)}</span></div>
          <div style={{ fontSize: 10, color: "#9aa093" }}>The system recomputes the authoritative total when you save.</div>
        </div>
      </div>

      {!isEdit && pays.length > 0 && (
        <div className="card" style={{ marginBottom: 11 }}>
          <div className="card-h"><span className="card-t">Payments</span><span className="card-sub">{pays.length} to record</span></div>
          <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {pays.map((p) => (
              <div key={p.key} style={roItemBox}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ fontSize: 12, color: "#414539" }}>{p.date} {"·"} {p.method}{p.slipPhase === "done" ? "" : " (planned)"}</span>
                  <span className="money" style={{ fontSize: 12.5, fontWeight: 700, color: "#0c3f39" }}>RM {fmt(num(p.amount))}</span>
                </div>
              </div>
            ))}
            <div style={{ fontSize: 10, color: "#a16a2e" }}>Only slip-backed payments are recorded on create.</div>
          </div>
        </div>
      )}
    </>
  );
}

// ---- Shared inline styles ---------------------------------------------------

const prefixBox: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "0 10px",
  background: "#f4f6f3",
  border: "1px solid rgba(34,31,32,.14)",
  borderRight: "none",
  borderRadius: "9px 0 0 9px",
  fontSize: 12.5,
  fontWeight: 700,
  color: "#414539",
};
const roItemBox: React.CSSProperties = {
  border: "1px solid #eceee9",
  borderRadius: 10,
  padding: "9px 11px",
  marginBottom: 7,
};
