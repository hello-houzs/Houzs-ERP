// ----------------------------------------------------------------------------
// Products — manufacturer SKU master (clone of 2990s's Products & Maintenance
// SKU Master surface). Lists mfg_products with a category filter + search,
// inline price edits, ACTIVE / POS toggles, a create drawer, and per-SKU price
// history. Reads /api/mfg-products (the cloned route).
//
// FULL furniture catalogue (NOT Strategy-2-stripped — the owner wants the whole
// module). The 2990s page (4777 lines) is deeply POS-coupled (supabase client,
// @2990s/design-system, useAuth, jspdf, sofa configurator). This Houzs-native
// rebuild keeps the SAME data + endpoints + the verbatim CSS module, on the
// Houzs seam: api client + react-query + useDialog/useToast (rule #10), never
// window.*; CSS Modules verbatim (rule #6). The deeper editors (sofa combo
// builder, allowed-options matrix, fabric grids) live on the Model detail page
// + Maintenance page; advanced per-SKU drawers are a documented follow-up.
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Search, Plus, History, X, Trash2 } from "lucide-react";
import {
  useMfgProducts,
  usePatchMfgProduct,
  useCreateMfgProduct,
  useDeleteMfgProduct,
  useMfgPriceHistory,
  type MfgProductRow,
  type MfgCategory,
} from "./products-queries";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import styles from "./Products.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const CATEGORIES: Array<MfgCategory | "ALL"> = ["ALL", "SOFA", "BEDFRAME", "MATTRESS", "ACCESSORY", "SERVICE"];

