// ----------------------------------------------------------------------------
// MRP · Stock Status Report — 1:1 clone of 2990s apps/backend/src/pages/Mrp.tsx,
// trimmed to the GENERIC model per Strategy-2 (Houzs is not the 2990s furniture
// business — docs/scm-clone/PLAN.md).
//
// Trading-company finished-goods MRP. Per SKU: how many units the open Sales
// Orders need (Qty Needed) vs what we can supply (Stock + outstanding PO), with
// the leftover = Shortage. Each SO line is tagged with how it is covered:
//   • stock        -> allocated from on-hand
//   • PO-xxxx + ETA -> covered by an outstanding PO (expected arrival)
//   • SHORT (orange) -> uncovered -> this is what you order next
//
// Read-only, recomputed server-side on every load (NO persistence). Backed by
// GET /api/mrp (backend/src/routes/mrp.ts).
//
// STRATEGY-2 — DROPPED vs 2990s (the furniture engine):
//   - the four CATEGORY TABS (Sofa / Bedframe / Mattress / Accessories) — there's
//     no product taxonomy on Houzs lines, so the page is ONE flat list.
//   - the sofa SETS path (sofaSetsToSkus / groupBySo / sofaComposition / SofaSoTable)
//     + the bedframe-flat variant flatten (groupByVariant) — generic groupByModel
//     ((warehouse, item_code) -> variant sub-rows -> SO orders) only.
//   - the admin "Re-bind WH" backfill (no state_warehouse_mappings flow on Houzs).
// KEPT verbatim: demand/supply/shortage per SO line, warehouse + date-window +
// only-shortages filters, per-line supplier dropdown, selection, Proceed PO.
//
// SEAMS: 2990s authedFetch + Supabase -> Houzs api client + react-query
// (lib mrp-queries); in-app useDialog/useToast (rule #10), never window.* ; the
// CSS module is copied VERBATIM (rule #6).
// ----------------------------------------------------------------------------

import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight, ChevronDown, RefreshCw, Truck, ShoppingCart, CalendarRange } from "lucide-react";
import { useMrp, useCreatePosFromSoItems, type MrpSku, type MrpLine, type MrpResponse } from "./mrp-queries";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import styles from "./Mrp.module.css";

const ICON = { size: 14, strokeWidth: 1.75 } as const;

const fmtDate = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

/* A "Model" groups every variant that shares the same SKU code (item_code),
   scoped to ONE warehouse (per-WH MRP, no cross-WH pooling). Single-variant
   models collapse to 2 levels (model -> orders); multi-variant models expand
   into variant sub-rows (each -> its SO orders). */
type ModelGroup = {
  groupKey: string;          // `${warehouseId ?? 'NOWH'}|${itemCode}` — identity
  warehouseId: string | null;
  warehouseCode: string | null;
  warehouseName: string | null;
  itemCode: string;
  description: string | null;
  category: string | null;
  variants: MrpSku[];
  qtyNeeded: number;
  stock: number;
  poOutstanding: number;
  shortage: number;
  suppliers: MrpSku["suppliers"];
};

const WH_NONE = "NOWH";
const skuGroupKey = (s: MrpSku) => `${s.warehouseId ?? WH_NONE}|${s.itemCode}`;
const rowKey = (s: MrpSku) => `${s.warehouseId ?? WH_NONE}|${s.itemCode}${s.variantKey}`;

/* The SKU's default supplier id for a freshly-shown shortage line — its main
   supplier (suppliers is main-first), else the first bound supplier, else null
   (unbound SKU: no PO can be raised until a supplier is assigned). */
const skuDefaultSupplierId = (s: MrpSku): string | null =>
  (s.suppliers.find((x) => x.isMain) ?? s.suppliers[0])?.supplierId ?? null;

/* Only SHORTAGE lines are selectable / orderable. */
const shortageLinesOf = (s: MrpSku) => s.lines.filter((l) => l.source === "shortage" && l.shortageQty > 0 && l.soItemId);
/* All shortage line ids beneath a variant (sku). */
const shortageLineIdsOf = (s: MrpSku): string[] => shortageLinesOf(s).map((l) => l.soItemId);

