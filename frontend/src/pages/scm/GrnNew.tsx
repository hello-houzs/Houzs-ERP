// ----------------------------------------------------------------------------
// GrnNew — full-page Create Goods Receipt at /grns/new.
//
// 1:1 clone of 2990s apps/backend/src/pages/GrnNew.tsx (AutoCount-style full-page
// form): a header card (supplier · received date · DN ref · receive-into
// warehouse · notes) above a card-per-line items list, a right-aligned totals
// card and a single "Receive & Post" button that POSTs /grns. Three ways in
// (verbatim from 2990s):
//   1. Single PO dropdown (or ?poId= deep link from a PO detail "Receive Goods")
//      → its outstanding lines load into the items grid.
//   2. "From PO (multi)" picker (/grns/from-po) → multi-select PO lines across one
//      supplier, stashed to sessionStorage['grnFromPoPicks'], read ONCE on mount.
//   3. Manual / blank GRN — no PO: pick a supplier, add lines by hand.
//
// SEAM changes (same playbook as PurchaseOrderNew):
//   - Data layer: 2990s lib/flow-queries + suppliers-queries -> the GRN hooks in
//     ./grn-queries + the PO hooks in ./PurchaseOrders + the warehouse hook in
//     ./inventory-queries (Houzs api client + TanStack). Identical shapes (rule #7).
//   - Components: @2990s/design-system Button -> Houzs components/Button; 2990s
//     MoneyInput -> a minimal inline RM<->centi input; react-router ->
//     react-router-dom (rule #9). ActionResultDialog -> window.alert.
//
// Strategy-2 product-layer simplifications (Houzs is not the furniture business):
//   - DROPPED the furniture line machinery: mfg_products / maintenance-config /
//     special_addons queries, the per-category sofa/bedframe variant editors, the
//     supplier-binding item lookup. A MANUAL line is plain text: Item Code +
//     Description + Qty Received + Unit Price. (PO-sourced lines carry their code /
//     description / price from the PO.) TODO: wire a product source + variant
//     editors in the Products slice.
//   - The per-line Rack picker is DROPPED (rackId omitted) — the rack module is
//     cloned but the picker UX is furniture-coupled. TODO: per-line rack picker.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Plus, Save, Trash2, ArrowRightLeft, ChevronDown } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../../components/Button";
import { api } from "../../api/client";
import { useCreateGrn, type NewGrnItem } from "./grn-queries";
import { usePurchaseOrders, usePurchaseOrderDetail } from "./PurchaseOrders";
import { useWarehouses } from "./inventory-queries";
import styles from "./PurchaseOrderDetail.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

const todayMyt = (): string => new Date().toISOString().slice(0, 10);

