// ----------------------------------------------------------------------------
// Maintenance — the Products & Maintenance config hub (clone of 2990s's
// Maintenance surface). Surfaces the SELLING fabric-tier add-on deltas
// (editable), the category library, the PWP (换购) rules, and a Sofa Combo
// pricing summary. Reads /api/fabric-tier-addon, /api/categories, /api/pwp-rules,
// /api/sofa-combos.
//
// FULL catalogue clone. Houzs-native rebuild on the established seam: api client
// + react-query + useDialog/useToast (rule #10), never window.*; CSS Modules
// verbatim (rule #6 — reuses Products.module.css's maint* classes). The
// effective-dated maintenance_config blob editor (bedframe/sofa option pools) is
// a documented follow-up; its route (/api/maintenance-config) IS cloned.
// ----------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { Save, Trash2 } from "lucide-react";
import {
  useFabricTierAddon,
  usePatchFabricTierAddon,
  useCategories,
  usePwpRules,
  useTogglePwpRule,
  useDeletePwpRule,
  useSofaCombos,
  useDeleteSofaCombo as useDeleteSofaComboInner,
} from "./products-queries";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import styles from "./Products.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const fmtRm = (whole: number | null | undefined): string => (whole == null ? "0" : whole.toLocaleString("en-MY"));

export const Maintenance = () => {
  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <div className={styles.eyebrow}>Products &amp; Maintenance</div>
          <h1 className={styles.maintTitle}>Maintenance</h1>
        </div>
      </div>

      <FabricTierPanel />
      <CategoriesPanel />
      <PwpRulesPanel />
      <CombosPanel />
    </div>
  );
};

