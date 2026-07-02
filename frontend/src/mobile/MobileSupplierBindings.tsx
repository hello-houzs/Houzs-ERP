import { useMemo, useState } from "react";
import {
  useCreateBinding,
  useUpdateBinding,
  useDeleteBinding,
  type BindingRow,
  type Currency,
  type MaterialKind,
  type NewBinding,
} from "../vendor/scm/lib/suppliers-queries";
import { MobileSkuPicker, type PickedSku } from "./MobileSkuPicker";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { useAuth } from "../auth/AuthContext";
import { ACCESS_RANK, type AccessLevel } from "../types";
import "./mobile.css";

// ---------------------------------------------------------------------------
// MobileSupplierBindings — editable "Assigned materials" (SKU material bindings)
// for the mobile Supplier detail. Mirrors the desktop SupplierDetail SKU
// Mappings surface (add / edit / delete / main-supplier toggle) but on the
// everyday FLAT price axis: material + supplier SKU + unit price (sen) +
// currency + lead time + MOQ + main-supplier flag.
//
// PER-CATEGORY PRICE MATRIX (sofa height×tier, bedframe P1/P2) is a desktop-only
// affordance in this first mobile pass (see report). The edit sheet NEVER sends
// `priceMatrix`, so PATCHing a matrix-bearing sofa/bedframe binding leaves its
// stored matrix intact — the row surfaces a read-only "Matrix" chip instead.
//
// Wires the vendored mutation hooks verbatim (same endpoints the desktop uses):
//   POST   /suppliers/:id/bindings              (useCreateBinding)
//   PATCH  /suppliers/:id/bindings/:bindingId   (useUpdateBinding)
//   DELETE /suppliers/:id/bindings/:bindingId   (useDeleteBinding)
// Money is sen/centi end-to-end (÷100 for display, ×100 on save). All prompts
// go through the in-app useConfirm / useNotify (no window.confirm). The whole
// editing surface is gated on the SCM L2 suppliers area meeting `edit` — the
// same gate the backend enforces (scmAreaGuard('scm.procurement.suppliers')).
// ---------------------------------------------------------------------------

const CURRENCIES: Currency[] = ["MYR", "RMB", "USD", "SGD"];

const dual = <T,>(camel: T | undefined, snake: T | undefined): T | undefined =>
  camel ?? snake;

/** Sen (centi) → "1,234.50", degrading NaN/blank to "0.00". */
function senToStr(sen: unknown): string {
  const n = Number(sen);
  return (Number.isFinite(n) ? n / 100 : 0).toFixed(2);
}

/** RM display of a sen amount + currency (non-MYR keeps its ISO tag). */
function money(sen: unknown, currency: Currency): string {
  const n = Number(sen);
  const v = (Number.isFinite(n) ? n / 100 : 0).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency === "MYR" ? `RM ${v}` : `${v} ${currency}`;
}

/** first non-empty trimmed string, else "—". */
function firstOf(...vals: unknown[]): string {
  for (const v of vals) {
    const str = v == null ? "" : String(v).trim();
    if (str) return str;
  }
  return "—";
}

/** A binding read tolerant of the driver's camelCase result columns
 *  (#1 recurring pg bug — r.snake_case can be undefined). */
type LooseBinding = BindingRow & Record<string, unknown>;

function readBinding(b: LooseBinding) {
  return {
    id: String(dual(b.id, (b as Record<string, unknown>).id) ?? ""),
    materialKind: (dual(
      (b as Record<string, unknown>).materialKind as MaterialKind | undefined,
      b.material_kind,
    ) ?? "mfg_product") as MaterialKind,
    materialCode: String(dual((b as Record<string, unknown>).materialCode as string | undefined, b.material_code) ?? ""),
    materialName: String(dual((b as Record<string, unknown>).materialName as string | undefined, b.material_name) ?? ""),
    supplierSku: String(dual((b as Record<string, unknown>).supplierSku as string | undefined, b.supplier_sku) ?? ""),
    unitPriceCenti: Number(dual((b as Record<string, unknown>).unitPriceCenti as number | undefined, b.unit_price_centi) ?? 0),
    currency: (dual((b as Record<string, unknown>).currency as Currency | undefined, b.currency) ?? "MYR") as Currency,
    leadTimeDays: Number(dual((b as Record<string, unknown>).leadTimeDays as number | undefined, b.lead_time_days) ?? 0),
    moq: Number(dual((b as Record<string, unknown>).moq as number | undefined, b.moq) ?? 0),
    isMainSupplier: Boolean(dual((b as Record<string, unknown>).isMainSupplier as boolean | undefined, b.is_main_supplier)),
    priceMatrix: dual((b as Record<string, unknown>).priceMatrix, b.price_matrix) ?? null,
  };
}

const inputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", height: 42, padding: "0 12px", borderRadius: 10,
  border: "1px solid #e3e6e0", background: "#fff", fontFamily: "inherit", fontSize: 14, color: "var(--ink)",
};
const labelStyle: React.CSSProperties = {
  fontSize: 9.5, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase",
  color: "#9aa093", marginBottom: 5, display: "block",
};

// ---------------------------------------------------------------------------
// Add / Edit binding bottom sheet. `editing` null → create (a MobileSkuPicker
// seeds the material); non-null → edit (material fixed, fields prefilled). Only
// changed fields are PATCHed on edit; create sends the full flat body. Never
// touches priceMatrix (desktop-only) — an existing matrix survives an edit.
// ---------------------------------------------------------------------------
function BindingEditSheet({
  supplierId,
  editing,
  onClose,
  onSaved,
}: {
  supplierId: string;
  editing: LooseBinding | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const notify = useNotify();
  const create = useCreateBinding();
  const update = useUpdateBinding();
  const seed = editing ? readBinding(editing) : null;

  // Picked material (create only). null until the operator picks one.
  const [picked, setPicked] = useState<PickedSku | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const [supplierSku, setSupplierSku] = useState(seed?.supplierSku ?? "");
  const [price, setPrice] = useState(seed ? senToStr(seed.unitPriceCenti) : "");
  const [currency, setCurrency] = useState<Currency>(seed?.currency ?? "MYR");
  const [leadTimeDays, setLeadTimeDays] = useState(seed ? String(seed.leadTimeDays) : "0");
  const [moq, setMoq] = useState(seed ? String(seed.moq) : "0");
  const [isMain, setIsMain] = useState(seed?.isMainSupplier ?? false);
  const [error, setError] = useState<string | null>(null);
  const busy = create.isPending || update.isPending;

  // The material this sheet operates on: fixed (edit) or picked (create).
  const material = editing
    ? { code: seed!.materialCode, name: seed!.materialName, kind: seed!.materialKind }
    : picked
      ? { code: picked.itemCode, name: picked.name, kind: "mfg_product" as MaterialKind }
      : null;

  const onPick = (sku: PickedSku) => {
    setPicked(sku);
    // supplierSku defaults from the material code (editable).
    setSupplierSku((prev) => (prev.trim() ? prev : sku.itemCode));
    // Seed the flat unit price from the catalog reference when blank.
    setPrice((prev) => (prev.trim() ? prev : senToStr(sku.unitPriceCenti)));
  };

  const save = async () => {
    setError(null);
    if (!material) { setError("Pick a material first."); return; }
    if (!supplierSku.trim()) { setError("Supplier SKU is required."); return; }
    const unitPriceCenti = Math.round(Number(price || "0") * 100);
    if (!Number.isFinite(unitPriceCenti) || unitPriceCenti < 0) { setError("Enter a valid unit price."); return; }
    const lead = Math.max(0, Math.round(Number(leadTimeDays || "0")));
    const moqN = Math.max(0, Math.round(Number(moq || "0")));

    try {
      if (editing) {
        // Send only the flat fields that changed (matrix untouched).
        const body: Partial<NewBinding> = {};
        if (supplierSku.trim() !== seed!.supplierSku) body.supplierSku = supplierSku.trim();
        if (unitPriceCenti !== seed!.unitPriceCenti) body.unitPriceCenti = unitPriceCenti;
        if (currency !== seed!.currency) body.currency = currency;
        if (lead !== seed!.leadTimeDays) body.leadTimeDays = lead;
        if (moqN !== seed!.moq) body.moq = moqN;
        if (isMain !== seed!.isMainSupplier) body.isMainSupplier = isMain;
        if (Object.keys(body).length === 0) { onClose(); return; }
        await update.mutateAsync({ supplierId, bindingId: seed!.id, ...body });
      } else {
        await create.mutateAsync({
          supplierId,
          materialKind: material.kind,
          materialCode: material.code,
          materialName: material.name,
          supplierSku: supplierSku.trim(),
          unitPriceCenti,
          currency,
          leadTimeDays: lead,
          moq: moqN,
          isMainSupplier: isMain,
        });
      }
      onSaved();
      onClose();
      void notify({ title: editing ? "Binding updated" : "Material assigned" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the binding. Please try again.");
    }
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 2600, background: "rgba(0,0,0,0.32)", display: "flex", alignItems: "flex-end" }}>
      <div onClick={(e) => e.stopPropagation()} className="hz-m" style={{ width: "100%", maxHeight: "90vh", overflowY: "auto", background: "#fff", borderRadius: "18px 18px 0 0", padding: "18px 16px calc(env(safe-area-inset-bottom) + 16px)", boxShadow: "0 -8px 28px rgba(0,0,0,0.16)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: "var(--ink)" }}>{editing ? "Edit Binding" : "Assign Material"}</div>
          <button onClick={onClose} style={{ border: "none", background: "transparent", fontSize: 15, fontWeight: 700, color: "var(--teal)", cursor: "pointer", fontFamily: "inherit" }}>Close</button>
        </div>

        {/* Material — a picker button on create, a fixed label on edit. */}
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Material</label>
          {editing ? (
            <div style={{ ...inputStyle, display: "flex", alignItems: "center", background: "#f7f8f5", color: "#11140f" }}>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {firstOf(material?.name, material?.code)}
              </span>
              {material?.code ? <span className="money" style={{ color: "#9aa093", fontSize: 12, marginLeft: 8 }}>{material.code}</span> : null}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              style={{ ...inputStyle, textAlign: "left", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
            >
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: material ? "#11140f" : "#9aa093" }}>
                {material ? firstOf(material.name, material.code) : "Pick a material…"}
              </span>
              {material?.code ? <span className="money" style={{ color: "#9aa093", fontSize: 12 }}>{material.code}</span> : null}
            </button>
          )}
          {picked?.category ? (
            <div style={{ fontSize: 10.5, color: "#a16a2e", marginTop: 5 }}>
              {picked.category} · sofa/bedframe per-category price matrix is edited on desktop.
            </div>
          ) : null}
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Supplier SKU</label>
          <input value={supplierSku} onChange={(e) => setSupplierSku(e.target.value)} placeholder="Supplier's own code" style={inputStyle} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 8, marginBottom: 12 }}>
          <div>
            <label style={labelStyle}>Unit Price</label>
            <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Currency</label>
            <select value={currency} onChange={(e) => setCurrency(e.target.value as Currency)} style={{ ...inputStyle, appearance: "none", WebkitAppearance: "none" }}>
              {CURRENCIES.map((cc) => <option key={cc} value={cc}>{cc}</option>)}
            </select>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
          <div>
            <label style={labelStyle}>Lead Time (days)</label>
            <input inputMode="numeric" value={leadTimeDays} onChange={(e) => setLeadTimeDays(e.target.value)} placeholder="0" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>MOQ</label>
            <input inputMode="numeric" value={moq} onChange={(e) => setMoq(e.target.value)} placeholder="0" style={inputStyle} />
          </div>
        </div>

        {/* Main-supplier toggle — the backend demotes any other main for this
            material; we just send the flag. */}
        <button
          type="button"
          onClick={() => setIsMain((v) => !v)}
          style={{
            width: "100%", boxSizing: "border-box", marginBottom: 14, padding: "11px 12px", borderRadius: 10,
            border: isMain ? "1.5px solid #16695f" : "1px solid #e3e6e0",
            background: isMain ? "#e1efed" : "#fff", color: isMain ? "#0c3f39" : "#767b6e",
            fontFamily: "inherit", fontSize: 13.5, fontWeight: 700, cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "space-between",
          }}
        >
          <span>Main supplier for this material</span>
          <span aria-hidden style={{ fontSize: 15 }}>{isMain ? "★" : "☆"}</span>
        </button>

        {error && <div style={{ fontSize: 11.5, color: "#b23a3a", margin: "0 0 12px", textAlign: "center" }}>{error}</div>}

        <button className="btn" disabled={busy} onClick={() => void save()} style={{ opacity: busy ? 0.6 : 1 }}>
          {busy ? "Saving…" : editing ? "Save" : "Assign Material"}
        </button>
      </div>

      {pickerOpen && (
        <MobileSkuPicker onClose={() => setPickerOpen(false)} onPick={onPick} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SupplierBindingsSection — the editable "Assigned materials" list. Renders
// each binding as a row (name · code, price, lead/MOQ, main star) with an Edit
// tap + a Delete (in-app confirm). Falls back to a read-only list when the
// operator lacks `edit` on the SCM suppliers area.
// ---------------------------------------------------------------------------
export function SupplierBindingsSection({
  supplierId,
  bindings,
  isLoading,
  onChanged,
}: {
  supplierId: string;
  bindings: LooseBinding[];
  isLoading: boolean;
  /** Invalidate the supplier detail query after a mutation. */
  onChanged: () => void;
}) {
  const { pageAccess } = useAuth();
  const confirm = useConfirm();
  const notify = useNotify();
  const remove = useDeleteBinding();

  // Mirror the backend gate: scmAreaGuard('scm.procurement.suppliers') requires
  // `edit` for POST/PATCH/DELETE. Below that → read-only (no add/edit/delete).
  const canEdit = useMemo<boolean>(() => {
    const level = pageAccess("scm.procurement.suppliers") as AccessLevel;
    return ACCESS_RANK[level] >= ACCESS_RANK.edit;
  }, [pageAccess]);

  const [sheet, setSheet] = useState<{ mode: "add" } | { mode: "edit"; binding: LooseBinding } | null>(null);

  const del = async (b: LooseBinding) => {
    if (remove.isPending) return;
    const r = readBinding(b);
    const ok = await confirm({
      title: "Remove this material?",
      body: `Unassign ${firstOf(r.materialName, r.materialCode)} from this supplier. This can be re-added later.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    try {
      await remove.mutateAsync({ supplierId, bindingId: r.id });
      onChanged();
      void notify({ title: "Material removed" });
    } catch (e) {
      void notify({ title: "Couldn't remove", body: e instanceof Error ? e.message : String(e), tone: "error" });
    }
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "4px 2px 6px" }}>
        <div className="ey" style={{ color: "#767b6e" }}>Assigned materials</div>
        {canEdit && (
          <button
            className="tinybtn"
            onClick={() => setSheet({ mode: "add" })}
            style={{ background: "#e1efed", border: "1px solid #16695f", color: "#0c3f39" }}
          >
            + Assign
          </button>
        )}
      </div>

      <div style={{ background: "#fff", border: "1px solid #e3e6e0", borderRadius: 12, padding: "2px 12px", marginBottom: 13 }}>
        {isLoading && <div style={{ fontSize: 11.5, color: "#9aa093", padding: "9px 0" }}>Loading{"…"}</div>}
        {!isLoading && (bindings.length ? bindings.map((b, i) => {
          const r = readBinding(b);
          const hasMatrix = r.priceMatrix != null && typeof r.priceMatrix === "object" && Object.keys(r.priceMatrix as object).length > 0;
          return (
            <div
              className="docrow"
              key={r.id || i}
              onClick={canEdit ? () => setSheet({ mode: "edit", binding: b }) : undefined}
              style={{ flexWrap: "wrap", cursor: canEdit ? "pointer" : "default" }}
            >
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: "#11140f" }}>
                {r.isMainSupplier ? <span aria-hidden style={{ color: "#a16a2e", marginRight: 4 }}>★</span> : null}
                {firstOf(r.materialName, r.materialCode)}
                {r.materialCode ? <span className="money" style={{ color: "#9aa093", fontWeight: 600 }}> {"·"} {r.materialCode}</span> : null}
              </span>
              <span className="money" style={{ fontSize: 12, fontWeight: 700, color: "var(--ink-2)", flex: "none" }}>
                {hasMatrix ? "Matrix" : money(r.unitPriceCenti, r.currency)}
              </span>
              <div className="money" style={{ flexBasis: "100%", fontSize: 10.5, color: "#9aa093", display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
                {r.supplierSku ? <span>SKU {r.supplierSku}</span> : null}
                <span>Lead {r.leadTimeDays}d</span>
                <span>MOQ {r.moq}</span>
                {canEdit && (
                  <button
                    onClick={(e) => { e.stopPropagation(); void del(b); }}
                    disabled={remove.isPending}
                    style={{ marginLeft: "auto", border: "none", background: "transparent", color: "#b23a3a", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", padding: 0 }}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          );
        }) : <div style={{ fontSize: 11.5, color: "#9aa093", padding: "9px 0" }}>No materials assigned.</div>)}
      </div>

      {sheet && (
        <BindingEditSheet
          supplierId={supplierId}
          editing={sheet.mode === "edit" ? sheet.binding : null}
          onClose={() => setSheet(null)}
          onSaved={onChanged}
        />
      )}
    </>
  );
}
