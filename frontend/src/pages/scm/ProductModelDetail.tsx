// ----------------------------------------------------------------------------
// Product Model detail — allowed-options editor + SKU list + SKU generator
// (clone of 2990s's ProductModelDetail surface). Reads /api/product-models/:id.
//
// FULL catalogue clone. Houzs-native rebuild on the established seam: api client
// + react-query + useDialog/useToast (rule #10), never window.*; CSS Modules
// verbatim (rule #6). 2990s's page (1331 lines) is supabase/design-system +
// R2-photo coupled; the photo uploader is dropped (R2 not wired this slice).
// Allowed-options here covers the two pricing axes: SOFA compartments + size-
// keyed (BEDFRAME/MATTRESS) sizes. The Generate SKUs button materialises the
// per-option mfg_products rows server-side (same endpoint 2990s used).
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Save, Sparkles } from "lucide-react";
import {
  useProductModel,
  usePatchProductModel,
  useGenerateSkus,
} from "./products-queries";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import styles from "./ProductModelDetail.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

// Standard size codes (2990s SIZE_INFO keys) + the sofa compartment vocabulary
// the configurator uses. The picker offers these as toggles; the saved set
// drives allowed_options.{sizes|compartments}.
const SIZE_CODES = ["K", "Q", "S", "SS", "SK", "SP"] as const;
const COMPARTMENT_CODES = [
  "1A(LHF)", "1A(RHF)", "1NA", "2A(LHF)", "2A(RHF)", "2NA", "3A(LHF)", "3A(RHF)",
  "L(LHF)", "L(RHF)", "Console", "Ottoman",
] as const;