// ── Fabric-tier add-on deltas (whole MYR) ────────────────────────────────
function FabricTierPanel() {
  const { data, isLoading } = useFabricTierAddon();
  const patch = usePatchFabricTierAddon();
  const toast = useToast();
  const [form, setForm] = useState({ sofaTier2Delta: 0, sofaTier3Delta: 0, bedframeTier2Delta: 0, bedframeTier3Delta: 0 });

  useEffect(() => {
    if (data) {
      setForm({
        sofaTier2Delta: data.sofaTier2Delta,
        sofaTier3Delta: data.sofaTier3Delta,
        bedframeTier2Delta: data.bedframeTier2Delta,
        bedframeTier3Delta: data.bedframeTier3Delta,
      });
    }
  }, [data]);

  const save = () => {
    patch.mutate(form, {
      onSuccess: () => toast.success("Fabric-tier deltas saved."),
      onError: (e) => toast.error(e instanceof Error ? e.message : "Save failed."),
    });
  };

  const fields: Array<[keyof typeof form, string]> = [
    ["sofaTier2Delta", "Sofa P2 Δ"],
    ["sofaTier3Delta", "Sofa P3 Δ"],
    ["bedframeTier2Delta", "Bedframe P2 Δ"],
    ["bedframeTier3Delta", "Bedframe P3 Δ"],
  ];

  return (
    <section className={styles.maintSection}>
      <div className={styles.maintHeader}>
        <span className={styles.maintSubtitle}>Fabric-tier add-on (selling, whole MYR)</span>
        <button className={styles.iconBtn} onClick={save} disabled={isLoading || patch.isPending}>
          <Save {...ICON} /> {patch.isPending ? "Saving…" : "Save"}
        </button>
      </div>
      <div className={styles.formGrid}>
        {fields.map(([key, label]) => (
          <div className={styles.field} key={key}>
            <label className={styles.fieldLabel}>{label}</label>
            <input
              className={styles.fieldInput}
              type="number"
              value={form[key]}
              onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) || 0 })}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Category library ─────────────────────────────────────────────────────
function CategoriesPanel() {
  const { data: cats, isLoading } = useCategories();
  return (
    <section className={styles.maintSection}>
      <div className={styles.maintHeader}>
        <span className={styles.maintSubtitle}>Categories</span>
      </div>
      {isLoading ? (
        <p>Loading…</p>
      ) : (
        <div className={styles.maintList}>
          {(cats ?? []).length === 0 && <p className={styles.priceEmpty}>No categories.</p>}
          {(cats ?? []).map((c) => (
            <div key={c.id} className={styles.maintRow}>
              <span className={styles.maintRowValue}>{c.label}</span>
              <span className={styles.maintRowPriceMuted}>{c.id}</span>
              {c.tbc && <span className={styles.tierChip}>TBC</span>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── PWP rules ────────────────────────────────────────────────────────────
function PwpRulesPanel() {
  const { data: rules, isLoading } = usePwpRules();
  const toggle = useTogglePwpRule();
  const del = useDeletePwpRule();
  const dialog = useDialog();
  const toast = useToast();

  const onDelete = async (id: string) => {
    if (!(await dialog.confirm("Delete this PWP rule?"))) return;
    del.mutate(
      { id },
      {
        onSuccess: () => toast.success("Rule deleted."),
        onError: (e) => toast.error(e instanceof Error ? e.message : "Delete failed."),
      },
    );
  };

  return (
    <section className={styles.maintSection}>
      <div className={styles.maintHeader}>
        <span className={styles.maintSubtitle}>PWP (换购) rules</span>
      </div>
      {isLoading ? (
        <p>Loading…</p>
      ) : (
        <div className={styles.maintList}>
          {(rules ?? []).length === 0 && <p className={styles.priceEmpty}>No PWP rules.</p>}
          {(rules ?? []).map((r) => (
            <div key={r.id} className={styles.maintRow}>
              <span className={styles.maintRowValue}>
                {r.triggerCategory} → {r.rewardCategory}
              </span>
              <span className={styles.maintRowPriceMuted}>
                {r.type} · ×{r.qtyPerTrigger}
              </span>
              <button
                className={`${styles.tierChip} ${r.active ? "" : styles.priceEmpty}`}
                onClick={() => toggle.mutate({ id: r.id, active: !r.active })}
              >
                {r.active ? "Active" : "Off"}
              </button>
              <button className={styles.iconBtn} onClick={() => onDelete(r.id)} title="Delete">
                <Trash2 {...ICON} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── Sofa combo pricing summary ───────────────────────────────────────────
function CombosPanel() {
  const { data: combos, isLoading } = useSofaCombos();
  const del = useDeleteSofaComboGuard();

  return (
    <section className={styles.maintSection}>
      <div className={styles.maintHeader}>
        <span className={styles.maintSubtitle}>Sofa combo pricing</span>
      </div>
      {isLoading ? (
        <p>Loading…</p>
      ) : (
        <div className={styles.maintList}>
          {(combos ?? []).length === 0 && <p className={styles.priceEmpty}>No active combos.</p>}
          {(combos ?? []).map((combo) => (
            <div key={combo.id} className={styles.maintRow}>
              <span className={styles.maintRowValue}>
                {combo.baseModel} · {combo.label ?? combo.modules.map((slot) => slot.join("/")).join(" + ")}
              </span>
              <span className={styles.maintRowPriceMuted}>
                {Object.entries(combo.sellingPricesByHeight)
                  .filter(([, v]) => v != null)
                  .map(([h, v]) => `${h}": RM ${fmtRm((v as number) / 100)}`)
                  .join(" · ") || "—"}
              </span>
              <button className={styles.iconBtn} onClick={() => del(combo.id)} title="Soft-delete">
                <Trash2 {...ICON} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// Small wrapper so the combos panel can call delete with a confirm gate without
// hoisting the mutation hook into the row map.
function useDeleteSofaComboGuard() {
  const del = useDeleteSofaComboInner();
  const dialog = useDialog();
  const toast = useToast();
  return async (id: string) => {
    if (!(await dialog.confirm("Soft-delete this combo? It stays in history; pricing lookup skips it."))) return;
    del.mutate(
      { id },
      {
        onSuccess: () => toast.success("Combo removed."),
        onError: (e) => toast.error(e instanceof Error ? e.message : "Delete failed."),
      },
    );
  };
}

export default Maintenance;
