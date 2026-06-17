// ----------------------------------------------------------------------------
// PurchaseInvoiceNew — full-page Create Purchase Invoice at /purchase-invoices/new.
//
// 1:1 clone of 2990s apps/backend/src/pages/PurchaseInvoiceNew.tsx (AutoCount-style
// full-page form). Two ways in:
//   1. From a posted GRN (?grnId={uuid}) — the GRN header is read-only context and
//      its remaining-to-bill lines load as PI lines (editable price). With
//      ?fromPicks=1 only the ticked GRN lines (sessionStorage piFromGrnPicks) load.
//   2. MANUAL — no grnId: pick a supplier, add line items by hand.
// PI is created POSTED directly + AP-only (no inventory — that landed at GRN time).
//
// SEAM changes (same playbook as GrnNew):
//   - Data layer: 2990s lib/flow-queries + suppliers-queries -> the PI hooks in
//     ./flow-queries + the GRN detail hook in ./grn-queries (Houzs api client +
//     TanStack). Shapes identical (rule #7).
//   - Components: @2990s/design-system Button -> Houzs components/Button; 2990s
//     MoneyInput -> a minimal inline RM<->centi input; react-router ->
//     react-router-dom (rule #9). ActionResultDialog -> window.alert + navigate.
//
// Strategy-2 product-layer simplifications (Houzs is not the furniture business):
//   - DROPPED the furniture line machinery: mfg_products / maintenance-config /
//     special_addons queries, the per-category sofa/bedframe variant editors, the
//     supplier-binding item lookup, the auto due-date from supplier payment terms.
//     A MANUAL line is plain text: Item Code + Description + Qty + Unit Price.
//     GRN-sourced lines carry their code / description / price from the GRN.
//     TODO: wire a product source + variant editors in the Products slice.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Plus, Save, Trash2, ArrowRightLeft, ChevronDown } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../../components/Button";
import { api } from "../../api/client";
import { useCreatePurchaseInvoice, type NewPiItem } from "./flow-queries";
import { useGrnDetail } from "./grn-queries";
import styles from "./PurchaseOrderDetail.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

const todayMyt = (): string => new Date().toISOString().slice(0, 10);

