import { useMemo } from "react";
import { adjustmentReasonLabel } from "@2990s/shared";
import { formatDate } from "../lib/utils";
import {
  useInventoryMovements,
  useInventoryProductBreakdown,
  type InventoryMovement,
} from "../vendor/scm/lib/inventory-queries";

/* ------------------------------------------------------------------ *
 * Mobile Stock Card — per-SKU on-hand, per-warehouse split and the
 * movement ledger with a client-computed running balance. Phone twin of
 * desktop pages/scm-v2/StockCard.tsx; reuses the SAME shared hooks
 * (useInventoryProductBreakdown / useInventoryMovements). No backend.
 * Opened from the Inventory list (MobileApp routes an inventory row here).
 * ------------------------------------------------------------------ */

type MovementRow = InventoryMovement & { runningBalance: number };

// OUT reduces on-hand (qty stored positive); IN/ADJUSTMENT/TRANSFER carry the
// value that applies (ADJ/TRANSFER are already signed). Verbatim from desktop
// StockCard running-balance rule.
const signedQty = (m: InventoryMovement): number => (m.movement_type === "OUT" ? -m.qty : m.qty);

const TYPE_PILL: Record<InventoryMovement["movement_type"], { cls: string; label: (m: InventoryMovement) => string }> = {
  IN: { cls: "in", label: (m) => `IN${m.source_doc_type ? ` · ${m.source_doc_type}` : ""}` },
  OUT: { cls: "out", label: (m) => `OUT${m.source_doc_type ? ` · ${m.source_doc_type}` : ""}` },
  ADJUSTMENT: { cls: "adj", label: () => "ADJ" },
  TRANSFER: { cls: "tr", label: () => "TRANSFER" },
};

export function MobileStockCard({
  productCode,
  productName,
  canTransfer,
  onBack,
  onNewTransfer,
}: {
  productCode: string;
  productName: string | null;
  canTransfer: boolean;
  onBack: () => void;
  onNewTransfer: () => void;
}) {
  const breakdownQ = useInventoryProductBreakdown(productCode);
  const movementsQ = useInventoryMovements({ productCode });

  const balances = useMemo(
    () => (breakdownQ.data?.balances ?? []).filter((b) => b.product_code === productCode),
    [breakdownQ.data, productCode],
  );
  const onHand = useMemo(() => balances.reduce((s, b) => s + (b.qty ?? 0), 0), [balances]);

  // API returns DESC; reverse to ASC to accumulate the running balance, then
  // render DESC (newest first) with the balance AFTER each movement.
  const rows = useMemo<MovementRow[]>(() => {
    const desc = movementsQ.data ?? [];
    const asc = [...desc].reverse();
    let running = 0;
    const out: MovementRow[] = [];
    for (const m of asc) {
      running += signedQty(m);
      out.push({ ...m, runningBalance: running });
    }
    return out.reverse();
  }, [movementsQ.data]);

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button className="back" onClick={onBack}>
            <span className="chev">‹</span> Inventory
          </button>
          <span className="eyebrow">Stock Card · {productCode}</span>
        </div>
        <div className="hdr-row" style={{ marginTop: 2 }}>
          <div className="scr-title">{productName || productCode}</div>
        </div>
      </header>

      <div className="hz-scroll" style={{ flex: 1, overflowY: "auto", padding: 14, paddingBottom: 40, display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="sc-hero">
          <div className="l">On hand · all warehouses</div>
          <div className="v tnum">{onHand} <span className="u">units</span></div>
        </div>

        {balances.length > 0 && (
          <>
            <div className="sc-sl"><span className="t">Per warehouse</span><span className="ln" /></div>
            <div className="sc-whgrid">
              {balances.map((b) => (
                <div key={b.warehouse_id}>
                  <span className="wn">{b.warehouse_name || b.warehouse_code || "—"}</span>
                  <span className="wq tnum">{b.qty ?? 0}</span>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="sc-sl"><span className="t">Movements</span><span className="ln" /></div>
        {movementsQ.isLoading ? (
          <div style={{ textAlign: "center", color: "var(--mut2)", fontSize: 12, padding: "20px 0" }}>Loading…</div>
        ) : movementsQ.error ? (
          <div style={{ textAlign: "center", color: "var(--red)", fontSize: 12, padding: "20px 0" }}>Couldn't load movements.</div>
        ) : rows.length === 0 ? (
          <div className="empty"><div className="empty-t">No movements yet.</div></div>
        ) : (
          <div className="card" style={{ padding: "4px 13px" }}>
            {rows.map((m) => {
              const pill = TYPE_PILL[m.movement_type];
              const sq = signedQty(m);
              return (
                <div key={m.id} className="sc-mv">
                  <span className={`sc-mp ${pill.cls}`}>{pill.label(m)}</span>
                  <div className="md">
                    <div className="dt tnum">{formatDate(m.created_at)}</div>
                    {/* An ADJUSTMENT has no source_doc_no, so the raw reason_code
                        (WRITEOFF / COUNT / DAMAGE / THEFT) was reaching the screen.
                        Desktop already labels it (StockAdjustments.tsx) — same
                        helper here so the two can't drift. */}
                    <div className="rf">
                      {m.source_doc_no ||
                        (m.reason_code ? adjustmentReasonLabel(m.reason_code) : "") ||
                        m.notes ||
                        "—"}
                    </div>
                  </div>
                  <span className={`sc-mq tnum${sq < 0 ? " neg" : ""}`}>{sq > 0 ? `+${sq}` : sq}</span>
                  <span className="sc-mb tnum">{m.runningBalance}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {canTransfer && (
        <div className="actbar">
          <button className="btn" onClick={onNewTransfer}>New stock transfer</button>
        </div>
      )}
    </div>
  );
}

export default MobileStockCard;