const fmtSen = (sen: number | null | undefined): string =>
  sen == null ? "—" : (sen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const ProductModelDetail = () => {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error } = useProductModel(id);
  const patch = usePatchProductModel();
  const gen = useGenerateSkus();
  const dialog = useDialog();
  const toast = useToast();

  const model = data?.model;
  const skus = data?.skus ?? [];
  const isSofa = model?.category === "SOFA";
  const isSizeKeyed = model?.category === "BEDFRAME" || model?.category === "MATTRESS";

  // Local edit state for the allowed-options sets + active toggle.
  const [sizes, setSizes] = useState<string[]>([]);
  const [comps, setComps] = useState<string[]>([]);
  const [active, setActive] = useState(true);

  useEffect(() => {
    if (!model) return;
    const ao = (model.allowed_options ?? {}) as { sizes?: unknown; compartments?: unknown };
    setSizes(Array.isArray(ao.sizes) ? (ao.sizes as string[]) : []);
    setComps(Array.isArray(ao.compartments) ? (ao.compartments as string[]) : []);
    setActive(model.active);
  }, [model]);

  const dirty = useMemo(() => {
    if (!model) return false;
    const ao = (model.allowed_options ?? {}) as { sizes?: unknown; compartments?: unknown };
    const curSizes = Array.isArray(ao.sizes) ? (ao.sizes as string[]) : [];
    const curComps = Array.isArray(ao.compartments) ? (ao.compartments as string[]) : [];
    const eq = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
    return !eq(sizes, curSizes) || !eq(comps, curComps) || active !== model.active;
  }, [model, sizes, comps, active]);

  const toggle = (list: string[], setList: (v: string[]) => void, code: string) => {
    setList(list.includes(code) ? list.filter((c) => c !== code) : [...list, code]);
  };

  const save = () => {
    if (!model) return;
    const allowedOptions: Record<string, unknown> = { ...(model.allowed_options ?? {}) };
    if (isSofa) allowedOptions.compartments = comps;
    if (isSizeKeyed) allowedOptions.sizes = sizes;
    patch.mutate(
      { id, patch: { allowedOptions, active } },
      {
        onSuccess: (res) => {
          toast.success(
            res.autoCreatedSkus.length > 0
              ? `Saved. Auto-created ${res.autoCreatedSkus.length} SKU(s).`
              : "Saved.",
          );
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : "Save failed."),
      },
    );
  };

  const generate = async () => {
    if (!(await dialog.confirm("Generate the SKU rows for every allowed option? Existing codes are skipped."))) return;
    gen.mutate(
      { id },
      {
        onSuccess: (res) => {
          if (res.generated === 0) toast.warning(res.skipped > 0 ? "All variant codes already exist." : "Nothing to generate.");
          else toast.success(`Generated ${res.generated} SKU(s).`);
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : "Generate failed."),
      },
    );
  };

  if (isLoading) return <div className={styles.page}><p className={styles.loading}>Loading model…</p></div>;
  if (error || !model)
    return (
      <div className={styles.page}>
        <p className={styles.errorBanner}>Failed to load model: {error instanceof Error ? error.message : "not found"}</p>
      </div>
    );

  return (
    <div className={styles.page}>
      <button className={styles.back} onClick={() => navigate("/product-models")}>
        <ArrowLeft {...ICON} /> Models
      </button>

      <div className={styles.header}>
        <div className={styles.titleRow}>
          <span className={styles.catPill}>{model.category}</span>
          <span className={styles.titleName}>
            {model.model_code} · {model.name}
          </span>
        </div>
        <div className={styles.headerActions}>
          <button className={styles.chip} onClick={save} disabled={!dirty || patch.isPending}>
            <Save {...ICON} /> {patch.isPending ? "Saving…" : "Save"}
          </button>
          <button className={styles.chip} onClick={generate} disabled={gen.isPending}>
            <Sparkles {...ICON} /> {gen.isPending ? "Generating…" : "Generate SKUs"}
          </button>
        </div>
      </div>

      <div className={styles.card}>
        <div className={styles.cardHeadRow}>
          <span className={styles.cardTitle}>Allowed options</span>
          <label className={styles.chip}>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active
          </label>
        </div>

        {isSofa && (
          <div className={styles.optGroup}>
            <div className={styles.optHead}>Compartments</div>
            <div className={styles.chipRow}>
              {COMPARTMENT_CODES.map((code) => (
                <button
                  key={code}
                  className={`${styles.chip} ${comps.includes(code) ? styles.chipOn : ""}`}
                  onClick={() => toggle(comps, setComps, code)}
                >
                  {code}
                </button>
              ))}
            </div>
          </div>
        )}

        {isSizeKeyed && (
          <div className={styles.optGroup}>
            <div className={styles.optHead}>Sizes</div>
            <div className={styles.chipRow}>
              {SIZE_CODES.map((code) => (
                <button
                  key={code}
                  className={`${styles.chip} ${sizes.includes(code) ? styles.chipOn : ""}`}
                  onClick={() => toggle(sizes, setSizes, code)}
                >
                  {code}
                </button>
              ))}
            </div>
          </div>
        )}

        {!isSofa && !isSizeKeyed && (
          <p className={styles.optHint}>
            {model.category} models have no variant axis — Generate SKUs creates a single SKU from the model code.
          </p>
        )}
      </div>

      <div className={styles.card}>
        <div className={styles.cardTitle}>SKU variants ({skus.length})</div>
        <table className={styles.skuTable}>
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Size</th>
              <th>Base</th>
              <th>Cost</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {skus.length === 0 && (
              <tr>
                <td colSpan={6} className={styles.modalEmpty}>
                  No SKUs yet — set allowed options then Generate SKUs.
                </td>
              </tr>
            )}
            {skus.map((s) => (
              <tr key={s.id}>
                <td>{s.code}</td>
                <td>{s.name}</td>
                <td>{s.size_label ?? s.size_code ?? "—"}</td>
                <td>{fmtSen(s.base_price_sen)}</td>
                <td>{fmtSen(s.cost_price_sen)}</td>
                <td>
                  <span className={styles.statusPill}>{s.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default ProductModelDetail;
