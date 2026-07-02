import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { MobileSkuPicker, type PickedSku } from "./MobileSkuPicker";
import "./mobile.css";

/* ---------------------------------------------------------------------------
 * MobileLineEditor — the shared per-document LINE-ITEM editor for the mobile
 * document detail screen. Every field-ops document (DO / SI / PO / GRN / PI /
 * SR / PR) exposes full per-line CRUD on the backend, but mobile document
 * detail was READ-ONLY for lines. This editor closes that gap by driving each
 * doc type off ONE table of per-doc "shapes" (LINE_SHAPES): each shape knows
 *
 *   • the item endpoints  ->  POST/PATCH/DELETE {basePath}/:id/items[/:itemId]
 *   • how to read a persisted line back into an editable draft (fromItem)
 *   • which draft fields the operator can edit (kind: catalog vs material line;
 *     qty semantics: sell-qty / received-qty / returned-qty)
 *   • the POST body (add) + PATCH body (edit), server-recomputed (honest
 *     pricing stays authoritative — we send item_code + item_group + qty +
 *     variants + a DEFAULT unit price only, never an authoritative total)
 *   • the lock rule (mirrors each desktop detail's isLocked / has_children so a
 *     posted / cancelled / child-bearing doc is read-only, matching the same
 *     backend guard that would otherwise 409).
 *
 * The editor is a bottom sheet opened per line (edit) or blank (add). It never
 * uses window.confirm — deletes route through the in-app useConfirm. Money is
 * *_centi across the wire (RM = centi / 100). Persisted columns are read
 * dual-vocabulary (camelCase ?? snake_case) since the driver camelCases result
 * columns.
 *
 * ADD scope: catalog docs (DO / SI) add a line via MobileSkuPicker (the same
 * searchable /mfg-products sheet the SO editor uses) — a picked SKU seeds
 * item_code + item_group + a default price. Material docs (PO / GRN / PI / SR /
 * PR) reference supplier materials / delivered DO lines that have no mobile
 * picker, so on mobile they support EDIT + DELETE of existing lines (the
 * highest-value gap — e.g. GRN per-line received qty). Adding a brand-new
 * material line stays on desktop (see phase-2 note in the deliver summary).
 * ------------------------------------------------------------------------- */

