// ----------------------------------------------------------------------------
// StockAdjustments — list of past manual stock adjustments (write-offs, found
// stock, damage, recount fixes). Read-only ledger at /stock-adjustments.
// + New Adjustment routes to /stock-adjustments/new. 1:1 clone of 2990s
// apps/backend/src/pages/StockAdjustments.tsx.
//
// SEAM changes (same playbook as the PO slice):
//   - Data layer: 2990s lib/inventory-queries -> Houzs api client + react-query
//     (co-located ./inventory-queries). Shapes identical (rule #7).
//   - adjustmentReasonLabel: 2990s @2990s/shared -> Houzs @shared/index (ported).
//   - Components: 2990s DataGrid -> plain <table> + verbatim Inventory.module.css.
//   - react-router -> react-router-dom (same hooks). Routes adapted to Houzs
//     (/inventory -> Inventory page; /stock-adjustments/new -> new form).
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Plus, Search, SlidersHorizontal } from "lucide-react";
import { Button } from "../../components/Button";
import { adjustmentReasonLabel } from "@shared/index";
import { useWarehouses, useInventoryMovements, type InventoryMovement } from "./inventory-queries";
import styles from "./Inventory.module.css";

const ICON = { size: 14, strokeWidth: 1.75 } as const;
const ICON_MD = { size: 16, strokeWidth: 1.75 } as const;

const fmtDateTime = (iso: string): string => {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const date = d.toLocaleDateString("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/-/g, "/");
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${date} ${time}`;
};

export const StockAdjustments = () => {
  const navigate = useNavigate();
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");

  const warehouses = useWarehouses();
  // Server filters by warehouse + date; SKU search is client-side because the
  // API's productCode filter is exact-match (eq), not ilike.
  const { data, isLoading, error } = useInventoryMovements({
    docType: "ADJUSTMENT",
    warehouseId: warehouseId ?? undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  });

  const wmap = useMemo(() => new Map((warehouses.data ?? []).map((w) => [w.id, w])), [warehouses.data]);

  const rows: InventoryMovement[] = useMemo(() => {
    const all = data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (m) => m.product_code.toLowerCase().includes(q) || (m.product_name ?? "").toLowerCase().includes(q),
    );
  }, [data, search]);

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <Link
            to="/inventory"
            className={styles.chip}
            style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4, marginBottom: "var(--space-2)" }}
          >
            <ArrowLeft {...ICON} /> <span>Inventory</span>
          </Link>
          <h1 className={styles.title}>Stock Adjustments</h1>
        </div>
        <Button variant="primary" onClick={() => navigate("/stock-adjustments/new")}>
          <Plus {...ICON_MD} />
          <span>New Adjustment</span>
        </Button>
      </div>

      {/* Filter row — Warehouse chips + Search + Date range */}
      <div className={styles.filterRow}>
        <div className={styles.warehouseChips}>
          <button type="button" className={styles.chip} data-active={warehouseId === null} onClick={() => setWarehouseId(null)}>
            All warehouses
          </button>
          {warehouses.data?.map((w) => (
            <button key={w.id} type="button" className={styles.chip} data-active={warehouseId === w.id} onClick={() => setWarehouseId(w.id)}>
              {w.code} · {w.name}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.filterRow}>
        <div className={styles.searchBox}>
          <Search {...ICON} className={styles.searchIcon} />
          <input
            type="search"
            className={styles.searchInput}
            placeholder="Search SKU code / description…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "var(--fs-12)", color: "var(--fg-muted)" }}>
          <SlidersHorizontal size={12} strokeWidth={1.75} />
          From
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "var(--fs-13)",
              background: "var(--c-paper)",
              border: "1px solid var(--line)",
              borderRadius: "var(--radius-md)",
              padding: "6px 8px",
              color: "var(--c-ink)",
            }}
          />
        </label>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "var(--fs-12)", color: "var(--fg-muted)" }}>
          To
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "var(--fs-13)",
              background: "var(--c-paper)",
              border: "1px solid var(--line)",
              borderRadius: "var(--radius-md)",
              padding: "6px 8px",
              color: "var(--c-ink)",
            }}
          />
        </label>
        {(dateFrom || dateTo || search || warehouseId) && (
          <button
            type="button"
            className={styles.chip}
            onClick={() => {
              setDateFrom("");
              setDateTo("");
              setSearch("");
              setWarehouseId(null);
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      <p className={styles.eyebrow}>
        {isLoading ? "Loading…" : `${rows.length} adjustment${rows.length === 1 ? "" : "s"} (latest first)`}
      </p>

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load.</strong> {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Date</th>
              <th>Warehouse</th>
              <th>SKU</th>
              <th>Product Name</th>
              <th style={{ textAlign: "right" }}>Qty Delta</th>
              <th>Reason</th>
              <th>Notes</th>
              <th>Performed By</th>
            </tr>
          </thead>
          <tbody>
            {!isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={8} className={styles.emptyRow}>
                  No stock adjustments yet — click "+ New Adjustment" to create one.
                </td>
              </tr>
            )}
            {rows.map((m) => {
              const w = wmap.get(m.warehouse_id);
              const qtyClass = m.qty > 0 ? styles.numCellPos : m.qty < 0 ? styles.numCellNeg : styles.numCellZero;
              return (
                <tr key={m.id}>
                  <td className={styles.numCellZero}>{fmtDateTime(m.created_at)}</td>
                  <td>{w ? `${w.code} · ${w.name}` : "—"}</td>
                  <td>
                    <span className={styles.codeChip}>{m.product_code}</span>
                  </td>
                  <td>{m.product_name ?? "—"}</td>
                  <td className={`${styles.numCell} ${qtyClass}`}>
                    {m.qty > 0 ? "+" : ""}
                    {m.qty.toLocaleString("en-MY")}
                  </td>
                  <td>{m.reason_code ? adjustmentReasonLabel(m.reason_code) : "—"}</td>
                  <td className={styles.numCellZero}>{m.notes ?? "—"}</td>
                  <td
                    className={styles.numCellZero}
                    style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-11)" }}
                  >
                    {m.performed_by != null ? String(m.performed_by) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
