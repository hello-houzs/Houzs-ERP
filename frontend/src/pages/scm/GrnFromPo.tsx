// ----------------------------------------------------------------------------
// GrnFromPo — multi-select PO LINE → New GRN form FEEDER at /grns/from-po.
//
// 1:1 clone of 2990s apps/backend/src/pages/GrnFromPo.tsx (the Commander
// 2026-05-29 redesign): this picker does NOT auto-create GRNs. Like Create-PO-
// from-SO, it FEEDS the New GRN form — tick the outstanding PO lines you're
// receiving, optionally adjust the Pick Qty, hit "Add N lines to GRN", and you
// land on /grns/new with those lines pre-loaded (supplier locked, each line
// keeping its own purchase_order_item_id so received_qty rolls up to every source
// PO). One supplier per GRN: once a line is ticked, other suppliers' lines grey
// out + disable.
//
// SEAM changes (same playbook as PurchaseOrderFromSo):
//   - Data layer: 2990s lib/suppliers-queries useOutstandingPoItems -> the GRN
//     hook in ./grn-queries (Houzs api client + TanStack). Shape identical (rule
//     #7) — backed by /api/grns/outstanding-po-items.
//   - Components: @2990s/design-system Button -> Houzs components/Button; 2990s
//     DataGrid + VariantDescription + ItemGroupPill (furniture-coupled) -> a plain
//     <table> with the verbatim PurchaseOrderDetail.module.css classes (rule #9).
//   - Routing: react-router -> react-router-dom (same hooks).
//
// Strategy-2 product-layer notes:
//   - The category + date-range filters (furniture taxonomy) are DROPPED; a plain
//     text search over PO no / code / supplier remains.
//   - APPEND-to-existing-GRN mode (?appendToGrn=) depends on the GRN edit page's
//     append flow + DataGrid; DROPPED. The picker always feeds the New GRN form.
//     TODO: append mode when the detail-edit append UX lands.
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Save, CheckSquare, Square } from "lucide-react";
import { Button } from "../../components/Button";
import { useOutstandingPoItems, type OutstandingPoItem } from "./grn-queries";
import { useToast } from "../../hooks/useToast";
import styles from "./PurchaseOrderDetail.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number, currency = "MYR"): string =>
  `${currency} ${(centi / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDateOrDash = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

type Pick = { picked: boolean; qty: number };

/* Shape stashed to sessionStorage for the New GRN form to consume — the full row
   plus the chosen pick qty (mirrors 2990s GrnFromPoPick). */
export type GrnFromPoPick = OutstandingPoItem & { _pickQty: number };

export const GrnFromPo = () => {
  const navigate = useNavigate();
  const toast = useToast();
  const itemsQ = useOutstandingPoItems();

  // ?poId=<id> (single / batch convert) → scope to those POs. Empty = full picker.
  const [searchParams] = useSearchParams();
  const poIdFilter = searchParams.get("poId");
  const poIdSet = useMemo(
    () =>
      new Set(
        (poIdFilter ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    [poIdFilter],
  );

  // Map<poItemId, { picked, qty }>. qty defaults to remainingQty when ticked.
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [search, setSearch] = useState("");

  const allRows = useMemo<OutstandingPoItem[]>(() => itemsQ.data ?? [], [itemsQ.data]);

  // The locked supplier — once any line is ticked, only that supplier's lines are
  // pickable (one supplier per GRN).
  const lockedSupplierId = useMemo(() => {
    const firstPicked = Object.entries(picks).find(([, p]) => p.picked);
    if (!firstPicked) return null;
    const row = allRows.find((r) => r.poItemId === firstPicked[0]);
    return row?.supplierId ?? null;
  }, [picks, allRows]);

  const rows = useMemo<OutstandingPoItem[]>(() => {
    let r = allRows;
    if (poIdSet.size > 0) r = r.filter((x) => poIdSet.has(x.poId));
    const q = search.trim().toLowerCase();
    if (q) {
      r = r.filter(
        (x) =>
          x.poDocNo.toLowerCase().includes(q) ||
          x.itemCode.toLowerCase().includes(q) ||
          (x.description ?? "").toLowerCase().includes(q) ||
          x.supplierName.toLowerCase().includes(q) ||
          x.supplierCode.toLowerCase().includes(q),
      );
    }
    return r;
  }, [allRows, poIdSet, search]);

  const isPickable = (r: OutstandingPoItem): boolean => !lockedSupplierId || r.supplierId === lockedSupplierId;

  const togglePick = (r: OutstandingPoItem) => {
    if (!isPickable(r)) return;
    setPicks((prev) => {
      const cur = prev[r.poItemId];
      if (cur?.picked) {
        const next = { ...prev };
        delete next[r.poItemId];
        return next;
      }
      return { ...prev, [r.poItemId]: { picked: true, qty: r.remainingQty } };
    });
  };

  const setQty = (r: OutstandingPoItem, qty: number) =>
    setPicks((prev) => ({ ...prev, [r.poItemId]: { picked: true, qty: Math.max(0, Math.min(qty, r.remainingQty)) } }));

  const selectAll = () => {
    // Select every pickable row of the SAME supplier (first row's supplier when
    // nothing is picked yet).
    const supplierId = lockedSupplierId ?? rows[0]?.supplierId ?? null;
    if (!supplierId) return;
    const next: Record<string, Pick> = {};
    for (const r of rows) if (r.supplierId === supplierId) next[r.poItemId] = { picked: true, qty: r.remainingQty };
    setPicks(next);
  };
  const clearAll = () => setPicks({});

  const pickedCount = Object.values(picks).filter((p) => p.picked).length;

  const addToGrn = () => {
    const stash: GrnFromPoPick[] = [];
    for (const r of allRows) {
      const p = picks[r.poItemId];
      if (p?.picked && p.qty > 0) stash.push({ ...r, _pickQty: p.qty });
    }
    if (stash.length === 0) {
      toast.error("Tick at least one PO line to receive.");
      return;
    }
    try {
      sessionStorage.setItem("grnFromPoPicks", JSON.stringify(stash));
    } catch {
      /* quota — fall through; the New GRN form simply starts blank */
    }
    navigate("/grns/new");
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/grns" className={styles.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>Receive from Purchase Order</h1>
          </div>
        </div>
        <div className={styles.actions}>
          <Button variant="ghost" onClick={selectAll} disabled={rows.length === 0}>
            <CheckSquare {...SM_ICON} />
            <span>Select all</span>
          </Button>
          <Button variant="ghost" onClick={clearAll} disabled={pickedCount === 0}>
            <Square {...SM_ICON} />
            <span>Clear</span>
          </Button>
          <Button variant="primary" onClick={addToGrn} disabled={pickedCount === 0}>
            <Save {...ICON} />
            <span>Add {pickedCount} line{pickedCount === 1 ? "" : "s"} to GRN</span>
          </Button>
        </div>
      </div>

      <div style={{ margin: "var(--space-3) 0" }}>
        <input
          className={styles.fieldInput}
          style={{ width: 320, maxWidth: "100%" }}
          value={search}
          placeholder="Search PO no / code / supplier…"
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <p className={styles.eyebrow}>
        {itemsQ.isLoading
          ? "Loading outstanding PO lines…"
          : `${rows.length} outstanding line${rows.length === 1 ? "" : "s"}${lockedSupplierId ? " · locked to one supplier" : ""}`}
      </p>

      {itemsQ.error && !itemsQ.isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load outstanding PO lines.</strong>{" "}
          {itemsQ.error instanceof Error ? itemsQ.error.message : String(itemsQ.error)}
        </div>
      )}

      <section className={styles.card}>
        {rows.length === 0 && !itemsQ.isLoading ? (
          <div className={styles.cardBody}>
            <p className={styles.emptyRow}>No outstanding PO lines to receive.</p>
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th style={{ width: 40 }} />
                <th>PO No.</th>
                <th>Supplier</th>
                <th>Item Code</th>
                <th>Description</th>
                <th className={styles.tableRight}>Remaining</th>
                <th className={styles.tableRight}>Unit Price</th>
                <th className={styles.tableRight}>Pick Qty</th>
                <th>Expected</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const p = picks[r.poItemId];
                const picked = Boolean(p?.picked);
                const pickable = isPickable(r);
                return (
                  <tr
                    key={r.poItemId}
                    onClick={() => togglePick(r)}
                    style={{
                      cursor: pickable ? "pointer" : "not-allowed",
                      opacity: pickable ? 1 : 0.4,
                      background: picked ? "rgba(232, 107, 58, 0.08)" : undefined,
                    }}
                  >
                    <td onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        className={styles.iconBtn}
                        disabled={!pickable}
                        onClick={() => togglePick(r)}
                        title={picked ? "Unpick" : "Pick"}
                      >
                        {picked ? <CheckSquare {...SM_ICON} /> : <Square {...SM_ICON} />}
                      </button>
                    </td>
                    <td>
                      <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--c-burnt)" }}>{r.poDocNo}</span>
                    </td>
                    <td>{r.supplierName || r.supplierCode || "—"}</td>
                    <td style={{ fontFamily: "var(--font-mono)" }}>{r.itemCode}</td>
                    <td>{r.description ?? "—"}</td>
                    <td className={styles.tableRight}>{r.remainingQty}</td>
                    <td className={styles.tableRight}>{fmtRm(r.unitPriceCenti)}</td>
                    <td className={styles.tableRight} onClick={(e) => e.stopPropagation()}>
                      <input
                        type="number"
                        min={0}
                        max={r.remainingQty}
                        className={styles.fieldInput}
                        style={{ width: 80, textAlign: "right" }}
                        value={picked ? p!.qty : r.remainingQty}
                        disabled={!picked}
                        onChange={(e) => setQty(r, Number(e.target.value) || 0)}
                      />
                    </td>
                    <td>{fmtDateOrDash(r.expectedAt)}</td>
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
