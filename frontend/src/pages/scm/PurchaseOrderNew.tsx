// ----------------------------------------------------------------------------
// PurchaseOrderNew — full-page Create PO at /purchase-orders/new.
//
// 1:1 clone of 2990s apps/backend/src/pages/PurchaseOrderNew.tsx (AutoCount-style
// full-page form): a 2-column header card above a card-per-line items list, a
// supplier-info banner, a right-aligned totals card and a single Create button
// that POSTs /purchase-orders. Same required fields (Creditor + Expected Delivery
// + Purchase Location) and the same per-line shape (NewPoItem).
//
// SEAM changes (same playbook as the Suppliers slice):
//   - Data layer: 2990s lib/suppliers-queries -> the PO hooks in ./PurchaseOrders
//     + the suppliers list/detail endpoints (Houzs api client + TanStack).
//     Identical request/response shapes (rule #7).
//   - Components: @2990s/design-system Button -> Houzs components/Button; 2990s
//     MoneyInput -> minimal inline RM<->centi inputs; react-router ->
//     react-router-dom (rule #9).
//
// Strategy-2 product-layer simplifications (Houzs is not the furniture business):
//   - DROPPED the furniture line machinery: the mfg_products / maintenance-config
//     / fabric_trackings queries, the per-category sofa/bedframe variant editors
//     + SpecialsCheckboxes, the item-first reverse-supplier lookup, and the
//     computeMfgPoUnitCost auto-pricing effect. A line is plain text: Item Code
//     (internal) + Supplier SKU + Description + Qty + Unit Price + Discount +
//     Delivery + Ship-to. When a Creditor is picked, the Item Code / Supplier SKU
//     fields offer that supplier's bindings via a <datalist> (autofills price +
//     description), but everything is hand-typeable for a one-off purchase.
//     TODO: wire to a Houzs product source + variant editors in the Products slice.
//   - Purchase Location + per-line Ship-to are plain text id inputs (warehouses
//     not cloned yet). TODO: warehouse pickers when the Warehouse slice lands.
//   - "From Sales Order" navigates to the picker (SO slice empty state for now).
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Plus, Save, Trash2, X, ArrowRightLeft } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../../components/Button";
import { api } from "../../api/client";
import { useCreatePurchaseOrder, type NewPoItem, type MaterialKind } from "./PurchaseOrders";
import { useToast } from "../../hooks/useToast";
import styles from "./PurchaseOrderDetail.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number | null | undefined, currency = "MYR"): string => {
  const v = centi ?? 0;
  return `${currency} ${(v / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const todayMyt = (): string => {
  // MYT (UTC+8) calendar date as YYYY-MM-DD.
  const now = new Date(Date.now() + 8 * 3600_000);
  return now.toISOString().slice(0, 10);
};

/* Per-line draft. materialKind uses the schema's lowercase enum so the POST body
   lines up with the API's VALID_KINDS. The furniture `category` / `variants`
   editors are dropped per Strategy-2 (the column still exists; the UI just
   doesn't render an editor). */
type DraftLine = {
  rid: string;
  bindingId?: string;
  materialKind: MaterialKind;
  materialCode: string;
  materialName: string;
  supplierSku?: string;
  qty: number;
  unitPriceCenti: number;
  discountCenti?: number;
  deliveryDate?: string;
  warehouseId?: string;
};

const newLine = (): DraftLine => ({
  rid: `l${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  materialKind: "mfg_product",
  materialCode: "",
  materialName: "",
  qty: 1,
  unitPriceCenti: 0,
});

/* ── Suppliers list + detail (bindings) via the suppliers endpoints ─────
   Same shapes 2990s's useSuppliers / useSupplierDetail return. Co-located so
   the PO slice doesn't import the Suppliers page module. */
type SupplierLite = {
  id: string;
  code: string;
  name: string;
  currency: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  payment_terms: string | null;
  address: string | null;
  area: string | null;
  postcode: string | null;
  state: string | null;
  country: string | null;
};
type BindingLite = {
  id: string;
  material_kind: MaterialKind;
  material_code: string;
  material_name: string;
  supplier_sku: string;
  unit_price_centi: number;
  currency: string;
};

function useSuppliersList() {
  return useQuery({
    queryKey: ["suppliers", "ACTIVE", ""],
    queryFn: async () => {
      const res = await api.get<{ suppliers: SupplierLite[] }>(`/api/suppliers?status=ACTIVE`);
      return res.suppliers;
    },
    staleTime: 30_000,
  });
}

