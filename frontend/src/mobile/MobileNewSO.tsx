import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { uploadSlipFull } from "../vendor/scm/lib/slip";
import { useStaff } from "../vendor/scm/lib/admin-queries";
import { useAuth } from "../vendor/scm/lib/auth";
import { useVenues } from "../vendor/scm/lib/venues-queries";
import { useStateWarehouseMappings } from "../vendor/scm/lib/state-warehouse-queries";
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
 * MobileNewSO — mobile New / Edit Sales Order as ONE single scrolling form
 * (owner rejected the 5-step wizard 2026-07-03). Every section — Customer,
 * Order info, Items, Payment — renders stacked in a single scroll with ONE
 * primary action at the bottom (Save draft / Create Sales Order / Save
 * Changes). Both NEW and EDIT are single-form.
 *
 * WIRED TO THE REAL BACKEND (unchanged contract):
 *   • CREATE  POST  /mfg-sales-orders            (new / edit-draft) → { docNo }
 *   • EDIT    PATCH /mfg-sales-orders/:docNo      (header fields only)
 *   • ITEMS   POST/PATCH/DELETE /mfg-sales-orders/:docNo/items
 *   • PHOTOS  POST  /mfg-sales-orders/:docNo/items/:id/photos (per-line photo)
 *   • PREFILL GET   /mfg-sales-orders/:docNo      (header + items)
 *             GET   /mfg-sales-orders/:docNo/payments
 *   • PAY     POST  /mfg-sales-orders/:docNo/payments (slip-backed rows)
 *   • VENUE   GET   /mfg-sales-orders/active-venue (derived venue)
 * The backend recomputes honest pricing and mints the doc_no server-side, so we
 * never send a doc_no and money crosses the wire as *_centi integers.
 *
 * CATEGORY-AWARE LINE VARIANTS — wired to the SAME real hooks the desktop
 * SoLineCard uses (NOT hardcoded arrays):
 *   • Fabrics  ← useFabricColoursActive() + fabric_library series via
 *               useFabricLibrary(); the Fabric picker is a SEARCHABLE modal
 *               (700+ colours) not a native <select>.
 *   • Sofa     Seat height ← maintenanceConfig.sofaSizes
 *              Leg height  ← maintenanceConfig.sofaLegHeights
 *   • Bedframe Gap   ← maintenanceConfig.gaps
 *              Divan ← maintenanceConfig.divanHeights
 *              Leg   ← maintenanceConfig.legHeights
 *              totalHeight (= divan + leg + gap) is COMPUTED into the variants
 *              blob for the backend, but no longer shown (owner: hide it).
 * Per-SKU allowed_options (Modular ON/OFF) filter every pool via
 * useModelAllowedOptionsByCode, exactly as SoLineCard does. The REQUIRED axes
 * per category are the shared so-variant-rule; Save is blocked when any line is
 * missing a required axis.
 *
 * Sofa follower-line inherit (mirror desktop SoLineCard inheritVariantsByCategory
 * + overriddenKeys): follower sofa/bedframe lines inherit the FIRST same-category
 * line's variants, BUT a manually-changed follower value WINS.
 * ------------------------------------------------------------------------- */

type Mode = "new" | "edit" | "edit-draft";

/* Per-line scan meta — the verbatim slip row, the SKU Claude suggested + its
   confidence, and the itemCode the scan seeded. */
type ScanLineMetaSeed = { rawText: string; suggestedCode: string; confidence: number; seededCode: string; seededName: string };

/* Line category — drives which variant panel shows (matches the desktop
   SoLineCard). Only sofa/bedframe have mandatory variant panels; every other
   group (mattress/accessory/others) is a plain line. */
type LineCat = "" | "sofa" | "bedframe" | "mattress";

type LineItem = {
  key: string;
  itemCode: string;
  itemGroup: string;
  itemId: string;
  name: string;
  qty: string;
  price: string; // RM, as typed — display/default only; server recomputes
  ddate: string; // per-line delivery date (ISO yyyy-mm-dd)
  remark: string;
  cat: LineCat;
  /* variants — the canonical variant blob, SAME keys the desktop SoLineCard /
     POST /mfg-sales-orders write. */
  variants: Record<string, unknown>;
  /* PR #147 parity — client-only set of variant keys this line was MANUALLY
     edited for. The master-follower cascade leaves an overridden key alone. */
  overriddenKeys: string[];
  /* Per-line photos. Already-saved R2 object keys (edit prefill) + staged File
     objects (uploaded against the itemId after the SO/items save, mirroring the
     desktop pendingPhotoFiles drain). */
  photoKeys: string[];
  photoFiles: File[];
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
  // Slip capture
  slipName: string;
  slipSession: string;
  slipPhase: "" | "uploading" | "done" | "error";
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
  venue_id?: string | null;
  venueId?: string | null;
  sales_location?: string | null;
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
  /* Saved per-line photo R2 object keys — dual-read camelCase / snake_case
     (the pg driver camelCases result columns; the API may expose either). */
  photo_urls?: string[] | null;
  photoUrls?: string[] | null;
  cancelled: boolean | null;
};
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
/* Payment method-aware sub-field option lists (payment-terminal metadata, not
   product variants — no product-config table, so they stay literal). */
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
    name: "", qty: "1", price: "0.00", ddate: "", remark: "", cat: "",
    variants: {}, overriddenKeys: [], photoKeys: [], photoFiles: [],
  };
}

/* item_group (catalog category, lowercase) → the line's `cat` axis. */
function catForGroup(group: string | null | undefined): LineCat {
  const g = (group ?? "").toLowerCase();
  return g === "sofa" ? "sofa" : g === "bedframe" ? "bedframe" : g === "mattress" ? "mattress" : "";
}

/* Build a line's outgoing `variants` blob for the create/edit body. We fold in
   the remark + a fresh computed totalHeight for bedframes (kept for the backend
   even though the readout is hidden). */
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

