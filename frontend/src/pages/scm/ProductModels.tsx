// ----------------------------------------------------------------------------
// Product Models — list + create (clone of 2990s's ProductModels page surface).
// A Model is the second-layer template that owns the allowed-options pool; each
// SKU on mfg_products belongs to a Model. Reads /api/product-models.
//
// FULL catalogue clone (NOT Strategy-2-stripped). Houzs-native rebuild on the
// established seam: api client + react-query + useDialog/useToast (rule #10),
// never window.*; CSS Modules verbatim (rule #6). The 2990s page (2176 lines) is
// supabase/design-system-coupled; the detail editor (allowed-options matrix,
// SKU generator, photo) lives on ProductModelDetail.
// ----------------------------------------------------------------------------

import { useState } from "react";
import { Link } from "react-router-dom";
import { Plus, X } from "lucide-react";
import {
  useProductModels,
  useCreateProductModel,
  useDeleteProductModel,
  type MfgCategory,
} from "./products-queries";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import styles from "./ProductModels.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const CATEGORIES: Array<MfgCategory | "ALL"> = ["ALL", "SOFA", "BEDFRAME", "MATTRESS", "ACCESSORY", "SERVICE"];

export const ProductModels = () => {
  const [category, setCategory] = useState<MfgCategory | "ALL">("ALL");
  const { data: models, isLoading, error } = useProductModels(category === "ALL" ? undefined : category);
  const del = useDeleteProductModel();
  const dialog = useDialog();
  const toast = useToast();
  const [createOpen, setCreateOpen] = useState(false);

  const onDelete = async (id: string, code: string) => {
    if (!(await dialog.confirm(`Delete Model "${code}"? Unused models only — a model with a used SKU is locked.`))) return;
    del.mutate(
      { id },
      {
        onSuccess: () => toast.success(`Deleted ${code}.`),
        onError: (e) => toast.error(e instanceof Error ? e.message : "Delete failed."),
      },
    );
  };

  const rows = models ?? [];

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1>Product Models</h1>
        </div>
        <button className={styles.filterChip} onClick={() => setCreateOpen(true)}>
          <Plus {...ICON} /> New Model
        </button>
      </div>

      <div className={styles.chipRow}>
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            className={`${styles.filterChip} ${category === cat ? styles.filterChipOn : ""}`}
            onClick={() => setCategory(cat)}
          >
            {cat}
          </button>
        ))}
      </div>

      {isLoading && <p>Loading models…</p>}
      {error && <p>Failed to load: {error instanceof Error ? error.message : String(error)}</p>}

      {!isLoading && !error && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Branding</th>
              <th>Category</th>
              <th>Active</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className={styles.empty}>
                  No models.
                </td>
              </tr>
            )}
            {rows.map((m) => (
              <tr key={m.id}>
                <td>
                  <Link to={`/product-models/${m.id}`} className={styles.codeChipLink}>
                    {m.model_code}
                  </Link>
                </td>
                <td>{m.name}</td>
                <td>{m.branding ?? "—"}</td>
                <td>{m.category}</td>
                <td>{m.active ? "Yes" : "No"}</td>
                <td>
                  <button className={styles.filterChip} onClick={() => onDelete(m.id, m.model_code)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {createOpen && <CreateModal onClose={() => setCreateOpen(false)} />}
    </div>
  );
};

function CreateModal({ onClose }: { onClose: () => void }) {
  const create = useCreateProductModel();
  const toast = useToast();
  const [modelCode, setModelCode] = useState("");
  const [name, setName] = useState("");
  const [branding, setBranding] = useState("");
  const [cat, setCat] = useState<MfgCategory>("SOFA");

  const submit = () => {
    if (!modelCode.trim()) return toast.error("Model code is required.");
    if (!name.trim()) return toast.error("Name is required.");
    create.mutate(
      { modelCode: modelCode.trim(), name: name.trim(), branding: branding.trim() || null, category: cat },
      {
        onSuccess: () => {
          toast.success(`Created ${modelCode.trim()}.`);
          onClose();
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : "Create failed."),
      },
    );
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalTitle}>
          New Model
          <button className={styles.filterChip} onClick={onClose}>
            <X {...ICON} />
          </button>
        </div>
        <div className={styles.field}>
          <label>Model code</label>
          <input value={modelCode} onChange={(e) => setModelCode(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label>Branding (optional)</label>
          <input value={branding} onChange={(e) => setBranding(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label>Category</label>
          <select value={cat} onChange={(e) => setCat(e.target.value as MfgCategory)}>
            {(["SOFA", "BEDFRAME", "MATTRESS", "ACCESSORY", "SERVICE"] as MfgCategory[]).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.modalFooter}>
          <button className={styles.filterChip} onClick={submit} disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ProductModels;
