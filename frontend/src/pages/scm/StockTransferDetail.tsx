// ----------------------------------------------------------------------------
// StockTransferDetail — header + lines at /stock-transfers/:id.
//
// 1:1 clone of 2990s apps/backend/src/pages/StockTransferDetail.tsx. PR-DRAFT-
// removal: transfers post on create, so detail is read-only for POSTED +
// CANCELLED rows; Cancel remains for POSTED rows (reverses the paired movements).
//
// SEAM changes (same playbook as GoodsReceivedDetail):
//   - Data layer: 2990s lib/stock-transfers-queries + inventory-queries ->
//     co-located ./stock-transfers-queries + ./inventory-queries (Houzs api
//     client + react-query). Shapes identical (rule #7).
//   - Components: @2990s/design-system Button -> Houzs components/Button.
//     react-router -> react-router-dom. CSS -> ./StockDoc.module.css. 2990s
//     SkeletonDetailPage -> plain loading text (done-slice precedent).
//   - STRATEGY-2: 2990s buildVariantSummary (furniture variant formatter) is
//     DROPPED. The "Description 2" column shows the line's stored description2 (if
//     any) else an em-dash — Houzs materials have no item-group/variant axes.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, X, Ban } from "lucide-react";
import { Button } from "../../components/Button";
import { useWarehouses } from "./inventory-queries";
import {
  useStockTransferDetail,
  useCancelStockTransfer,
  type StockTransferItemInput,
  type StockTransferStatus,
} from "./stock-transfers-queries";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import styles from "./StockDoc.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

type LineDraft = StockTransferItemInput & { _key: string };

const newKey = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const STATUS_TONE: Record<StockTransferStatus, { bg: string; fg: string; label: string }> = {
  POSTED: { bg: "rgba(47, 93, 79, 0.16)", fg: "var(--c-secondary-a, #2F5D4F)", label: "Posted" },
  CANCELLED: { bg: "rgba(184, 51, 31, 0.10)", fg: "var(--c-festive-b, #B8331F)", label: "Cancelled" },
};