/* Line-item body for POST /:docNo/items and the create body's items[]. Pure +
   module-level so BOTH the interactive save() and the headless
   createDraftFromPrefill() below shape a line identically (no copy-paste). */
function buildItemBody(l: LineItem): Record<string, unknown> {
  const variants = buildVariants(l);
  return {
    itemCode: l.itemCode,
    itemGroup: l.itemGroup || "others",
    description: l.name.trim(),
    qty: num(l.qty) || 1,
    unitPriceCenti: toCenti(l.price),
    lineDeliveryDate: l.ddate || null,
    ...(Object.keys(variants).length ? { variants } : {}),
  };
}

/* ── Headless draft-create from a scan prefill ───────────────────────────────
   The owner wants "OCR 了直接進 SO draft 做": after scanning, a DRAFT SO should
   be created in the background WITHOUT the operator reviewing the form, and it
   must survive the operator navigating away / pressing Cancel.

   This is the SAME create call the interactive form fires on "Save draft":
   POST /mfg-sales-orders with the dates left null (which the backend treats as a
   DRAFT). We deliberately REUSE the pure body-shaping (newLine seeding + the
   module-level buildItemBody, identical to the interactive path) instead of
   duplicating it, and we DO NOT touch the backend's honest-pricing recompute —
   the server mints the doc_no and prices exactly as it does for a hand-saved
   draft.

   What a headless draft intentionally omits vs. the interactive save: venue /
   salesLocation resolution (those come from live hooks — active-venue, staff,
   state→warehouse — that only exist inside the mounted form) AND slip-backed
   payments (those are recorded only after the SO exists, from uploaded slip
   sessions the mounted form owns). A DRAFT is a skeleton the operator opens and
   reviews later, where the venue auto-fill, variant panels and payment capture
   run normally; omitting them here is safe because venueId is optional on the
   create body and the draft carries no delivery dates or payments yet.

   Returns the minted docNo. Throws on failure so the caller can show a plain-
   language notify (it never leaves a phantom — a failed POST creates nothing). */
