// ----------------------------------------------------------------------------
// Fabric Converter — fabric cost ledger + per-context price tiers (clone of
// 2990s's FabricTracking page). Reads /api/fabric-tracking.
//
// FULL catalogue clone. Houzs-native rebuild on the established seam: api client
// + react-query + useDialog/useToast (rule #10), never window.*; CSS Modules
// verbatim (rule #6). Columns: Fabric Code · Description (editable) · Supplier
// Code (editable) · Series (editable) · Sofa Tier · Bedframe Tier · Active ·
// delete. Tiers cycle PRICE_1 -> 2 -> 3 on click. Create + per-row delete (PR
// #43). CSV export/import is a documented follow-up (the bulk-upsert route IS
// cloned at /api/fabric-tracking/bulk-upsert).
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Search, Plus, X, Trash2 } from "lucide-react";
import {
  useFabricTrackings,
  useCreateFabric,
  usePatchFabricField,
  useDeleteFabric,
  type FabricRow,
  type FabricTier,
} from "./products-queries";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import styles from "./FabricTracking.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const TIER_CYCLE: Record<string, FabricTier> = { PRICE_1: "PRICE_2", PRICE_2: "PRICE_3", PRICE_3: "PRICE_1" };
const tierLabel = (t: FabricTier | null): string => (t ? t.replace("PRICE_", "P") : "—");

