// ----------------------------------------------------------------------------
// StockCard — per-SKU drilldown at /stock-card/:productCode. Optional
// ?warehouseId=… scopes the ledger + lots to one warehouse; otherwise sums
// across all warehouses. Read-only. 1:1 clone of 2990s
// apps/backend/src/pages/StockCard.tsx.
//
// SEAM changes (same playbook as the PO slice):
//   - Data layer: 2990s lib/inventory-queries -> Houzs api client + react-query
//     (co-located ./inventory-queries). Shapes identical (rule #7).
//   - Chrome: 2990s SalesOrderDetail.module.css `chrome` import -> the chrome
//     addendum merged into the verbatim Inventory.module.css (one stylesheet).
//   - Components: 2990s DataGrid (Movements ledger) -> plain <table> + verbatim
//     Inventory.module.css. Running balance precomputed chronologically.
//   - react-router -> react-router-dom (same hooks).
//
// docHrefFor deep-links to GRN/DO/DR/PR/transfer/stocktake detail pages. Those
// routes are cloned in LATER slices; until then the links 404 harmlessly (the
// ledger still renders). Kept verbatim so they light up as each slice lands.
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, Boxes, ArrowDownLeft, ArrowUpRight, ChevronDown, ChevronRight } from "lucide-react";
import {
  useInventoryMovements,
  useInventoryLots,
  useInventoryProductBreakdown,
  useWarehouses,
  type InventoryMovement,
  type InventoryLot,
} from "./inventory-queries";
import styles from "./Inventory.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRm = (sen: number | null | undefined): string => {
  if (sen == null) return "—";
  return `RM ${(sen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const fmtDateTime = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const date = d.toLocaleDateString("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/-/g, "/");
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${date} ${time}`;
};

const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/-/g, "/");
};

const docHrefFor = (m: InventoryMovement): string | null => {
  switch (m.source_doc_type) {
    case "GRN":
      return m.source_doc_id ? `/grns/${m.source_doc_id}` : null;
    case "DO":
      return m.source_doc_id ? `/mfg-delivery-orders/${m.source_doc_id}` : null;
    case "DR":
      return m.source_doc_id ? `/delivery-returns/${m.source_doc_id}` : null;
    case "PURCHASE_RETURN":
      return m.source_doc_id ? `/purchase-returns/${m.source_doc_id}` : null;
    case "STOCK_TRANSFER":
      return m.source_doc_id ? `/inventory/transfers/${m.source_doc_id}` : null;
    case "STOCK_TAKE":
      return m.source_doc_id ? `/inventory/stock-takes/${m.source_doc_id}` : null;
    case "ADJUSTMENT":
      return "/stock-adjustments";
    default:
      return null;
  }
};