function groupByModel(skus: MrpSku[]): ModelGroup[] {
  const map = new Map<string, ModelGroup>();
  for (const s of skus) {
    const gk = skuGroupKey(s);
    let g = map.get(gk);
    if (!g) {
      g = {
        groupKey: gk,
        warehouseId: s.warehouseId, warehouseCode: s.warehouseCode, warehouseName: s.warehouseName,
        itemCode: s.itemCode, description: s.description, category: s.category,
        variants: [], qtyNeeded: 0, stock: 0, poOutstanding: 0, shortage: 0,
        suppliers: s.suppliers,
      };
      map.set(gk, g);
    }
    g.variants.push(s);
    g.qtyNeeded += s.qtyNeeded;
    g.stock += s.stock;
    g.poOutstanding += s.poOutstanding;
    g.shortage += s.shortage;
  }
  const groups = [...map.values()];
  for (const g of groups) {
    g.variants.sort((a, b) => ((a.variantLabel ?? "") < (b.variantLabel ?? "") ? -1 : 1));
  }
  // Shortage models float to the top (the orange ones to act on), then by
  // warehouse, then by code — so each warehouse's rows cluster together.
  groups.sort((a, b) => {
    if ((b.shortage > 0 ? 1 : 0) !== (a.shortage > 0 ? 1 : 0)) {
      return (b.shortage > 0 ? 1 : 0) - (a.shortage > 0 ? 1 : 0);
    }
    const wa = a.warehouseCode ?? a.warehouseName ?? "";
    const wb = b.warehouseCode ?? b.warehouseName ?? "";
    if (wa !== wb) return wa < wb ? -1 : 1;
    return a.itemCode < b.itemCode ? -1 : 1;
  });
  return groups;
}

