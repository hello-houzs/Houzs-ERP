// ----------------------------------------------------------------------------
// StockTakeNew — at /stock-takes/new (PR — Inv PR5).
//
// 1:1 clone of 2990s apps/backend/src/pages/StockTakeNew.tsx. Step 1: pick
// Warehouse + Scope + Date + Notes. On Submit the server snapshots system_qty
// for every in-scope SKU and creates an OPEN stock take; we navigate to the
// detail page where the commander enters counts.
//
// SEAM changes (same playbook as GrnNew):
//   - Data layer: 2990s lib/stock-takes-queries + inventory-queries -> co-located
//     ./stock-takes-queries + ./inventory-queries (Houzs api client +
//     react-query). Shapes identical (rule #7).
//   - Components: @2990s/design-system Button -> Houzs components/Button.
//     react-router -> react-router-dom. CSS -> ./StockDoc.module.css.
//   - STRATEGY-2 product layer (matches the backend snapshot seam):
//       * 2990s useMfgProducts (SKU master) drove the prefix-suggestion datalist
//         -> DROPPED (no catalogue); the prefix field is a plain text input.
//       * The live count-sheet PREVIEW reads inventory_balances (showAll=false) —
//         the SAME source the server snapshots from (Houzs has no v_inventory_all
//         _skus catalogue view), so ALL/CODE_PREFIX previews are honest.
//       * CATEGORY scope: kept in the dropdown for wire fidelity, but inventory_
//         balances has no category column, so it snapshots zero rows (the server
//         returns scope_empty). The preview shows 0 + the help note explains it.
//         TODO: wire CATEGORY + a catalogue-backed preview in the Products slice.
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Save, X, ClipboardList } from "lucide-react";
import { Button } from "../../components/Button";
import { useWarehouses, useInventoryBalances } from "./inventory-queries";
import { useCreateStockTake, type StockTakeScopeType } from "./stock-takes-queries";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import styles from "./StockDoc.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const todayISO = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const CATEGORIES: Array<{ value: string; label: string }> = [
  { value: "BEDFRAME", label: "Bedframe" },
  { value: "MATTRESS", label: "Mattress" },
  { value: "SOFA", label: "Sofa" },
  { value: "ACCESSORY", label: "Accessory" },
  { value: "SERVICE", label: "Service" },
];