export const StockCard = () => {
  const { productCode = "" } = useParams<{ productCode: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const warehouseId = searchParams.get("warehouseId") || undefined;
  const [includeClosed, setIncludeClosed] = useState(false);
  const [lotsOpen, setLotsOpen] = useState(true);

  const warehousesQ = useWarehouses();
  const breakdownQ = useInventoryProductBreakdown(productCode || null);
  const movementsQ = useInventoryMovements({ productCode: productCode || undefined, warehouseId });
  const lotsQ = useInventoryLots(productCode || null, { warehouseId, includeClosed });

  const warehouses = warehousesQ.data ?? [];
  const breakdownAll = (breakdownQ.data?.balances ?? []).filter((b) => b.product_code === productCode);
  const breakdown = warehouseId ? breakdownAll.filter((b) => b.warehouse_id === warehouseId) : breakdownAll;

  const movementsDesc = useMemo(() => movementsQ.data ?? [], [movementsQ.data]);
  const movementsWithBalance = useMemo(() => {
    const asc = [...movementsDesc].slice().reverse();
    let running = 0;
    const out: Array<InventoryMovement & { runningBalance: number }> = [];
    for (const m of asc) {
      running += m.movement_type === "OUT" ? -m.qty : m.qty;
      out.push({ ...m, runningBalance: running });
    }
    return out.reverse();
  }, [movementsDesc]);

  const lots: InventoryLot[] = lotsQ.data ?? [];

  const whName = (id: string) => {
    const wh = warehouses.find((w) => w.id === id);
    return wh ? `${wh.code} · ${wh.name}` : "—";
  };

  // ── Stats (always reflect the active warehouse filter) ────────────────
  const productName = breakdownAll[0]?.product_name ?? movementsDesc.find((m) => m.product_name)?.product_name ?? null;
  const totalQty = breakdown.reduce((s, b) => s + (b.qty ?? 0), 0);
  const warehouseCount = breakdown.filter((b) => (b.qty ?? 0) !== 0).length;
  const lastMovementAt = movementsDesc[0]?.created_at ?? null;
  const fifoValue = lots.reduce((s, l) => s + l.qty_remaining * l.unit_cost_sen, 0);

  return (
    <div className={styles.page}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/inventory" className={styles.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Inventory</span>
          </Link>
          <div>
            <h1 className={styles.title}>
              <Boxes size={20} strokeWidth={1.75} style={{ color: "var(--c-burnt)" }} />
              {" Stock Card · "}
              <span className={styles.codeChip} style={{ fontSize: "var(--fs-18)" }}>
                {productCode}
              </span>
            </h1>
            <p className={styles.subtitle}>
              {productName ?? "No movements yet for this SKU."}
              {warehouseId &&
                warehouses.length > 0 &&
                (() => {
                  const w = warehouses.find((x) => x.id === warehouseId);
                  return w ? ` · scoped to ${w.code} · ${w.name}` : null;
                })()}
            </p>
          </div>
        </div>
      </div>

      {/* ── Stats ──────────────────────────────────────────────────────── */}
      <div className={styles.statGrid}>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Current Qty</span>
          <span className={styles.statValue}>{totalQty.toLocaleString("en-MY")}</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Warehouses</span>
          <span className={styles.statValue}>{warehouseCount}</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Last Movement</span>
          <span className={styles.statValue} style={{ fontSize: "var(--fs-16)" }}>
            {lastMovementAt ? fmtDate(lastMovementAt) : "—"}
          </span>
          <span className={styles.statCaption}>{lastMovementAt ? fmtDateTime(lastMovementAt) : "No activity yet"}</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>FIFO Value</span>
          <span className={styles.statValue}>{fmtRm(fifoValue)}</span>
        </div>
      </div>

      {/* ── Warehouse filter pills ─────────────────────────────────────── */}
      <div className={styles.warehouseChips}>
        <button
          type="button"
          className={styles.chip}
          data-active={!warehouseId}
          onClick={() => {
            const p = new URLSearchParams(searchParams);
            p.delete("warehouseId");
            setSearchParams(p, { replace: true });
          }}
        >
          All warehouses
        </button>
        {warehouses.map((w) => (
          <button
            key={w.id}
            type="button"
            className={styles.chip}
            data-active={warehouseId === w.id}
            onClick={() => {
              const p = new URLSearchParams(searchParams);
              p.set("warehouseId", w.id);
              setSearchParams(p, { replace: true });
            }}
          >
            {w.code} · {w.name}
          </button>
        ))}
      </div>

      {/* ── Per-Warehouse Balance card (only in All mode) ──────────────── */}
      {!warehouseId && (
        <section className={styles.card}>
          <header className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>Per-Warehouse Balance</h2>
          </header>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Warehouse Code</th>
                <th>Warehouse Name</th>
                <th style={{ textAlign: "right" }}>Qty On Hand</th>
                <th style={{ textAlign: "right" }}>Value</th>
              </tr>
            </thead>
            <tbody>
              {breakdownQ.isLoading && (
                <tr>
                  <td colSpan={4} className={styles.emptyRow}>Loading…</td>
                </tr>
              )}
              {!breakdownQ.isLoading && breakdownAll.length === 0 && (
                <tr>
                  <td colSpan={4} className={styles.emptyRow}>No warehouse balances for this SKU.</td>
                </tr>
              )}
              {!breakdownQ.isLoading &&
                breakdownAll.map((b) => {
                  const qtyClass = b.qty > 0 ? styles.numCellPos : b.qty < 0 ? styles.numCellNeg : styles.numCellZero;
                  return (
                    <tr key={`${b.warehouse_id}|${b.variant_key ?? ""}`}>
                      <td>
                        <span className={styles.codeChip}>{b.warehouse_code ?? "—"}</span>
                      </td>
                      <td>{b.warehouse_name ?? "—"}</td>
                      <td className={`${styles.numCell} ${qtyClass}`}>{b.qty.toLocaleString("en-MY")}</td>
                      <td className={`${styles.numCell} ${styles.numCellZero}`}>
                        {b.value_sen && b.value_sen > 0 ? fmtRm(b.value_sen) : "—"}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </section>
      )}

      {/* ── Movements ledger ───────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>
            Movements ({movementsWithBalance.length}
            {warehouseId ? " · filtered" : ""})
          </h2>
        </header>
        {!movementsQ.isLoading && movementsQ.error ? (
          <div className={styles.bannerWarn} style={{ margin: "var(--space-3)" }}>
            <strong>Failed to load.</strong>{" "}
            {movementsQ.error instanceof Error ? movementsQ.error.message : String(movementsQ.error)}
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Source Doc</th>
                <th>Warehouse</th>
                <th style={{ textAlign: "right" }}>Qty</th>
                <th style={{ textAlign: "right" }}>Unit Cost</th>
                <th style={{ textAlign: "right" }}>Running Balance</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {movementsQ.isLoading && (
                <tr>
                  <td colSpan={8} className={styles.emptyRow}>Loading…</td>
                </tr>
              )}
              {!movementsQ.isLoading && movementsWithBalance.length === 0 && (
                <tr>
                  <td colSpan={8} className={styles.emptyRow}>No movements for this SKU yet.</td>
                </tr>
              )}
              {movementsWithBalance.map((m) => {
                const href = docHrefFor(m);
                const qtySign =
                  m.movement_type === "IN" ? "+" : m.movement_type === "OUT" ? "−" : m.qty > 0 ? "+" : m.qty < 0 ? "−" : "";
                const qtyClass = m.qty > 0 ? styles.numCellPos : m.qty < 0 ? styles.numCellNeg : styles.numCellZero;
                return (
                  <tr key={m.id}>
                    <td className={styles.numCellZero}>{fmtDateTime(m.created_at)}</td>
                    <td>
                      <span
                        className={`${styles.movementPill} ${
                          m.movement_type === "IN"
                            ? styles.movementIn
                            : m.movement_type === "OUT"
                              ? styles.movementOut
                              : styles.movementAdj
                        }`}
                      >
                        {m.movement_type === "IN" && <ArrowDownLeft size={11} strokeWidth={2} style={{ marginRight: 4 }} />}
                        {m.movement_type === "OUT" && <ArrowUpRight size={11} strokeWidth={2} style={{ marginRight: 4 }} />}
                        {m.movement_type}
                      </span>
                    </td>
                    <td>
                      {m.source_doc_no ? (
                        href ? (
                          <Link to={href} className={styles.docLink}>
                            {m.source_doc_no}
                          </Link>
                        ) : (
                          <span className={styles.docLink}>{m.source_doc_no}</span>
                        )
                      ) : (
                        <span className={styles.numCellZero}>—</span>
                      )}
                    </td>
                    <td>{whName(m.warehouse_id)}</td>
                    <td className={`${styles.numCell} ${qtyClass}`}>
                      {qtySign}
                      {Math.abs(m.qty).toLocaleString("en-MY")}
                    </td>
                    <td className={`${styles.numCell} ${styles.numCellZero}`}>
                      {m.unit_cost_sen && m.unit_cost_sen > 0 ? fmtRm(m.unit_cost_sen) : "—"}
                    </td>
                    <td className={styles.numCell} style={{ fontWeight: 700 }}>
                      {m.runningBalance.toLocaleString("en-MY")}
                    </td>
                    <td className={styles.numCellZero}>{m.notes ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* ── FIFO Lots ──────────────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader} style={{ cursor: "pointer" }} onClick={() => setLotsOpen((v) => !v)}>
          <h2 className={styles.cardTitle} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {lotsOpen ? <ChevronDown size={14} strokeWidth={1.75} /> : <ChevronRight size={14} strokeWidth={1.75} />}
            FIFO Lots ({lots.length}
            {includeClosed ? " · incl closed" : " · open only"})
          </h2>
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: "var(--fs-13)",
              fontFamily: "var(--font-sans)",
              color: "var(--c-ink)",
              cursor: "pointer",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <input type="checkbox" checked={includeClosed} onChange={(e) => setIncludeClosed(e.target.checked)} />
            Show closed lots
          </label>
        </header>
        {lotsOpen && (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Received At</th>
                <th>Source Doc</th>
                <th>Warehouse</th>
                <th style={{ textAlign: "right" }}>Qty Received</th>
                <th style={{ textAlign: "right" }}>Qty Remaining</th>
                <th style={{ textAlign: "right" }}>Unit Cost</th>
                <th style={{ textAlign: "right" }}>Remaining Value</th>
              </tr>
            </thead>
            <tbody>
              {lotsQ.isLoading && (
                <tr>
                  <td colSpan={7} className={styles.emptyRow}>Loading lots…</td>
                </tr>
              )}
              {!lotsQ.isLoading && lots.length === 0 && (
                <tr>
                  <td colSpan={7} className={styles.emptyRow}>
                    {includeClosed
                      ? "No lots ever recorded for this SKU."
                      : 'No open lots — toggle "Show closed lots" to see consumed ones.'}
                  </td>
                </tr>
              )}
              {!lotsQ.isLoading &&
                lots.map((l) => {
                  const closed = l.qty_remaining === 0;
                  const remainingValue = l.remaining_value_sen ?? l.qty_remaining * l.unit_cost_sen;
                  return (
                    <tr key={l.id} style={closed ? { opacity: 0.55 } : undefined}>
                      <td className={styles.numCellZero}>{fmtDateTime(l.received_at)}</td>
                      <td>
                        {l.source_doc_no ? (
                          <span className={styles.docLink}>{l.source_doc_no}</span>
                        ) : (
                          <span className={styles.numCellZero}>—</span>
                        )}
                      </td>
                      <td>{l.warehouse_code ?? "—"}</td>
                      <td className={`${styles.numCell} ${styles.numCellZero}`}>{l.qty_received.toLocaleString("en-MY")}</td>
                      <td className={`${styles.numCell} ${closed ? styles.numCellZero : styles.numCellPos}`}>
                        {l.qty_remaining.toLocaleString("en-MY")}
                        {closed && (
                          <span style={{ marginLeft: 6, fontSize: "var(--fs-11)", color: "var(--fg-muted)", fontWeight: 500 }}>
                            closed
                          </span>
                        )}
                      </td>
                      <td className={`${styles.numCell} ${styles.numCellZero}`}>{fmtRm(l.unit_cost_sen)}</td>
                      <td className={styles.numCell} style={{ fontWeight: 700 }}>
                        {remainingValue > 0 ? fmtRm(remainingValue) : "—"}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
};
