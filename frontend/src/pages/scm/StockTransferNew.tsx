// ----------------------------------------------------------------------------
// StockTransferNew — full-page form at /stock-transfers/new.
//
// 1:1 clone of 2990s apps/backend/src/pages/StockTransferNew.tsx. Header card
// (From/To/Date/Notes) + items table with SKU + qty + live current-balance
// lookup against the From warehouse. PR-DRAFT-removal: Save creates as POSTED
// directly + writes inventory_movements inline; routes to /stock-transfers/:id.
//
// SEAM changes (same playbook as GrnNew / PurchaseReturnNew):
//   - Data layer: 2990s lib/stock-transfers-queries + inventory-queries ->
//     co-located ./stock-transfers-queries + ./inventory-queries (Houzs api
//     client + react-query). Shapes identical (rule #7).
//   - Components: @2990s/design-system Button -> Houzs components/Button (variant
//     only). react-router -> react-router-dom. CSS: 2990s SalesOrderDetail.module
//     .css -> ./StockDoc.module.css (slice-local, same look).
//   - STRATEGY-2 product layer: 2990s useMfgProducts (furniture SKU master, the
//     <datalist> picker + auto-name fill) is DROPPED. SKU + description are plain
//     manual text inputs (Houzs enters its own codes). The available-balance
//     lookup is kept verbatim, but Houzs's /inventory?showAll path returns an
//     empty catalogue rollup until a product layer lands, so "Available" shows
//     "—" and never blocks the save (the avail==null guard). TODO: wire the SKU
//     picker + live availability to a Houzs product source in the Products slice.
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowRight, Save, X, Plus, Trash2, AlertTriangle } from "lucide-react";
import { Button } from "../../components/Button";
import { useWarehouses, useInventoryBalances } from "./inventory-queries";
import { useCreateStockTransfer, type StockTransferItemInput } from "./stock-transfers-queries";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import styles from "./StockDoc.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

type LineDraft = StockTransferItemInput & { _key: string };

const newKey = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const blankLine = (): LineDraft => ({
  _key: newKey(),
  productCode: "",
  productName: "",
  qty: 1,
  notes: "",
});