function useSupplierBindings(supplierId: string) {
  return useQuery({
    queryKey: ["supplier-detail", supplierId],
    queryFn: () => api.get<{ supplier: SupplierLite; bindings: BindingLite[] }>(`/api/suppliers/${supplierId}`),
    enabled: Boolean(supplierId),
    staleTime: 30_000,
  });
}

export const PurchaseOrderNew = () => {
  const navigate = useNavigate();
  const toast = useToast();
  const create = useCreatePurchaseOrder();

  // ── Header state ──────────────────────────────────────────────────
  const [supplierId, setSupplierId] = useState<string>("");
  const [poDate, setPoDate] = useState<string>(() => todayMyt());
  const [expectedAt, setExpectedAt] = useState<string>("");
  const [purchaseLocationId, setPurchaseLocationId] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  // ── Items state ───────────────────────────────────────────────────
  const [lines, setLines] = useState<DraftLine[]>([newLine()]);

  // ── Data ──────────────────────────────────────────────────────────
  const suppliersQ = useSuppliersList();
  const supplierDetailQ = useSupplierBindings(supplierId);
  const supplier = supplierDetailQ.data?.supplier ?? null;
  const bindings = useMemo(() => supplierDetailQ.data?.bindings ?? [], [supplierDetailQ.data?.bindings]);
  const currency = supplier?.currency ?? "MYR";

  const setLine = (rid: string, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const addLine = () =>
    setLines((prev) => [...prev, { ...newLine(), warehouseId: purchaseLocationId || undefined, deliveryDate: expectedAt || undefined }]);
  const dropLine = (rid: string) => setLines((prev) => (prev.length === 1 ? [newLine()] : prev.filter((l) => l.rid !== rid)));

  // Picking a binding (from either datalist) autofills code/name/sku/price.
  const pickBinding = (rid: string, b: BindingLite) =>
    setLine(rid, {
      bindingId: b.id,
      materialKind: b.material_kind,
      materialCode: b.material_code,
      materialName: b.material_name,
      supplierSku: b.supplier_sku,
      unitPriceCenti: b.unit_price_centi,
    });

  const subtotalCenti = useMemo(
    () => lines.reduce((s, l) => s + Math.max(0, l.qty * l.unitPriceCenti - (l.discountCenti ?? 0)), 0),
    [lines],
  );

  const onSave = () => {
    if (!supplierId) {
      toast.error("Pick a Creditor (supplier) first.");
      return;
    }
    // Expected Delivery + Purchase Location are required (API rejects missing).
    if (!expectedAt) {
      toast.error("Expected Delivery date is required.");
      return;
    }
    if (!purchaseLocationId) {
      toast.error("Purchase Location is required.");
      return;
    }
    const validLines = lines.filter((l) => l.materialCode.trim() && l.qty > 0);
    const items: NewPoItem[] = validLines.map((l) => ({
      materialKind: l.materialKind,
      materialCode: l.materialCode,
      materialName: l.materialName || l.materialCode,
      supplierSku: l.supplierSku,
      qty: l.qty,
      unitPriceCenti: l.unitPriceCenti,
      bindingId: l.bindingId,
      discountCenti: l.discountCenti,
      deliveryDate: l.deliveryDate || undefined,
      warehouseId: l.warehouseId || undefined,
    }));

    create.mutate(
      {
        supplierId,
        currency,
        poDate,
        expectedAt,
        notes: notes || undefined,
        purchaseLocationId,
        items,
      },
      {
        onSuccess: (res) => navigate(`/purchase-orders/${res.id}`),
        onError: (err) => toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`),
      },
    );
  };

  return (
    <div className={styles.page}>
      {/* Top bar */}
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/purchase-orders" className={styles.backBtn}>
            <ArrowLeft {...ICON} /> <span>Purchase Orders</span>
          </Link>
          <h1 className={styles.title}>New Purchase Order</h1>
        </div>
        <div className={styles.actions}>
          <Button variant="ghost" onClick={() => navigate("/purchase-orders/from-so")}>
            <ArrowRightLeft {...ICON} /> <span>From Sales Order</span>
          </Button>
          <Button variant="ghost" onClick={() => navigate("/purchase-orders")}>
            <X {...ICON} /> <span>Cancel</span>
          </Button>
          <Button variant="primary" onClick={onSave} disabled={create.isPending}>
            <Save {...ICON} />
            <span>{create.isPending ? "Saving…" : "Create Purchase Order"}</span>
          </Button>
        </div>
      </div>

      {/* Header card */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Header</h2>
        </div>
        <div className={styles.cardBody}>
          <div className={styles.formGrid2}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Creditor *</span>
              <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={styles.fieldSelect}>
                <option value="">— Pick a supplier —</option>
                {(suppliersQ.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} · {s.name}
                  </option>
                ))}
              </select>
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>P/O No</span>
              <input type="text" readOnly value="(assigned on Save)" className={styles.fieldInput} />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Name</span>
              <input type="text" readOnly value={supplier?.name ?? ""} placeholder="(auto-filled when supplier selected)" className={styles.fieldInput} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Date *</span>
              <input type="date" value={poDate} onChange={(e) => setPoDate(e.target.value)} className={styles.fieldInput} />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Address</span>
              <textarea
                readOnly
                value={[supplier?.address, supplier?.area, supplier?.postcode, supplier?.state, supplier?.country].filter(Boolean).join(", ")}
                placeholder="(auto-filled when supplier selected)"
                className={styles.fieldInput}
                style={{ minHeight: 52, resize: "vertical" }}
                rows={3}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Expected Delivery *</span>
              <input type="date" value={expectedAt} onChange={(e) => setExpectedAt(e.target.value)} className={styles.fieldInput} required />
            </label>

            {/* Purchase Location — plain text id (warehouses not cloned).
                TODO: warehouse picker when the Warehouse slice lands. */}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Purchase Location *</span>
              <input
                value={purchaseLocationId}
                onChange={(e) => setPurchaseLocationId(e.target.value)}
                className={styles.fieldInput}
                placeholder="warehouse id (picker after Warehouse slice)"
                required
              />
              <span style={{ fontSize: "var(--fs-11)", color: "var(--fg-muted)" }}>
                Default ship-to for every line; each line can override below.
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Notes</span>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Free text — supplier instructions, internal notes…"
                className={styles.fieldInput}
                rows={3}
                style={{ minHeight: 52, resize: "vertical" }}
              />
            </label>
          </div>

          {supplier && (
            <div
              style={{
                marginTop: "var(--space-3)",
                background: "var(--c-cream)",
                border: "1px solid var(--line)",
                borderRadius: "var(--radius-md)",
                padding: "var(--space-2) var(--space-3)",
                fontSize: "var(--fs-12)",
                color: "var(--fg-muted)",
                display: "flex",
                gap: "var(--space-4)",
                flexWrap: "wrap",
              }}
            >
              {supplier.contact_person && (
                <span>
                  Contact: <strong>{supplier.contact_person}</strong>
                </span>
              )}
              {supplier.phone && (
                <span>
                  Phone: <strong>{supplier.phone}</strong>
                </span>
              )}
              {supplier.email && (
                <span>
                  Email: <strong>{supplier.email}</strong>
                </span>
              )}
              {supplier.payment_terms && (
                <span>
                  Terms: <strong>{supplier.payment_terms}</strong>
                </span>
              )}
              <span>
                Currency: <strong>{currency}</strong>
              </span>
            </div>
          )}
        </div>
      </section>

      {/* Items card */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Items</h2>
          <span style={{ fontSize: "var(--fs-12)", color: "var(--fg-muted)" }}>
            {supplierId
              ? bindings.length > 0
                ? `${bindings.length} item(s) bound to this supplier — pick from the list or type a one-off`
                : "No SKUs bound to this supplier yet — type a one-off purchase"
              : "Pick a Creditor to load its bound items (or type a one-off)"}
          </span>
        </div>
        <div className={styles.cardBody} style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          {lines.map((l, idx) => {
            const lineTotalCenti = Math.max(0, l.qty * l.unitPriceCenti - (l.discountCenti ?? 0));
            return (
              <div key={l.rid} className={styles.lineCard}>
                {/* Card header — Line N · line total · remove */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)" }}>
                  <span
                    style={{
                      fontFamily: "var(--font-button)",
                      fontSize: "var(--fs-12)",
                      fontWeight: 700,
                      letterSpacing: "0.1em",
                      color: "var(--fg-muted)",
                    }}
                  >
                    LINE {idx + 1}
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                    <span className={styles.previewPrice}>{fmtRm(lineTotalCenti, currency)}</span>
                    <button
                      type="button"
                      onClick={() => dropLine(l.rid)}
                      title="Remove line"
                      className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                    >
                      <Trash2 {...ICON} />
                    </button>
                  </div>
                </div>

                {/* Identity row — internal code + supplier SKU */}
                <div className={styles.formGrid2}>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Item Code (Internal)</span>
                    <input
                      type="text"
                      list={`bindings-${l.rid}`}
                      value={l.materialCode}
                      onChange={(e) => {
                        const code = e.target.value;
                        const match = supplierId ? bindings.find((b) => b.material_code === code) : undefined;
                        if (match) {
                          pickBinding(l.rid, match);
                          return;
                        }
                        setLine(l.rid, { materialCode: code, bindingId: undefined });
                      }}
                      placeholder="Type our internal SKU…"
                      className={styles.fieldInput}
                      style={{ fontFamily: "var(--font-mono)" }}
                    />
                    <datalist id={`bindings-${l.rid}`}>
                      {supplierId &&
                        bindings.map((b) => (
                          <option key={b.id} value={b.material_code}>
                            {b.material_name} · {b.supplier_sku} · {fmtRm(b.unit_price_centi, b.currency)}
                          </option>
                        ))}
                    </datalist>
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Supplier SKU</span>
                    <input
                      type="text"
                      list={`supplier-skus-${l.rid}`}
                      value={l.supplierSku ?? ""}
                      onChange={(e) => {
                        const sku = e.target.value;
                        if (supplierId) {
                          const match = bindings.find((b) => b.supplier_sku === sku);
                          if (match) {
                            pickBinding(l.rid, match);
                            return;
                          }
                        }
                        setLine(l.rid, { supplierSku: sku });
                      }}
                      placeholder={supplierId ? "Type or pick supplier’s code…" : "Pick a supplier first"}
                      className={styles.fieldInput}
                      style={{ fontFamily: "var(--font-mono)" }}
                    />
                    <datalist id={`supplier-skus-${l.rid}`}>
                      {supplierId &&
                        bindings.map((b) => (
                          <option key={b.id} value={b.supplier_sku || ""}>
                            {b.material_code} · {b.material_name} · {fmtRm(b.unit_price_centi, b.currency)}
                          </option>
                        ))}
                    </datalist>
                  </label>
                </div>

                {/* Description — full width */}
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Description</span>
                  <input
                    type="text"
                    value={l.materialName}
                    onChange={(e) => setLine(l.rid, { materialName: e.target.value })}
                    placeholder="(auto-filled if bound — editable for one-off purchases)"
                    className={styles.fieldInput}
                  />
                </label>

                {/* Pricing row — Qty · Unit Price · Discount · Delivery · Ship-to */}
                <div className={styles.formGrid4} style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Qty</span>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={l.qty}
                      onChange={(e) => setLine(l.rid, { qty: Number(e.target.value) })}
                      className={styles.fieldInput}
                      style={{ textAlign: "right" }}
                    />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Unit Price ({currency})</span>
                    <RmInput valueCenti={l.unitPriceCenti} onCommit={(centi) => setLine(l.rid, { unitPriceCenti: centi })} />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Discount ({currency})</span>
                    <RmInput valueCenti={l.discountCenti ?? 0} onCommit={(centi) => setLine(l.rid, { discountCenti: centi })} />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Delivery Date</span>
                    <input
                      type="date"
                      value={l.deliveryDate ?? ""}
                      onChange={(e) => setLine(l.rid, { deliveryDate: e.target.value })}
                      className={styles.fieldInput}
                    />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Ship-to Location</span>
                    <input
                      value={l.warehouseId ?? ""}
                      onChange={(e) => setLine(l.rid, { warehouseId: e.target.value })}
                      className={styles.fieldInput}
                      placeholder="(inherits Purchase Location)"
                    />
                  </label>
                </div>
              </div>
            );
          })}

          <button type="button" onClick={addLine} className={styles.addLineBtn}>
            <Plus {...ICON} /> Add another item
          </button>
        </div>
      </section>

      {/* Totals card aligned right */}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <section className={styles.card} style={{ maxWidth: 360, width: "100%" }}>
          <div className={styles.cardBody}>
            <div className={styles.totalsGrid}>
              <div className={styles.totalRow}>
                <span className={styles.totalLabel}>Subtotal</span>
                <span className={styles.totalValue}>{fmtRm(subtotalCenti, currency)}</span>
              </div>
              <div className={`${styles.totalRow} ${styles.grandTotalRow}`}>
                <span className={styles.totalLabel}>Total</span>
                <span className={`${styles.totalValue} ${styles.grandTotal}`}>{fmtRm(subtotalCenti, currency)}</span>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};

/* Minimal inline RM<->centi input (no MoneyInput in this slice). Uncontrolled
   draft; commits on blur. */
const RmInput = ({ valueCenti, onCommit }: { valueCenti: number; onCommit: (centi: number) => void }) => {
  const toRm = (c: number) => (c ? (c / 100).toFixed(2) : "");
  return (
    <input
      className={styles.fieldInput}
      style={{ textAlign: "right" }}
      inputMode="decimal"
      defaultValue={toRm(valueCenti)}
      placeholder="0.00"
      onBlur={(e) => {
        const t = e.target.value.trim();
        const n = t === "" ? 0 : Number(t);
        onCommit(Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0);
      }}
    />
  );
};