export async function createDraftFromPrefill(prefill: MobileScanPrefill): Promise<string> {
  // Map each scanned line into a minimal LineItem, exactly as the interactive
  // form seeds `lines` from scanPrefill (name / qty / price / remark), then
  // shape it through the shared buildItemBody.
  const lines: LineItem[] = (prefill.lines ?? []).map((l) => ({
    ...newLine(),
    name: l.name,
    qty: l.qty || "1",
    price: l.price || "0.00",
    itemCode: l.itemCode || "",
    remark: l.remark,
  }));
  // Same "named line" filter the interactive create uses — a line counts once it
  // has a name or a matched itemCode (drops blank rows).
  const namedLines = lines.filter((l) => l.name.trim() || l.itemCode.trim());
  const items = namedLines.map((l) => buildItemBody(l));

  // Phone shaping mirrors save(): the prefill carries national digits, the +60
  // prefix is re-attached here (the form's prefix box owns it interactively).
  const phoneOut = prefill.phone.trim() ? "+60" + prefill.phone.replace(/\s+/g, "") : null;
  const ecPhoneOut = prefill.emergencyPhone.trim() ? "+60" + prefill.emergencyPhone.replace(/\s+/g, "") : null;

  const body: Record<string, unknown> = {
    customerName: prefill.name.trim(),
    debtorName: prefill.name.trim(),
    customerSoNo: prefill.custRef.trim() || null,
    phone: phoneOut,
    customerType: inListOpt(prefill.customerType, CUSTOMER_TYPES) || null,
    buildingType: inListOpt(prefill.buildingType, BUILDING_TYPES) || null,
    note: prefill.note.trim() || null,
    address1: prefill.address1.trim() || null,
    customerState: inListOpt(prefill.state, STATES) || null,
    city: prefill.city.trim() || null,
    postcode: prefill.postcode.trim() || null,
    // DRAFT: no dates (the interactive "Save draft" nulls these too).
    internalExpectedDd: null,
    customerDeliveryDate: null,
    emergencyContactPhone: ecPhoneOut,
    items,
  };

  const res = await authedFetch<{ docNo: string }>(`/mfg-sales-orders`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return res?.docNo ?? "";
}

/* Keep a value only when it's one of the known option strings (empty otherwise) —
   the headless equivalent of the component's `inList` seed guard, so a stray OCR
   value never reaches the backend as an invalid enum. */
function inListOpt(v: string | null | undefined, list: string[]): string {
  const s = (v ?? "").trim();
  return list.includes(s) ? s : "";
}

/* Map a persisted SoItem (edit prefill) back into an editable LineItem. */
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
    photoKeys: Array.isArray(it.photoUrls) ? it.photoUrls : Array.isArray(it.photo_urls) ? it.photo_urls : [],
    photoFiles: [],
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

type Opt = { value: string; label: string };
type VariantPools = {
  ready: boolean; // maintenance config loaded (pools meaningful)
  fabricColours: FabricColourRow[];
  fabricSeries: Map<string, string>; // fabricId → series label
  maint: MaintenanceConfig | null;
};

export function MobileNewSO({
  mode,
  docNo,
  scanPrefill,
  onBack,
  onSaved,
}: {
  mode: Mode;
  docNo?: string;
  scanPrefill?: MobileScanPrefill;
  onBack: () => void;
  onSaved?: (docNo: string) => void;
}) {
  const qc = useQueryClient();
  const notify = useNotify();
  const confirm = useConfirm();
  const staffQ = useStaff();
  const { staff: authStaff } = useAuth();
  const isEdit = mode === "edit" || mode === "edit-draft";

  /* ── Real variant sources — the SAME hooks the desktop SoLineCard reads. */
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

  /* One-shot seed derived from the scan handoff (new-from-scan only). */
  const scanLines: Array<{ line: LineItem; meta: ScanLineMetaSeed }> = (scanPrefill?.lines ?? []).map((l) => {
    const line: LineItem = { ...newLine(), name: l.name, qty: l.qty || "1", price: l.price || "0.00", remark: l.remark };
    return { line, meta: { rawText: l.rawText, suggestedCode: l.suggestedCode, confidence: l.confidence, seededCode: l.itemCode, seededName: l.name } };
  });
  const seededLineMeta: Record<string, ScanLineMetaSeed> = {};
  for (const { line, meta } of scanLines) seededLineMeta[line.key] = meta;
  const inList = (v: string, list: string[]) => (list.includes(v) ? v : "");

  /* Seed ONE payment row per captured payment slip. */
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
  const [procDate, setProcDate] = useState(scanPrefill?.processingDate ?? "");
  const [delivDate, setDelivDate] = useState(scanPrefill?.deliveryDate ?? "");
  const [note, setNote] = useState(scanPrefill?.note ?? "");

  // Emergency contact
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
  const [origItems, setOrigItems] = useState<SoItem[]>([]);
  const [existingPays, setExistingPays] = useState<SoPayment[]>([]);
  const [lineLocked, setLineLocked] = useState(false);
  // Prefill venue (edit) — used to seed the manual venue pick.
  const [prefillVenueId, setPrefillVenueId] = useState<string | null>(null);
  const [prefillVenueName, setPrefillVenueName] = useState<string>("");
  // SKU picker sheet — the line key it was opened for, or null when closed.
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  // Fabric picker sheet — the line key it was opened for, or null when closed.
  const [fabricPickerFor, setFabricPickerFor] = useState<string | null>(null);

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
    custType?: string; buildingType?: string; note?: string;
    procDate?: string; delivDate?: string;
    addr1?: string; state?: string; city?: string; postcode?: string;
  };
  const [scanBaseline] = useState<ScanBaseline | null>(
    scanPrefill
      ? {
          name: scanPrefill.name, custRef: scanPrefill.custRef, phone: scanPrefill.phone,
          custType: custType, buildingType: buildingType,
          note: scanPrefill.note,
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
        setPrefillVenueId(h.venueId ?? h.venue_id ?? null);
        setPrefillVenueName(h.venue ?? "");
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
    scanSlipFilesRef.current = {}; // consume once
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

  // ---- Derived Venue / Sales Location (desktop parity) ----------------------
  const venuesQ = useVenues();
  const staffList = useMemo(() => (staffQ.data ?? []).filter((s) => s.active), [staffQ.data]);
  const selectedStaff = useMemo(
    () => staffList.find((s) => s.id === salespersonId) ?? null,
    [staffList, salespersonId],
  );

  /* Houzs venue auto-fill (owner 2026-06-25) — the logged-in salesperson's
     active exhibition project already knows this week's venue. Declared BEFORE
     resolvedVenueName so the memo can read it (no TDZ). */
  const [autoVenue, setAutoVenue] = useState<{
    venueId: string | null; venueName: string | null; projectName: string | null;
  } | null>(null);
  useEffect(() => {
    if (isEdit) return; // edit keeps the persisted venue
    let alive = true;
    authedFetch<{ venueId: string | null; venueName: string | null; projectName: string | null }>(
      "/mfg-sales-orders/active-venue",
    )
      .then((r) => { if (alive) setAutoVenue(r); })
      .catch(() => {});
    return () => { alive = false; };
  }, [isEdit]);

  /* Venue derives from the picked salesperson's staff.venue_id (falls back to
     the auth user's own venue, the persisted venue on edit, or the active
     project's venue). Mirrors SalesOrderNew resolvedVenue*. It stays read-only
     on mobile (the owner scopes venue picking to the desktop). */
  const resolvedVenueId: string | null =
    prefillVenueId ?? selectedStaff?.venueId ?? authStaff?.venueId ?? autoVenue?.venueId ?? null;
  const resolvedVenueName: string = useMemo(() => {
    if (resolvedVenueId) {
      const v = (venuesQ.data ?? []).find((r) => r.id === resolvedVenueId);
      if (v?.name) return v.name;
    }
    return prefillVenueName || autoVenue?.venueName || "";
  }, [resolvedVenueId, venuesQ.data, prefillVenueName, autoVenue]);

  /* Sales Location derives from state_warehouse_mappings for the picked state
     (desktop parity: SalesOrderNew state → salesLocation cascade). */
  const stateWarehousesQ = useStateWarehouseMappings();
  const salesLocation: string = useMemo(() => {
    if (!state) return "";
    const list = stateWarehousesQ.data?.mappings ?? [];
    const hit = list.find((m) => m.state === state);
    return hit?.warehouse?.code ?? "";
  }, [state, stateWarehousesQ.data]);

  /* Effective venue to SEND on save (resolvedVenueId already folds in the
     persisted / salesperson / active-project fallbacks). */
  const outgoingVenueId = resolvedVenueId;
  const outgoingVenueName = resolvedVenueName;

  // ---- Totals ---------------------------------------------------------------
  const subtotal = useMemo(
    () => lines.reduce((a, l) => a + toCenti(l.price) * num(l.qty), 0),
    [lines],
  );

  const title = mode === "edit-draft" ? "Edit Draft" : mode === "edit" ? "Edit Sales Order" : "New Sales Order";

  // ---- Validation -----------------------------------------------------------
  /* Email is NOT required (owner 2026-07-03). Required = customer name + phone.
     If an email IS typed it must still be well-formed. */
  const emailProvided = Boolean(email.trim());
  const emailFormatOk = !emailProvided || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const nameErr = !name.trim();
  const phoneErr = !phone.trim();
  const emailErr = emailProvided && !emailFormatOk; // only an error when a BAD email is typed
  const dateXorErr = Boolean(procDate) !== Boolean(delivDate); // set together or both empty

  /* Dynamic "missing required fields" message — names ONLY what's actually
     missing/invalid (owner: don't say "name, phone and email" when only email
     is empty; email is optional anyway). */
  const missingCustomerMsg = (): string | null => {
    const miss: string[] = [];
    if (nameErr) miss.push("customer name");
    if (phoneErr) miss.push("phone");
    if (emailErr) miss.push("a valid email");
    if (miss.length === 0) return null;
    const joined = miss.length === 1 ? miss[0] : miss.slice(0, -1).join(", ") + " and " + miss[miss.length - 1];
    return `Fill in ${joined}.`;
  };

  const namedLines = useMemo(() => lines.filter((l) => l.name.trim() || l.itemCode.trim()), [lines]);
  const unpickedLines = useMemo(() => namedLines.filter((l) => !l.itemCode.trim()), [namedLines]);
  const linesMissingVariants = useMemo(
    () => namedLines.filter((l) => l.itemCode.trim() && missingVariantAxes(l.itemGroup, l.variants).length > 0),
    [namedLines],
  );

  /* Per-category variants captured from the FIRST line of that category that
     has any variants set. Mirrors SalesOrderNew.inheritVariantsByCategory. */
  const inheritVariantsByCategory = useMemo(() => {
    const out: Record<string, Record<string, unknown>> = {};
    for (const l of lines) {
      const cat = l.itemGroup;
      if (!cat || out[cat]) continue;
      if (l.variants && Object.keys(l.variants).length > 0) out[cat] = l.variants;
    }
    return out;
  }, [lines]);

  /* Follower-line inherit cascade (mirror SoLineCard master-follower): when the
     FIRST same-category line's variants change, copy each variant key onto
     follower lines of that category — UNLESS the follower manually overrode that
     key (overriddenKeys wins). The first line of each category is the master. */
  useEffect(() => {
    setLines((prev) => {
      const masterByCat = new Map<string, LineItem>();
      for (const l of prev) {
        if (!l.itemCode.trim() || !l.itemGroup) continue;
        if (!masterByCat.has(l.itemGroup)) masterByCat.set(l.itemGroup, l);
      }
      let mutated = false;
      const next = prev.map((l) => {
        if (!l.itemCode.trim() || !l.itemGroup) return l;
        const master = masterByCat.get(l.itemGroup);
        if (!master || master.key === l.key) return l; // masters are untouched
        if (l.cat !== "sofa" && l.cat !== "bedframe") return l;
        const overrides = new Set(l.overriddenKeys);
        const merged: Record<string, unknown> = { ...l.variants };
        let changed = false;
        for (const [k, v] of Object.entries(master.variants)) {
          if (k === "remark") continue; // remark is per-line, never inherited
          if (overrides.has(k)) continue; // manual override wins
          if (merged[k] !== v) { merged[k] = v; changed = true; }
        }
        if (changed) { mutated = true; return { ...l, variants: merged }; }
        return l;
      });
      return mutated ? next : prev;
    });
    // Depend on the master variants (JSON) so the cascade re-runs on any master
    // edit; overriddenKeys guards keep manual follower values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(inheritVariantsByCategory)]);

  /* Scanned hint — a field the scan filled shows a subtle "scanned" tag. */
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

  /* Post-save per-line photo upload. Uploads each staged File against the saved
     itemId (mirrors the desktop pendingPhotoFiles drain). On CREATE we re-fetch
     the items to pair each line's staged files with its minted id (matched by
     item_code + description in order). */
  async function uploadStagedPhotos(soDocNo: string) {
    const withFiles = lines.filter((l) => l.photoFiles.length > 0);
    if (withFiles.length === 0) return;
    // Resolve each staged line to a saved itemId. In edit mode a persisted line
    // already carries itemId; otherwise pair against the freshly saved items.
    let saved: SoItem[] = [];
    const needsLookup = withFiles.some((l) => !l.itemId);
    if (needsLookup) {
      try {
        const detail = await authedFetch<DetailResp>(`/mfg-sales-orders/${encodeURIComponent(soDocNo)}`);
        saved = (detail.items ?? []).filter((it) => !it.cancelled);
      } catch { /* best-effort */ }
    }
    const claimed = new Set<string>();
    const resolveId = (l: LineItem): string | null => {
      if (l.itemId) return l.itemId;
      const hit = saved.find((s) =>
        !claimed.has(s.id) &&
        (s.item_code ?? "") === l.itemCode &&
        (s.description ?? "") === l.name.trim(),
      ) ?? saved.find((s) => !claimed.has(s.id) && (s.item_code ?? "") === l.itemCode);
      if (hit) { claimed.add(hit.id); return hit.id; }
      return null;
    };
    let failed = 0;
    for (const l of withFiles) {
      const itemId = resolveId(l);
      if (!itemId) { failed += l.photoFiles.length; continue; }
      for (const file of l.photoFiles) {
        try {
          const fd = new FormData();
          fd.append("file", file);
          await authedFetch(`/mfg-sales-orders/${encodeURIComponent(soDocNo)}/items/${encodeURIComponent(itemId)}/photos`, {
            method: "POST", body: fd,
          });
        } catch { failed += 1; }
      }
    }
    if (failed > 0) {
      void notify({ title: "Some photos didn't upload", body: `${failed} line photo(s) failed to upload. Add them again from the SO detail screen.`, tone: "error" });
    }
  }

  /* Line-item body for POST /:docNo/items and the create body's items[].
     Delegates to the module-level buildItemBody (shared with the headless
     createDraftFromPrefill). */
  const itemBody = buildItemBody;

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
    const custMsg = missingCustomerMsg();
    if (custMsg) { setError(custMsg); return; }
    if (namedLines.length < 1) { setError("Add at least one line item."); return; }
    if (unpickedLines.length > 0) {
      setError(`Pick a product from the catalog for every line (${unpickedLines.length} line${unpickedLines.length === 1 ? "" : "s"} still ha${unpickedLines.length === 1 ? "s" : "ve"} no product selected).`);
      return;
    }
    if (linesMissingVariants.length > 0) {
      const l = linesMissingVariants[0];
      const miss = missingVariantAxes(l.itemGroup, l.variants).map((a) => a.label).join(", ");
      setError(`Complete the required options (${miss}) on "${l.name || l.itemCode}".`);
      return;
    }
    const procOut = asDraft ? "" : procDate;
    const delivOut = asDraft ? "" : delivDate;
    if (!asDraft && Boolean(procDate) !== Boolean(delivDate)) {
      setError("Processing Date and Delivery Date must be set together, or both left empty.");
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
          email: email.trim() || null,
          customerType: custType || null,
          buildingType: buildingType || null,
          venueId: outgoingVenueId ?? undefined,
          venue: outgoingVenueName || null,
          note: note.trim() || null,
          address1: addressLater ? null : addr1.trim() || null,
          address2: addressLater ? null : addr2.trim() || null,
          customerState: state || null,
          city: city.trim() || null,
          postcode: postcode.trim() || null,
          salesLocation: salesLocation || undefined,
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
          await uploadStagedPhotos(docNo);
        }
        await recordSlipBackedPayments(docNo);

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
        venueId: outgoingVenueId ?? undefined,
        venue: outgoingVenueName || null,
        note: note.trim() || null,
        address1: addressLater ? null : addr1.trim() || null,
        address2: addressLater ? null : addr2.trim() || null,
        customerState: state || null,
        city: city.trim() || null,
        postcode: postcode.trim() || null,
        salesLocation: salesLocation || undefined,
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
      if (res?.docNo) {
        await uploadStagedPhotos(res.docNo);
        await recordSlipBackedPayments(res.docNo);
      }
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

  const patchLine = (key: string, patch: Partial<LineItem>) =>
    setLines((prev) => prev.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  // ---- Render ---------------------------------------------------------------
  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      {/* Header — "Cancel" text button, Draft/Editing pill, title. No wizard
          progress bar (single-form). */}
      <header className="hdr">
        <div className="hdr-row">
          <button type="button" onClick={onBack} style={{ background: "none", border: "none", color: "var(--mut)", fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit", padding: 0 }}>Cancel</button>
          <span className="badge b-grey">{mode === "edit" ? "EDITING" : "DRAFT"}</span>
        </div>
        <div id="nso-title" className="scr-title" style={{ marginTop: 6 }}>{title}</div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 12, paddingBottom: 24 }}>
        {loading ? (
          <div style={{ textAlign: "center", color: "#9aa093", fontSize: 12, padding: "40px 0" }}>Loading{"…"}</div>
        ) : (
          <>
            {fromScan && (
              <div style={{ display: "flex", alignItems: "flex-start", gap: 9, marginBottom: 11, padding: "10px 12px", background: "#eaf2f0", border: "1px solid #cfe1dc", borderRadius: 12 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none", marginTop: 1 }}><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" /><circle cx="12" cy="13" r="3" /></svg>
                <div style={{ fontSize: 11.5, color: "#16695f", lineHeight: 1.5 }}>
                  Prefilled from your scan. Review every field marked <b>Scanned</b>, correct anything the reader missed, then create the order.
                </div>
              </div>
            )}

            {/* ── Customer ────────────────────────────────────────────── */}
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
                  <Field label="Email" style={{ flex: 1 }} error={touched && emailErr}>
                    <input className="fld-i" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Optional" />
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

            {/* ── Emergency Contact ───────────────────────────────────── */}
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

            {/* ── Order info ──────────────────────────────────────────── */}
            <div className="card" style={{ marginBottom: 11 }}>
              <div className="card-h"><span className="card-t">Order info</span></div>
              <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                <div style={{ display: "flex", gap: 9 }}>
                  <Field label="Building Type" style={{ flex: 1 }} scanned={scanned("buildingType", buildingType)}>
                    <select className="fld-i" value={buildingType} onChange={(e) => setBuildingType(e.target.value)}>
                      {BUILDING_TYPES.map((t) => <option key={t} value={t}>{t || "—"}</option>)}
                    </select>
                  </Field>
                  {/* Venue is derived (salesperson's active project / home venue);
                      shown read-only with the resolved NAME (desktop parity). */}
                  <Field label="Venue" style={{ flex: 1 }}>
                    <div className="fld-ro">{resolvedVenueName || "—"}</div>
                  </Field>
                </div>
                {!isEdit && autoVenue?.venueId && autoVenue?.projectName && (
                  <div style={{ fontSize: 10, color: "#16695f", marginTop: -4 }}>Auto-filled from {autoVenue.projectName}</div>
                )}
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
                <div style={{ display: "flex", gap: 9 }}>
                  <Field label="Country" style={{ flex: 1 }}>
                    <div className="fld-ro">Malaysia</div>
                  </Field>
                  {/* Sales Location derives from state → warehouse mapping. */}
                  <Field label="Sales Location" style={{ flex: 1 }}>
                    <div className="fld-ro">{salesLocation || (state ? "Not mapped" : "Pick a state")}</div>
                  </Field>
                </div>
              </div>
            </div>

            {/* ── Delivery address ────────────────────────────────────── */}
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

            {/* ── Line items ──────────────────────────────────────────── */}
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
                          onOpenFabricPicker={() => setFabricPickerFor(l.key)}
                          onChange={(patch) => patchLine(l.key, patch)}
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

            {/* ── Payment ─────────────────────────────────────────────── */}
            <div className="card" style={{ marginBottom: 11 }}>
              <div className="card-h"><span className="card-t">Payments</span><span className="card-sub">Method · amount · slip</span></div>
              <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                {isEdit && existingPays.length > 0 && (
                  <>
                    <div className="fld-l" style={{ marginBottom: 2 }}>Recorded</div>
                    {existingPays.map((p) => (
                      <div key={p.id} style={roItemBox}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                          <span style={{ fontSize: 12, color: "#414539" }}>{(p.paid_at ?? "").slice(0, 10) || "—"} {"·"} {p.method || "—"}</span>
                          <span className="money" style={{ fontSize: 12.5, fontWeight: 700, color: "#0c3f39" }}>RM {fromCenti(p.amount_centi)}</span>
                        </div>
                      </div>
                    ))}
                    <div style={{ height: 4 }} />
                  </>
                )}
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
                    Each payment needs a slip to be recorded. Slip-backed rows are saved to the order on {isEdit ? "Save" : "Create"}; rows without a slip stay as planned entries — add their slip here or from the SO detail screen.
                  </div>
                )}
              </div>
            </div>

            {error && <div style={{ marginTop: 4, fontSize: 12, color: "#b23a3a", textAlign: "center", padding: "0 4px" }}>{error}</div>}
          </>
        )}
      </div>

      {/* Action bar — single primary action per mode+status. Balanced,
          full-width buttons (no Back/Next). */}
      {!loading && (
        <footer id="nso-footer" className="actbar" style={{ display: "flex", gap: 9 }}>
          {mode === "edit" ? (
            <button className="btn" disabled={submitting} onClick={() => save(false)} style={{ flex: 1, opacity: submitting ? 0.6 : 1 }}>
              {submitting ? "Saving…" : "Save Changes"}
            </button>
          ) : (
            <>
              <button className="btn-ghost" disabled={submitting} onClick={() => save(true)} style={{ flex: 1, opacity: submitting ? 0.6 : 1 }}>
                {submitting ? "Saving…" : "Save draft"}
              </button>
              <button className="btn" disabled={submitting} onClick={() => save(false)} style={{ flex: 1, opacity: submitting ? 0.6 : 1 }}>
                {submitting ? "Saving…" : "Create Sales Order"}
              </button>
            </>
          )}
        </footer>
      )}

      {pickerFor && (() => {
        /* Seed an existing base line with a picked SKU's real catalog identity.
           `cat` derives from the picked group so the right variant panel shows.
           Changing the SKU resets the variant blob (a bedframe's divan pool
           differs from a sofa's) BUT seeds same-category followers from the FIRST
           line's variants (mirrors SoLineCard.pickProduct inherit). overriddenKeys
           resets on a fresh pick. Shared by single-pick and multi-pick so every
           new line is a proper pickable line with identical seeding. */
        const seedLine = (base: LineItem, sku: PickedSku): LineItem => {
          const nextCat = catForGroup(sku.itemGroup);
          const inherited = inheritVariantsByCategory[sku.itemGroup];
          const seeded = inherited && Object.keys(inherited).length > 0
            ? { ...inherited }
            : (nextCat === base.cat ? base.variants : {});
          // Don't inherit remark across lines.
          const seededVariants = { ...seeded };
          delete (seededVariants as Record<string, unknown>).remark;
          return {
            ...base,
            itemCode: sku.itemCode,
            itemGroup: sku.itemGroup,
            name: sku.name,
            cat: nextCat,
            price: fromCenti(sku.unitPriceCenti),
            variants: seededVariants,
            overriddenKeys: [],
          };
        };
        return (
          <MobileSkuPicker
            initialCat={mapPickerCat(lines.find((l) => l.key === pickerFor)?.cat)}
            onClose={() => setPickerFor(null)}
            onPick={(sku: PickedSku) => {
              setLines((prev) => prev.map((x) => (x.key === pickerFor ? seedLine(x, sku) : x)));
              setPickerFor(null);
            }}
            onPickMany={(skus: PickedSku[]) => {
              if (skus.length === 0) { setPickerFor(null); return; }
              setLines((prev) => {
                const idx = prev.findIndex((x) => x.key === pickerFor);
                if (idx < 0) return prev;
                // First selection fills the line the picker was opened for; the
                // rest append as fresh lines (each seeded off a blank newLine so
                // it's a proper pickable line). The follower-inherit effect then
                // cascades the first sofa line's fabric/seat/leg to these new
                // sofa followers, with any manual override winning.
                const next = [...prev];
                next[idx] = seedLine(next[idx]!, skus[0]!);
                const extras = skus.slice(1).map((sku) => seedLine(newLine(), sku));
                next.splice(idx + 1, 0, ...extras);
                return next;
              });
              setPickerFor(null);
            }}
          />
        );
      })()}

      {fabricPickerFor && (() => {
        const line = lines.find((l) => l.key === fabricPickerFor);
        return (
          <FabricPicker
            pools={pools}
            current={String(line?.variants.fabricCode ?? "")}
            onClose={() => setFabricPickerFor(null)}
            onPick={(colourId) => {
              const c = pools.fabricColours.find((x) => x.colourId === colourId);
              const seriesLabel = c ? pools.fabricSeries.get(c.fabricId) ?? null : null;
              const patch: Record<string, unknown> = {
                fabricCode: colourId,
                colourId,
                ...(c ? { fabricId: c.fabricId } : {}),
                ...(seriesLabel ? { fabricLabel: seriesLabel } : {}),
                ...(c?.label ? { colourLabel: c.label } : {}),
                ...(c?.swatchHex ? { colourHex: c.swatchHex } : {}),
              };
              setLines((prev) => prev.map((x) => {
                if (x.key !== fabricPickerFor) return x;
                const overrides = Array.from(new Set([...x.overriddenKeys, ...Object.keys(patch)]));
                return { ...x, variants: { ...x.variants, ...patch }, overriddenKeys: overrides };
              }));
              setFabricPickerFor(null);
            }}
          />
        );
      })()}
    </div>
  );
}

/* LineCat → the SKU picker's category chip seed. */
function mapPickerCat(c: LineCat | undefined): "" | "sofa" | "bedframe" {
  return c === "sofa" ? "sofa" : c === "bedframe" ? "bedframe" : "";
}

/* Prefill helper — the stored phone is "+60xxxxxxxx"; strip the +60 prefix. */
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

/* ── Variant pool → option list builders (REAL sources) ─────────────────── */
function restrictS(opts: string[], pool?: string[] | null): string[] {
  return Array.isArray(pool) && pool.length > 0 ? opts.filter((o) => pool.includes(o)) : opts;
}
function restrictP<T extends { value: string }>(opts: T[], pool?: string[] | null): T[] {
  return Array.isArray(pool) && pool.length > 0 ? opts.filter((o) => pool.includes(o.value)) : opts;
}
function sortNumeric<T extends { value: string }>(opts: T[]): T[] {
  return [...opts].sort((a, b) => {
    const na = parseInches(a.value), nb = parseInches(b.value);
    if (na !== nb) return na - nb;
    return a.value.localeCompare(b.value, undefined, { sensitivity: "base" });
  });
}

/* Fabric options — active fabric_colours filtered by the Model's
   allowed_options.fabrics. Used by BOTH the count-check and the searchable
   FabricPicker modal. */
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
  onOpenFabricPicker,
  onChange,
  onRemove,
}: {
  line: LineItem;
  index: number;
  pools: VariantPools;
  removable: boolean;
  showErrors: boolean;
  onOpenPicker: () => void;
  onOpenFabricPicker: () => void;
  onChange: (patch: Partial<LineItem>) => void;
  onRemove: () => void;
}) {
  const amt = fmt(num(line.qty) * num(line.price));
  const picked = Boolean(line.itemCode.trim());
  const v = line.variants;
  const photoInputRef = useRef<HTMLInputElement | null>(null);

  /* Per-SKU allowed_options (Modular ON/OFF), resolved by code. */
  const allowQ = useModelAllowedOptionsByCode(line.itemCode || undefined);
  const allow = allowQ.data ?? null;

  /* A variant edit marks the key as manually-overridden so the follower cascade
     leaves it alone (mirrors SoLineCard setVariants + overriddenKeys). */
  const setVar = (patch: Record<string, unknown>) => {
    const overrides = Array.from(new Set([...line.overriddenKeys, ...Object.keys(patch)]));
    onChange({ variants: { ...line.variants, ...patch }, overriddenKeys: overrides });
  };

  const maint = pools.maint;
  const fabVal = String(v.fabricCode ?? "");
  const fabColourLabel = String(v.colourLabel ?? "");
  const fabOptsCount = fabricOptions(pools, allow, fabVal).length;

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

  const missing = new Set(missingVariantAxes(line.itemGroup, line.variants).map((a) => a.key));

  const addPhotos = (files: File[]) => {
    if (files.length === 0) return;
    onChange({ photoFiles: [...line.photoFiles, ...files] });
  };
  const removeStagedPhoto = (idx: number) => {
    onChange({ photoFiles: line.photoFiles.filter((_, i) => i !== idx) });
  };

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

        {/* Category-aware variant panels — REAL hooks. */}
        {picked && !pools.ready && (
          <div style={{ fontSize: 10.5, color: "#9aa093", padding: "4px 0" }}>Loading options{"…"}</div>
        )}

        {picked && pools.ready && line.cat === "sofa" && (
          <>
            <FabricField
              value={fabVal} colourLabel={fabColourLabel} count={fabOptsCount}
              invalid={showErrors && missing.has("fabricCode")} onOpen={onOpenFabricPicker}
            />
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
            <FabricField
              value={fabVal} colourLabel={fabColourLabel} count={fabOptsCount}
              invalid={showErrors && missing.has("fabricCode")} onOpen={onOpenFabricPicker}
            />
            {/* Bedframe build — 3 selects stacked in a responsive grid so DIVAN /
                LEG / GAP each get full width and read completely (owner: the old
                3-in-a-row cramped them to "No Le"). */}
            <div style={{ background: "#f4f6f3", border: "1px solid #e3e6e0", borderRadius: 10, padding: "9px 10px" }}>
              <div className="fld-l" style={{ marginBottom: 7 }}>Bedframe build</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                <SpecSel label="Divan" required invalid={showErrors && missing.has("divanHeight")}
                  value={String(v.divanHeight ?? "")} opts={bfDivanOpts} onChange={(x) => setVar({ divanHeight: x })} />
                <SpecSel label="Leg" required invalid={showErrors && missing.has("legHeight")}
                  value={String(v.legHeight ?? "")} opts={bfLegOpts} onChange={(x) => setVar({ legHeight: x })} />
                <SpecSel label="Gap" required invalid={showErrors && missing.has("gap")}
                  value={String(v.gap ?? "")} opts={bfGapOpts} onChange={(x) => setVar({ gap: x })} />
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
          {/* Per-line reference photo — the camera opens the file picker and each
              chosen file becomes a thumbnail (owner: the old button just toggled
              a green tick and never uploaded). Staged files upload against the
              line's itemId after the SO saves. */}
          <input
            ref={photoInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={(e) => { addPhotos(Array.from(e.target.files ?? [])); e.target.value = ""; }}
          />
          <button
            type="button"
            onClick={() => photoInputRef.current?.click()}
            title="Attach a reference photo"
            style={{ width: 46, flex: "none", alignSelf: "flex-end", height: 38, border: "1px solid #d6d9d2", borderRadius: 9, background: "#f4f6f3", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" /><circle cx="12" cy="13" r="3" /></svg>
          </button>
        </div>

        {/* Photo thumbnails — already-saved (edit prefill) + staged (this session) */}
        {(line.photoKeys.length > 0 || line.photoFiles.length > 0) && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 1 }}>
            {line.photoKeys.map((k) => (
              <div key={k} style={photoTile}>
                <div style={{ ...photoTileInner, background: "#e1efed", color: "#16695f", fontSize: 8, fontWeight: 700, letterSpacing: ".04em" }}>SAVED</div>
              </div>
            ))}
            {line.photoFiles.map((f, i) => (
              <StagedPhotoThumb key={`${f.name}-${i}`} file={f} onRemove={() => removeStagedPhoto(i)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* Read-only tile style for a persisted (edit) photo — the full thumbnail lives
   on the SO detail screen; here we show a compact marker so the operator knows
   photos exist without a signed-URL round-trip. */
const photoTile: React.CSSProperties = {
  width: 52, height: 52, flex: "none", borderRadius: 9, overflow: "hidden",
  border: "1px solid #d6d9d2", position: "relative",
};
const photoTileInner: React.CSSProperties = {
  width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
};

/* Staged (this-session) photo — object-URL preview + a delete X. Revokes the
   URL on unmount / file change (mirrors the desktop pendingPreviews). */
function StagedPhotoThumb({ file, onRemove }: { file: File; onRemove: () => void }) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <div style={photoTile}>
      <img src={url} alt={file.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      <button
        type="button"
        onClick={onRemove}
        title="Remove (not uploaded yet)"
        style={{ position: "absolute", top: 2, right: 2, width: 16, height: 16, borderRadius: 999, border: "none", background: "rgba(17,20,15,.7)", color: "#fff", fontSize: 10, lineHeight: 1, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
      >{"✕"}</button>
    </div>
  );
}

/* FabricField — a tappable read-only row that opens the searchable FabricPicker
   modal (native <select> with 700+ options is unusable per owner). Shows the
   picked fabric code (+ colour label) or a "Select fabric" placeholder. */
function FabricField({ value, colourLabel, count, invalid, onOpen }: {
  value: string; colourLabel: string; count: number; invalid: boolean; onOpen: () => void;
}) {
  return (
    <Field label="Fabric / colour *">
      <button
        type="button"
        onClick={onOpen}
        className="fld-i"
        style={{
          textAlign: "left", fontFamily: "inherit", cursor: "pointer", display: "flex",
          alignItems: "center", gap: 8, background: "#fff",
          ...(invalid ? { borderColor: "#b23a3a", boxShadow: "0 0 0 2px rgba(178,58,58,.12)" } : null),
        }}
      >
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: value ? "#11140f" : "#9aa093", fontWeight: value ? 700 : 400 }}>
          {value ? (colourLabel ? `${value} — ${colourLabel}` : value) : (count === 0 ? "No fabrics configured" : "Select fabric…")}
        </span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
      </button>
    </Field>
  );
}

/* FabricPicker — searchable bottom-sheet for the 700+ fabric-colours list.
   Mirrors the MobileSkuPicker sheet chrome + search box. Filters by fabric code
   AND colour label. */
function FabricPicker({ pools, current, onPick, onClose }: {
  pools: VariantPools; current: string; onPick: (colourId: string) => void; onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = [...pools.fabricColours].sort((a, b) => a.colourId.localeCompare(b.colourId, undefined, { sensitivity: "base" }));
    if (!q) return all;
    return all.filter((c) =>
      c.colourId.toLowerCase().includes(q) ||
      (c.label ?? "").toLowerCase().includes(q) ||
      (pools.fabricSeries.get(c.fabricId) ?? "").toLowerCase().includes(q),
    );
  }, [pools.fabricColours, pools.fabricSeries, search]);

  return (
    <div className="sheet-bd" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <div className="sheet-head">
          <div>
            <div className="ey" style={{ color: "#a16a2e" }}>Fabric</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#11140f", marginTop: 2 }}>Pick a fabric / colour</div>
          </div>
          <button className="sheet-x" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>

        <div style={{ padding: "0 14px 10px", flex: "none" }}>
          <div className="searchbar">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search fabric code or colour" autoFocus />
          </div>
        </div>

        <div className="sheet-scroll" style={{ gap: 7 }}>
          {rows.length === 0 ? (
            <div style={{ textAlign: "center", color: "#9aa093", fontSize: 12, padding: "28px 0" }}>No fabrics match{search.trim() ? ` "${search.trim()}"` : ""}.</div>
          ) : (
            rows.map((c) => {
              const on = c.colourId === current;
              const series = pools.fabricSeries.get(c.fabricId) ?? "";
              return (
                <button
                  key={c.colourId}
                  type="button"
                  onClick={() => { onPick(c.colourId); onClose(); }}
                  style={{
                    textAlign: "left", width: "100%", boxSizing: "border-box",
                    border: on ? "1px solid #16695f" : "1px solid rgba(34,31,32,.12)",
                    background: on ? "#e1efed" : "#fff",
                    borderRadius: 11, padding: "10px 12px", cursor: "pointer", fontFamily: "inherit",
                    display: "flex", alignItems: "center", gap: 10,
                  }}
                >
                  {c.swatchHex && (
                    <span style={{ width: 22, height: 22, flex: "none", borderRadius: 6, background: c.swatchHex, border: "1px solid rgba(34,31,32,.15)" }} />
                  )}
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: "#11140f" }}>{c.colourId}</span>
                    {(c.label || series) && (
                      <span style={{ display: "block", fontSize: 10.5, color: "#767b6e", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {[series, c.label].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </span>
                  {on && <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}><path d="M20 6 9 17l-5-5" /></svg>}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

/* SpecSel — a labelled <select> bound to a real option list. */
function SpecSel({ label, value, opts, onChange, required = false, invalid = false, emptyHint }: {
  label: string; value: string; opts: Opt[]; onChange: (v: string) => void;
  required?: boolean; invalid?: boolean; emptyHint?: string;
}) {
  const hasCurrent = Boolean(value) && opts.some((o) => o.value === value);
  return (
    <Field label={label + (required ? " *" : "")} style={{ flex: 1, minWidth: 0 }}>
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