const todayISO = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export const StockTransferNew = () => {
  const navigate = useNavigate();
  const dialog = useDialog();
  const toast = useToast();
  const create = useCreateStockTransfer();

  // ── Header state ─────────────────────────────────────────────────────
  const [fromWarehouseId, setFromWarehouseId] = useState<string>("");
  const [toWarehouseId, setToWarehouseId] = useState<string>("");
  const [transferDate, setTransferDate] = useState<string>(todayISO());
  const [notes, setNotes] = useState<string>("");

  // ── Lines ────────────────────────────────────────────────────────────
  const [lines, setLines] = useState<LineDraft[]>([blankLine()]);

  // ── Data ─────────────────────────────────────────────────────────────
  const warehouses = useWarehouses();
  // Pull balances for the From warehouse so we can show "available" inline.
  const balances = useInventoryBalances({
    warehouseId: fromWarehouseId || undefined,
    showAll: true,
  });
  const balanceMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of balances.data?.balances ?? []) {
      m.set(b.product_code, b.qty);
    }
    return m;
  }, [balances.data]);

  // ── Helpers ──────────────────────────────────────────────────────────
  const setLine = (key: string, patch: Partial<LineDraft>) => {
    setLines((cur) => cur.map((l) => (l._key === key ? { ...l, ...patch } : l)));
  };

  const addLine = () => setLines((cur) => [...cur, blankLine()]);
  const removeLine = (key: string) => setLines((cur) => (cur.length <= 1 ? cur : cur.filter((l) => l._key !== key)));

  // ── Validation ───────────────────────────────────────────────────────
  const sameWarehouse = Boolean(fromWarehouseId && toWarehouseId && fromWarehouseId === toWarehouseId);
  const validLines = lines.filter((l) => l.productCode.trim() && l.qty > 0);
  const overdrawn = validLines.filter((l) => {
    const avail = balanceMap.get(l.productCode);
    if (avail == null) return false; // unknown — don't block
    return l.qty > avail;
  });

  const canSave = Boolean(fromWarehouseId && toWarehouseId && !sameWarehouse && transferDate && validLines.length > 0);

  const onSave = async () => {
    if (!canSave) {
      toast.error("Pick From + To warehouses (must differ), date, and at least one valid line.");
      return;
    }
    if (overdrawn.length > 0) {
      const proceed = await dialog.confirm(
        `Some lines exceed available stock at the source warehouse:\n` +
          overdrawn.map((l) => `  ${l.productCode}: want ${l.qty}, have ${balanceMap.get(l.productCode) ?? 0}`).join("\n") +
          `\n\nSaving will post immediately and push the source balance negative. Continue?`,
      );
      if (!proceed) return;
    }

    create.mutate(
      {
        fromWarehouseId,
        toWarehouseId,
        transferDate,
        notes: notes.trim() || undefined,
        items: validLines.map(({ _key: _ignored, ...rest }) => ({
          ...rest,
          productName: rest.productName?.trim() || undefined,
          notes: rest.notes?.trim() || undefined,
        })),
      },
      {
        onSuccess: (res) => navigate(`/stock-transfers/${res.id}`),
        onError: (err) => toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`),
      },
    );
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/stock-transfers" className={styles.backBtn}>
            <ArrowLeft {...ICON} /> <span>Stock Transfers</span>
          </Link>
          <h1 className={styles.title}>New Stock Transfer</h1>
        </div>
        <div className={styles.actions}>
          <Button variant="ghost" onClick={() => navigate("/stock-transfers")}>
            <X {...ICON} /> Cancel
          </Button>
          <Button variant="primary" onClick={onSave} disabled={create.isPending}>
            <Save {...ICON} />
            {create.isPending ? "Posting…" : "Post Transfer"}
          </Button>
        </div>
      </div>

      {/* ── Header card ──────────────────────────────────────────────── */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Transfer</h2>
        </div>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>From Warehouse *</span>
              <select value={fromWarehouseId} onChange={(e) => setFromWarehouseId(e.target.value)} className={styles.fieldSelect}>
                <option value="">— Pick source —</option>
                {(warehouses.data ?? []).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code} · {w.name}
                  </option>
                ))}
              </select>
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>
                <ArrowRight size={11} strokeWidth={1.75} style={{ verticalAlign: "middle", marginRight: 4 }} />
                To Warehouse *
              </span>
              <select value={toWarehouseId} onChange={(e) => setToWarehouseId(e.target.value)} className={styles.fieldSelect}>
                <option value="">— Pick destination —</option>
                {(warehouses.data ?? []).map((w) => (
                  <option key={w.id} value={w.id} disabled={w.id === fromWarehouseId}>
                    {w.code} · {w.name}
                    {w.id === fromWarehouseId ? " (source)" : ""}
                  </option>
                ))}
              </select>
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Transfer Date *</span>
              <input type="date" value={transferDate} onChange={(e) => setTransferDate(e.target.value)} className={styles.fieldInput} />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Notes</span>
              <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="(optional)" className={styles.fieldInput} />
            </label>
          </div>

          {sameWarehouse && (
            <div
              style={{
                marginTop: "var(--space-3)",
                padding: "var(--space-3) var(--space-4)",
                background: "rgba(184, 51, 31, 0.08)",
                border: "1px solid var(--c-festive-b, #B8331F)",
                borderRadius: "var(--radius-md)",
                fontSize: "var(--fs-13)",
                color: "var(--c-festive-b, #B8331F)",
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
              }}
            >
              <AlertTriangle size={16} strokeWidth={1.75} />
              <span>Source and destination warehouses must be different.</span>
            </div>
          )}
        </div>
      </section>

      {/* ── Items card ──────────────────────────────────────────────── */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Items</h2>
          <Button variant="ghost" onClick={addLine}>
            <Plus size={14} strokeWidth={1.75} /> Add Line Item
          </Button>
        </div>
        <div className={styles.cardBody}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th style={{ width: "20%" }}>SKU *</th>
                <th>Description</th>
                <th style={{ width: 110, textAlign: "right" }}>Available</th>
                <th style={{ width: 110, textAlign: "right" }}>Qty *</th>
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {lines.map((ln) => {
                const avail = ln.productCode ? balanceMap.get(ln.productCode) : undefined;
                const isOverdrawn = avail != null && ln.qty > avail;
                return (
                  <tr key={ln._key}>
                    <td>
                      <input
                        type="text"
                        value={ln.productCode}
                        onChange={(e) => setLine(ln._key, { productCode: e.target.value })}
                        placeholder="Type code…"
                        className={styles.fieldInput}
                        style={{ fontFamily: "var(--font-mono)" }}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        value={ln.productName ?? ""}
                        onChange={(e) => setLine(ln._key, { productName: e.target.value })}
                        placeholder="(optional)"
                        className={styles.fieldInput}
                      />
                    </td>
                    <td className={styles.tableRight} style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-13)" }}>
                      {!fromWarehouseId ? (
                        <span className={styles.muted}>—</span>
                      ) : !ln.productCode ? (
                        <span className={styles.muted}>—</span>
                      ) : balances.isLoading ? (
                        <span className={styles.muted}>…</span>
                      ) : (
                        <span style={{ color: (avail ?? 0) > 0 ? "var(--c-ink)" : "var(--fg-muted)" }}>
                          {(avail ?? 0).toLocaleString("en-MY")}
                        </span>
                      )}
                    </td>
                    <td className={styles.tableRight}>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={ln.qty}
                        onChange={(e) => {
                          const n = Math.max(0, Math.floor(Number(e.target.value) || 0));
                          setLine(ln._key, { qty: n });
                        }}
                        className={styles.fieldInput}
                        style={{
                          textAlign: "right",
                          fontFamily: "var(--font-mono)",
                          color: isOverdrawn ? "var(--c-festive-b, #B8331F)" : "var(--c-ink)",
                        }}
                      />
                    </td>
                    <td className={styles.actionsCell}>
                      <button
                        type="button"
                        onClick={() => removeLine(ln._key)}
                        className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                        disabled={lines.length <= 1}
                        title="Remove line"
                      >
                        <Trash2 size={14} strokeWidth={1.75} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className={styles.addLineRow}>
            <Button variant="ghost" onClick={addLine}>
              <Plus size={14} strokeWidth={1.75} /> Add Line Item
            </Button>
          </div>

          {overdrawn.length > 0 && (
            <div
              style={{
                marginTop: "var(--space-3)",
                padding: "var(--space-3) var(--space-4)",
                background: "rgba(184, 51, 31, 0.08)",
                border: "1px solid var(--c-festive-b, #B8331F)",
                borderRadius: "var(--radius-md)",
                fontSize: "var(--fs-13)",
                color: "var(--c-festive-b, #B8331F)",
                display: "flex",
                alignItems: "flex-start",
                gap: "var(--space-2)",
              }}
            >
              <AlertTriangle size={16} strokeWidth={1.75} style={{ flexShrink: 0, marginTop: 2 }} />
              <span>
                <strong>
                  {overdrawn.length} line{overdrawn.length === 1 ? "" : "s"} exceed available stock.
                </strong>{" "}
                Saving will post immediately and push the source balance negative. You'll be asked to confirm on Save.
              </span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
