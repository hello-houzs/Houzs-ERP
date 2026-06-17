// ----------------------------------------------------------------------------
// StockTakes — list at /stock-takes (PR — Inv PR5).
//
// 1:1 clone of 2990s apps/backend/src/pages/StockTakes.tsx. AutoCount-style
// cycle count list. Pick warehouse + scope, snapshot system_qty, type counted_qty
// per line, Post -> ADJUSTMENT movements. + New Stock Take routes to
// /stock-takes/new.
//
// SEAM changes (same playbook as StockTransfers):
//   - Data layer: 2990s lib/stock-takes-queries -> co-located ./stock-takes-
//     queries (Houzs api client + react-query). Shapes identical (rule #7).
//   - Components: 2990s DataGrid -> plain <table> + Inventory.module.css;
//     @2990s/design-system Button -> Houzs components/Button. react-router ->
//     react-router-dom.
//   - Routes adapted to Houzs paths (/inventory back-link; /stock-takes/*).
//   - created_by is a Houzs users.id (number).
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Plus, SlidersHorizontal } from "lucide-react";
import { Button } from "../../components/Button";
import { useWarehouses } from "./inventory-queries";
import { useStockTakes, type StockTakeRow, type StockTakeStatus } from "./stock-takes-queries";
import styles from "./Inventory.module.css";

const ICON = { size: 14, strokeWidth: 1.75 } as const;
const ICON_MD = { size: 16, strokeWidth: 1.75 } as const;

// PR-DRAFT-removal — DRAFT renamed to OPEN (migration 0078).
const STATUS_OPTIONS: Array<StockTakeStatus | "ALL"> = ["ALL", "OPEN", "POSTED", "CANCELLED"];

const STATUS_TONE: Record<StockTakeStatus, { bg: string; fg: string; label: string }> = {
  OPEN: { bg: "rgba(34, 31, 32, 0.08)", fg: "var(--fg-muted)", label: "Open" },
  POSTED: { bg: "rgba(47, 93, 79, 0.16)", fg: "var(--c-secondary-a, #2F5D4F)", label: "Posted" },
  CANCELLED: { bg: "rgba(184, 51, 31, 0.10)", fg: "var(--c-festive-b, #B8331F)", label: "Cancelled" },
};

const fmtDate = (iso: string): string => {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/-/g, "/");
};

const scopeLabel = (scopeType: string, scopeValue: string | null): string => {
  if (scopeType === "ALL") return "All SKUs";
  if (scopeType === "CATEGORY") return `Category · ${scopeValue ?? "—"}`;
  if (scopeType === "CODE_PREFIX") return `Prefix · ${scopeValue ?? "—"}`;
  return scopeType;
};

const selectStyle = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-13)",
  background: "var(--c-paper)",
  border: "1px solid var(--line)",
  borderRadius: "var(--radius-md)",
  padding: "6px 8px",
  color: "var(--c-ink)",
} as const;

export const StockTakes = () => {
  const navigate = useNavigate();
  const [status, setStatus] = useState<StockTakeStatus | "ALL">("ALL");
  const [warehouseId, setWarehouseId] = useState<string>("");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");

  const warehouses = useWarehouses();
  const wmap = useMemo(() => new Map((warehouses.data ?? []).map((w) => [w.id, w])), [warehouses.data]);

  const { data: takes, isLoading, error } = useStockTakes({
    status: status === "ALL" ? undefined : status,
    warehouseId: warehouseId || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  });

  const rows = useMemo<StockTakeRow[]>(() => takes ?? [], [takes]);

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
          <h1 className={styles.title}>Stock Takes</h1>
        </div>
        <Button variant="primary" onClick={() => navigate("/stock-takes/new")}>
          <Plus {...ICON_MD} />
          <span>New Stock Take</span>
        </Button>
      </div>

      {/* Status pills */}
      <div className={styles.filterRow}>
        <div className={styles.warehouseChips}>
          {STATUS_OPTIONS.map((s) => (
            <button key={s} type="button" className={styles.chip} data-active={status === s} onClick={() => setStatus(s)}>
              {s === "ALL" ? "All status" : STATUS_TONE[s].label}
            </button>
          ))}
        </div>
      </div>

      {/* Warehouse + date range filters */}
      <div className={styles.filterRow}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "var(--fs-12)", color: "var(--fg-muted)" }}>
          <SlidersHorizontal size={12} strokeWidth={1.75} />
          Warehouse
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} style={selectStyle}>
            <option value="">Any warehouse</option>
            {(warehouses.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.code} · {w.name}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "var(--fs-12)", color: "var(--fg-muted)" }}>
          Date from
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={selectStyle} />
        </label>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "var(--fs-12)", color: "var(--fg-muted)" }}>
          to
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={selectStyle} />
        </label>
        {(warehouseId || dateFrom || dateTo || status !== "ALL") && (
          <button
            type="button"
            className={styles.chip}
            onClick={() => {
              setStatus("ALL");
              setWarehouseId("");
              setDateFrom("");
              setDateTo("");
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      <p className={styles.eyebrow}>
        {isLoading ? "Loading…" : `${rows.length} stock take${rows.length === 1 ? "" : "s"} (latest first)`}
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
              <th>STK #</th>
              <th>Date</th>
              <th>Warehouse</th>
              <th>Scope</th>
              <th>Status</th>
              <th style={{ textAlign: "right" }}>Lines</th>
              <th style={{ textAlign: "right" }}>Variance Total</th>
            </tr>
          </thead>
          <tbody>
            {!isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={7} className={styles.emptyRow}>
                  No stock takes yet — click "+ New Stock Take" to start a cycle count.
                </td>
              </tr>
            )}
            {rows.map((t) => {
              const tone = STATUS_TONE[t.status];
              const wh = t.warehouse ?? wmap.get(t.warehouse_id);
              const variance = t.variance_total ?? 0;
              const varianceColor =
                variance > 0 ? "var(--c-secondary-a, #2F5D4F)" : variance < 0 ? "var(--c-festive-b, #B8331F)" : "var(--fg-muted)";
              return (
                <tr key={t.id} style={{ cursor: "pointer" }} onClick={() => navigate(`/stock-takes/${t.id}`)}>
                  <td>
                    <span style={{ fontWeight: 700, color: "var(--c-burnt)", fontVariantNumeric: "tabular-nums" }}>
                      {t.take_no}
                    </span>
                  </td>
                  <td className={styles.numCellZero}>{fmtDate(t.take_date)}</td>
                  <td>
                    <strong>{wh ? wh.code : "—"}</strong>
                    {wh && (
                      <span style={{ color: "var(--fg-muted)", marginLeft: 6, fontSize: "var(--fs-12)" }}>{wh.name}</span>
                    )}
                  </td>
                  <td style={{ fontSize: "var(--fs-13)" }}>{scopeLabel(t.scope_type, t.scope_value)}</td>
                  <td>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        padding: "2px 8px",
                        borderRadius: "var(--radius-pill)",
                        fontFamily: "var(--font-button)",
                        fontSize: "var(--fs-11)",
                        fontWeight: 600,
                        background: tone.bg,
                        color: tone.fg,
                        letterSpacing: "0.02em",
                      }}
                    >
                      {tone.label}
                    </span>
                  </td>
                  <td className={`${styles.numCell} ${styles.numCellZero}`}>{(t.line_count ?? 0).toLocaleString("en-MY")}</td>
                  <td className={`${styles.numCell} ${styles.numCellZero}`} style={{ color: varianceColor, fontFamily: "var(--font-mono)" }}>
                    {variance > 0 ? "+" : ""}
                    {variance.toLocaleString("en-MY")}
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
