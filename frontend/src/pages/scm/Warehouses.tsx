// ----------------------------------------------------------------------------
// Warehouses — CRUD page for physical stock locations (1:1 clone of 2990s
// apps/backend/src/pages/Warehouses.tsx). Default seed: KL Warehouse + 2990 PJ
// (migration 0026). Add new warehouses here; deactivate (don't delete) when
// retired to preserve historical movements + lots.
//
// SEAM changes (same playbook as the PO slice):
//   - Data layer: 2990s lib/inventory-queries -> Houzs api client + react-query
//     (co-located ./inventory-queries). Shapes identical (rule #7).
//   - Components: @2990s/design-system Button (has size) -> Houzs components/
//     Button (variant only); 2990s DataGrid -> plain <table> + the verbatim
//     Inventory.module.css classes (rule #9).
//   - react-router -> react-router-dom (same hooks).
// ----------------------------------------------------------------------------

import { useState } from "react";
import { Plus, X, Star, Warehouse as WarehouseIcon } from "lucide-react";
import { Button } from "../../components/Button";
import { useToast } from "../../hooks/useToast";
import {
  useWarehouses,
  useCreateWarehouse,
  useUpdateWarehouse,
  type Warehouse,
} from "./inventory-queries";
import styles from "./Inventory.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

export const Warehouses = () => {
  const [includeInactive, setIncludeInactive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Warehouse | null>(null);
  const warehouses = useWarehouses({ includeInactive });

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.title}>Warehouses</h1>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus {...ICON} />
          <span>New Warehouse</span>
        </Button>
      </div>

      <div className={styles.headerRow}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--fs-13)" }}>
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          Show inactive
        </label>
      </div>

      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Location</th>
              <th>Default</th>
              <th>Status</th>
              <th style={{ textAlign: "right" }} />
            </tr>
          </thead>
          <tbody>
            {warehouses.isLoading && (
              <tr>
                <td colSpan={6} className={styles.emptyRow}>Loading…</td>
              </tr>
            )}
            {!warehouses.isLoading && (warehouses.data?.length ?? 0) === 0 && (
              <tr>
                <td colSpan={6} className={styles.emptyRow}>
                  <WarehouseIcon size={32} strokeWidth={1.5} />
                  <div style={{ marginTop: 8 }}>No warehouses yet.</div>
                </td>
              </tr>
            )}
            {warehouses.data?.map((w) => (
              <tr key={w.id}>
                <td>
                  <span className={styles.codeChip}>{w.code}</span>
                </td>
                <td>{w.name}</td>
                <td className={styles.numCellZero}>{w.location ?? "—"}</td>
                <td>
                  {w.is_default ? (
                    <Star size={12} strokeWidth={2} style={{ color: "var(--c-orange)", fill: "var(--c-orange)" }} />
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  <span className={`${styles.movementPill} ${w.is_active ? styles.movementIn : styles.movementAdj}`}>
                    {w.is_active ? "Active" : "Inactive"}
                  </span>
                </td>
                <td style={{ textAlign: "right" }}>
                  <Button variant="ghost" onClick={() => setEditing(w)}>
                    Edit
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(creating || editing) && (
        <WarehouseDrawer
          editing={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
};

const WarehouseDrawer = ({ editing, onClose }: { editing: Warehouse | null; onClose: () => void }) => {
  const toast = useToast();
  const create = useCreateWarehouse();
  const update = useUpdateWarehouse();
  const [form, setForm] = useState({
    code: editing?.code ?? "",
    name: editing?.name ?? "",
    location: editing?.location ?? "",
    isActive: editing?.is_active ?? true,
    isDefault: editing?.is_default ?? false,
  });

  const submit = () => {
    if (!form.code.trim() || !form.name.trim()) {
      toast.error("Code and Name are required.");
      return;
    }
    if (editing) {
      update.mutate(
        {
          id: editing.id,
          code: form.code,
          name: form.name,
          location: form.location,
          isActive: form.isActive,
          isDefault: form.isDefault,
        },
        { onSuccess: onClose },
      );
    } else {
      create.mutate(
        { code: form.code, name: form.name, location: form.location || undefined, isDefault: form.isDefault },
        { onSuccess: onClose },
      );
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.32)",
        zIndex: 50,
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 480, maxWidth: "95vw", background: "var(--c-cream)", padding: "var(--space-5)", overflow: "auto" }}
      >
        <div className={styles.headerRow}>
          <h2 className={styles.title} style={{ fontSize: "var(--fs-22)" }}>
            {editing ? "Edit Warehouse" : "New Warehouse"}
          </h2>
          <button type="button" className={styles.chip} onClick={onClose}>
            <X {...ICON} />
          </button>
        </div>

        <label style={{ display: "block", marginTop: "var(--space-4)" }}>
          <div className={styles.eyebrow}>Code *</div>
          <input
            className={styles.searchInput}
            style={{ width: "100%" }}
            value={form.code}
            placeholder="KL / PJ / JB"
            onChange={(e) => setForm((s) => ({ ...s, code: e.target.value.toUpperCase() }))}
          />
        </label>
        <label style={{ display: "block", marginTop: "var(--space-3)" }}>
          <div className={styles.eyebrow}>Name *</div>
          <input
            className={styles.searchInput}
            style={{ width: "100%" }}
            value={form.name}
            placeholder="KL Warehouse / 2990 PJ"
            onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
          />
        </label>
        <label style={{ display: "block", marginTop: "var(--space-3)" }}>
          <div className={styles.eyebrow}>Location</div>
          <input
            className={styles.searchInput}
            style={{ width: "100%" }}
            value={form.location ?? ""}
            placeholder="Address / area"
            onChange={(e) => setForm((s) => ({ ...s, location: e.target.value }))}
          />
        </label>
        <div style={{ display: "flex", gap: "var(--space-4)", marginTop: "var(--space-3)" }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={form.isDefault}
              onChange={(e) => setForm((s) => ({ ...s, isDefault: e.target.checked }))}
            />
            Default warehouse
          </label>
          {editing && (
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => setForm((s) => ({ ...s, isActive: e.target.checked }))}
              />
              Active
            </label>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-3)", marginTop: "var(--space-5)" }}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={create.isPending || update.isPending}>
            {create.isPending || update.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
};