export const FabricTracking = () => {
  const [search, setSearch] = useState("");
  const { data: fabrics, isLoading, error } = useFabricTrackings({ search: search.trim() || undefined });
  const rows = useMemo(() => fabrics ?? [], [fabrics]);

  const patchField = usePatchFabricField();
  const del = useDeleteFabric();
  const dialog = useDialog();
  const toast = useToast();
  const [createOpen, setCreateOpen] = useState(false);

  const cycleTier = (row: FabricRow, field: "sofaPriceTier" | "bedframePriceTier", current: FabricTier | null) => {
    const next = current ? TIER_CYCLE[current] : "PRICE_1";
    patchField.mutate(
      { id: row.id, field: "tier", body: { field, tier: next } },
      { onError: (e) => toast.error(`Update failed: ${e instanceof Error ? e.message : String(e)}`) },
    );
  };

  const commitText = (row: FabricRow, field: "supplier-code" | "description" | "series", key: string, value: string, current: string | null) => {
    const trimmed = value.trim();
    if (trimmed === (current ?? "")) return;
    patchField.mutate(
      { id: row.id, field, body: { [key]: trimmed } },
      { onError: (e) => toast.error(`Update failed: ${e instanceof Error ? e.message : String(e)}`) },
    );
  };

  const toggleActive = (row: FabricRow) => {
    patchField.mutate(
      { id: row.id, field: "active", body: { isActive: !row.is_active } },
      { onError: (e) => toast.error(`Update failed: ${e instanceof Error ? e.message : String(e)}`) },
    );
  };

  const onDelete = async (row: FabricRow) => {
    if (!(await dialog.confirm(`Delete fabric "${row.fabric_code}"?`))) return;
    del.mutate(
      { id: row.id },
      {
        onSuccess: () => toast.success(`Deleted ${row.fabric_code}.`),
        onError: (e) => toast.error(e instanceof Error ? e.message : "Delete failed."),
      },
    );
  };

  return (
    <div className={styles.page}>
      <div className={styles.titleBlock}>
        <h1 className={styles.title}>Fabric Converter</h1>
        <p className={styles.subtitle}>Fabric cost ledger + per-context selling tiers (sofa / bedframe).</p>
      </div>

      <div className={styles.filterRow}>
        <div className={styles.searchBox}>
          <Search {...ICON} className={styles.searchIcon} />
          <input
            className={styles.searchInput}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search code / description"
          />
        </div>
        <button className={styles.iconBtn} onClick={() => setCreateOpen(true)}>
          <Plus {...ICON} /> New Fabric
        </button>
      </div>

      {isLoading && <p>Loading fabrics…</p>}
      {error && <p className={styles.bannerWarn}>Failed to load: {error instanceof Error ? error.message : String(error)}</p>}

      {!isLoading && !error && (
        <div className={styles.tableCard}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Code</th>
                <th>Description</th>
                <th>Supplier Code</th>
                <th>Series</th>
                <th>Sofa</th>
                <th>Bedframe</th>
                <th>Active</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className={styles.emptyRow}>
                    No fabrics.
                  </td>
                </tr>
              )}
              {rows.map((f) => (
                <tr key={f.id}>
                  <td>
                    <span className={styles.codeChip}>{f.fabric_code}</span>
                  </td>
                  <td>
                    <input
                      className={styles.supplierCodeInput}
                      defaultValue={f.fabric_description ?? ""}
                      onBlur={(e) => commitText(f, "description", "description", e.target.value, f.fabric_description)}
                    />
                  </td>
                  <td>
                    <input
                      className={styles.supplierCodeInput}
                      defaultValue={f.supplier_code ?? ""}
                      onBlur={(e) => commitText(f, "supplier-code", "supplierCode", e.target.value, f.supplier_code)}
                    />
                  </td>
                  <td>
                    <input
                      className={styles.supplierCodeInput}
                      defaultValue={f.series ?? ""}
                      onBlur={(e) => commitText(f, "series", "series", e.target.value, f.series)}
                    />
                  </td>
                  <td>
                    <button className={styles.tierPicker} onClick={() => cycleTier(f, "sofaPriceTier", f.sofa_price_tier)}>
                      {tierLabel(f.sofa_price_tier)}
                    </button>
                  </td>
                  <td>
                    <button className={styles.tierPicker} onClick={() => cycleTier(f, "bedframePriceTier", f.bedframe_price_tier)}>
                      {tierLabel(f.bedframe_price_tier)}
                    </button>
                  </td>
                  <td>
                    <button className={styles.catChip} onClick={() => toggleActive(f)}>
                      {f.is_active ? "Yes" : "No"}
                    </button>
                  </td>
                  <td>
                    <button className={styles.iconBtn} onClick={() => onDelete(f)} title="Delete">
                      <Trash2 {...ICON} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className={styles.recordCount}>{rows.length} fabric(s)</div>
        </div>
      )}

      {createOpen && <CreateFabric onClose={() => setCreateOpen(false)} />}
    </div>
  );
};

function CreateFabric({ onClose }: { onClose: () => void }) {
  const create = useCreateFabric();
  const toast = useToast();
  const [code, setCode] = useState("");
  const [desc, setDesc] = useState("");
  const [supplierCode, setSupplierCode] = useState("");

  const submit = () => {
    if (!code.trim()) return toast.error("Fabric code is required.");
    create.mutate(
      { fabricCode: code.trim(), fabricDescription: desc.trim() || undefined, supplierCode: supplierCode.trim() || undefined },
      {
        onSuccess: () => {
          toast.success(`Created ${code.trim()}.`);
          onClose();
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : "Create failed."),
      },
    );
  };

  return (
    <div className={styles.bannerWarn} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "grid", placeItems: "center", zIndex: 50 }} onClick={onClose}>
      <div style={{ background: "var(--surface, #fff)", padding: 20, borderRadius: 12, minWidth: 360 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <strong>New Fabric</strong>
          <button className={styles.iconBtn} onClick={onClose}>
            <X {...ICON} />
          </button>
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span>Fabric code</span>
            <input className={styles.searchInput} value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span>Description</span>
            <input className={styles.searchInput} value={desc} onChange={(e) => setDesc(e.target.value)} />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span>Supplier code</span>
            <input className={styles.searchInput} value={supplierCode} onChange={(e) => setSupplierCode(e.target.value)} />
          </label>
          <button className={styles.iconBtn} onClick={submit} disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default FabricTracking;