const fmtRm = (centi: number | null | undefined, currency = "MYR"): string => {
  const v = centi ?? 0;
  return `${currency} ${(v / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/** One stashed pick from the From-PO picker (sessionStorage). */
export type GrnFromPoPick = {
  poItemId: string;
  poId: string;
  poDocNo: string;
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  itemCode: string;
  description: string | null;
  itemGroup: string;
  remainingQty: number;
  unitPriceCenti: number;
  warehouseLocationId: string | null;
  variants: Record<string, unknown> | null;
  _pickQty: number;
};

type DraftLine = {
  rid: string;
  purchaseOrderItemId: string | null;
  materialKind: "mfg_product" | "fabric" | "raw";
  materialCode: string;
  materialName: string;
  itemGroup: string | null;
  variants: Record<string, unknown> | null;
  outstanding: number | null;
  qtyReceived: number;
  unitPriceCenti: number;
  notes: string;
};

type SupplierLite = { id: string; code: string; name: string };

export const GrnNew = () => {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  // From-PO-multi picks — read ONCE on mount; when present they drive the form.
  const [picks, setPicks] = useState<GrnFromPoPick[] | null>(null);
  const pickSupplierId = picks?.[0]?.supplierId ?? null;
  const pickSupplierName = picks?.[0]?.supplierName ?? picks?.[0]?.supplierCode ?? null;
  const pickPoId = picks?.[0]?.poId ?? null;
  const hasPicks = !!picks && picks.length > 0;

  // Inline single-PO picker (drives the form when there are no picks).
  const [selPoId, setSelPoId] = useState<string>(params.get("poId") ?? "");
  const poListQ = usePurchaseOrders();
  const poQ = usePurchaseOrderDetail(selPoId || null);

  // Manual-mode supplier (blank GRN, no PO).
  const [manualSupplierId, setManualSupplierId] = useState<string>("");
  const suppliers = useSuppliersForPicker();

  const outstanding = useMemo(
    () => (poListQ.data ?? []).filter((po) => po.status === "SUBMITTED" || po.status === "PARTIALLY_RECEIVED"),
    [poListQ.data],
  );

  const create = useCreateGrn();
  const saving = create.isPending;

  const [receivedAt, setReceivedAt] = useState<string>(() => todayMyt());
  const [deliveryNoteRef, setDeliveryNoteRef] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [warehouseId, setWarehouseId] = useState<string>("");
  const warehousesQ = useWarehouses();
  const [picksResolved, setPicksResolved] = useState<boolean>(false);

  // On mount: read the stashed From-PO picks (if any) + load them as lines.
  const readPicksRef = useRef(false);
  useEffect(() => {
    if (readPicksRef.current) return;
    readPicksRef.current = true;

    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem("grnFromPoPicks");
    } catch {
      /* ignore */
    }
    if (!raw) {
      setPicksResolved(true);
      return;
    }
    try {
      sessionStorage.removeItem("grnFromPoPicks");
    } catch {
      /* ignore */
    }
    let newPicks: GrnFromPoPick[] = [];
    try {
      const r = JSON.parse(raw);
      if (Array.isArray(r)) newPicks = r as GrnFromPoPick[];
    } catch {
      /* malformed */
    }
    const pickLines: DraftLine[] = newPicks.map((p) => ({
      rid: `p${p.poItemId}`,
      purchaseOrderItemId: p.poItemId,
      materialKind: "mfg_product",
      materialCode: p.itemCode,
      materialName: p.description ?? p.itemCode,
      itemGroup: p.itemGroup || null,
      variants: (p.variants as Record<string, unknown> | null) ?? null,
      outstanding: p.remainingQty,
      qtyReceived: p._pickQty,
      unitPriceCenti: p.unitPriceCenti ?? 0,
      notes: "",
    }));
    setLines(pickLines);
    if (newPicks.length) setPicks(newPicks);
    setPicksResolved(true);
  }, []);

  // Load lines from the selected single PO (only outstanding qty > 0). Skipped
  // when From-PO-multi picks already populated the form.
  useEffect(() => {
    if (hasPicks) return;
    if (!selPoId) {
      // Manual mode — seed ONE blank starter line (matches New PO). Never clobber.
      setLines((prev) =>
        prev.length > 0
          ? prev
          : [
              {
                rid: `m${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                purchaseOrderItemId: null,
                materialKind: "mfg_product",
                materialCode: "",
                materialName: "",
                itemGroup: null,
                variants: null,
                outstanding: null,
                qtyReceived: 1,
                unitPriceCenti: 0,
                notes: "",
              },
            ],
      );
      return;
    }
    if (!poQ.data) return;
    const next: DraftLine[] = poQ.data.items
      .map((it) => {
        const outstandingQty = (it.qty ?? 0) - (it.received_qty ?? 0);
        return {
          rid: `r${it.id}`,
          purchaseOrderItemId: it.id,
          materialKind: it.material_kind,
          materialCode: it.material_code,
          materialName: it.material_name,
          itemGroup: it.item_group ?? null,
          variants: (it.variants as Record<string, unknown> | null) ?? null,
          outstanding: outstandingQty,
          qtyReceived: outstandingQty,
          unitPriceCenti: it.unit_price_centi ?? 0,
          notes: "",
        };
      })
      .filter((l) => (l.outstanding ?? 0) > 0);
    setLines(next);
  }, [poQ.data, selPoId, hasPicks]);

  const setLine = (rid: string, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const dropLine = (rid: string) => setLines((prev) => prev.filter((l) => l.rid !== rid));
  const addEmptyManualLine = () =>
    setLines((prev) => [
      ...prev,
      {
        rid: `m${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        purchaseOrderItemId: null,
        materialKind: "mfg_product",
        materialCode: "",
        materialName: "",
        itemGroup: null,
        variants: null,
        outstanding: null,
        qtyReceived: 1,
        unitPriceCenti: 0,
        notes: "",
      },
    ]);

  const subtotalCenti = useMemo(() => lines.reduce((s, l) => s + l.qtyReceived * l.unitPriceCenti, 0), [lines]);

  const po = poQ.data?.purchaseOrder;
  const isManual = !hasPicks && !selPoId;
  const supplierId = hasPicks ? pickSupplierId : po ? po.supplier_id : isManual ? manualSupplierId || null : null;
  const supplierName = hasPicks
    ? pickSupplierName
    : po
      ? po.supplier?.name ?? po.supplier?.code ?? null
      : isManual
        ? suppliers.find((s) => s.id === manualSupplierId)?.name ?? null
        : null;
  const headerPoId = hasPicks ? pickPoId : po?.id ?? null;
  const currency = po?.currency ?? "MYR";

  // Default the warehouse: prefer the PO's purchase location / picks' warehouse,
  // else the first warehouse. Only seeds when blank; never clobbers a choice.
  useEffect(() => {
    if (warehouseId) return;
    if (!picksResolved) return;
    const pickLoc = hasPicks ? picks?.find((p) => p.warehouseLocationId)?.warehouseLocationId ?? null : null;
    const poLoc = po?.purchase_location_id ?? null;
    const fallback = pickLoc ?? poLoc ?? (warehousesQ.data?.[0]?.id ?? "");
    if (fallback) setWarehouseId(fallback);
  }, [warehouseId, picksResolved, hasPicks, picks, po, warehousesQ.data]);

  const canSave = !!supplierId && lines.length > 0 && lines.every((l) => l.qtyReceived >= 0);

  const onSave = async () => {
    if (!supplierId) {
      window.alert(
        hasPicks
          ? "The picks are missing a supplier — go back to the picker and try again."
          : "Choose the PO you are receiving against, or pick a supplier for a manual receipt.",
      );
      return;
    }
    const realLines = lines.filter((l) => l.materialCode.trim());
    if (realLines.length === 0) {
      window.alert("Add at least one item to receive.");
      return;
    }
    if (!canSave) {
      window.alert("Each line must have a received qty of 0 or more.");
      return;
    }
    try {
      const items: NewGrnItem[] = realLines.map((l) => ({
        purchaseOrderItemId: l.purchaseOrderItemId,
        materialKind: l.materialKind,
        materialCode: l.materialCode,
        materialName: l.materialName || l.materialCode,
        qtyReceived: l.qtyReceived,
        // GRN only captures received qty; accepted follows received (rejected 0)
        // so the API + inventory rollup keep working with the simplified UI.
        qtyAccepted: l.qtyReceived,
        qtyRejected: 0,
        unitPriceCenti: l.unitPriceCenti,
        itemGroup: l.itemGroup ?? undefined,
        variants: l.variants ?? undefined,
        description: l.materialName || undefined,
        notes: l.notes || undefined,
      }));
      const res = await create.mutateAsync({
        purchaseOrderId: headerPoId,
        supplierId,
        warehouseId: warehouseId || undefined,
        receivedAt,
        deliveryNoteRef: deliveryNoteRef || undefined,
        notes: notes || undefined,
        items,
      });
      navigate(`/grns/${res.id}`);
    } catch (e) {
      window.alert(`Receive failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className={styles.page}>
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/grns" className={styles.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>New Goods Receipt</h1>
          </div>
        </div>
        <div className={styles.actions}>
          <div className={styles.totalRail}>
            <span className={styles.totalRailLabel}>Total</span>
            <span className={styles.totalRailValue}>{fmtRm(subtotalCenti, currency)}</span>
          </div>
          <Button variant="ghost" onClick={() => navigate("/grns/from-po")}>
            <ArrowRightLeft {...ICON} />
            <span>From Purchase Order</span>
          </Button>
          <Button variant="primary" onClick={onSave} disabled={saving || !canSave}>
            <Save {...ICON} />
            <span>{saving ? "Receiving…" : "Receive & Post"}</span>
          </Button>
        </div>
      </div>

      {/* ── Header card: source + supplier + dates + warehouse + notes ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Receipt Details</h2>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            {/* Source: single-PO picker (hidden once picks drive the form). */}
            {!hasPicks && (
              <label className={styles.field} style={{ gridColumn: "span 2" }}>
                <span className={styles.fieldLabel}>Receive against PO</span>
                <span className={styles.selectWrap}>
                  <select
                    className={styles.fieldSelect}
                    value={selPoId}
                    onChange={(e) => {
                      setSelPoId(e.target.value);
                      setLines([]);
                    }}
                  >
                    <option value="">— Manual receipt (no PO) —</option>
                    {outstanding.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.po_number} · {p.supplier?.name ?? p.supplier?.code ?? "—"}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
                </span>
              </label>
            )}

            {/* Supplier: locked (PO / picks) or a manual picker. */}
            {isManual ? (
              <label className={styles.field} style={{ gridColumn: "span 2" }}>
                <span className={styles.fieldLabel}>Supplier *</span>
                <span className={styles.selectWrap}>
                  <select
                    className={styles.fieldSelect}
                    value={manualSupplierId}
                    onChange={(e) => setManualSupplierId(e.target.value)}
                  >
                    <option value="">— Pick supplier —</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.code} · {s.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
                </span>
              </label>
            ) : (
              <div className={styles.field} style={{ gridColumn: "span 2" }}>
                <span className={styles.fieldLabel}>Supplier</span>
                <div style={{ fontSize: "var(--fs-13)", paddingTop: 6 }}>{supplierName ?? "—"}</div>
              </div>
            )}

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Received Date</span>
              <input type="date" className={styles.fieldInput} value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>DN Ref</span>
              <input
                className={styles.fieldInput}
                value={deliveryNoteRef}
                placeholder="Supplier's DO no."
                onChange={(e) => setDeliveryNoteRef(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Receive into</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                  <option value="">— Default warehouse —</option>
                  {(warehousesQ.data ?? []).map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.code} · {w.name}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field} style={{ gridColumn: "span 3" }}>
              <span className={styles.fieldLabel}>Notes</span>
              <input className={styles.fieldInput} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
          </div>
        </div>
      </section>

      {/* ── Line items ──────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Line Items ({lines.length})</h2>
        </header>
        {lines.length === 0 ? (
          <div className={styles.cardBody}>
            <p className={styles.emptyRow}>
              {selPoId ? "This PO has no outstanding lines to receive." : "Add an item to receive."}
            </p>
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Item Code</th>
                <th>Description</th>
                <th className={styles.tableRight}>Outstanding</th>
                <th className={styles.tableRight}>Qty Received</th>
                <th className={styles.tableRight}>Unit Price</th>
                <th className={styles.tableRight}>Line Total</th>
                <th className={styles.tableRight}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const isPoLine = !!l.purchaseOrderItemId;
                return (
                  <tr key={l.rid}>
                    <td>
                      {isPoLine ? (
                        <span className={styles.codeCell}>{l.materialCode}</span>
                      ) : (
                        <input
                          className={styles.fieldInput}
                          style={{ width: 130 }}
                          value={l.materialCode}
                          placeholder="Code"
                          onChange={(e) => setLine(l.rid, { materialCode: e.target.value })}
                        />
                      )}
                    </td>
                    <td>
                      {isPoLine ? (
                        l.materialName || "—"
                      ) : (
                        <input
                          className={styles.fieldInput}
                          style={{ width: 220 }}
                          value={l.materialName}
                          placeholder="Description"
                          onChange={(e) => setLine(l.rid, { materialName: e.target.value })}
                        />
                      )}
                    </td>
                    <td className={styles.tableRight}>{l.outstanding ?? "—"}</td>
                    <td className={styles.tableRight}>
                      <input
                        type="number"
                        min={0}
                        className={styles.fieldInput}
                        style={{ width: 80, textAlign: "right" }}
                        value={l.qtyReceived}
                        onChange={(e) => setLine(l.rid, { qtyReceived: Number(e.target.value) || 0 })}
                      />
                    </td>
                    <td className={styles.tableRight}>
                      <InlineRmInput
                        valueCenti={l.unitPriceCenti}
                        onCommit={(centi) => setLine(l.rid, { unitPriceCenti: centi })}
                        style={{ width: 110 }}
                      />
                    </td>
                    <td className={styles.priceCell}>{fmtRm(l.qtyReceived * l.unitPriceCenti, currency)}</td>
                    <td className={styles.tableRight}>
                      <button
                        type="button"
                        className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                        title="Remove line"
                        onClick={() => dropLine(l.rid)}
                      >
                        <Trash2 {...SM_ICON} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {/* Manual mode: add another hand-typed line. */}
        {isManual && (
          <div className={styles.cardBody}>
            <Button variant="ghost" onClick={addEmptyManualLine}>
              <Plus {...ICON} />
              <span>Add another item</span>
            </Button>
          </div>
        )}
      </section>
    </div>
  );
};

/* Minimal supplier picker source — reads the suppliers list endpoint directly
   (same shape 2990s's useSuppliers returns). Co-located so the GRN slice doesn't
   import the Suppliers page module. */
function useSuppliersForPicker(): SupplierLite[] {
  const q = useQuery({
    queryKey: ["suppliers", "ACTIVE", ""],
    queryFn: async () => {
      const res = await api.get<{ suppliers: SupplierLite[] }>(`/api/suppliers?status=ACTIVE`);
      return res.suppliers;
    },
    staleTime: 30_000,
  });
  return q.data ?? [];
}

/* Minimal inline RM<->centi editor (no MoneyInput in this slice). */
const InlineRmInput = ({
  valueCenti,
  onCommit,
  style,
}: {
  valueCenti: number;
  onCommit: (centi: number) => void;
  style?: React.CSSProperties;
}) => {
  const toRm = (c: number) => (c ? (c / 100).toFixed(2) : "");
  const [draft, setDraft] = useState(toRm(valueCenti));
  const [committed, setCommitted] = useState(valueCenti);
  if (committed !== valueCenti) {
    setCommitted(valueCenti);
    setDraft(toRm(valueCenti));
  }
  const commit = () => {
    const t = draft.trim();
    const n = t === "" ? 0 : Number(t);
    const next = Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : valueCenti;
    onCommit(next);
  };
  return (
    <input
      className={styles.fieldInput}
      style={{ textAlign: "right", ...style }}
      value={draft}
      inputMode="decimal"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === "Escape") {
          setDraft(toRm(valueCenti));
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
};
