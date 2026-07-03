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
import "./mobile.css";

/* ---------------------------------------------------------------------------
 * MobileNewSO — mobile New / Edit Sales Order FORM. 1:1 with the owner's mobile
 * design (#new-so): Customer / Order Info / Emergency Contact / Delivery Address
 * / Line Items (per-line delivery date + optional bedframe build panel) /
 * Payments cards, all under the .hz-m scope. Presentation ports the design's
 * verbatim markup + CSS classes (.hdr / .so-card / .so-hd / .so-ti / .so-sub /
 * .so-bd / .fld / .fld-l / .fld-i / .addline / .so-sub-row / .actbar / .btn from
 * mobile.css). Wired to the real backend:
 *
 *   • CREATE  POST  /mfg-sales-orders            (new / edit-draft) → { docNo }
 *   • EDIT    PATCH /mfg-sales-orders/:docNo      (header fields only)
 *   • PREFILL GET   /mfg-sales-orders/:docNo      (header + items)
 *             GET   /mfg-sales-orders/:docNo/payments
 *
 * The backend recomputes honest pricing and mints the doc_no server-side, so we
 * never send a doc_no. Money crosses the wire as *_centi integers.
 *
 * LINE ITEMS: each line picks a REAL catalog SKU via MobileSkuPicker (the
 * searchable bottom-sheet over useMfgProducts → GET /mfg-products). On CREATE we
 * send items[] with the picked item_code + item_group + variants + qty (mirrors
 * desktop's POST); the server recomputes the honest price and rejects >0.5%
 * drift, so we NEVER send an authoritative price — the unit price we send is a
 * catalog default only, and a blank processing/delivery date pair keeps the
 * order a plain draft (the server pairs-guards proc/deliv, so we submit them
 * all-or-nothing).
 *
 * On EDIT the PATCH /:docNo endpoint accepts HEADER fields only; line-item
 * mutations flow through the dedicated /:docNo/items endpoints. So the existing
 * lines load into the SAME editable cards and, on save, we diff them against the
 * frozen snapshot: added lines → POST /:docNo/items, changed lines → PATCH
 * /:docNo/items/:itemId, removed lines → DELETE /:docNo/items/:itemId (in-app
 * confirm). Line edits are locked (read-only) once the SO is SHIPPED+ / has a
 * downstream DO/SI (has_children), mirroring desktop. Payments stay read-only in
 * edit mode (their own screen owns them).
 * ------------------------------------------------------------------------- */

type Mode = "new" | "edit" | "edit-draft";

/* Per-line scan meta — the verbatim slip row, the SKU Claude suggested + its
   confidence, and the itemCode the scan seeded. Keyed by the seeded line's
   `key` so the on-save learning POST can pair the operator's final line against
   the AI original. */
type ScanLineMetaSeed = { rawText: string; suggestedCode: string; confidence: number; seededCode: string; seededName: string };

/* Line category — drives which variant panel shows (matches the new design's
   category-aware line card). "sofa"/"bedframe" map to the backend item_group;
   "" leaves the line a plain free-typed item (no mandatory variants). */
type LineCat = "" | "sofa" | "bedframe";

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
  // Sofa spec
  fabric: string;
  seat: string;
  // Bedframe spec
  size: string;
  head: string;
  store: string;
  // Bedframe build (also the sofa leg pick reuses `leg`)
  divan: string;
  leg: string;
  gap: string;
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
];
// Sofa spec option lists (mirror the new design's NSO_* arrays)
const FABRIC_OPTS = ["BO315-22 · Boston Charcoal", "BO315-04 · Boston Sand", "VL220-11 · Velour Teal"];
const SEAT_OPTS = ['22"', '24"', '26"'];
// Bedframe spec option lists
const SIZE_OPTS = ["Single", "Super Single", "Queen", "King"];
const HEAD_OPTS = ['Slim 20"', 'Standard 28"', 'Tall 40"', "No headboard"];
const STORE_OPTS = ["No storage", "Side drawer ×2", "Hydraulic lift"];
const DIVAN_OPTS = ['8"', '10"', '12"'];
const LEG_OPTS = ['4"', '6"', '8"'];
const GAP_OPTS = ['0"', '1"', '2"'];
// Payment method-aware sub-field option lists
const BANK_OPTS = ["Maybank", "CIMB", "Public Bank", "HSBC", "RHB"];
const PLAN_OPTS = ["One Shot", "6 months", "12 months", "24 months", "36 months"];
const ONLINE_OPTS = ["Bank Transfer", "TNG eWallet", "DuitNow", "Cheque"];