export const StockTakeNew = () => {
  const navigate = useNavigate();
  const dialog = useDialog();
  const toast = useToast();
  const create = useCreateStockTake();

  const [warehouseId, setWarehouseId] = useState<string>("");
  const [takeDate, setTakeDate] = useState<string>(todayISO());
  const [scopeType, setScopeType] = useState<StockTakeScopeType>("ALL");
  const [scopeValue, setScopeValue] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  const warehouses = useWarehouses();

  // Live "expected count sheet size" — reads inventory_balances (showAll=false),
  // the SAME source the server snapshots from (Houzs has no catalogue view).
  // Empty when no warehouse picked.
  const balances = useInventoryBalances({ warehouseId: warehouseId || undefined });

  const previewCount = useMemo(() => {
    if (!warehouseId) return 0;
    const list = balances.data?.balances ?? [];
    if (scopeType === "CATEGORY") return 0; // no category axis in Houzs balances
    if (scopeType === "CODE_PREFIX") {
      const p = scopeValue.trim().toUpperCase();
      if (!p) return list.length;
      return list.filter((b) => b.product_code.toUpperCase().startsWith(p)).length;
    }
    return list.length;
  }, [balances.data, scopeType, scopeValue, warehouseId]);

  const needsScopeValue = scopeType === "CATEGORY" || scopeType === "CODE_PREFIX";
  const canCreate = Boolean(warehouseId && takeDate && (!needsScopeValue || scopeValue.trim()));

  const onCreate = async () => {
    if (!canCreate) {
      toast.error("Pick a warehouse, date, and (for Category/Prefix scopes) a scope value.");
      return;
    }
    if (previewCount === 0) {
      const proceed = await dialog.confirm(
        "No SKUs match this scope at the chosen warehouse. The count sheet will be empty. Continue?",
      );
      if (!proceed) return;
    }
    create.mutate(
      {
        warehouseId,
        takeDate,
        scopeType,
        scopeValue: needsScopeValue ? scopeValue.trim() : null,
        notes: notes.trim() || undefined,
      },
      {
        onSuccess: (res) => navigate(`/stock-takes/${res.id}`),
        onError: (err) => toast.error(`Create failed: ${err instanceof Error ? err.message : String(err)}`),
      },
    );
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/stock-takes" className={styles.backBtn}>
            <ArrowLeft {...ICON} /> <span>Stock Takes</span>
          </Link>
          <h1 className={styles.title}>New Stock Take</h1>
        </div>
        <div className={styles.actions}>
          <Button variant="ghost" onClick={() => navigate("/stock-takes")}>
            <X {...ICON} /> Cancel
          </Button>
          <Button variant="primary" onClick={onCreate} disabled={create.isPending}>
            <Save {...ICON} />
            {create.isPending ? "Snapshotting…" : "Create Count Sheet"}
          </Button>
        </div>
      </div>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Setup</h2>
        </div>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Warehouse *</span>
              <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className={styles.fieldSelect}>
                <option value="">— Pick warehouse —</option>
                {(warehouses.data ?? []).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code} · {w.name}
                  </option>
                ))}
              </select>
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Take Date *</span>
              <input type="date" value={takeDate} onChange={(e) => setTakeDate(e.target.value)} className={styles.fieldInput} />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Scope *</span>
              <select
                value={scopeType}
                onChange={(e) => {
                  setScopeType(e.target.value as StockTakeScopeType);
                  setScopeValue("");
                }}
                className={styles.fieldSelect}
              >
                <option value="ALL">All SKUs in warehouse</option>
                <option value="CATEGORY">By category</option>
                <option value="CODE_PREFIX">By code prefix</option>
              </select>
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>
                {scopeType === "CATEGORY" ? "Category *" : scopeType === "CODE_PREFIX" ? "Code prefix *" : "Scope value"}
              </span>
              {scopeType === "CATEGORY" ? (
                <select value={scopeValue} onChange={(e) => setScopeValue(e.target.value)} className={styles.fieldSelect}>
                  <option value="">— Pick category —</option>
                  {CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              ) : scopeType === "CODE_PREFIX" ? (
                <input
                  type="text"
                  value={scopeValue}
                  onChange={(e) => setScopeValue(e.target.value.toUpperCase())}
                  placeholder="e.g. BF, MAT, SOF…"
                  className={styles.fieldInput}
                  style={{ fontFamily: "var(--font-mono)" }}
                />
              ) : (
                <input type="text" value="(all SKUs)" disabled className={styles.fieldInput} />
              )}
            </label>
          </div>

          <div style={{ marginTop: "var(--space-3)" }}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Notes</span>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. Monthly cycle count · KL warehouse"
                className={styles.fieldInput}
              />
            </label>
          </div>

          <div
            style={{
              marginTop: "var(--space-4)",
              padding: "var(--space-3) var(--space-4)",
              background: "var(--c-cream)",
              border: "1px solid var(--line)",
              borderRadius: "var(--radius-md)",
              display: "flex",
              alignItems: "center",
              gap: "var(--space-3)",
            }}
          >
            <ClipboardList size={18} strokeWidth={1.75} style={{ color: "var(--fg-muted)" }} />
            <div style={{ fontSize: "var(--fs-13)", color: "var(--c-ink)" }}>
              {!warehouseId ? (
                <span style={{ color: "var(--fg-muted)" }}>Pick a warehouse to preview the count sheet size.</span>
              ) : balances.isLoading ? (
                <span style={{ color: "var(--fg-muted)" }}>Counting in-scope SKUs…</span>
              ) : (
                <>
                  Count sheet will contain{" "}
                  <strong style={{ fontFamily: "var(--font-mono)" }}>{previewCount.toLocaleString("en-MY")}</strong> SKU
                  {previewCount === 1 ? "" : "s"} with their current system qty snapshotted.
                </>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