const num = (s: string) => parseFloat(String(s).replace(/,/g, "")) || 0;
const toCenti = (s: string) => Math.round(num(s) * 100);
const fromCenti = (c: number | null | undefined) =>
  ((c ?? 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (n: number) => n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inchNum = (s: string) => parseInt(s, 10) || 0;

/* Dual-read a driver-camelCased result column (r.camelCase ?? r.snake_case). */
const dr = <T,>(row: any, camel: string, snake: string): T | undefined =>
  (row?.[camel] ?? row?.[snake]) as T | undefined;
const drStr = (row: any, camel: string, snake: string): string => {
  const v = dr<unknown>(row, camel, snake);
  return v == null ? "" : String(v);
};
const drNum = (row: any, camel: string, snake: string): number => {
  const v = dr<unknown>(row, camel, snake);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/* Variant option lists — mirror MobileNewSO's spec pools so an edited bedframe/
   sofa line offers the SAME choices desktop does. */
const FABRIC_OPTS = ["BO315-22 · Boston Charcoal", "BO315-04 · Boston Sand", "VL220-11 · Velour Teal"];
const SEAT_OPTS = ['22"', '24"', '26"'];
const SIZE_OPTS = ["Single", "Super Single", "Queen", "King"];
const HEAD_OPTS = ['Slim 20"', 'Standard 28"', 'Tall 40"', "No headboard"];
const STORE_OPTS = ["No storage", "Side drawer ×2", "Hydraulic lift"];
const DIVAN_OPTS = ['8"', '10"', '12"'];
const LEG_OPTS = ['4"', '6"', '8"'];
const GAP_OPTS = ['0"', '1"', '2"'];
const CONDITION_OPTS = ["NEW", "USED", "DAMAGED", "DEFECTIVE"];

type LineCat = "" | "sofa" | "bedframe";
function catForGroup(group: string | null | undefined): LineCat {
  const g = (group ?? "").toLowerCase();
  return g === "sofa" ? "sofa" : g === "bedframe" ? "bedframe" : "";
}

/* ── Draft — the editable in-sheet shape ─────────────────────────────────────
   A superset covering every doc's editable fields; a shape only surfaces the
   fields it declares (fields[]). itemId "" = a not-yet-persisted add line. */
export type LineDraft = {
  itemId: string;
  itemCode: string;
  itemGroup: string;
  name: string;
  qty: string;
  price: string; // RM as typed — DEFAULT only (server recomputes)
  remark: string;
  condition: string;
  cat: LineCat;
  // Variants
  fabric: string;
  seat: string;
  size: string;
  head: string;
  store: string;
  divan: string;
  leg: string;
  gap: string;
};

function blankDraft(): LineDraft {
  return {
    itemId: "", itemCode: "", itemGroup: "", name: "", qty: "1", price: "0.00",
    remark: "", condition: "NEW", cat: "",
    fabric: FABRIC_OPTS[0], seat: '24"', size: "Queen", head: 'Standard 28"',
    store: "No storage", divan: '10"', leg: '6"', gap: '1"',
  };
}

/* Which editable inputs a shape shows. "qty" label + which extra rows render. */
type LineFieldKey = "price" | "variants" | "condition" | "remark";

type LineShape = {
  /** GET/items base path (relative to /api/scm). Items live at {basePath}/:id/items. */
  basePath: string;
  /** JSON key holding the header in GET {basePath}/:id. */
  headerKey: string;
  /** Human doc noun for copy ("delivery order"). */
  docNoun: string;
  /** How the operator picks a NEW line's product. "catalog" -> SKU picker;
   *  "none" -> add-line disabled on mobile (material/DO-linked docs). */
  addMode: "catalog" | "none";
  /** Qty label — "Qty" / "Received" / "Returned". */
  qtyLabel: string;
  /** Editable rows to show beyond qty. */
  fields: LineFieldKey[];
  /** Read a persisted GET item into an editable draft (dual-vocabulary). */
  fromItem: (it: any) => LineDraft;
  /** Present the line read-only (locked doc) — name, qty label, amount RM. */
  readonly: (it: any) => { name: string; qtyText: string; amountCenti: number };
  /** true -> lines are read-only (mirror desktop isLocked). */
  locked: (h: any) => boolean;
  /** Copy shown when locked. */
  lockedNote: string;
  /** Build the POST body for an added line (camelCase — server maps to columns). */
  addBody: (d: LineDraft) => Record<string, unknown>;
  /** Build the PATCH body for an edited line. */
  patchBody: (d: LineDraft) => Record<string, unknown>;
};

/* Canonical variant blob — identical vocabulary to MobileNewSO.buildVariants so
   an edited line round-trips through the same keys desktop reads. */
function buildVariants(d: LineDraft): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  if (d.remark.trim()) v.remark = d.remark.trim();
  if (d.cat === "bedframe") {
    v.size = d.size; v.headboard = d.head; v.storage = d.store;
    v.divanHeight = d.divan; v.legHeight = d.leg; v.gap = d.gap;
    v.fabricCode = d.fabric;
    v.totalHeight = inchNum(d.divan) + inchNum(d.leg) + inchNum(d.gap);
  } else if (d.cat === "sofa") {
    v.seatHeight = d.seat; v.legHeight = d.leg; v.fabricCode = d.fabric;
  }
  return v;
}
const hasVariants = (d: LineDraft) => Object.keys(buildVariants(d)).length > 0;

/* Read the descriptive variant keys buildVariants writes back into a draft. */
function readVariants(base: LineDraft, it: any, group: string): LineDraft {
  const v = (dr<Record<string, unknown>>(it, "variants", "variants") ?? {}) as Record<string, unknown>;
  const str = (x: unknown, fb: string) => (typeof x === "string" && x ? x : fb);
  return {
    ...base,
    cat: catForGroup(group),
    remark: drStr(it, "notes", "notes") || str(v.remark, ""),
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

/* ── Per-doc shapes ─────────────────────────────────────────────────────────
   Bodies mirror the exact backend contracts (verified against
   backend/src/scm/routes/*). Only the fields relevant to each doc are sent. */
export const LINE_SHAPES: Record<string, LineShape> = {
  // Delivery Order — catalog line (item_code). Locked once INVOICED / CANCELLED
  // or a non-cancelled DR/SI child exists (has_children stamped by GET /:id).
  "delivery-orders-mfg": {
    basePath: "/delivery-orders-mfg",
    headerKey: "deliveryOrder",
    docNoun: "delivery order",
    addMode: "catalog",
    qtyLabel: "Qty",
    fields: ["price", "variants", "remark"],
    locked: (h) =>
      ["INVOICED", "CANCELLED"].includes(String(h?.status ?? "").toUpperCase()) ||
      Boolean(dr<boolean>(h, "hasChildren", "has_children")),
    lockedNote: "Locked — this delivery order is invoiced, cancelled, or has downstream documents.",
    fromItem: (it) => {
      const group = drStr(it, "itemGroup", "item_group").toLowerCase();
      const base: LineDraft = {
        ...blankDraft(),
        itemId: drStr(it, "id", "id"),
        itemCode: drStr(it, "itemCode", "item_code"),
        itemGroup: group,
        name: drStr(it, "description", "description") || drStr(it, "itemCode", "item_code"),
        qty: String(drNum(it, "qty", "qty") || 1),
        price: fromCenti(drNum(it, "unitPriceCenti", "unit_price_centi")),
      };
      return readVariants(base, it, group);
    },
    readonly: (it) => ({
      name: drStr(it, "description", "description") || drStr(it, "itemCode", "item_code") || "—",
      qtyText: `×${drNum(it, "qty", "qty")}`,
      amountCenti: drNum(it, "lineTotalCenti", "line_total_centi"),
    }),
    addBody: (d) => ({
      itemCode: d.itemCode,
      itemGroup: d.itemGroup || "others",
      description: d.name.trim(),
      uom: "UNIT",
      qty: num(d.qty) || 1,
      unitPriceCenti: toCenti(d.price),
      ...(hasVariants(d) ? { variants: buildVariants(d) } : {}),
      ...(d.remark.trim() ? { notes: d.remark.trim() } : {}),
    }),
    patchBody: (d) => ({
      itemCode: d.itemCode,
      itemGroup: d.itemGroup || "others",
      description: d.name.trim(),
      qty: num(d.qty) || 1,
      unitPriceCenti: toCenti(d.price),
      variants: buildVariants(d),
      notes: d.remark.trim() || null,
    }),
  },

  // Sales Invoice — catalog line. Locked only when CANCELLED (SI is a leaf).
  "sales-invoices": {
    basePath: "/sales-invoices",
    headerKey: "salesInvoice",
    docNoun: "invoice",
    addMode: "catalog",
    qtyLabel: "Qty",
    fields: ["price", "variants", "remark"],
    locked: (h) => String(h?.status ?? "").toUpperCase() === "CANCELLED",
    lockedNote: "Locked — this invoice is cancelled.",
    fromItem: (it) => {
      const group = drStr(it, "itemGroup", "item_group").toLowerCase();
      const base: LineDraft = {
        ...blankDraft(),
        itemId: drStr(it, "id", "id"),
        itemCode: drStr(it, "itemCode", "item_code"),
        itemGroup: group,
        name: drStr(it, "description", "description") || drStr(it, "itemCode", "item_code"),
        qty: String(drNum(it, "qty", "qty") || 1),
        price: fromCenti(drNum(it, "unitPriceCenti", "unit_price_centi")),
      };
      return readVariants(base, it, group);
    },
    readonly: (it) => ({
      name: drStr(it, "description", "description") || drStr(it, "itemCode", "item_code") || "—",
      qtyText: `×${drNum(it, "qty", "qty")}`,
      amountCenti: drNum(it, "lineTotalCenti", "line_total_centi"),
    }),
    addBody: (d) => ({
      itemCode: d.itemCode,
      itemGroup: d.itemGroup || "others",
      description: d.name.trim(),
      uom: "UNIT",
      qty: num(d.qty) || 1,
      unitPriceCenti: toCenti(d.price),
      ...(hasVariants(d) ? { variants: buildVariants(d) } : {}),
      ...(d.remark.trim() ? { notes: d.remark.trim() } : {}),
    }),
    patchBody: (d) => ({
      itemCode: d.itemCode,
      itemGroup: d.itemGroup || "others",
      description: d.name.trim(),
      qty: num(d.qty) || 1,
      unitPriceCenti: toCenti(d.price),
      variants: buildVariants(d),
      notes: d.remark.trim() || null,
    }),
  },

  // Purchase Order — material line (material_code). Editable in DRAFT /
  // SUBMITTED / PARTIALLY_RECEIVED without GRN children. Add stays desktop.
  "mfg-purchase-orders": {
    basePath: "/mfg-purchase-orders",
    headerKey: "purchaseOrder",
    docNoun: "purchase order",
    addMode: "none",
    qtyLabel: "Qty",
    fields: ["price", "remark"],
    locked: (h) => {
      const st = String(h?.status ?? "").toUpperCase();
      const editable = st === "DRAFT" || st === "SUBMITTED" || st === "PARTIALLY_RECEIVED";
      return !editable || Boolean(dr<boolean>(h, "hasChildren", "has_children"));
    },
    lockedNote: "Locked — this purchase order is received, cancelled, or has goods receipts.",
    fromItem: (it) => ({
      ...blankDraft(),
      itemId: drStr(it, "id", "id"),
      itemCode: drStr(it, "materialCode", "material_code"),
      itemGroup: drStr(it, "itemGroup", "item_group").toLowerCase(),
      name: drStr(it, "description", "description") || drStr(it, "materialName", "material_name"),
      qty: String(drNum(it, "qty", "qty") || 1),
      price: fromCenti(drNum(it, "unitPriceCenti", "unit_price_centi")),
      remark: drStr(it, "notes", "notes"),
    }),
    readonly: (it) => ({
      name: drStr(it, "materialName", "material_name") || drStr(it, "materialCode", "material_code") || "—",
      qtyText: `×${drNum(it, "qty", "qty")}`,
      amountCenti: drNum(it, "lineTotalCenti", "line_total_centi"),
    }),
    addBody: () => ({}),
    patchBody: (d) => ({
      qty: num(d.qty) || 1,
      unitPriceCenti: toCenti(d.price),
      notes: d.remark.trim() || null,
    }),
  },

  // GRN — the biggest gap: per-line RECEIVED qty edit. `qty` maps to
  // qty_received (server syncs qty_accepted). Editable while DRAFT, or POSTED
  // without PI/PR children.
  grns: {
    basePath: "/grns",
    headerKey: "grn",
    docNoun: "goods receipt",
    addMode: "none",
    qtyLabel: "Received",
    fields: ["price", "remark"],
    locked: (h) => {
      const st = String(h?.status ?? "").toUpperCase();
      return !(st === "DRAFT" || (st === "POSTED" && !dr<boolean>(h, "hasChildren", "has_children")));
    },
    lockedNote: "Locked — this goods receipt is cancelled, closed, or already invoiced/returned.",
    fromItem: (it) => ({
      ...blankDraft(),
      itemId: drStr(it, "id", "id"),
      itemCode: drStr(it, "materialCode", "material_code"),
      itemGroup: drStr(it, "itemGroup", "item_group").toLowerCase(),
      name: drStr(it, "description", "description") || drStr(it, "materialName", "material_name"),
      qty: String(drNum(it, "qtyReceived", "qty_received") || 1),
      price: fromCenti(drNum(it, "unitPriceCenti", "unit_price_centi")),
      remark: drStr(it, "notes", "notes"),
    }),
    readonly: (it) => ({
      name: drStr(it, "materialName", "material_name") || drStr(it, "materialCode", "material_code") || "—",
      qtyText: `Received ${drNum(it, "qtyReceived", "qty_received")}`,
      amountCenti: drNum(it, "lineTotalCenti", "line_total_centi"),
    }),
    addBody: () => ({}),
    patchBody: (d) => ({
      qty: num(d.qty) || 0,
      unitPriceCenti: toCenti(d.price),
      notes: d.remark.trim() || null,
    }),
  },

  // Purchase Invoice — material line. Locked when CANCELLED or a payment exists.
  "purchase-invoices": {
    basePath: "/purchase-invoices",
    headerKey: "purchaseInvoice",
    docNoun: "purchase invoice",
    addMode: "none",
    qtyLabel: "Qty",
    fields: ["price", "remark"],
    locked: (h) =>
      String(h?.status ?? "").toUpperCase() === "CANCELLED" ||
      drNum(h, "paidCenti", "paid_centi") > 0,
    lockedNote: "Locked — this purchase invoice is cancelled or already has a payment.",
    fromItem: (it) => ({
      ...blankDraft(),
      itemId: drStr(it, "id", "id"),
      itemCode: drStr(it, "materialCode", "material_code"),
      itemGroup: drStr(it, "itemGroup", "item_group").toLowerCase(),
      name: drStr(it, "description", "description") || drStr(it, "materialName", "material_name"),
      qty: String(drNum(it, "qty", "qty") || 1),
      price: fromCenti(drNum(it, "unitPriceCenti", "unit_price_centi")),
      remark: drStr(it, "notes", "notes"),
    }),
    readonly: (it) => ({
      name: drStr(it, "materialName", "material_name") || drStr(it, "materialCode", "material_code") || "—",
      qtyText: `×${drNum(it, "qty", "qty")}`,
      amountCenti: drNum(it, "lineTotalCenti", "line_total_centi"),
    }),
    addBody: () => ({}),
    patchBody: (d) => ({
      qty: num(d.qty) || 1,
      unitPriceCenti: toCenti(d.price),
      notes: d.remark.trim() || null,
    }),
  },

  // Sales Return (delivery-returns) — returned qty + condition on a DO-linked
  // line. Locked when REFUNDED / CREDIT_NOTED / CANCELLED.
  "delivery-returns": {
    basePath: "/delivery-returns",
    headerKey: "deliveryReturn",
    docNoun: "sales return",
    addMode: "none",
    qtyLabel: "Returned",
    fields: ["price", "condition", "remark"],
    locked: (h) => ["REFUNDED", "CREDIT_NOTED", "CANCELLED"].includes(String(h?.status ?? "").toUpperCase()),
    lockedNote: "Locked — this return is refunded, credit-noted, or cancelled.",
    fromItem: (it) => ({
      ...blankDraft(),
      itemId: drStr(it, "id", "id"),
      itemCode: drStr(it, "itemCode", "item_code"),
      itemGroup: drStr(it, "itemGroup", "item_group").toLowerCase(),
      name: drStr(it, "description", "description") || drStr(it, "itemCode", "item_code"),
      qty: String(drNum(it, "qtyReturned", "qty_returned") || 1),
      price: fromCenti(drNum(it, "unitPriceCenti", "unit_price_centi")),
      condition: drStr(it, "condition", "condition") || "NEW",
      remark: drStr(it, "notes", "notes"),
    }),
    readonly: (it) => ({
      name: drStr(it, "description", "description") || drStr(it, "itemCode", "item_code") || "—",
      qtyText: `Returned ${drNum(it, "qtyReturned", "qty_returned")}`,
      amountCenti: drNum(it, "lineTotalCenti", "line_total_centi"),
    }),
    addBody: () => ({}),
    patchBody: (d) => ({
      qtyReturned: num(d.qty) || 1,
      unitPriceCenti: toCenti(d.price),
      condition: d.condition || null,
      notes: d.remark.trim() || null,
    }),
  },

  // Purchase Return — returned qty + reason. Editable only while POSTED.
  "purchase-returns": {
    basePath: "/purchase-returns",
    headerKey: "purchaseReturn",
    docNoun: "purchase return",
    addMode: "none",
    qtyLabel: "Returned",
    fields: ["price", "remark"],
    locked: (h) => String(h?.status ?? "").toUpperCase() !== "POSTED",
    lockedNote: "Locked — only a posted purchase return can be edited.",
    fromItem: (it) => ({
      ...blankDraft(),
      itemId: drStr(it, "id", "id"),
      itemCode: drStr(it, "materialCode", "material_code"),
      itemGroup: drStr(it, "itemGroup", "item_group").toLowerCase(),
      name: drStr(it, "description", "description") || drStr(it, "materialName", "material_name"),
      qty: String(drNum(it, "qtyReturned", "qty_returned") || 1),
      price: fromCenti(drNum(it, "unitPriceCenti", "unit_price_centi")),
      remark: drStr(it, "reason", "reason") || drStr(it, "notes", "notes"),
    }),
    readonly: (it) => ({
      name: drStr(it, "materialName", "material_name") || drStr(it, "materialCode", "material_code") || "—",
      qtyText: `Returned ${drNum(it, "qtyReturned", "qty_returned")}`,
      amountCenti: drNum(it, "lineRefundCenti", "line_refund_centi") || drNum(it, "lineTotalCenti", "line_total_centi"),
    }),
    addBody: () => ({}),
    patchBody: (d) => ({
      qty: num(d.qty) || 1,
      unitPriceCenti: toCenti(d.price),
      reason: d.remark.trim() || null,
    }),
  },
};

/* ── The bottom-sheet editor ─────────────────────────────────────────────── */
const inputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", height: 42, padding: "0 12px", borderRadius: 10,
  border: "1px solid #e3e6e0", background: "#fff", fontFamily: "inherit", fontSize: 14, color: "var(--ink)",
};
const selectStyle: React.CSSProperties = { ...inputStyle, appearance: "none", WebkitAppearance: "none" };
const labelStyle: React.CSSProperties = { fontSize: 9.5, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "#9aa093", marginBottom: 5, display: "block" };

function Sel({ label, value, opts, onChange }: { label: string; value: string; opts: string[]; onChange: (v: string) => void }) {
  return (
    <div style={{ flex: 1 }}>
      <label style={labelStyle}>{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={selectStyle}>
        {opts.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

/** Line-edit bottom sheet. `initial` null = an ADD line (catalog docs only). */
function LineEditSheet({ shape, docId, initial, onClose, onSaved }: {
  shape: LineShape; docId: string; initial: LineDraft | null; onClose: () => void; onSaved: () => void;
}) {
  const notify = useNotify();
  const isAdd = initial == null;
  const [draft, setDraft] = useState<LineDraft>(() => initial ?? blankDraft());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<LineDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const showVariants = shape.fields.includes("variants");
  const showPrice = shape.fields.includes("price");
  const showCondition = shape.fields.includes("condition");
  const showRemark = shape.fields.includes("remark");
  const picked = Boolean(draft.itemCode.trim());
  const amount = fmt(num(draft.qty) * num(draft.price));

  const save = async () => {
    if (isAdd && !draft.itemCode.trim()) { setError("Pick a product from the catalog first."); return; }
    const qtyN = num(draft.qty);
    if (!(qtyN > 0)) { setError(`Enter a ${shape.qtyLabel.toLowerCase()} quantity greater than zero.`); return; }
    setError(null);
    setBusy(true);
    try {
      const base = `${shape.basePath}/${encodeURIComponent(docId)}/items`;
      if (isAdd) {
        await authedFetch(base, { method: "POST", body: JSON.stringify(shape.addBody(draft)) });
      } else {
        await authedFetch(`${base}/${encodeURIComponent(draft.itemId)}`, { method: "PATCH", body: JSON.stringify(shape.patchBody(draft)) });
      }
      onSaved();
      onClose();
      void notify({ title: isAdd ? "Line added" : "Line updated" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the line. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 2600, background: "rgba(0,0,0,0.32)", display: "flex", alignItems: "flex-end" }}>
      <div onClick={(e) => e.stopPropagation()} className="hz-m" style={{ width: "100%", maxHeight: "90vh", overflowY: "auto", background: "#fff", borderRadius: "18px 18px 0 0", padding: "18px 16px calc(env(safe-area-inset-bottom) + 16px)", boxShadow: "0 -8px 28px rgba(0,0,0,0.16)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: "var(--ink)" }}>{isAdd ? "Add Line" : "Edit Line"}</div>
          <button onClick={onClose} style={{ border: "none", background: "transparent", fontSize: 15, fontWeight: 700, color: "var(--teal)", cursor: "pointer", fontFamily: "inherit" }}>Close</button>
        </div>

        {/* Product — catalog picker on add; read-only identity on edit / material docs. */}
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Product</label>
          {isAdd && shape.addMode === "catalog" ? (
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              style={{ ...inputStyle, textAlign: "left", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", border: picked ? "1px solid #bcdcd7" : "1px dashed #c2c6bd" }}
            >
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: picked ? "var(--ink)" : "#9aa093", fontWeight: picked ? 700 : 600 }}>
                {picked ? `${draft.name}  ·  ${draft.itemCode}` : "Pick a product…"}
              </span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 6 15 12 9 18" /></svg>
            </button>
          ) : (
            <div style={{ ...inputStyle, display: "flex", alignItems: "center", background: "#f4f6f3", color: "#414539" }}>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {draft.name || draft.itemCode || "—"}{draft.itemCode ? <span style={{ color: "#9aa093" }}>  ·  {draft.itemCode}</span> : null}
              </span>
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>{shape.qtyLabel}</label>
            <input inputMode="decimal" value={draft.qty} onChange={(e) => set({ qty: e.target.value })} style={inputStyle} />
          </div>
          {showPrice && (
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Unit Price (RM)</label>
              <input inputMode="decimal" value={draft.price} onChange={(e) => set({ price: e.target.value })} style={inputStyle} />
            </div>
          )}
        </div>

        {showCondition && (
          <div style={{ marginBottom: 12 }}>
            <Sel label="Condition" value={draft.condition} opts={CONDITION_OPTS} onChange={(v) => set({ condition: v })} />
          </div>
        )}

        {showVariants && (
          <>
            <div style={{ marginBottom: 12 }}>
              <Sel label="Category" value={draft.cat} opts={["", "sofa", "bedframe"]} onChange={(v) => set({ cat: v as LineCat })} />
            </div>
            {draft.cat === "sofa" && (
              <>
                <div style={{ marginBottom: 12 }}><Sel label="Fabric / colour" value={draft.fabric} opts={FABRIC_OPTS} onChange={(v) => set({ fabric: v })} /></div>
                <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                  <Sel label="Seat height" value={draft.seat} opts={SEAT_OPTS} onChange={(v) => set({ seat: v })} />
                  <Sel label="Leg height" value={draft.leg} opts={LEG_OPTS} onChange={(v) => set({ leg: v })} />
                </div>
              </>
            )}
            {draft.cat === "bedframe" && (
              <>
                <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                  <Sel label="Size" value={draft.size} opts={SIZE_OPTS} onChange={(v) => set({ size: v })} />
                  <Sel label="Headboard" value={draft.head} opts={HEAD_OPTS} onChange={(v) => set({ head: v })} />
                </div>
                <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                  <Sel label="Fabric / colour" value={draft.fabric} opts={FABRIC_OPTS} onChange={(v) => set({ fabric: v })} />
                  <Sel label="Storage" value={draft.store} opts={STORE_OPTS} onChange={(v) => set({ store: v })} />
                </div>
                <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                  <Sel label="Divan" value={draft.divan} opts={DIVAN_OPTS} onChange={(v) => set({ divan: v })} />
                  <Sel label="Leg" value={draft.leg} opts={LEG_OPTS} onChange={(v) => set({ leg: v })} />
                  <Sel label="Gap" value={draft.gap} opts={GAP_OPTS} onChange={(v) => set({ gap: v })} />
                </div>
              </>
            )}
          </>
        )}

        {showRemark && (
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Remark</label>
            <input value={draft.remark} onChange={(e) => set({ remark: e.target.value })} placeholder="Optional line note" style={inputStyle} />
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "4px 0 14px" }}>
          <span style={{ fontSize: 11, color: "#9aa093" }}>Prices are recomputed by the system when you save.</span>
          {showPrice && <span className="money" style={{ fontSize: 14, fontWeight: 800, color: "#0c3f39" }}>RM {amount}</span>}
        </div>

        {error && <div style={{ fontSize: 11.5, color: "#b23a3a", margin: "2px 0 12px", textAlign: "center" }}>{error}</div>}

        <button className="btn" disabled={busy} onClick={() => void save()} style={{ opacity: busy ? 0.6 : 1 }}>
          {busy ? "Saving…" : isAdd ? "Add Line" : "Save Line"}
        </button>
      </div>

      {pickerOpen && (
        <MobileSkuPicker
          initialCat={draft.cat}
          onClose={() => setPickerOpen(false)}
          onPick={(sku: PickedSku) => {
            set({
              itemCode: sku.itemCode,
              itemGroup: sku.itemGroup,
              name: sku.name,
              cat: catForGroup(sku.itemGroup),
              price: fromCenti(sku.unitPriceCenti),
            });
            setPickerOpen(false);
          }}
        />
      )}
    </div>
  );
}

/* ── Public editable line-items card ─────────────────────────────────────────
   Drop-in replacement for the read-only line list. When the shape is missing
   or locked, renders a read-only list (with a locked note); otherwise each line
   is tappable to Edit + shows a Delete, and (catalog docs) an Add Line button. */
export function MobileEditableLines({ moduleKey, docId, header, items, isLoading, error, onChanged }: {
  moduleKey: string;
  docId: string;
  header: any;
  items: any[];
  isLoading: boolean;
  error: boolean;
  /** Called after any add / edit / delete lands so the parent can refetch. */
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const notify = useNotify();
  const shape = LINE_SHAPES[moduleKey];
  const [editing, setEditing] = useState<LineDraft | null>(null);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const locked = useMemo(() => (shape ? shape.locked(header) : true), [shape, header]);
  const canAdd = !!shape && !locked && shape.addMode === "catalog";

  const refresh = () => {
    onChanged();
    void qc.invalidateQueries({ queryKey: ["mobile-module"] });
  };

  const doDelete = async (it: any) => {
    if (!shape) return;
    const ro = shape.readonly(it);
    const id = String(it?.id ?? it?.ID ?? "");
    if (!id) return;
    if (!(await confirm({ title: "Remove this line?", body: ro.name !== "—" ? `"${ro.name}" will be removed from the ${shape.docNoun}.` : undefined, confirmLabel: "Remove", danger: true }))) return;
    setBusyId(id);
    try {
      await authedFetch(`${shape.basePath}/${encodeURIComponent(docId)}/items/${encodeURIComponent(id)}`, { method: "DELETE" });
      refresh();
      void notify({ title: "Line removed" });
    } catch (e) {
      void notify({ title: "Couldn't remove the line", body: e instanceof Error ? e.message : String(e), tone: "error" });
    } finally {
      setBusyId(null);
    }
  };

  // No shape (unknown module) or locked -> read-only list.
  const readOnly = !shape || locked;

  return (
    <>
      <div style={{ background: "#fff", border: "1px solid #e3e6e0", borderRadius: 12, padding: "2px 12px", marginBottom: 13 }}>
        {isLoading && <div style={{ fontSize: 11.5, color: "#9aa093", padding: "9px 0" }}>Loading…</div>}
        {error && !isLoading && <div style={{ fontSize: 11.5, color: "#b23a3a", padding: "9px 0" }}>Couldn't load line items. Please try again.</div>}
        {!isLoading && !error && (items.length ? items.map((it, i) => {
          const id = String(it?.id ?? it?.ID ?? i);
          const ro = shape ? shape.readonly(it) : { name: "—", qtyText: "", amountCenti: 0 };
          const rowBusy = busyId === id;
          return (
            <div className="docrow" key={id} style={{ flexWrap: "wrap", opacity: rowBusy ? 0.5 : 1 }}>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: "#11140f" }}>
                {ro.name} <span style={{ color: "#9aa093", fontWeight: 600 }}>{ro.qtyText}</span>
              </span>
              <span className="money" style={{ fontSize: 12.5, fontWeight: 800, color: "#11140f", flex: "none" }}>RM {fromCenti(ro.amountCenti)}</span>
              {!readOnly && (
                <div style={{ flexBasis: "100%", display: "flex", gap: 8, marginTop: 6 }}>
                  <button className="tinybtn" disabled={rowBusy} onClick={() => setEditing(shape!.fromItem(it))} style={{ background: "#e1efed", border: "1px solid #16695f", color: "#0c3f39" }}>Edit</button>
                  <button className="tinybtn" disabled={rowBusy} onClick={() => void doDelete(it)} style={{ background: "#fff", border: "1px solid #f0d4d4", color: "#b23a3a" }}>{rowBusy ? "Removing…" : "Delete"}</button>
                </div>
              )}
            </div>
          );
        }) : <div style={{ fontSize: 11.5, color: "#9aa093", padding: "9px 0" }}>No line items.</div>)}
      </div>

      {canAdd && (
        <button className="addline" style={{ marginBottom: 13 }} onClick={() => setAdding(true)}>+ Add Line Item</button>
      )}
      {readOnly && shape && (
        <div style={{ fontSize: 10, color: "#9aa093", margin: "-6px 2px 13px" }}>{shape.lockedNote}</div>
      )}

      {editing && shape && (
        <LineEditSheet shape={shape} docId={docId} initial={editing} onClose={() => setEditing(null)} onSaved={refresh} />
      )}
      {adding && shape && (
        <LineEditSheet shape={shape} docId={docId} initial={null} onClose={() => setAdding(false)} onSaved={refresh} />
      )}
    </>
  );
}