const uid = () => Math.random().toString(36).slice(2, 10);
const num = (s: string) => parseFloat(String(s).replace(/,/g, "")) || 0;
const toCenti = (s: string) => Math.round(num(s) * 100);
const fromCenti = (c: number | null | undefined) =>
  ((c ?? 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (n: number) => n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inchNum = (s: string) => parseInt(s, 10) || 0;

function newLine(): LineItem {
  return {
    key: uid(), itemCode: "", itemGroup: "", itemId: "",
    name: "", qty: "1", price: "0.00", ddate: "", remark: "", photo: false, cat: "",
    fabric: FABRIC_OPTS[0], seat: '24"',
    size: "Queen", head: 'Standard 28"', store: "No storage",
    divan: '10"', leg: '6"', gap: '1"',
  };
}

/* item_group (catalog category, lowercase) → the line's `cat` axis, which
   drives the sofa/bedframe variant panels. Only sofa/bedframe have panels;
   every other group (mattress/accessory/others/service) is a plain line. */
function catForGroup(group: string | null | undefined): LineCat {
  const g = (group ?? "").toLowerCase();
  return g === "sofa" ? "sofa" : g === "bedframe" ? "bedframe" : "";
}

/* Build a line's `variants` blob the same way the create path does, so ONE
   builder feeds both the create body and the edit-mode POST/PATCH. Mirrors
   desktop's canonical variant keys (bedframe: divanHeight/legHeight/gap/
   fabricCode(+size/headboard/storage descriptive); sofa: seatHeight/legHeight/
   fabricCode). remark rides as variants.remark AND the dedicated column. */
function buildVariants(l: LineItem): Record<string, unknown> {
  const variants: Record<string, unknown> = {};
  if (l.remark.trim()) variants.remark = l.remark.trim();
  if (l.cat === "bedframe") {
    variants.size = l.size;
    variants.headboard = l.head;
    variants.storage = l.store;
    variants.divanHeight = l.divan;
    variants.legHeight = l.leg;
    variants.gap = l.gap;
    variants.fabricCode = l.fabric;
    variants.totalHeight = inchNum(l.divan) + inchNum(l.leg) + inchNum(l.gap);
  } else if (l.cat === "sofa") {
    variants.seatHeight = l.seat;
    variants.legHeight = l.leg;
    variants.fabricCode = l.fabric;
  }
  return variants;
}

/* Map a persisted SoItem (edit prefill) back into an editable LineItem. Reads
   the descriptive variant keys buildVariants writes, dual-reading nothing new
   (variants is a free-form blob, not driver-camelCased). Falls back to the
   newLine() defaults for any axis the stored blob didn't carry. */
function lineFromItem(it: SoItem): LineItem {
  const base = newLine();
  const v = (it.variants ?? {}) as Record<string, unknown>;
  const str = (x: unknown, fallback: string) => (typeof x === "string" && x ? x : fallback);
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
    remark: it.remark ?? str(v.remark, ""),
    cat,
    fabric: str(v.fabricCode, base.fabric),
    seat: str(v.seatHeight, base.seat),
    size: str(v.size, base.size),
    head: str(v.headboard, base.head),
    store: str(v.storage, base.store),
    divan: str(v.divanHeight, base.divan),
    leg: str(v.legHeight, base.leg),
    gap: str(v.gap, base.gap),
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

/* Method label → the backend's payment method enum (merchant | transfer | cash
 * | installment). Kept here for reference; payment ROWS are not POSTed on
 * create (each needs an uploaded slip session — see TODO(verify) below), so
 * this map is applied only if/when the slip-upload flow is wired. */
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

  /* One-shot seed derived from the scan handoff (new-from-scan only). Fields the
     mobile form binds to a fixed dropdown list (State / Customer Type / Building
     Type / payment method) only seed when the scanned value is IN that list —
     an off-list value is left blank for the operator to pick (never a bogus
     option). Everything else (free-text) seeds verbatim. Computed once; the
     scanPrefill prop is stable for this screen's lifetime (MobileApp remounts
     the screen on navigation), so reading it in the state initializers is safe
     and can't stomp later operator edits. */
  const scanLines: Array<{ line: LineItem; meta: ScanLineMetaSeed }> = (scanPrefill?.lines ?? []).map((l) => {
    const line: LineItem = { ...newLine(), name: l.name, qty: l.qty || "1", price: l.price || "0.00", remark: l.remark };
    return { line, meta: { rawText: l.rawText, suggestedCode: l.suggestedCode, confidence: l.confidence, seededCode: l.itemCode, seededName: l.name } };
  });
  const seededLineMeta: Record<string, ScanLineMetaSeed> = {};
  for (const { line, meta } of scanLines) seededLineMeta[line.key] = meta;
  const inList = (v: string, list: string[]) => (list.includes(v) ? v : "");

  /* Seed ONE payment row per captured payment slip (scanPrefill.payments[]),
     each carrying its OCR'd method/amount/approval. Method is mapped through the
     dropdown list (an off-list method stays blank for the operator to pick).
     Each row starts in the "uploading" phase and its carried File is stashed in
     `scanSlipFiles` (keyed by row.key) so the on-mount effect below can pre-upload
     it and attach the resulting slip session — mirroring PayCard.onPickSlip — so
     recordSlipBackedPayments posts all N slip-backed rows on create.
     Back-compat: when only the single `payment` (no `payments` array) is present,
     seed one slip-less row exactly as before. Computed once — scanPrefill is
     stable for this screen's lifetime (see note above). */
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
  /* Captured payment-slip Files from the scan handoff, keyed by seeded row.key —
     consumed once by the on-mount effect that pre-uploads them. Held in a ref (not
     state) so it never re-renders and is read exactly once. */
  const scanSlipFilesRef = useRef<Record<string, File>>(scanSlipFilesInit);
  // In edit mode: the ORIGINAL persisted items (frozen snapshot) used to diff
  // against the editable `lines` on save — POST added, PATCH changed, DELETE
  // removed. Payments stay read-only here (own screen).
  const [origItems, setOrigItems] = useState<SoItem[]>([]);
  const [existingPays, setExistingPays] = useState<SoPayment[]>([]);
  /* Line-mutation lock (edit mode) — mirrors desktop SalesOrderDetail: line
     add/edit/delete is blocked once the SO is SHIPPED+ / INVOICED / CLOSED /
     CANCELLED or has a non-cancelled downstream DO/SI (has_children). The
     backend also enforces this (soHasDownstream → 409); we gate the UI so the
     operator never sends a doomed request. */
  const [lineLocked, setLineLocked] = useState(false);
  // SKU picker sheet — the line key it was opened for, or null when closed.
  const [pickerFor, setPickerFor] = useState<string | null>(null);

  const [loading, setLoading] = useState(isEdit);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  /* ── Scan-Order review state (scanPrefill only) ─────────────────────────
     Mirrors SalesOrderNew.tsx's fromScan carry-through. We keep the frozen
     AI-original slip + sampleId + salesperson so SAVE can run the same
     edit-gate learning POST desktop does, plus the AI-prefilled baseline (per
     field) so scan-filled fields show a subtle "scanned" hint, and per-line
     scan meta (rawText + suggested code) so the learning POST can pair the
     operator's final line against the AI original. */
  const [scanSampleId] = useState<string | null>(scanPrefill?.sampleId ?? null);
  const [scanSalesperson] = useState<string | null>(scanPrefill?.salesperson ?? null);
  const [scanAiOriginal] = useState<ExtractedSlip | null>(scanPrefill?.aiOriginal ?? null);
  type ScanBaseline = {
    name?: string; custRef?: string; phone?: string;
    custType?: string; buildingType?: string; venue?: string; note?: string;
    procDate?: string; delivDate?: string;
    addr1?: string; state?: string; city?: string; postcode?: string;
  };
  /* AI-prefilled baseline (only fields the seed actually filled) — a field
     whose current value equals its baseline is still showing the AI's guess, so
     it gets the subtle "scanned" hint. A field the scan left blank has no
     baseline entry and never shows the hint. */
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
        // Customer SO ref lives in customer_so_no (desktop's field); fall back
        // to the legacy `ref` column for older mobile-created rows.
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
        /* Load the persisted lines into the editable list (skip cancelled
           rows — they're history, not editable). Keep the frozen snapshot for
           the save-time diff. When the SO has no live lines, seed one blank
           editable card so the operator can add the first item. */
        const liveItems = (detail.items ?? []).filter((it) => !it.cancelled);
        setOrigItems(liveItems);
        const editable = liveItems.map(lineFromItem);
        setLines(editable.length ? editable : [newLine()]);
        setExistingPays(payResp.payments ?? []);
        /* Lock line mutations on SHIPPED+ / has_children (desktop parity). */
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

  /* ── Pre-upload scan-seeded payment slips (new-from-scan only) ───────────
     Each payment row seeded from scanPrefill.payments[] carries a captured File
     (stashed in scanSlipFilesRef by key). On mount we upload every one via the
     same uploadSlipFull({ file }) call PayCard.onPickSlip uses, then attach the
     returned slip session to its row so recordSlipBackedPayments posts all N on
     create. Runs async in the background — never blocks the form render; a failed
     upload flips just that row to "error" (operator re-attaches from the row).
     Each row started in "uploading". Fires once on mount. */
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
  /* Display-only subtotal from the on-screen line prices. This is an ESTIMATE
     for the operator — the server recomputes every line's honest price on save,
     so the authoritative total lands on the SO detail after save. Lines are the
     single source in both new + edit mode now (edit loads persisted lines into
     the editable list). */
  const subtotal = useMemo(
    () => lines.reduce((a, l) => a + toCenti(l.price) * num(l.qty), 0),
    [lines],
  );
  const paidTotal = useMemo(() => {
    if (isEdit) return existingPays.reduce((a, p) => a + (p.amount_centi ?? 0), 0);
    return pays.reduce((a, p) => a + toCenti(p.amount), 0);
  }, [isEdit, existingPays, pays]);
  const balance = Math.max(0, subtotal - paidTotal);

  const title = mode === "edit-draft" ? "Edit Draft" : mode === "edit" ? "Edit" : "New Sales Order";

  // ---- Validation -----------------------------------------------------------
  const emailOk = !email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const nameErr = !name.trim();
  const phoneErr = !phone.trim();
  const emailErr = !email.trim() || !emailOk;

  /* Scanned hint — a field the scan filled shows a subtle "scanned" tag until
     the operator changes it (once changed it's their own value, no tag). Only
     meaningful on a scan-seeded SO (null baseline → never shown). */
  const scanned = (key: keyof ScanBaseline, current: string): boolean => {
    if (!scanBaseline) return false;
    const base = scanBaseline[key];
    if (base === undefined || base === "") return false;
    return current === base;
  };

  /* ── Edit-gate learning (scan-seeded SO only) ──────────────────────────
     Mirrors SalesOrderNew.tsx's maybeLearnFromScan. We rebuild the operator's
     FINAL values into the ExtractedSlip shape and compare against the frozen
     AI-original; if anything the OCR can learn from changed, POST
     /scan-so/samples/:id/confirm so the correction becomes a few-shot example +
     re-distills the rep's rules. Fire-and-forget — never blocks or fails save.
     The mobile form has no dropdown masters, so option picks are recorded as
     operator-confirmed matches (the free-text final value wins). */
  const maybeLearnFromScan = () => {
    if (!fromScan || !scanSampleId || !scanAiOriginal) return;
    const ai = scanAiOriginal;
    const optMatch = (v: string) => (v ? { value: v, confidence: 1, reason: "operator-confirmed" } : null);
    const norm = (s: string | null | undefined) => (s ?? "").trim();
    // Operator phone is national (no +60); compare against the AI's raw phones by
    // digits so a formatting-only difference doesn't count as a correction.
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
    // Line count differing (operator added / removed a row) is a correction.
    if (finalLines.length !== ai.lines.length) changed = true;
    for (const l of finalLines) {
      const meta = scanLineMeta[l.key];
      // A line with no scan meta was added by the operator → a correction. A
      // seeded line whose NAME the operator retyped is the OCR's lesson (mobile
      // has no SKU code, so the name is the learnable field).
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
      // Per-line correction — pair the slip's verbatim rawText (carried from the
      // scan) with the operator's FINAL name/qty/price so the distiller learns
      // this rep's handwriting. Mobile has no SKU code, so skuMatch stays null.
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

  /* Post-create payment recording — the SO-create body's payments[] omits
     onlineType / accountSheet / collectedBy / paidAt, so to preserve the full
     sub-field set the design captures we record each SLIP-BACKED row AFTER the
     SO exists, through the same POST /:docNo/payments the SO-detail screen uses.
     Rows WITHOUT a slip are never posted (the backend requires a slip); they
     stayed on-screen as display-only "planned" rows with a slip-required hint,
     so nothing is silently dropped. Fires after create; a failed row surfaces a
     notify but never rolls back the created SO. */
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

  /* Line-item body for POST /:docNo/items and the create body's items[]. We
     send item_code + item_group + qty + variants + per-line delivery date + an
     optional discount. The unit price rides along as a DEFAULT (mirrors what
     desktop POSTs) — the server RECOMPUTES it honestly and rejects >0.5% drift,
     so this figure is never authoritative. A blank itemCode is impossible here:
     the save gate below blocks unpicked lines (POST /:docNo/items 400s on a
     blank code anyway). */
  const itemBody = (l: LineItem): Record<string, unknown> => ({
    itemCode: l.itemCode,
    itemGroup: l.itemGroup || "others",
    description: l.name.trim(),
    qty: num(l.qty) || 1,
    unitPriceCenti: toCenti(l.price),
    lineDeliveryDate: l.ddate || null,
    ...(Object.keys(buildVariants(l)).length ? { variants: buildVariants(l) } : {}),
  });

  /* PATCH body for an existing line — item_code + item_group + qty + discount +
     variants (server recomputes price). Sent only for a line whose priced shape
     actually moved (see lineChanged). */
  const itemPatchBody = (l: LineItem): Record<string, unknown> => ({
    itemCode: l.itemCode,
    itemGroup: l.itemGroup || "others",
    description: l.name.trim(),
    qty: num(l.qty) || 1,
    unitPriceCenti: toCenti(l.price),
    lineDeliveryDate: l.ddate || null,
    variants: buildVariants(l),
  });

  /* Did this edit-mode line change vs its persisted snapshot? Compares the
     priced/identifying shape (code, group, qty, delivery date, variants) plus
     description. Variants compare key-order-independently (Postgres jsonb
     reorders keys) so an untouched line isn't re-PATCHed (which could trip the
     backend's allowed_options re-validation on a since-changed pool). */
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

  /* Reconcile the editable `lines` against the frozen `origItems` snapshot,
     applying each change through the dedicated /items endpoints. Returns the
     number of writes that failed (each write is independent so one failure
     doesn't abort the rest). */
  async function applyLineDiff(soDocNo: string): Promise<number> {
    const base = `/mfg-sales-orders/${encodeURIComponent(soDocNo)}/items`;
    let failed = 0;
    // DELETE — snapshot rows whose id is no longer in the editable list.
    const liveIds = new Set(lines.map((l) => l.itemId).filter(Boolean));
    for (const snap of origItems) {
      if (liveIds.has(snap.id)) continue;
      try { await authedFetch(`${base}/${encodeURIComponent(snap.id)}`, { method: "DELETE" }); }
      catch { failed += 1; }
    }
    // POST (new) / PATCH (changed) — walk the editable list.
    const snapById = new Map(origItems.map((s) => [s.id, s]));
    for (const l of lines) {
      if (!l.itemCode.trim()) continue; // unpicked lines are blocked earlier
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
      return;
    }
    /* Honest-pricing prerequisite — every non-empty line MUST carry a real
       catalog itemCode (picked from the SKU sheet) so the server can price it.
       A named-but-unpicked line is blocked with a clear message rather than
       silently sent (and rejected) with a blank code. */
    const namedLines = lines.filter((l) => l.name.trim() || l.itemCode.trim());
    const unpicked = namedLines.filter((l) => !l.itemCode.trim());
    if (unpicked.length > 0) {
      setError(`Pick a product from the catalog for every line (${unpicked.length} line${unpicked.length === 1 ? "" : "s"} still ha${unpicked.length === 1 ? "s" : "ve"} no product selected).`);
      return;
    }
    // Save as Draft forces blank processing/delivery dates (the existing
    // blank-date behavior keeps the order a plain draft); a normal Create keeps
    // the pairs-guard so proc/deliv are set together or both empty.
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
        // EDIT — header fields only (line items / payments have their own endpoints).
        const patch: Record<string, unknown> = {
          debtorName: name.trim(),
          // Matches desktop SO Detail's PATCH: customer_so_no via `customerSoNo`.
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

        /* Line-item diff → the dedicated /items endpoints (only when line edits
           are allowed — a locked SO shows lines read-only and skips this). The
           header PATCH above never touches lines, so we reconcile the editable
           list against the frozen snapshot:
             • line with no itemId          → POST   /:docNo/items       (added)
             • line whose priced shape moved → PATCH  /:docNo/items/:id  (changed)
             • snapshot id absent from list  → DELETE /:docNo/items/:id  (removed)
           Every write is server-recomputed; we never send an authoritative
           price. A failed write surfaces a notify but leaves the header saved. */
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
      // Real item_code + item_group + variants + qty per line; the server
      // recomputes the honest price (fixes the old RM 0.00 blank-code path).
      const items = namedLines.map((l) => itemBody(l));

      const body: Record<string, unknown> = {
        customerName: name.trim(),
        debtorName: name.trim(),
        // Customer's own SO reference → customer_so_no (desktop sends
        // `customerSoNo`, backend writes it to customer_so_no on create;
        // sending `ref` mis-routed it to the unrelated `ref` column).
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
        // Payments are NOT sent inline on create. The create body's payments[]
        // omits onlineType / accountSheet / collectedBy / paidAt, so to keep the
        // full sub-field set we record each slip-backed row AFTER create through
        // POST /:docNo/payments (recordSlipBackedPayments below) — the same path
        // the SO-detail screen uses. Slip-less rows stay display-only "planned".
      };

      const res = await authedFetch<{ docNo: string }>(`/mfg-sales-orders`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      // Record the slip-backed payment rows against the freshly-created SO.
      if (res?.docNo) await recordSlipBackedPayments(res.docNo);
      // Edit-gate learning (scan-seeded SO only) — fire-and-forget, after the
      // SO exists so a learning failure never blocks the save.
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
  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button className="back" onClick={onBack}><span className="chev">{"‹"}</span> Cancel</button>
          {mode === "edit" ? null : <span className="badge b-grey">Draft</span>}
        </div>
        <div id="nso-title" className="scr-title" style={{ marginTop: 6 }}>{title}</div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 12, paddingBottom: 24 }}>
        {loading ? (
          <div style={{ textAlign: "center", color: "#9aa093", fontSize: 12, padding: "40px 0" }}>Loading{"…"}</div>
        ) : (
          <>
            {fromScan && (
              <div style={{ display: "flex", alignItems: "flex-start", gap: 9, marginBottom: 9, padding: "10px 12px", background: "#eaf2f0", border: "1px solid #cfe1dc", borderRadius: 12 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none", marginTop: 1 }}><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" /><circle cx="12" cy="13" r="3" /></svg>
                <div style={{ fontSize: 11.5, color: "#16695f", lineHeight: 1.5 }}>
                  Prefilled from your scan. Review every field marked <b>Scanned</b>, correct anything the reader missed, then create the order.
                </div>
              </div>
            )}

            {/* Customer */}
            <div className="card" style={{ marginBottom: 11 }}>
              <div className="card-h"><span className="card-t">Customer</span></div>
              {/* Field order + two-column pairing ported from the owner's design
                  MobileNewSO Customer card: Name / Phone+Email / Customer type +
                  Salesperson / Customer SO ref. All fields, validation, scanned
                  hints and the +60 prefix box are ours, kept intact. */}
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

            {/* Order Info */}
            <div className="card" style={{ marginBottom: 11 }}>
              <div className="card-h"><span className="card-t">Order info</span></div>
              {/* Two-column pairing from the design Order info card: Building type
                  + Venue / Processing + Delivery / Note. */}
              <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                <div style={{ display: "flex", gap: 9 }}>
                  <Field label="Building Type" style={{ flex: 1 }} scanned={scanned("buildingType", buildingType)}>
                    <select className="fld-i" value={buildingType} onChange={(e) => setBuildingType(e.target.value)}>
                      {BUILDING_TYPES.map((t) => <option key={t} value={t}>{t || "—"}</option>)}
                    </select>
                  </Field>
                  <Field label="Venue" style={{ flex: 1 }} scanned={scanned("venue", venue)}>
                    <input className="fld-i" value={venue} onChange={(e) => setVenue(e.target.value)} placeholder="Exhibition / outlet venue" />
                  </Field>
                </div>
                <div style={{ display: "flex", gap: 9 }}>
                  <Field label="Processing Date" style={{ flex: 1 }} scanned={scanned("procDate", procDate)}>
                    <input className="fld-i" type="date" value={procDate} onChange={(e) => setProcDate(e.target.value)} />
                  </Field>
                  <Field label="Delivery Date" style={{ flex: 1 }} scanned={scanned("delivDate", delivDate)}>
                    <input className="fld-i" type="date" value={delivDate} onChange={(e) => setDelivDate(e.target.value)} />
                  </Field>
                </div>
                <Field label="Note" scanned={scanned("note", note)}>
                  <input className="fld-i" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Internal notes — SO detail only" />
                </Field>
              </div>
            </div>

            {/* Emergency Contact */}
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

            {/* Delivery Address */}
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
                    {/* Country is fixed to Malaysia; Sales Location is derived
                        server-side from the salesperson's active venue, so both
                        are shown read-only here (inert — no create-form source). */}
                    <div style={{ display: "flex", gap: 11 }}>
                      <Field label="Country" style={{ flex: 1 }}>
                        <input className="fld-i" value="Malaysia" disabled />
                      </Field>
                      <Field label="Sales Location" style={{ flex: 1 }}>
                        <input className="fld-i" value="Auto (from salesperson)" disabled />
                      </Field>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Line Items — editable in BOTH new + edit mode (edit loads the
                persisted lines into the same cards; the diff on save applies to
                the /items endpoints). Locked read-only once the SO is SHIPPED+ /
                has downstream docs (desktop parity). */}
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
                          removable={lines.length > 1}
                          onOpenPicker={() => setPickerFor(l.key)}
                          onChange={(patch) => setLines((prev) => prev.map((x) => (x.key === l.key ? { ...x, ...patch } : x)))}
                          onRemove={async () => {
                            /* No naked deletes — confirm in-app. A persisted line
                               (itemId) is only actually removed from the SO when
                               the diff runs on Save; dropping it from the list
                               here stages that DELETE. */
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

            {/* Payments */}
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

            {error && <div style={{ marginTop: 4, fontSize: 12, color: "#b23a3a", textAlign: "center", padding: "0 4px" }}>{error}</div>}
          </>
        )}
      </div>

      {!loading && (
        <footer className="actbar">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 9 }}>
            <span style={{ fontSize: 11.5, color: "var(--mut)" }}>
              Balance <span className="money" style={{ color: "var(--gold)", fontWeight: 700 }}>RM {fmt(balance / 100)}</span>
            </span>
            <span className="money" style={{ fontSize: 17, fontWeight: 800, color: "var(--brand-d)" }}>RM {fmt(subtotal / 100)}</span>
          </div>
          <div id="nso-footer" style={{ display: "flex", gap: 9 }}>
            {isEdit ? (
              <button className="btn" disabled={submitting} onClick={() => save(false)} style={{ opacity: submitting ? 0.6 : 1 }}>
                {submitting ? "Saving…" : "Save Changes"}
              </button>
            ) : (
              <>
                <button className="btn-ghost" disabled={submitting} onClick={() => save(true)} style={{ flex: 1, opacity: submitting ? 0.6 : 1 }}>
                  {submitting ? "Saving…" : "Save as Draft"}
                </button>
                <button className="btn" disabled={submitting} onClick={() => save(false)} style={{ flex: 1.4, opacity: submitting ? 0.6 : 1 }}>
                  {submitting ? "Saving…" : "Create Sales Order"}
                </button>
              </>
            )}
          </div>
        </footer>
      )}

      {pickerFor && (
        <MobileSkuPicker
          initialCat={lines.find((l) => l.key === pickerFor)?.cat ?? ""}
          onClose={() => setPickerFor(null)}
          onPick={(sku: PickedSku) => {
            /* Seed the line with the real catalog identity. `cat` derives from
               the picked group so the right variant panel shows; the unit price
               defaults from the catalog SELLING price (server recomputes on
               save). We deliberately DON'T stomp the operator's typed qty /
               remark / already-picked variants. */
            setLines((prev) => prev.map((x) => {
              if (x.key !== pickerFor) return x;
              return {
                ...x,
                itemCode: sku.itemCode,
                itemGroup: sku.itemGroup,
                name: sku.name,
                cat: catForGroup(sku.itemGroup),
                price: fromCenti(sku.unitPriceCenti),
              };
            }));
            setPickerFor(null);
          }}
        />
      )}
    </div>
  );
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

/* Subtle marker that a field still holds the AI-scanned value (clears once the
   operator edits it). Mirrors desktop's blue-diff idea, minimal for mobile. */
function ScannedTag() {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "1px 6px", borderRadius: 999, background: "#eaf2f0", color: "#16695f", fontSize: 8, fontWeight: 700, letterSpacing: ".04em" }}>
      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" /><circle cx="12" cy="13" r="3" /></svg>
      SCANNED
    </span>
  );
}

function LineCard({
  line,
  index,
  removable,
  onOpenPicker,
  onChange,
  onRemove,
}: {
  line: LineItem;
  index: number;
  removable: boolean;
  onOpenPicker: () => void;
  onChange: (patch: Partial<LineItem>) => void;
  onRemove: () => void;
}) {
  const amt = fmt(num(line.qty) * num(line.price));
  const catLabel = LINE_CATS.find((c) => c.value === line.cat)?.label ?? "General item";
  const picked = Boolean(line.itemCode.trim());
  return (
    <div style={{ border: "1px solid rgba(34,31,32,.12)", borderRadius: 11, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "#f4f6f3", borderBottom: "1px solid rgba(34,31,32,.1)" }}>
        <span style={{ width: 19, height: 19, flex: "none", borderRadius: 6, background: "#16695f", color: "#fff", fontSize: 10.5, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>{index + 1}</span>
        {/* SKU picker trigger — replaces the old free-typed name. Tapping opens
            the searchable catalog bottom-sheet; the picked product's code + name
            drive the line's item_code (so the server can price it). */}
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
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <Field label="Category" style={{ flex: 1 }}>
            <select className="fld-i" value={line.cat} onChange={(e) => onChange({ cat: e.target.value as LineCat })}>
              {LINE_CATS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </Field>
          <span style={{ flex: 1, textAlign: "right", fontSize: 11, color: "#9aa093", paddingBottom: 9 }}>
            Amount <b className="money" style={{ fontSize: 13, fontWeight: 800, color: "#0c3f39" }}>RM {amt}</b>
          </span>
        </div>

        {line.cat === "sofa" && (
          <>
            <SpecSel label="Fabric / colour" value={line.fabric} opts={FABRIC_OPTS} onChange={(v) => onChange({ fabric: v })} />
            <div style={{ display: "flex", gap: 9 }}>
              <SpecSel label="Seat height" value={line.seat} opts={SEAT_OPTS} onChange={(v) => onChange({ seat: v })} />
              <SpecSel label="Leg height" value={line.leg} opts={LEG_OPTS} onChange={(v) => onChange({ leg: v })} />
            </div>
          </>
        )}

        {line.cat === "bedframe" && (
          <>
            <div style={{ display: "flex", gap: 8 }}>
              <SpecSel label="Size" value={line.size} opts={SIZE_OPTS} onChange={(v) => onChange({ size: v })} />
              <SpecSel label="Headboard" value={line.head} opts={HEAD_OPTS} onChange={(v) => onChange({ head: v })} />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <SpecSel label="Fabric / colour" value={line.fabric} opts={FABRIC_OPTS} onChange={(v) => onChange({ fabric: v })} />
              <SpecSel label="Storage" value={line.store} opts={STORE_OPTS} onChange={(v) => onChange({ store: v })} />
            </div>
            <div style={{ background: "#f4f6f3", border: "1px solid #e3e6e0", borderRadius: 10, padding: "9px 10px" }}>
              <div className="fld-l" style={{ marginBottom: 7 }}>Bedframe build</div>
              <div style={{ display: "flex", gap: 8 }}>
                <SpecSel label="Divan" value={line.divan} opts={DIVAN_OPTS} onChange={(v) => onChange({ divan: v })} />
                <SpecSel label="Leg" value={line.leg} opts={LEG_OPTS} onChange={(v) => onChange({ leg: v })} />
                <SpecSel label="Gap" value={line.gap} opts={GAP_OPTS} onChange={(v) => onChange({ gap: v })} />
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8, paddingTop: 8, borderTop: "1px solid #e3e6e0", fontSize: 11, color: "#767b6e" }}>
                Total height <strong className="money" style={{ color: "#0c3f39", fontSize: 13 }}>{inchNum(line.divan) + inchNum(line.leg) + inchNum(line.gap)}{'"'}</strong>
              </div>
            </div>
          </>
        )}

        <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
          <Field label="Remark" style={{ flex: 1 }}>
            <input className="fld-i" value={line.remark} onChange={(e) => onChange({ remark: e.target.value })} placeholder="e.g. LHF chaise facing window" />
          </Field>
          {line.photo ? (
            <button
              type="button"
              onClick={() => onChange({ photo: false })}
              title={catLabel + " reference photo captured"}
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

function SpecSel({ label, value, opts, onChange }: { label: string; value: string; opts: string[]; onChange: (v: string) => void }) {
  return (
    <Field label={label} style={{ flex: 1 }}>
      <select className="fld-i" value={value} onChange={(e) => onChange(e.target.value)}>
        {opts.map((o) => <option key={o} value={o}>{o}</option>)}
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
            <SpecSel label="Bank" value={pay.bank} opts={BANK_OPTS} onChange={(v) => onChange({ bank: v })} />
            <SpecSel label="Plan" value={pay.plan} opts={PLAN_OPTS} onChange={(v) => onChange({ plan: v })} />
          </div>
        )}
        {pay.method === "Installment" && (
          <SpecSel label="Installment plan" value={pay.plan} opts={PLAN_OPTS} onChange={(v) => onChange({ plan: v })} />
        )}
        {pay.method === "Online" && (
          <SpecSel label="Sub-type" value={pay.online} opts={ONLINE_OPTS} onChange={(v) => onChange({ online: v })} />
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