const fmtRm = (centi: number | null | undefined, currency = "MYR"): string => {
  const v = centi ?? 0;
  return `${currency} ${(v / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

type SupplierLite = { id: string; code: string; name: string };

type DraftLine = {
  rid: string;
  grnItemId: string | null;
  materialKind: "mfg_product" | "fabric" | "raw";
  materialCode: string;
  materialName: string;
  itemGroup: string | null;
  variants: Record<string, unknown> | null;
  qty: number;
  unitPriceCenti: number;
  notes: string;
};

export const PurchaseInvoiceNew = () => {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const grnId = params.get("grnId");
  // fromPicks = arrived from the GRN->PI picker: build ONLY the ticked lines.
  const fromPicks = params.get("fromPicks") === "1";
  const grnQ = useGrnDetail(grnId);

  // Manual mode = no ?grnId= in the URL.
  const isManual = !grnId;

  const create = useCreatePurchaseInvoice();
  const saving = create.isPending;

  const [manualSupplierId, setManualSupplierId] = useState<string>("");
  const suppliers = useSuppliersForPicker();

  const [supplierInvoiceRef, setSupplierInvoiceRef] = useState<string>("");
  const [invoiceDate, setInvoiceDate] = useState<string>(() => todayMyt());
  const [dueDate, setDueDate] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [lines, setLines] = useState<DraftLine[]>([]);

  // ── GRN-sourced lines (only when ?grnId= present). ──────────────────────
  useEffect(() => {
    if (!grnQ.data) return;
    let pickQtyById: Map<string, number> | null = null;
    if (fromPicks) {
      try {
        const raw = sessionStorage.getItem("piFromGrnPicks");
        if (raw) {
          const arr = JSON.parse(raw) as Array<{ grnItemId: string; qty: number }>;
          pickQtyById = new Map(arr.map((p) => [p.grnItemId, Number(p.qty ?? 0)]));
        }
      } catch {
        pickQtyById = null;
      }
      try {
        sessionStorage.removeItem("piFromGrnPicks");
      } catch {
        /* ignore */
      }
    }
    const next: DraftLine[] = (grnQ.data.items ?? [])
      // Remaining-to-bill = accepted - already-invoiced - returned-to-supplier.
      .map((it) => ({ ...it, _remaining: (it.qty_accepted ?? 0) - (it.invoiced_qty ?? 0) - (it.returned_qty ?? 0) }))
      .filter((it) => (pickQtyById ? pickQtyById.has(it.id) : it._remaining > 0))
      .map((it) => ({
        rid: `r${it.id}`,
        grnItemId: it.id,
        materialKind: it.material_kind,
        materialCode: it.material_code,
        materialName: it.material_name,
        itemGroup: it.item_group ?? null,
        variants: (it.variants as Record<string, unknown> | null) ?? null,
        qty: pickQtyById ? pickQtyById.get(it.id) ?? it._remaining : it._remaining,
        unitPriceCenti: it.unit_price_centi ?? 0,
        notes: "",
      }));
    setLines(next);
  }, [grnQ.data, fromPicks]);

  // Manual mode — seed ONE blank starter line (matches New GRN). Never clobber.
  useEffect(() => {
    if (!isManual) return;
    setLines((prev) =>
      prev.length > 0
        ? prev
        : [
            {
              rid: `m${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              grnItemId: null,
              materialKind: "mfg_product",
              materialCode: "",
              materialName: "",
              itemGroup: null,
              variants: null,
              qty: 1,
              unitPriceCenti: 0,
              notes: "",
            },
          ],
    );
  }, [isManual]);

  const setLine = (rid: string, patch: Partial<DraftLine>) => setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const dropLine = (rid: string) => setLines((prev) => prev.filter((l) => l.rid !== rid));
  const addEmptyManualLine = () =>
    setLines((prev) => [
      ...prev,
      {
        rid: `m${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        grnItemId: null,
        materialKind: "mfg_product",
        materialCode: "",
        materialName: "",
        itemGroup: null,
        variants: null,
        qty: 1,
        unitPriceCenti: 0,
        notes: "",
      },
    ]);

  const subtotalCenti = useMemo(() => lines.reduce((s, l) => s + l.qty * l.unitPriceCenti, 0), [lines]);

  const grn = grnQ.data?.grn;
  const supplier = grn?.supplier;
  const po = grn?.purchase_order;
  const currency = "MYR";

  const supplierId = isManual ? manualSupplierId || null : grn?.supplier_id ?? null;
  const supplierName = isManual ? suppliers.find((s) => s.id === manualSupplierId)?.name ?? null : supplier?.name ?? null;

  const canSave = !!supplierId && lines.length > 0 && lines.every((l) => l.qty > 0);

  const onSave = async () => {
    if (!supplierId) {
      window.alert(isManual ? "Choose a supplier for this manual invoice." : "This GRN is missing a supplier — reopen it and try again.");
      return;
    }
    const realLines = lines.filter((l) => l.materialCode.trim());
    if (realLines.length === 0) {
      window.alert("Pick at least one item to invoice.");
      return;
    }
    if (!canSave) {
      window.alert("Each line needs qty > 0.");
      return;
    }
    try {
      const items: NewPiItem[] = realLines.map((l) => ({
        grnItemId: l.grnItemId,
        materialKind: l.materialKind,
        materialCode: l.materialCode,
        materialName: l.materialName || l.materialCode,
        qty: l.qty,
        unitPriceCenti: l.unitPriceCenti,
        notes: l.notes || undefined,
        itemGroup: l.itemGroup,
        variants: l.variants,
      }));
      const res = await create.mutateAsync({
        supplierId,
        purchaseOrderId: isManual ? null : grn?.purchase_order_id ?? null,
        grnId: isManual ? null : grn?.id ?? null,
        supplierInvoiceRef: supplierInvoiceRef || undefined,
        invoiceDate,
        dueDate: dueDate || undefined,
        notes: notes || undefined,
        items,
      });
      navigate(`/purchase-invoices/${res.id}`);
    } catch (err) {
      window.alert(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className={styles.page}>
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/purchase-invoices" className={styles.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>New Purchase Invoice{!isManual && grn?.grn_number ? ` · ${grn.grn_number}` : ""}</h1>
          </div>
        </div>
        <div className={styles.actions}>
          <div className={styles.totalRail}>
            <span className={styles.totalRailLabel}>Total</span>
            <span className={styles.totalRailValue}>{fmtRm(subtotalCenti, currency)}</span>
          </div>
          {isManual && (
            <Button variant="ghost" onClick={() => navigate("/purchase-invoices/from-grn")}>
              <ArrowRightLeft {...ICON} />
              <span>From Goods Receipt</span>
            </Button>
          )}
          <Button variant="primary" onClick={onSave} disabled={saving || !canSave}>
            <Save {...ICON} />
            <span>{saving ? "Saving…" : "Create Purchase Invoice"}</span>
          </Button>
        </div>
      </div>

      {/* ── Header card ────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Header</h2>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            {/* Supplier: locked (from GRN) or a manual picker. */}
            {isManual ? (
              <label className={styles.field} style={{ gridColumn: "span 2" }}>
                <span className={styles.fieldLabel}>Supplier *</span>
                <span className={styles.selectWrap}>
                  <select className={styles.fieldSelect} value={manualSupplierId} onChange={(e) => setManualSupplierId(e.target.value)}>
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
            {!isManual && (
              <>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>GRN #</span>
                  <div style={{ fontSize: "var(--fs-13)", paddingTop: 6, fontFamily: "var(--font-mono)", color: "var(--c-burnt)" }}>{grn?.grn_number ?? "—"}</div>
                </div>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>PO #</span>
                  <div style={{ fontSize: "var(--fs-13)", paddingTop: 6, fontFamily: "var(--font-mono)" }}>{po?.po_number ?? "—"}</div>
                </div>
              </>
            )}

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Supplier Invoice #</span>
              <input className={styles.fieldInput} value={supplierInvoiceRef} placeholder="From the supplier's printed invoice" onChange={(e) => setSupplierInvoiceRef(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Invoice Date</span>
              <input type="date" className={styles.fieldInput} value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Due Date</span>
              <input type="date" className={styles.fieldInput} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </label>
            <label className={styles.field} style={{ gridColumn: "span 3" }}>
              <span className={styles.fieldLabel}>Notes</span>
              <input className={styles.fieldInput} value={notes} placeholder="Internal notes for AP" onChange={(e) => setNotes(e.target.value)} />
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
            <p className={styles.emptyRow}>{!isManual && grnQ.isLoading ? "Loading GRN items…" : isManual ? "Pick a supplier above, then add items below." : "No items left to bill on this GRN."}</p>
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Item Code</th>
                <th>Description</th>
                <th className={styles.tableRight}>Qty</th>
                <th className={styles.tableRight}>Unit Price</th>
                <th className={styles.tableRight}>Line Total</th>
                <th className={styles.tableRight}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const isManualLine = l.grnItemId === null;
                return (
                  <tr key={l.rid}>
                    <td>
                      {isManualLine ? (
                        <input className={styles.fieldInput} style={{ width: 130 }} value={l.materialCode} placeholder="Code" onChange={(e) => setLine(l.rid, { materialCode: e.target.value })} />
                      ) : (
                        <span className={styles.codeCell}>{l.materialCode}</span>
                      )}
                    </td>
                    <td>
                      {isManualLine ? (
                        <input className={styles.fieldInput} style={{ width: 220 }} value={l.materialName} placeholder="Description" onChange={(e) => setLine(l.rid, { materialName: e.target.value })} />
                      ) : (
                        l.materialName || "—"
                      )}
                    </td>
                    <td className={styles.tableRight}>
                      <input type="number" min={0} className={styles.fieldInput} style={{ width: 80, textAlign: "right" }} value={l.qty} onChange={(e) => setLine(l.rid, { qty: Math.max(0, Number(e.target.value) || 0) })} />
                    </td>
                    <td className={styles.tableRight}>
                      <InlineRmInput valueCenti={l.unitPriceCenti} onCommit={(centi) => setLine(l.rid, { unitPriceCenti: centi })} style={{ width: 110 }} />
                    </td>
                    <td className={styles.priceCell}>{fmtRm(l.qty * l.unitPriceCenti, currency)}</td>
                    <td className={styles.tableRight}>
                      <button type="button" className={`${styles.iconBtn} ${styles.iconBtnDanger}`} title="Remove line" onClick={() => dropLine(l.rid)}>
                        <Trash2 {...SM_ICON} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
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

/* Minimal supplier picker source — reads the suppliers list endpoint directly. */
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
const InlineRmInput = ({ valueCenti, onCommit, style }: { valueCenti: number; onCommit: (centi: number) => void; style?: React.CSSProperties }) => {
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