const fmtSen = (sen: number | null | undefined): string => {
  if (sen == null) return "—";
  return (sen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const parseRm = (v: string): number | null => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
};

export const Products = () => {
  const [category, setCategory] = useState<MfgCategory | "ALL">("ALL");
  const [search, setSearch] = useState("");
  const { data: products, isLoading, error } = useMfgProducts({
    category: category === "ALL" ? undefined : category,
    search: search.trim() || undefined,
  });
  const rows = useMemo(() => products ?? [], [products]);

  const patch = usePatchMfgProduct();
  const del = useDeleteMfgProduct();
  const dialog = useDialog();
  const toast = useToast();

  const [createOpen, setCreateOpen] = useState(false);
  const [historyFor, setHistoryFor] = useState<MfgProductRow | null>(null);

  // Inline price commit (base / cost / sell), only when the value changed.
  const commitPrice = async (
    row: MfgProductRow,
    field: "basePriceSen" | "sellPriceSen",
    raw: string,
    current: number | null,
  ) => {
    const sen = raw.trim() === "" ? null : parseRm(raw);
    if (raw.trim() !== "" && sen == null) {
      toast.error("Enter a valid price (RM, >= 0).");
      return;
    }
    if (sen === current) return;
    patch.mutate(
      { id: row.id, patch: { [field]: sen } },
      {
        onSuccess: () => toast.success(`${row.code} updated.`),
        onError: (e) => toast.error(`Update failed: ${e instanceof Error ? e.message : String(e)}`),
      },
    );
  };

  const toggleStatus = (row: MfgProductRow) => {
    const next = row.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    patch.mutate(
      { id: row.id, patch: { status: next } },
      { onError: (e) => toast.error(`Update failed: ${e instanceof Error ? e.message : String(e)}`) },
    );
  };

  const onDelete = async (row: MfgProductRow) => {
    if (!(await dialog.confirm(`Delete SKU "${row.code}"? Unused SKUs only — a used SKU is locked.`))) return;
    del.mutate(
      { id: row.id },
      {
        onSuccess: () => toast.success(`Deleted ${row.code}.`),
        onError: (e) => toast.error(e instanceof Error ? e.message : "Delete failed."),
      },
    );
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <div className={styles.eyebrow}>Products &amp; Maintenance</div>
          <h1 className={styles.maintTitle}>SKU Master</h1>
        </div>
        <button className={styles.iconBtn} onClick={() => setCreateOpen(true)}>
          <Plus {...ICON} /> New SKU
        </button>
      </div>

      <div className={styles.actionsRow}>
        <div className={styles.searchBox}>
          <Search {...ICON} className={styles.searchIcon} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search code / name / barcode"
            className={styles.fieldInput}
          />
        </div>
        <div className={styles.categoryChips}>
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              className={`${styles.catPill} ${category === cat ? styles.tierChip : ""}`}
              onClick={() => setCategory(cat)}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {isLoading && <p>Loading SKUs…</p>}
      {error && <p className={styles.bannerWarn}>Failed to load: {error instanceof Error ? error.message : String(error)}</p>}

      {!isLoading && !error && (
        <div className={styles.tableCard}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Category</th>
                <th>Base (RM)</th>
                <th>Sell (RM)</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", padding: "2rem" }}>
                    No SKUs.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className={styles.codeChip}>{r.code}</span>
                  </td>
                  <td>
                    <span className={styles.nameMain}>{r.name}</span>
                    {r.branding && <span className={styles.nameSub}> · {r.branding}</span>}
                  </td>
                  <td>{r.category}</td>
                  <td className={styles.numCell}>
                    <span className={styles.maintRowRmPrefix}>RM</span>
                    <input
                      type="number"
                      step="0.01"
                      defaultValue={r.base_price_sen == null ? "" : (r.base_price_sen / 100).toString()}
                      onBlur={(e) => commitPrice(r, "basePriceSen", e.target.value, r.base_price_sen)}
                      className={styles.fieldInput}
                      style={{ width: 90 }}
                    />
                  </td>
                  <td className={styles.numCell}>
                    <span className={styles.maintRowRmPrefix}>RM</span>
                    <input
                      type="number"
                      step="0.01"
                      defaultValue={r.sell_price_sen == null ? "" : (r.sell_price_sen / 100).toString()}
                      onBlur={(e) => commitPrice(r, "sellPriceSen", e.target.value, r.sell_price_sen)}
                      className={styles.fieldInput}
                      style={{ width: 90 }}
                    />
                  </td>
                  <td>
                    <button
                      className={`${styles.tierChip} ${r.status === "ACTIVE" ? "" : styles.priceEmpty}`}
                      onClick={() => toggleStatus(r)}
                      title="Toggle ACTIVE / INACTIVE"
                    >
                      {r.status}
                    </button>
                  </td>
                  <td className={styles.actionsRow}>
                    <button className={styles.iconBtn} onClick={() => setHistoryFor(r)} title="Price history">
                      <History {...ICON} />
                    </button>
                    <button className={styles.iconBtn} onClick={() => onDelete(r)} title="Delete">
                      <Trash2 {...ICON} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className={styles.tableFoot}>{rows.length} SKU(s)</div>
        </div>
      )}

      {createOpen && <CreateDrawer onClose={() => setCreateOpen(false)} />}
      {historyFor && <HistoryDrawer product={historyFor} onClose={() => setHistoryFor(null)} />}
    </div>
  );
};

// ── Create drawer ──────────────────────────────────────────────────────
function CreateDrawer({ onClose }: { onClose: () => void }) {
  const create = useCreateMfgProduct();
  const toast = useToast();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [cat, setCat] = useState<MfgCategory>("SOFA");
  const [basePrice, setBasePrice] = useState("");

  const submit = () => {
    if (!code.trim()) return toast.error("Code is required.");
    if (!name.trim()) return toast.error("Name is required.");
    create.mutate(
      {
        code: code.trim(),
        name: name.trim(),
        category: cat,
        basePriceSen: basePrice.trim() ? parseRm(basePrice) ?? undefined : undefined,
      },
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
    <div className={styles.drawerBackdrop} onClick={onClose}>
      <div className={styles.drawer} onClick={(e) => e.stopPropagation()}>
        <div className={styles.drawerHeader}>
          <span className={styles.drawerTitle}>New SKU</span>
          <button className={styles.iconBtn} onClick={onClose}>
            <X {...ICON} />
          </button>
        </div>
        <div className={styles.drawerBody}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Code</label>
            <input className={styles.fieldInput} value={code} onChange={(e) => setCode(e.target.value)} />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Name</label>
            <input className={styles.fieldInput} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Category</label>
            <select className={styles.fieldSelect} value={cat} onChange={(e) => setCat(e.target.value as MfgCategory)}>
              {(["SOFA", "BEDFRAME", "MATTRESS", "ACCESSORY", "SERVICE"] as MfgCategory[]).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Base price (RM)</label>
            <input className={styles.fieldInput} type="number" step="0.01" value={basePrice} onChange={(e) => setBasePrice(e.target.value)} />
          </div>
        </div>
        <div className={styles.drawerFooter}>
          <button className={styles.iconBtn} onClick={submit} disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── History drawer ─────────────────────────────────────────────────────
function HistoryDrawer({ product, onClose }: { product: MfgProductRow; onClose: () => void }) {
  const { data: history, isLoading } = useMfgPriceHistory(product.id);
  return (
    <div className={styles.drawerBackdrop} onClick={onClose}>
      <div className={styles.drawer} onClick={(e) => e.stopPropagation()}>
        <div className={styles.drawerHeader}>
          <span className={styles.drawerTitle}>Price history · {product.code}</span>
          <button className={styles.iconBtn} onClick={onClose}>
            <X {...ICON} />
          </button>
        </div>
        <div className={styles.drawerBody}>
          {isLoading && <p>Loading…</p>}
          {!isLoading && (history ?? []).length === 0 && <p>No price changes recorded.</p>}
          {(history ?? []).map((h) => (
            <div key={h.id} className={styles.maintRow}>
              <span className={styles.maintRowValue}>{h.field}</span>
              <span className={styles.maintRowPriceMuted}>
                {fmtSen(h.old_value_sen)} → {fmtSen(h.new_value_sen)}
              </span>
              <span className={styles.maintRowPriceMuted}>{new Date(h.changed_at).toLocaleDateString("en-GB")}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default Products;