const fmtDateTime = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const date = d.toLocaleDateString("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/-/g, "/");
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${date} ${time}`;
};

export const StockTransferDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const dialog = useDialog();
  const toast = useToast();

  const detail = useStockTransferDetail(id ?? null);
  const cancel = useCancelStockTransfer();

  const warehouses = useWarehouses();

  // ── Read-only state mirrored from server (no edits post-0078) ────────
  const [fromWarehouseId, setFromWarehouseId] = useState("");
  const [toWarehouseId, setToWarehouseId] = useState("");
  const [transferDate, setTransferDate] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Array<LineDraft & { description2?: string | null }>>([]);

  // Hydrate when detail loads / refreshes.
  useEffect(() => {
    if (!detail.data) return;
    const t = detail.data.transfer;
    setFromWarehouseId(t.from_warehouse_id);
    setToWarehouseId(t.to_warehouse_id);
    setTransferDate(t.transfer_date);
    setNotes(t.notes ?? "");
    setLines(
      detail.data.lines.map((l) => ({
        _key: newKey(),
        productCode: l.product_code,
        productName: l.product_name ?? "",
        qty: l.qty,
        notes: l.notes ?? "",
      })),
    );
  }, [detail.data]);

  const status: StockTransferStatus | undefined = detail.data?.transfer.status;
  const tone = status ? STATUS_TONE[status] : null;
  const isPosted = status === "POSTED";

  const wmap = useMemo(() => new Map((warehouses.data ?? []).map((w) => [w.id, w])), [warehouses.data]);
  // Read referenced so the disabled selects + future code keep the hook honest.
  void wmap;

  // ── Cancel ───────────────────────────────────────────────────────────
  const onCancel = async () => {
    if (!id) return;
    const proceed = await dialog.confirm(
      "Cancel this transfer? The paired stock movements (out of the source warehouse, into the destination) will be reversed automatically — the stock returns to where it started.",
    );
    if (!proceed) return;
    cancel.mutate(id, {
      onSuccess: () => detail.refetch(),
      onError: (err) => toast.error(`Cancel failed: ${err instanceof Error ? err.message : String(err)}`),
    });
  };

  // ── Render ───────────────────────────────────────────────────────────
  if (detail.isLoading) {
    return (
      <div className={styles.page}>
        <p className={styles.subtitle}>Loading…</p>
      </div>
    );
  }
  if (detail.error || !detail.data) {
    return (
      <div className={styles.page}>
        <p className={styles.subtitle}>{detail.error instanceof Error ? detail.error.message : "Transfer not found."}</p>
        <Link to="/stock-transfers">Back to Stock Transfers</Link>
      </div>
    );
  }

  const t = detail.data.transfer;

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/stock-transfers" className={styles.backBtn}>
            <ArrowLeft {...ICON} /> <span>Stock Transfers</span>
          </Link>
          <h1 className={styles.title}>
            {t.transfer_no}
            {tone && (
              <span
                style={{
                  marginLeft: "var(--space-3)",
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "4px 10px",
                  borderRadius: "var(--radius-pill)",
                  fontFamily: "var(--font-button)",
                  fontSize: "var(--fs-12)",
                  fontWeight: 600,
                  background: tone.bg,
                  color: tone.fg,
                  letterSpacing: "0.04em",
                  verticalAlign: "middle",
                }}
              >
                {tone.label}
              </span>
            )}
          </h1>
          <p className={styles.subtitle}>
            Created {fmtDateTime(t.created_at)}
            {t.posted_at ? ` · Posted ${fmtDateTime(t.posted_at)}` : ""}
            {t.cancelled_at ? ` · Cancelled ${fmtDateTime(t.cancelled_at)}` : ""}
          </p>
        </div>
        <div className={styles.actions}>
          {isPosted && (
            <Button variant="ghost" onClick={onCancel} disabled={cancel.isPending}>
              <Ban {...ICON} /> {cancel.isPending ? "Cancelling…" : "Cancel"}
            </Button>
          )}
          <Button variant="ghost" onClick={() => navigate("/stock-transfers")}>
            <X {...ICON} /> Close
          </Button>
        </div>
      </div>

      {/* ── Header card ─────────────────────────────────────────────── */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Transfer</h2>
        </div>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            {/* Read-only display since transfers post on create. */}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>From Warehouse</span>
              <select value={fromWarehouseId} className={styles.fieldSelect} disabled>
                <option value="">—</option>
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
                To Warehouse
              </span>
              <select value={toWarehouseId} className={styles.fieldSelect} disabled>
                <option value="">—</option>
                {(warehouses.data ?? []).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code} · {w.name}
                  </option>
                ))}
              </select>
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Transfer Date</span>
              <input type="date" value={transferDate} className={styles.fieldInput} disabled />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Notes</span>
              <input type="text" value={notes} className={styles.fieldInput} disabled />
            </label>
          </div>
        </div>
      </section>

      {/* ── Lines card (read-only post-0078) ────────────────────────── */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Items</h2>
        </div>
        <div className={styles.cardBody}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th style={{ width: "20%" }}>SKU</th>
                <th>Description</th>
                <th>Description 2</th>
                <th style={{ width: 110, textAlign: "right" }}>Qty</th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr>
                  <td colSpan={4} className={styles.emptyRow}>
                    No lines.
                  </td>
                </tr>
              )}
              {lines.map((ln) => (
                <tr key={ln._key}>
                  <td>
                    <span className={styles.codeCell}>{ln.productCode}</span>
                  </td>
                  <td>{ln.productName || <span className={styles.muted}>—</span>}</td>
                  {/* "Description 2": STRATEGY-2 — show stored description2 (none on
                      a transfer line in Houzs) else em-dash. buildVariantSummary
                      (furniture formatter) dropped. */}
                  <td>
                    {ln.description2 && ln.description2.trim() ? (
                      <span>{ln.description2}</span>
                    ) : (
                      <span className={styles.muted}>—</span>
                    )}
                  </td>
                  <td className={styles.tableRight} style={{ fontFamily: "var(--font-mono)" }}>
                    {ln.qty.toLocaleString("en-MY")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