export const Mrp = () => {
  const navigate = useNavigate();
  const dialog = useDialog();
  const toast = useToast();
  const [warehouseId, setWarehouseId] = useState<string>("all");
  /* Two expand levels: models (itemCode) and variants (rowKey). */
  const [expandedModels, setExpandedModels] = useState<Set<string>>(new Set());
  const [expandedVariants, setExpandedVariants] = useState<Set<string>>(new Set());
  /* Selection lives at the SO ORDER-LINE level: each individual shortage line
     (soItemId) has its own checkbox. The Model/Variant checkboxes are parent
     "select all shortage lines beneath me" toggles. */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [poMode, setPoMode] = useState<"combined" | "per-so">("combined");
  /* Turnover control: order by delivery-date window with a switchable basis. */
  const [dateBasis, setDateBasis] = useState<"delivery" | "processing" | "soDate" | "orderBy">("delivery");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [showUndated, setShowUndated] = useState<boolean>(false);
  /* Focus view: show ONLY the rows that still need ordering (shortage > 0). */
  const [onlyShort, setOnlyShort] = useState<boolean>(false);
  /* Supplier is chosen PER SHORTAGE SO LINE (different lines of the same SKU may
     pick different suppliers). { soItemId: supplierId }; defaults to the SKU's
     main supplier when no entry. */
  const [lineSupplier, setLineSupplier] = useState<Record<string, string>>({});
  const setLineSupplierId = (soItemId: string, supplierId: string) =>
    setLineSupplier((prev) => ({ ...prev, [soItemId]: supplierId }));
  /* Proceed-PO confirm step (in-page, verbatim 2990s) so the operator can
     OPTIONALLY pick one Expected Delivery date for the whole batch; blank = keep
     each SO's own dates. null = closed. */
  const [confirmState, setConfirmState] = useState<
    | { picks: Array<{ soItemId: string; qty: number; supplierId: string | null }>; count: number; units: number }
    | null
  >(null);
  const [proceedExpectedAt, setProceedExpectedAt] = useState<string>("");

  const q = useMrp({ warehouseId, includeUndated: showUndated });
  const data = q.data;
  const createPos = useCreatePosFromSoItems();

  const tabSkus = data?.skus ?? [];

  /* Delivery-date window: filter child lines + recompute the parent's Qty
     Needed / Shortage to the window. Stock/PO Outstanding stay SKU-level. */
  const hasWindow = Boolean(dateFrom || dateTo);
  const lineDate = (l: MrpLine): string | null =>
    dateBasis === "processing" ? l.processingDate
    : dateBasis === "soDate" ? l.soDate
    : dateBasis === "orderBy" ? l.orderByDate
    : l.deliveryDate;
  const lineInWindow = (l: MrpLine): boolean => {
    const d = lineDate(l);
    if (!d) return false;
    const x = d.slice(0, 10);
    if (dateFrom && x < dateFrom) return false;
    if (dateTo && x > dateTo) return false;
    return true;
  };
  const viewSkus: MrpSku[] = tabSkus
    .map((s) => {
      if (!hasWindow) return s;
      const lines = s.lines.filter(lineInWindow);
      const qtyNeeded = lines.reduce((a, l) => a + l.qty, 0);
      const shortage = lines.reduce((a, l) => a + (l.source === "shortage" ? l.shortageQty : 0), 0);
      return { ...s, lines, qtyNeeded, shortage };
    })
    .filter((s) => !hasWindow || s.lines.length > 0);

  const models = groupByModel(viewSkus);

  /* Only-shortages focus filter — affects which ROWS render. */
  const displayModels = onlyShort ? models.filter((m) => m.shortage > 0) : models;

  const toggleModel = (code: string) =>
    setExpandedModels((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  const toggleVariant = (key: string) =>
    setExpandedVariants((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  const expandAll = () => {
    setExpandedModels(new Set(models.map((m) => m.groupKey)));
    setExpandedVariants(new Set(viewSkus.map(rowKey)));
  };
  const collapseAll = () => { setExpandedModels(new Set()); setExpandedVariants(new Set()); };

  /* Fire the (mode-aware) convert-from-SO endpoint for the given picks.
     `expectedAt` — when set, the server applies it as the PO header expected_at
     AND every PO line's delivery date for the whole batch; when blank we send
     nothing so it keeps using each SO's own dates. */
  const runCreatePos = (
    picks: Array<{ soItemId: string; qty: number; supplierId: string | null }>,
    expectedAt?: string,
  ) => {
    if (picks.length === 0) {
      toast.warning("No uncovered (shortage) lines in the current selection / window.");
      return;
    }
    const body = { picks, mode: poMode, fromMrp: true, ...(expectedAt ? { expectedAt } : {}) };
    createPos.mutate(body, {
      onSuccess: async (res) => {
        if (!res.total) {
          toast.warning(
            "No POs created — these SKUs aren't bound to a supplier yet, or the convert-from-SO path is unavailable. Assign each shortage SKU a main supplier, then proceed again.",
          );
          return;
        }
        setSelected(new Set());
        void q.refetch();
        const open = await dialog.confirm({
          title: `Successfully created ${res.total} PO${res.total === 1 ? "" : "s"}`,
          message: (res.created ?? []).map((p) => p.poNumber).join(", ") || "Purchase orders created.",
          confirmLabel: "Open Purchase Orders",
          cancelLabel: "Stay here",
          tone: "info",
        });
        if (open) navigate("/purchase-orders");
      },
      onError: (err) => {
        const raw = err instanceof Error ? err.message : String(err);
        let errCode = "";
        let serverMsg = "";
        const codes: string[] = [];
        try {
          const m = raw.match(/\{.*\}/);
          if (m) {
            const j = JSON.parse(m[0]) as { error?: string; message?: string; itemCodes?: string[] };
            errCode = typeof j.error === "string" ? j.error : "";
            serverMsg = typeof j.message === "string" ? j.message : "";
            if (j.error === "missing_bindings" && Array.isArray(j.itemCodes)) codes.push(...j.itemCodes);
          }
        } catch { /* generic */ }
        // A stale view can still try to order a line already PO'd elsewhere.
        if (errCode === "qty_exceeds_remaining") {
          void q.refetch();
          toast.warning("Some of these lines were already put on a PO. The list has been refreshed — review what still needs ordering and proceed again.");
          return;
        }
        if (codes.length > 0) {
          toast.error("Assign these SKUs to a supplier first, then proceed: " + codes.join(", "));
          return;
        }
        toast.error(serverMsg || `Order failed: ${raw}`);
      },
    });
  };

  /* General — picks (+ unit count) from SHORTAGE order-lines. When a line-level
     selection exists, only the selected soItemIds are gathered; otherwise every
     visible shortage line. Each pick carries its per-line chosen supplier. */
  const gatherShortages = (skus: MrpResponse["skus"], onlySelected: boolean) => {
    const picks: Array<{ soItemId: string; qty: number; supplierId: string | null }> = [];
    let units = 0;
    for (const s of skus) {
      const def = skuDefaultSupplierId(s);
      for (const l of shortageLinesOf(s)) {
        if (onlySelected && !selected.has(l.soItemId)) continue;
        picks.push({ soItemId: l.soItemId, qty: l.shortageQty, supplierId: lineSupplier[l.soItemId] ?? def });
        units += l.shortageQty;
      }
    }
    return { picks, units };
  };

  const shortageSkus = viewSkus.filter((s) => s.shortage > 0);
  const allShortageLineIds = shortageSkus.flatMap((s) => shortageLineIdsOf(s));

  /* Toggle one SO order-line. */
  const toggleSelectLine = (soItemId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(soItemId)) next.delete(soItemId); else next.add(soItemId);
      return next;
    });
  };
  /* Parent toggle: select / deselect every shortage line beneath the given ids. */
  const setLinesSelected = (ids: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of ids) { if (on) next.add(k); else next.delete(k); }
      return next;
    });
  };

  const shortCount = allShortageLineIds.length;
  const selectedShortCount = allShortageLineIds.filter((id) => selected.has(id)).length;
  const allShortSelected = shortCount > 0 && selectedShortCount === shortCount;
  const someShortSelected = selectedShortCount > 0 && !allShortSelected;
  const toggleSelectAll = () => {
    if (allShortSelected) { setSelected(new Set()); return; }
    setSelected(new Set(allShortageLineIds));
  };

  /* Proceed PO — gather the selected shortage lines (or all visible shortage
     lines if none selected) and open the confirm dialog. */
  const onProceed = () => {
    const onlySelected = selectedShortCount > 0;
    const { picks, units } = gatherShortages(shortageSkus, onlySelected);
    if (picks.length === 0) {
      toast.warning("No uncovered (shortage) lines in the current selection / window.");
      return;
    }
    setProceedExpectedAt("");
    setConfirmState({ picks, count: picks.length, units });
  };

  const basisLabel = dateBasis === "processing" ? "Processing Date" : dateBasis === "soDate" ? "SO Date" : dateBasis === "orderBy" ? "Order-by" : "Delivery";
  const windowLabel = hasWindow ? `${basisLabel} ${dateFrom || "…"} → ${dateTo || "…"}` : "";

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.title}>MRP · Stock Status Report</h1>
        </div>
        <div className={styles.actions}>
          {/* Group 1 — PO generation mode toggle. */}
          <div className={styles.modeToggle} role="group" aria-label="PO generation mode">
            <button type="button" className={styles.modeBtn} data-active={poMode === "combined"}
              onClick={() => setPoMode("combined")} title="One PO per supplier">Combined</button>
            <button type="button" className={styles.modeBtn} data-active={poMode === "per-so"}
              onClick={() => setPoMode("per-so")} title="One PO per SO">Per SO</button>
          </div>

          <span className={styles.toolbarDivider} aria-hidden="true" />

          {/* Group 2 — utilities. */}
          <div className={styles.utilityGroup} role="group" aria-label="Table utilities">
            <button type="button" className={styles.ghostBtn} onClick={collapseAll}>Collapse</button>
            <button type="button" className={styles.ghostBtn} onClick={expandAll}>Expand</button>
            <button type="button" className={styles.ghostBtn} onClick={() => void q.refetch()} disabled={q.isFetching}>
              <RefreshCw {...ICON} className={q.isFetching ? styles.spin : undefined} /> Refresh
            </button>
          </div>

          <span className={styles.toolbarDivider} aria-hidden="true" />

          {/* Group 3 — PRIMARY CTA. */}
          <button
            type="button"
            className={styles.primaryBtn}
            disabled={createPos.isPending || shortCount === 0}
            onClick={onProceed}
            title={
              selectedShortCount > 0 ? "Order the selected SKUs"
              : hasWindow ? `Order everything in ${windowLabel} as one batch`
              : "Order all shortage SKUs"
            }
          >
            <ShoppingCart {...ICON} />
            {createPos.isPending
              ? "Processing…"
              : selectedShortCount > 0
                ? `Proceed PO (${selectedShortCount})`
                : hasWindow
                  ? `Proceed PO · window (${shortCount})`
                  : `Proceed PO (${shortCount})`}
          </button>
        </div>
      </div>

      {/* Active date-window chip (reflects the live filter). */}
      {data && hasWindow && (
        <div className={styles.summaryRow}>
          <span className={styles.summaryChip}><CalendarRange {...ICON} /> Window {windowLabel}</span>
        </div>
      )}

      {/* Filters — switchable date basis drives the window; Warehouse on the right. */}
      <div className={styles.filterRow}>
        <label className={styles.filterField}>
          <span className={styles.filterLabel}>Date</span>
          <select className={styles.filterSelect} value={dateBasis}
            onChange={(e) => setDateBasis(e.target.value as typeof dateBasis)}
            title="Which date the From–To window filters on">
            <option value="delivery">Delivery date</option>
            <option value="orderBy">Order-by date</option>
            <option value="processing">Processing date</option>
            <option value="soDate">SO date</option>
          </select>
        </label>
        <label className={styles.filterField}>
          <span className={styles.filterLabel}>from</span>
          <input type="date" className={styles.filterSelect} value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)} />
        </label>
        <label className={styles.filterField}>
          <span className={styles.filterLabel}>to</span>
          <input type="date" className={styles.filterSelect} value={dateTo}
            onChange={(e) => setDateTo(e.target.value)} />
        </label>
        {hasWindow && (
          <button type="button" className={styles.ghostBtn}
            onClick={() => { setDateFrom(""); setDateTo(""); }}>Clear window</button>
        )}
        <label className={styles.filterField} title="Show SO lines that have no delivery date (not ready to order)">
          <input type="checkbox" checked={showUndated} onChange={(e) => setShowUndated(e.target.checked)} />
          <span className={styles.filterLabel}>Show no-date</span>
        </label>
        <label className={styles.filterField} title="Hide fully-covered rows — show only what still needs ordering">
          <input type="checkbox" checked={onlyShort} onChange={(e) => setOnlyShort(e.target.checked)} />
          <span className={styles.filterLabel}>Only shortages</span>
        </label>
        <label className={styles.filterField}>
          <span className={styles.filterLabel}>Warehouse</span>
          <select className={styles.filterSelect} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="all">All warehouses</option>
            {(data?.warehouses ?? []).map((w) => (
              <option key={w.id} value={w.id}>{w.code} · {w.name}</option>
            ))}
          </select>
        </label>
      </div>

      {/* Table — Model -> Variant -> SO orders. */}
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.colSelect}>
                <input
                  type="checkbox"
                  aria-label="Select all shortage rows"
                  title="Select all shortage rows"
                  disabled={shortCount === 0}
                  checked={allShortSelected}
                  ref={(el) => { if (el) el.indeterminate = someShortSelected; }}
                  onChange={toggleSelectAll}
                />
              </th>
              <th className={styles.colCaret} />
              <th>Warehouse</th>
              <th>Item Code</th>
              <th>Description</th>
              <th className={styles.num}>Qty Needed</th>
              <th className={styles.num}>Stock</th>
              <th className={styles.num}>PO Outstanding</th>
              <th className={styles.num}>Shortage</th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading && (
              <tr><td colSpan={9} className={styles.stateCell}>Loading MRP…</td></tr>
            )}
            {q.isError && (
              <tr><td colSpan={9} className={styles.stateCell}>Failed to load: {(q.error as Error)?.message}</td></tr>
            )}
            {data && displayModels.length === 0 && (
              <tr><td colSpan={9} className={styles.stateCell}>
                {onlyShort ? "Nothing needs ordering — everything in view is covered."
                  : hasWindow ? "No demand delivering in this window."
                  : "No open Sales-Order demand for this filter."}
              </td></tr>
            )}
            {displayModels.map((g) => (
              <ModelRows
                key={g.groupKey}
                group={g}
                modelOpen={expandedModels.has(g.groupKey)}
                onToggleModel={() => toggleModel(g.groupKey)}
                expandedVariants={expandedVariants}
                onToggleVariant={toggleVariant}
                selected={selected}
                onToggleLine={toggleSelectLine}
                onSetLinesSelected={setLinesSelected}
                lineSupplier={lineSupplier}
                onLineSupplierChange={setLineSupplierId}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Proceed-PO confirm — optional Expected Delivery date for the whole batch
          (verbatim 2990s, in-page, never a browser confirm). */}
      {confirmState && (
        <div className={styles.dialogBackdrop} onClick={() => setConfirmState(null)}>
          <div className={styles.dialog} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h2 className={styles.dialogTitle}>Proceed PO</h2>
            <p className={styles.dialogBody}>
              Generate purchase orders for {confirmState.count} {confirmState.count === 1 ? "line" : "lines"}
              {" "}({confirmState.units} {confirmState.units === 1 ? "unit" : "units"}) in{" "}
              {poMode === "combined" ? "Combined (one PO per supplier)" : "Per SO (one PO per SO)"} mode.
            </p>
            <label className={styles.dialogField}>
              <span className={styles.filterLabel}>Expected Delivery (optional — leave blank to use each SO's own date)</span>
              <input
                type="date"
                className={styles.filterSelect}
                value={proceedExpectedAt}
                onChange={(e) => setProceedExpectedAt(e.target.value)}
                title="Apply one delivery date to the whole batch (PO header + every line). Leave blank to keep each SO's own date."
              />
            </label>
            <div className={styles.dialogActions}>
              <button type="button" className={styles.ghostBtn} onClick={() => setConfirmState(null)}>Cancel</button>
              <button
                type="button"
                className={styles.primaryBtn}
                disabled={createPos.isPending}
                onClick={() => {
                  const { picks } = confirmState;
                  setConfirmState(null);
                  runCreatePos(picks, proceedExpectedAt || undefined);
                }}
              >
                {createPos.isPending ? "Processing…" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/* Per-shortage-line supplier dropdown. Each shortage SO line picks its own
   supplier, defaulting to the SKU's main supplier; different lines of the same
   SKU MAY differ. Unbound SKU -> "— none —" (can't be ordered until a supplier
   is assigned). */
const LineSupplierCell = ({ suppliers, chosenSupplierId, onSupplierChange }: {
  suppliers: MrpSku["suppliers"]; chosenSupplierId: string | null;
  onSupplierChange: (supplierId: string) => void;
}) => {
  if (suppliers.length === 0) return <span className={styles.noSupplier}>— none —</span>;
  const defaultSupplierId = suppliers.find((s) => s.isMain)?.supplierId ?? suppliers[0]!.supplierId;
  return (
    <select
      className={styles.supplierSelect}
      value={chosenSupplierId ?? defaultSupplierId}
      onChange={(e) => onSupplierChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      title="Supplier for this SO line — defaults to the SKU's main supplier"
    >
      {suppliers.map((s) => (
        <option key={s.supplierId} value={s.supplierId}>
          {s.name}{s.isMain ? " ★" : ""} · {s.code}
        </option>
      ))}
    </select>
  );
};

/* One Model and its variants. Multi-variant models expand into variant sub-rows
   (each expandable to its SO orders). Single-variant models expand straight to
   their SO orders. Selection + supplier live on each SO ORDER LINE; the Model /
   Variant checkboxes are parent toggles. */
const ModelRows = ({
  group, modelOpen, onToggleModel, expandedVariants, onToggleVariant,
  selected, onToggleLine, onSetLinesSelected, lineSupplier, onLineSupplierChange,
}: {
  group: ModelGroup;
  modelOpen: boolean;
  onToggleModel: () => void;
  expandedVariants: Set<string>;
  onToggleVariant: (key: string) => void;
  selected: Set<string>;
  onToggleLine: (soItemId: string) => void;
  onSetLinesSelected: (ids: string[], on: boolean) => void;
  lineSupplier: Record<string, string>;
  onLineSupplierChange: (soItemId: string, supplierId: string) => void;
}) => {
  const short = group.shortage > 0;
  // Parent (Model) checkbox state — over every shortage line beneath the model.
  const modelLineIds = group.variants.flatMap(shortageLineIdsOf);
  const modelSel = modelLineIds.filter((id) => selected.has(id));
  const allSel = modelLineIds.length > 0 && modelSel.length === modelLineIds.length;
  const someSel = modelSel.length > 0 && !allSel;
  // Single-variant models collapse to 2 levels (model -> orders). A "N variants"
  // pill appears whenever the model has named variants.
  const variantCount = group.variants.length;
  const hasNamedVariant = group.variants.some((v) => v.variantKey !== "");
  const single = variantCount === 1;
  const onlyVariant = group.variants[0]!;

  return (
    <>
      <tr className={`${styles.skuRow} ${short ? styles.skuRowShort : ""}`} onClick={onToggleModel}>
        <td className={styles.colSelect} onClick={(e) => e.stopPropagation()}>
          {modelLineIds.length > 0 && (
            <input
              type="checkbox"
              checked={allSel}
              ref={(el) => { if (el) el.indeterminate = someSel; }}
              onChange={(e) => onSetLinesSelected(modelLineIds, e.target.checked)}
              aria-label={`Select all shortage lines under ${group.itemCode}`}
            />
          )}
        </td>
        <td className={styles.colCaret}>
          {modelOpen ? <ChevronDown {...ICON} /> : <ChevronRight {...ICON} />}
        </td>
        <td className={styles.whCell}>
          {group.warehouseCode
            ? <span className={styles.whTag} title={group.warehouseName ?? undefined}>{group.warehouseCode}</span>
            : <span className={styles.whNone}>—</span>}
        </td>
        <td className={styles.codeCell}>{group.itemCode}</td>
        <td className={styles.descCell}>
          {group.description ?? "—"}
          {hasNamedVariant
            ? <span className={styles.countTag}>{variantCount} variant{variantCount === 1 ? "" : "s"}</span>
            : null}
        </td>
        <td className={styles.num}>{group.qtyNeeded}</td>
        <td className={styles.num}>{group.stock}</td>
        <td className={styles.num}>{group.poOutstanding || "—"}</td>
        <td className={`${styles.num} ${short ? styles.shortNum : ""}`}>{short ? group.shortage : "—"}</td>
      </tr>

      {/* Single-variant model → orders directly (2-level). Show the variant spec
          as a label above the orders when there is one. */}
      {modelOpen && single && (
        <tr className={styles.detailRow}>
          <td /><td />
          <td colSpan={7}>
            {onlyVariant.variantLabel && (
              <div className={styles.singleSpec}>
                <span className={styles.variantBranch}>↳</span>
                <span className={styles.variantTag}>{onlyVariant.variantLabel}</span>
              </div>
            )}
            <OrderLines sku={onlyVariant} selected={selected} onToggleLine={onToggleLine}
              lineSupplier={lineSupplier} onLineSupplierChange={onLineSupplierChange} />
          </td>
        </tr>
      )}

      {/* Multi-variant model → variant sub-rows (each expandable to orders). */}
      {modelOpen && !single && group.variants.map((v) => {
        const k = rowKey(v);
        const vShort = v.shortage > 0;
        const vOpen = expandedVariants.has(k);
        const vLineIds = shortageLineIdsOf(v);
        const vSel = vLineIds.filter((id) => selected.has(id));
        const vAllSel = vLineIds.length > 0 && vSel.length === vLineIds.length;
        const vSomeSel = vSel.length > 0 && !vAllSel;
        return (
          <FragmentRow key={k}>
            <tr className={`${styles.variantRow} ${vShort ? styles.variantRowShort : ""}`} onClick={() => onToggleVariant(k)}>
              <td className={styles.colSelect} onClick={(e) => e.stopPropagation()}>
                {vLineIds.length > 0 && (
                  <input
                    type="checkbox"
                    checked={vAllSel}
                    ref={(el) => { if (el) el.indeterminate = vSomeSel; }}
                    onChange={(e) => onSetLinesSelected(vLineIds, e.target.checked)}
                    aria-label={`Select all shortage lines under ${v.variantLabel ?? v.itemCode}`}
                  />
                )}
              </td>
              <td className={styles.colCaret}>
                {vOpen ? <ChevronDown {...ICON} /> : <ChevronRight {...ICON} />}
              </td>
              <td />{/* warehouse — inherited from parent model row */}
              <td />
              <td className={styles.variantDescCell}>
                <span className={styles.variantBranch}>↳</span>
                <span className={styles.variantTag}>{v.variantLabel ?? "(no variant)"}</span>
              </td>
              <td className={styles.num}>{v.qtyNeeded}</td>
              <td className={styles.num}>{v.stock}</td>
              <td className={styles.num}>{v.poOutstanding || "—"}</td>
              <td className={`${styles.num} ${vShort ? styles.shortNum : ""}`}>{vShort ? v.shortage : "—"}</td>
            </tr>
            {vOpen && (
              <tr className={styles.detailRow}>
                <td /><td />
                <td colSpan={7}>
                  <OrderLines sku={v} selected={selected} onToggleLine={onToggleLine}
                    lineSupplier={lineSupplier} onLineSupplierChange={onLineSupplierChange} />
                </td>
              </tr>
            )}
          </FragmentRow>
        );
      })}
    </>
  );
};

/* Tiny helper so multi-element returns inside .map keep a single key. */
const FragmentRow = ({ children }: { children: ReactNode }) => <>{children}</>;

/* The SO-order child table. Each shortage line has its own select checkbox +
   supplier dropdown; covered lines show the covering PO's supplier read-only. */
const OrderLines = ({ sku, selected, onToggleLine, lineSupplier, onLineSupplierChange }: {
  sku: MrpSku;
  selected: Set<string>;
  onToggleLine: (soItemId: string) => void;
  lineSupplier: Record<string, string>;
  onLineSupplierChange: (soItemId: string, supplierId: string) => void;
}) => (
  <table className={styles.childTable}>
    <thead>
      <tr>
        <th className={styles.colSelect} />
        <th>SO No</th>
        <th>Warehouse</th>
        <th>Customer</th>
        <th>Processing Date</th>
        <th>Delivery Date</th>
        <th className={styles.num}>Qty</th>
        <th>Coverage</th>
        <th>Supplier</th>
      </tr>
    </thead>
    <tbody>
      {sku.lines.map((ln, i) => (
        <ChildLine
          key={`${ln.soDocNo}-${i}`}
          ln={ln}
          suppliers={sku.suppliers}
          whCode={sku.warehouseCode}
          whName={sku.warehouseName}
          selected={selected.has(ln.soItemId)}
          onToggleLine={() => onToggleLine(ln.soItemId)}
          chosenSupplierId={lineSupplier[ln.soItemId] ?? null}
          onSupplierChange={(sid) => onLineSupplierChange(ln.soItemId, sid)}
        />
      ))}
    </tbody>
  </table>
);

const ChildLine = ({ ln, suppliers, whCode, whName, selected, onToggleLine, chosenSupplierId, onSupplierChange }: {
  ln: MrpLine;
  suppliers: MrpSku["suppliers"];
  whCode: string | null;
  whName: string | null;
  selected: boolean;
  onToggleLine: () => void;
  chosenSupplierId: string | null;
  onSupplierChange: (supplierId: string) => void;
}) => {
  const short = ln.source === "shortage" && ln.shortageQty > 0 && Boolean(ln.soItemId);
  return (
    <tr className={short ? styles.childShort : undefined}>
      <td className={styles.colSelect}>
        {short && (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleLine}
            aria-label={`Select ${ln.soDocNo} to order`}
          />
        )}
      </td>
      <td className={styles.codeCell}>{ln.soDocNo}</td>
      <td className={styles.whCell}>
        {whCode
          ? <span className={styles.whTag} title={whName ?? undefined}>{whCode}</span>
          : <span className={styles.whNone}>—</span>}
      </td>
      <td>{ln.debtorName ?? "—"}</td>
      <td>{fmtDate(ln.processingDate)}</td>
      <td>{fmtDate(ln.deliveryDate)}</td>
      <td className={styles.num}>{ln.qty}</td>
      <td>
        {ln.source === "stock" && <span className={`${styles.tag} ${styles.tagStock}`}>stock</span>}
        {ln.source === "po" && (
          <span className={`${styles.tag} ${styles.tagPo}`}>
            {ln.poNumber
              ? `${ln.poNumber}${ln.poEta ? ` · ETA ${fmtDate(ln.poEta)}` : ""}`
              : "ordered"}
          </span>
        )}
        {short && (
          <span className={`${styles.tag} ${styles.tagShort}`}>
            SHORT{ln.shortageQty > 1 ? ` ×${ln.shortageQty}` : ""}
          </span>
        )}
      </td>
      <td className={styles.supplierCell}>
        {short
          ? <LineSupplierCell suppliers={suppliers} chosenSupplierId={chosenSupplierId} onSupplierChange={onSupplierChange} />
          : ln.source === "po"
            ? <span className={styles.poSupplierRO} title="Supplier locked — this line is already on a PO">
                <Truck {...ICON} /> {ln.poSupplierName ?? "—"}
              </span>
            : <span className={styles.whNone}>—</span>}
      </td>
    </tr>
  );
};
