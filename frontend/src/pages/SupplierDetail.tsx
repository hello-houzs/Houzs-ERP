// ----------------------------------------------------------------------------
// SupplierDetail — full-page route at /suppliers/:id.
//
// 1:1 clone of 2990s apps/backend/src/pages/SupplierDetail.tsx, scoped to the
// parts that are NOT coupled to 2990s's furniture product layer:
//   1. Header: back button + Building2 icon + code · name + status pill
//   2. Supplier Info card: view + inline edit (all master fields)
//   3. Tab strip: Overview / SKU Pricing
//   4. Overview: 3 KPI tiles (On-Time / Defect / Avg Lead) + Last 10 POs table
//   5. SKU Mappings table (+ Add SKU Mapping) with inline supplier-SKU + unit
//      price editors, the Main star toggle and per-row edit/delete.
//
// SEAM changes (the only deviations from 2990s):
//   - Data layer: 2990s lib/suppliers-queries -> the query hooks co-located in
//     Suppliers.tsx (Houzs api client + @tanstack/react-query). Identical
//     request/response shapes. (rule #7)
//   - Components: @2990s/design-system Button -> Houzs components/Button;
//     2990s DataGrid -> plain <table> rendered with the verbatim .module.css
//     classes. (rule #9)
//
// Product-layer note (Houzs has no furniture catalogue yet). DROPPED from the
// 2990s page (all furniture-coupled, see brief):
//   - Maintenance / Combo Pricing / Fabric Converter tabs (sofa/bedframe/fabric
//     surcharge config — pulled MaintenanceTab, SofaComboTab, FabricTracking).
//   - The per-category price_matrix editors (Sofa seat-height × P1/P2/P3,
//     Bedframe Price 1/2) — sofa/fabric-tier specific. The price_matrix COLUMN
//     stays in the schema; unit_price_centi is the simple price field here.
//   - The Model-first SKU picker + composeSupplierSku autofill + the
//     Product-Maintenance-shaped category grouping (queried mfg_products).
//   - The per-supplier CSV import/export (sofa-height columns).
//   The Add/Edit SKU dialog uses plain TEXT inputs for material code + name +
//   supplier SKU + a materialKind selector (the materialKind enum values).
//   TODO: wire to Houzs product source in the Products slice.
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Building2,
  Clock,
  AlertTriangle,
  CheckCircle2,
  TrendingUp,
  Package,
  Plus,
  Pencil,
  Trash2,
  Star,
  X,
  Save,
  ChevronDown,
} from "lucide-react";
import { Button } from "../components/Button";
import {
  useSupplierDetail,
  useSupplierScorecard,
  useUpdateSupplier,
  useCreateBinding,
  useUpdateBinding,
  useDeleteBinding,
  type BindingRow,
  type MaterialKind,
  type Currency,
  type SupplierRow,
  type SupplierStatus,
  type SupplierScorecard,
  type UpdateBindingMutation,
  type DeleteBindingMutation,
} from "./Suppliers";
import styles from "./SupplierDetail.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

const STATUS_CLASS: Record<SupplierStatus, string> = {
  ACTIVE: styles.statusActive ?? "",
  INACTIVE: styles.statusInactive ?? "",
  BLOCKED: styles.statusBlocked ?? "",
};

const fmtCurrency = (centi: number, currency: Currency): string => {
  const v = (centi / 100).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency === "MYR" ? `RM ${v}` : `${v} ${currency}`;
};

const fmtDate = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d
    .toLocaleDateString("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" })
    .replace(/-/g, "/");
};

const fmtRm = (centi: number): string =>
  `RM ${(centi / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type DeliveryDelta = { label: string; tone: "ok" | "late" | "neutral" };

function deliveryDelta(expected: string | null, received: string | null): DeliveryDelta {
  if (!expected || !received) return { label: "—", tone: "neutral" };
  const exp = new Date(expected).getTime();
  const rec = new Date(received).getTime();
  if (!Number.isFinite(exp) || !Number.isFinite(rec)) return { label: "—", tone: "neutral" };
  const diffDays = Math.round((rec - exp) / 86400000);
  if (diffDays <= 0) {
    return { label: diffDays === 0 ? "on time" : `${-diffDays}d early`, tone: "ok" };
  }
  return { label: `${diffDays}d late`, tone: "late" };
}

type SupplierDetailTab = "overview" | "sku-pricing";

export const SupplierDetail = () => {
  const { id } = useParams<{ id: string }>();
  const detail = useSupplierDetail(id ?? null);
  const scorecard = useSupplierScorecard(id ?? null);

  const supplier = detail.data?.supplier;
  const bindings = detail.data?.bindings ?? [];
  const score = scorecard.data;

  const [activeTab, setActiveTab] = useState<SupplierDetailTab>("overview");

  // KPI tone selection — same thresholds as 2990s / HOOKKA.
  const otrTone = useMemo(() => {
    const v = score?.onTimeRate ?? 0;
    if (v >= 90) return styles.kpiValueOk;
    if (v >= 75) return styles.kpiValueWarn;
    return styles.kpiValueBad;
  }, [score]);

  const defectTone = useMemo(() => {
    const v = score?.defectRate ?? 0;
    if (v <= 1) return styles.kpiValueOk;
    if (v <= 3) return styles.kpiValueWarn;
    return styles.kpiValueBad;
  }, [score]);

  // SKU dialog state — modal for create / edit.
  const [skuDialog, setSkuDialog] = useState<
    { mode: "closed" } | { mode: "create" } | { mode: "edit"; binding: BindingRow }
  >({ mode: "closed" });

  const [editingInfo, setEditingInfo] = useState(false);

  if (detail.isLoading) {
    return (
      <div className={styles.page}>
        <p className={styles.infoLabel}>Loading supplier…</p>
      </div>
    );
  }

  if (detail.isError || !supplier) {
    return (
      <div className={styles.page}>
        <Link to="/suppliers" className={styles.backBtn}>
          <ArrowLeft {...ICON} />
          <span>Back to Suppliers</span>
        </Link>
        <div className={styles.bannerWarn}>
          <strong>Supplier not found or failed to load.</strong>
          {detail.error instanceof Error ? ` ${detail.error.message}` : null}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/suppliers" className={styles.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>
              <Building2 size={14} strokeWidth={1.75} style={{ color: "var(--c-burnt)" }} />
              {supplier.code} — {supplier.name}
            </h1>
            <p className={styles.subtitle}>
              Supplier scorecard, SKU mappings and recent purchase order history.
            </p>
          </div>
        </div>
        <span className={`${styles.statusPill} ${STATUS_CLASS[supplier.status]}`}>
          {supplier.status}
        </span>
      </div>

      {/* ── Supplier Info ──────────────────────────────────────────── */}
      <SupplierInfoCard
        supplier={supplier}
        editing={editingInfo}
        onEdit={() => setEditingInfo(true)}
        onClose={() => setEditingInfo(false)}
      />

      {/* ── Tab strip: Overview / SKU Pricing ───────────────────────── */}
      <div
        role="tablist"
        style={{
          display: "flex",
          gap: 0,
          borderBottom: "1px solid var(--line)",
          marginTop: "var(--space-4)",
        }}
      >
        <SupplierTabButton active={activeTab === "overview"} onClick={() => setActiveTab("overview")}>
          Overview
        </SupplierTabButton>
        <SupplierTabButton
          active={activeTab === "sku-pricing"}
          onClick={() => setActiveTab("sku-pricing")}
        >
          SKU Pricing
          <span
            style={{
              marginLeft: "var(--space-2)",
              padding: "0 var(--space-2)",
              borderRadius: "var(--radius-pill)",
              background: "var(--c-paper)",
              border: "1px solid var(--line)",
              fontSize: "var(--fs-11)",
              color: "var(--fg-muted)",
            }}
          >
            {bindings.length}
          </span>
        </SupplierTabButton>
      </div>

      {activeTab === "overview" && (
        <SupplierOverviewPanel score={score} otrTone={otrTone} defectTone={defectTone} />
      )}
      {activeTab === "sku-pricing" && (
        <SupplierSkuPricingPanel id={id!} bindings={bindings} setSkuDialog={setSkuDialog} />
      )}

      {/* ── SKU dialog (modal) ──────────────────────────────────────── */}
      {skuDialog.mode === "create" && (
        <SkuFormDialog supplierId={id!} editing={null} onClose={() => setSkuDialog({ mode: "closed" })} />
      )}
      {skuDialog.mode === "edit" && (
        <SkuFormDialog
          supplierId={id!}
          editing={skuDialog.binding}
          onClose={() => setSkuDialog({ mode: "closed" })}
        />
      )}
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Tab pill + panels
   ════════════════════════════════════════════════════════════════════════ */

const SupplierTabButton = ({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) => (
  <button
    type="button"
    role="tab"
    aria-selected={active}
    onClick={onClick}
    style={{
      padding: "var(--space-3) var(--space-4)",
      background: "transparent",
      border: "none",
      borderBottom: active ? "2px solid var(--c-burnt)" : "2px solid transparent",
      color: active ? "var(--c-ink)" : "var(--fg-muted)",
      fontFamily: "var(--font-button)",
      fontSize: "var(--fs-14)",
      fontWeight: 600,
      cursor: "pointer",
      display: "inline-flex",
      alignItems: "center",
    }}
  >
    {children}
  </button>
);

const SupplierOverviewPanel = ({
  score,
  otrTone,
  defectTone,
}: {
  score: SupplierScorecard | undefined;
  otrTone: string | undefined;
  defectTone: string | undefined;
}) => {
  return (
    <>
      {/* ── KPI tiles ──────────────────────────────────────────────── */}
      <section className={styles.kpiGrid}>
        <div className={styles.kpiCard}>
          <div className={styles.kpiHead}>
            <span className={styles.kpiLabel}>On-Time Rate</span>
            <CheckCircle2 {...ICON} style={{ color: "var(--c-secondary-a, #2F5D4F)" }} />
          </div>
          <p className={`${styles.kpiValue} ${(score?.receivedPOs ?? 0) > 0 ? otrTone : ""}`}>
            {(score?.receivedPOs ?? 0) > 0 ? `${(score?.onTimeRate ?? 0).toFixed(1)}%` : "—"}
          </p>
          <p className={styles.kpiCaption}>
            {(score?.receivedPOs ?? 0) > 0
              ? `${score?.onTimeCount ?? 0} of ${score?.receivedPOs ?? 0} received POs on time`
              : "No received POs yet"}
          </p>
        </div>

        <div className={styles.kpiCard}>
          <div className={styles.kpiHead}>
            <span className={styles.kpiLabel}>Defect Rate</span>
            <AlertTriangle {...ICON} style={{ color: "var(--c-festive-b, #B8331F)" }} />
          </div>
          <p className={`${styles.kpiValue} ${(score?.receivedPOs ?? 0) > 0 ? defectTone : ""}`}>
            {(score?.receivedPOs ?? 0) > 0 ? `${(score?.defectRate ?? 0).toFixed(2)}%` : "—"}
          </p>
        </div>

        <div className={styles.kpiCard}>
          <div className={styles.kpiHead}>
            <span className={styles.kpiLabel}>Avg Lead Days</span>
            <Clock {...ICON} style={{ color: "var(--c-burnt)" }} />
          </div>
          <p className={styles.kpiValue}>
            {(score?.receivedPOs ?? 0) > 0 ? (score?.averageLeadDays ?? 0).toFixed(1) : "—"}
          </p>
        </div>
      </section>

      {/* ── Last 10 POs ───────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>
            <TrendingUp {...ICON} style={{ color: "var(--c-burnt)" }} />
            Last 10 Purchase Orders
            <span className={styles.cardTitleCount}>({score?.totalPOs ?? 0} total)</span>
          </h2>
        </header>
        <LastTenPOsTable rows={score?.last10POs ?? []} />
      </section>
    </>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   SupplierSkuPricingPanel — the SKU Mappings card. Single Unit Price column
   (2990s's DefaultSkuMappingsTable shape; the sofa/bedframe per-category
   matrix variants are furniture-specific and dropped per the product-layer
   note). Inline supplier-SKU + unit-price editors, Main star, row actions are
   ported faithfully.
   ════════════════════════════════════════════════════════════════════════ */

const SupplierSkuPricingPanel = ({
  id,
  bindings,
  setSkuDialog,
}: {
  id: string;
  bindings: BindingRow[];
  setSkuDialog: (
    s: { mode: "closed" } | { mode: "create" } | { mode: "edit"; binding: BindingRow },
  ) => void;
}) => {
  return (
    <section className={styles.card} style={{ marginTop: "var(--space-3)" }}>
      <header className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>
          <Package {...ICON} style={{ color: "var(--c-burnt)" }} />
          SKU Mappings
          <span className={styles.cardTitleCount}>
            {bindings.length === 0
              ? "(no codes yet)"
              : `(${bindings.length} ${bindings.length === 1 ? "code" : "codes"})`}
          </span>
        </h2>
        <span style={{ display: "inline-flex", gap: "var(--space-2)" }}>
          <Button variant="primary" onClick={() => setSkuDialog({ mode: "create" })}>
            <Plus {...ICON} />
            <span>Add SKU Mapping</span>
          </Button>
        </span>
      </header>
      {bindings.length === 0 ? (
        <div className={styles.cardBody}>
          <p className={styles.emptyRow}>No SKU mappings yet for this supplier.</p>
        </div>
      ) : (
        <SkuMappingsTable
          supplierId={id}
          bindings={bindings}
          onEdit={(b) => setSkuDialog({ mode: "edit", binding: b })}
        />
      )}
    </section>
  );
};

const InfoCell = ({ label, value }: { label: string; value: string }) => (
  <div className={styles.infoCell}>
    <span className={styles.infoLabel}>{label}</span>
    <span className={styles.infoValue}>{value}</span>
  </div>
);

/* ════════════════════════════════════════════════════════════════════════
   SKU Mappings table — single Unit Price column. Inline edit (supplier SKU +
   unit price), Main star toggle, per-row edit/delete. Double-click opens edit.
   ════════════════════════════════════════════════════════════════════════ */

const SkuMappingsTable = ({
  supplierId,
  bindings,
  onEdit,
}: {
  supplierId: string;
  bindings: BindingRow[];
  onEdit: (b: BindingRow) => void;
}) => {
  const update = useUpdateBinding();
  const remove = useDeleteBinding();

  return (
    <div className={styles.tableScroll}>
      <table className={`${styles.table} ${styles.tableDefault}`}>
        <thead>
          <tr>
            <th>Internal Code</th>
            <th>Internal Description</th>
            <th>Supplier SKU</th>
            <th className={styles.tableRight}>Unit Price</th>
            <th className={styles.tableRight}>Lead</th>
            <th className={styles.tableRight}>MOQ</th>
            <th>Matrix</th>
            <th>Main</th>
            <th className={styles.tableRight}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {bindings.map((b) => (
            <tr key={b.id} onDoubleClick={() => onEdit(b)}>
              <td className={styles.codeCell}>{b.material_code}</td>
              <td>{b.material_name}</td>
              <td onClick={(e) => e.stopPropagation()}>
                <InlineSupplierSku binding={b} supplierId={supplierId} update={update} />
              </td>
              <td className={styles.tableRight} onClick={(e) => e.stopPropagation()}>
                <InlineUnitPrice binding={b} supplierId={supplierId} update={update} />
              </td>
              <td className={`${styles.tableRight} ${styles.muted}`}>{b.lead_time_days}d</td>
              <td className={`${styles.tableRight} ${styles.muted}`}>{b.moq}</td>
              <td className={styles.muted}>{b.price_matrix ? "Yes" : "—"}</td>
              <td onClick={(e) => e.stopPropagation()}>
                <MainStarCell binding={b} supplierId={supplierId} update={update} />
              </td>
              <td className={styles.tableRight} onClick={(e) => e.stopPropagation()}>
                <RowActionsCell binding={b} supplierId={supplierId} remove={remove} onEdit={onEdit} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const MainStarCell = ({
  binding,
  supplierId,
  update,
}: {
  binding: BindingRow;
  supplierId: string;
  update: UpdateBindingMutation;
}) => (
  <span className={styles.actionsCell} style={{ justifyContent: "flex-start" }}>
    <button
      type="button"
      className={styles.iconBtn}
      title={binding.is_main_supplier ? "Main supplier" : "Set as main"}
      onClick={(e) => {
        e.stopPropagation();
        update.mutate({
          supplierId,
          bindingId: binding.id,
          isMainSupplier: !binding.is_main_supplier,
        });
      }}
    >
      <Star
        size={16}
        strokeWidth={1.75}
        fill={binding.is_main_supplier ? "currentColor" : "none"}
        style={{ color: binding.is_main_supplier ? "var(--c-burnt)" : "var(--fg-muted)" }}
      />
    </button>
    {binding.is_main_supplier && <span className={styles.mainPill}>Main</span>}
  </span>
);

const RowActionsCell = ({
  binding,
  supplierId,
  remove,
  onEdit,
}: {
  binding: BindingRow;
  supplierId: string;
  remove: DeleteBindingMutation;
  onEdit: (b: BindingRow) => void;
}) => (
  <span className={styles.actionsCell}>
    <button
      type="button"
      className={styles.iconBtn}
      title="Edit"
      onClick={(e) => {
        e.stopPropagation();
        onEdit(binding);
      }}
    >
      <Pencil {...SM_ICON} />
    </button>
    <button
      type="button"
      className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
      title="Delete"
      onClick={(e) => {
        e.stopPropagation();
        if (confirm(`Remove mapping ${binding.material_code} → ${binding.supplier_sku}?`)) {
          remove.mutate({ supplierId, bindingId: binding.id });
        }
      }}
    >
      <Trash2 {...SM_ICON} />
    </button>
  </span>
);

/* ════════════════════════════════════════════════════════════════════════
   Inline editors — supplier_sku + unit_price cells (2990s pattern: local draft,
   blur or Enter to commit via useUpdateBinding, Escape to revert).
   ════════════════════════════════════════════════════════════════════════ */

const InlineSupplierSku = ({
  binding,
  supplierId,
  update,
}: {
  binding: BindingRow;
  supplierId: string;
  update: UpdateBindingMutation;
}) => {
  const [draft, setDraft] = useState(binding.supplier_sku);
  // Re-sync if the server cache returns a new value while mounted.
  const [committed, setCommitted] = useState(binding.supplier_sku);
  if (committed !== binding.supplier_sku) {
    setCommitted(binding.supplier_sku);
    setDraft(binding.supplier_sku);
  }
  const commit = () => {
    const next = draft.trim();
    if (next === binding.supplier_sku) return;
    if (!next) {
      setDraft(binding.supplier_sku);
      return;
    }
    update.mutate({ supplierId, bindingId: binding.id, supplierSku: next });
  };
  return (
    <input
      className={styles.inlineSku}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === "Escape") {
          setDraft(binding.supplier_sku);
          (e.target as HTMLInputElement).blur();
        }
      }}
      title="Click to edit · Enter to save · Esc to cancel"
    />
  );
};

const InlineUnitPrice = ({
  binding,
  supplierId,
  update,
}: {
  binding: BindingRow;
  supplierId: string;
  update: UpdateBindingMutation;
}) => {
  // 2990s used a shared MoneyInput (free typing in RM, commits centi). Houzs
  // has no MoneyInput in this slice — inline a minimal RM editor with the same
  // commit ergonomics (rule #9). Stores centi via unitPriceCenti.
  const toRm = (centi: number) => (centi ? (centi / 100).toFixed(2) : "");
  const [draft, setDraft] = useState(toRm(binding.unit_price_centi));
  const [committed, setCommitted] = useState(binding.unit_price_centi);
  if (committed !== binding.unit_price_centi) {
    setCommitted(binding.unit_price_centi);
    setDraft(toRm(binding.unit_price_centi));
  }
  const commit = () => {
    const t = draft.trim();
    const n = t === "" ? 0 : Number(t);
    const next = Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : binding.unit_price_centi;
    if (next === binding.unit_price_centi) {
      setDraft(toRm(binding.unit_price_centi));
      return;
    }
    update.mutate({ supplierId, bindingId: binding.id, unitPriceCenti: next });
  };
  return (
    <span className={styles.matrixCell}>
      <span className={styles.matrixCurrency}>
        {binding.currency === "MYR" ? "RM" : binding.currency}
      </span>
      <input
        className={styles.inlinePrice}
        value={draft}
        inputMode="decimal"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === "Escape") {
            setDraft(toRm(binding.unit_price_centi));
            (e.target as HTMLInputElement).blur();
          }
        }}
        title="Click to edit · Enter to save · Esc to cancel"
      />
    </span>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Last 10 POs table
   ════════════════════════════════════════════════════════════════════════ */

type LastPo = {
  id: string;
  poNo: string;
  status: string;
  poDate: string;
  expectedDate: string | null;
  receivedDate: string | null;
  totalCenti: number;
  orderedQty: number;
  receivedQty: number;
};

const LastTenPOsTable = ({ rows }: { rows: LastPo[] }) => {
  if (rows.length === 0) {
    return (
      <div className={styles.cardBody}>
        <p className={styles.emptyRow}>No purchase orders found for this supplier.</p>
      </div>
    );
  }

  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>PO No.</th>
          <th>Status</th>
          <th className={styles.tableRight}>Ordered</th>
          <th className={styles.tableRight}>Received</th>
          <th className={styles.tableRight}>Total</th>
          <th>Expected</th>
          <th>Actual</th>
          <th>Delta</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((po) => {
          const delta = deliveryDelta(po.expectedDate, po.receivedDate);
          return (
            <tr key={po.id}>
              <td className={styles.codeCell}>{po.poNo}</td>
              <td className={styles.muted}>{po.status}</td>
              <td className={`${styles.tableRight} ${styles.muted}`}>{po.orderedQty}</td>
              <td className={`${styles.tableRight} ${styles.muted}`}>{po.receivedQty}</td>
              <td className={styles.priceCell}>{fmtRm(po.totalCenti)}</td>
              <td className={styles.muted}>{fmtDate(po.expectedDate)}</td>
              <td className={styles.muted}>{fmtDate(po.receivedDate)}</td>
              <td>
                <span
                  className={
                    delta.tone === "ok"
                      ? styles.deltaOk
                      : delta.tone === "late"
                        ? styles.deltaLate
                        : styles.deltaNeutral
                  }
                >
                  {delta.label}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   SKU form modal — create or edit a supplier_material_binding.

   Ported from 2990s SkuFormDialog, minus the mfg_products auto-bind autofill
   (composeSupplierSku) — Houzs has no product catalogue, so material code,
   description and supplier SKU are plain text inputs and materialKind is the
   enum selector (product-layer note).
   ════════════════════════════════════════════════════════════════════════ */

type SkuDraft = {
  materialKind: MaterialKind;
  materialCode: string;
  materialName: string;
  supplierSku: string;
  unitPriceCenti: number;
  currency: Currency;
  leadTimeDays: number;
  moq: number;
  isMainSupplier: boolean;
};

const SkuFormDialog = ({
  supplierId,
  editing,
  onClose,
}: {
  supplierId: string;
  editing: BindingRow | null;
  onClose: () => void;
}) => {
  const create = useCreateBinding();
  const update = useUpdateBinding();

  const [draft, setDraft] = useState<SkuDraft>(() =>
    editing
      ? {
          materialKind: editing.material_kind,
          materialCode: editing.material_code,
          materialName: editing.material_name,
          supplierSku: editing.supplier_sku,
          unitPriceCenti: editing.unit_price_centi,
          currency: editing.currency,
          leadTimeDays: editing.lead_time_days,
          moq: editing.moq,
          isMainSupplier: editing.is_main_supplier,
        }
      : {
          materialKind: "mfg_product",
          materialCode: "",
          materialName: "",
          supplierSku: "",
          unitPriceCenti: 0,
          currency: "MYR",
          leadTimeDays: 0,
          moq: 0,
          isMainSupplier: false,
        },
  );

  const submit = () => {
    if (!draft.materialCode.trim() || !draft.materialName.trim() || !draft.supplierSku.trim()) {
      alert("Internal code, description and supplier SKU are required.");
      return;
    }
    if (editing) {
      update.mutate({ supplierId, bindingId: editing.id, ...draft }, { onSuccess: onClose });
    } else {
      create.mutate({ supplierId, ...draft }, { onSuccess: onClose });
    }
  };

  const set = <K extends keyof SkuDraft>(k: K, v: SkuDraft[K]) =>
    setDraft((s) => ({ ...s, [k]: v }));

  const pending = create.isPending || update.isPending;

  // Unit price editor — minimal RM <-> centi (no MoneyInput in this slice).
  const priceRm = draft.unitPriceCenti ? (draft.unitPriceCenti / 100).toFixed(2) : "";

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <header className={styles.modalHeader}>
          <h3 className={styles.modalTitle}>{editing ? "Edit SKU Mapping" : "Add SKU Mapping"}</h3>
          <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Close">
            <X {...ICON} />
          </button>
        </header>

        <div className={styles.modalBody}>
          <div className={styles.formGrid}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Material Kind</span>
              <span className={styles.selectWrap}>
                <select
                  className={styles.fieldSelect}
                  value={draft.materialKind}
                  onChange={(e) => set("materialKind", e.target.value as MaterialKind)}
                >
                  <option value="mfg_product">Manufacturing SKU</option>
                  <option value="fabric">Fabric</option>
                  <option value="raw">Raw material</option>
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Currency</span>
              <span className={styles.selectWrap}>
                <select
                  className={styles.fieldSelect}
                  value={draft.currency}
                  onChange={(e) => set("currency", e.target.value as Currency)}
                >
                  <option>MYR</option>
                  <option>RMB</option>
                  <option>USD</option>
                  <option>SGD</option>
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Our Internal Code *</span>
              <input
                className={styles.fieldInput}
                placeholder="e.g. 1003-(K), AVANI 01"
                value={draft.materialCode}
                onChange={(e) => set("materialCode", e.target.value)}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Supplier SKU *</span>
              <input
                className={styles.fieldInput}
                placeholder="Their code"
                value={draft.supplierSku}
                onChange={(e) => set("supplierSku", e.target.value)}
              />
            </label>

            <label className={`${styles.field} ${styles.formGridFull}`}>
              <span className={styles.fieldLabel}>Internal Description *</span>
              <input
                className={styles.fieldInput}
                placeholder="e.g. HILTON BEDFRAME (6FT)"
                value={draft.materialName}
                onChange={(e) => set("materialName", e.target.value)}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Unit Price ({draft.currency})</span>
              <input
                className={styles.fieldInput}
                inputMode="decimal"
                placeholder="0.00"
                defaultValue={priceRm}
                onBlur={(e) => {
                  const t = e.target.value.trim();
                  const n = t === "" ? 0 : Number(t);
                  set("unitPriceCenti", Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0);
                }}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Lead Time (days)</span>
              <input
                type="number"
                className={styles.fieldInput}
                value={draft.leadTimeDays}
                onChange={(e) => set("leadTimeDays", Number(e.target.value) || 0)}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>MOQ</span>
              <input
                type="number"
                className={styles.fieldInput}
                value={draft.moq}
                onChange={(e) => set("moq", Number(e.target.value) || 0)}
              />
            </label>

            <div className={`${styles.field} ${styles.formGridFull}`}>
              <label className={styles.checkRow}>
                <input
                  type="checkbox"
                  checked={draft.isMainSupplier}
                  onChange={(e) => set("isMainSupplier", e.target.checked)}
                />
                <span className={styles.fieldLabel} style={{ margin: 0 }}>
                  Set as MAIN supplier for this material
                </span>
              </label>
            </div>
          </div>
        </div>

        <footer className={styles.modalFooter}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={pending}>
            {pending ? "Saving…" : editing ? "Save Changes" : "Add Mapping"}
          </Button>
        </footer>
      </div>
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Supplier Info card with inline edit (all fields). Ported from 2990s, minus
   the furniture SupplyCategoryPicker (-> plain text), PhoneInput (-> plain
   text) and the Country/State/PaymentTerms localities cascades (-> plain text).
   ════════════════════════════════════════════════════════════════════════ */

const SupplierInfoCard = ({
  supplier,
  editing,
  onEdit,
  onClose,
}: {
  supplier: SupplierRow;
  editing: boolean;
  onEdit: () => void;
  onClose: () => void;
}) => {
  const update = useUpdateSupplier();
  const [form, setForm] = useState({
    code: supplier.code,
    name: supplier.name,
    supplierType: supplier.supplier_type ?? "",
    category: supplier.category ?? "",
    tinNumber: supplier.tin_number ?? "",
    businessRegNo: supplier.business_reg_no ?? "",
    contactPerson: supplier.contact_person ?? "",
    attention: supplier.attention ?? "",
    email: supplier.email ?? "",
    phone: supplier.phone ?? "",
    mobile: supplier.mobile ?? "",
    fax: supplier.fax ?? "",
    website: supplier.website ?? "",
    whatsappNumber: supplier.whatsapp_number ?? "",
    paymentTerms: supplier.payment_terms ?? "",
    address: supplier.address ?? "",
    postcode: supplier.postcode ?? "",
    area: supplier.area ?? "",
    state: supplier.state ?? "",
    country: supplier.country ?? "Malaysia",
    businessNature: supplier.business_nature ?? "",
    notes: supplier.notes ?? "",
  });

  const setF = (k: keyof typeof form, v: string) => setForm((s) => ({ ...s, [k]: v }));

  const save = () => {
    update.mutate({ id: supplier.id, ...form } as Partial<SupplierRow> & { id: string }, {
      onSuccess: onClose,
      // Never fail silently (2990s Commander 2026-06-16): surface the real error.
      onError: (err) =>
        window.alert(`Save failed: ${err instanceof Error ? err.message : String(err)}`),
    });
  };

  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Supplier Info</h2>
        <span style={{ display: "inline-flex", gap: "var(--space-2)" }}>
          {!editing ? (
            <Button variant="ghost" onClick={onEdit}>
              <Pencil {...ICON} />
              <span>Edit</span>
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" onClick={save} disabled={update.isPending}>
                <Save {...ICON} />
                <span>{update.isPending ? "Saving…" : "Save"}</span>
              </Button>
            </>
          )}
        </span>
      </header>
      <div className={styles.cardBody}>
        {!editing ? (
          <div className={styles.infoGrid}>
            <InfoCell label="Credit Account" value={supplier.code} />
            <InfoCell label="Company Name" value={supplier.name} />
            <InfoCell label="Supplier Type" value={supplier.supplier_type ?? "—"} />
            <InfoCell label="Supply Category" value={supplier.category || "—"} />
            <InfoCell label="TIN Number" value={supplier.tin_number ?? "—"} />
            <InfoCell label="Business Reg No" value={supplier.business_reg_no ?? "—"} />
            <InfoCell label="Contact Person" value={supplier.contact_person ?? "—"} />
            <InfoCell label="Attention" value={supplier.attention ?? "—"} />
            <InfoCell label="Email" value={supplier.email ?? "—"} />
            <InfoCell label="Phone" value={supplier.phone ?? "—"} />
            <InfoCell label="Mobile" value={supplier.mobile ?? "—"} />
            <InfoCell label="Fax" value={supplier.fax ?? "—"} />
            <InfoCell label="WhatsApp" value={supplier.whatsapp_number ?? "—"} />
            <InfoCell label="Website" value={supplier.website ?? "—"} />
            <InfoCell label="Payment Terms" value={supplier.payment_terms ?? "—"} />
            <InfoCell label="Currency" value={supplier.currency} />
            <InfoCell label="Country" value={supplier.country ?? "Malaysia"} />
            <InfoCell label="State" value={supplier.state ?? "—"} />
            <InfoCell label="Postcode" value={supplier.postcode ?? "—"} />
            <InfoCell label="Area" value={supplier.area ?? "—"} />
            <InfoCell label="Business Nature" value={supplier.business_nature ?? "—"} />
            {supplier.address && (
              <div className={`${styles.infoCell} ${styles.infoCellFull}`}>
                <span className={styles.infoLabel}>Billing Address</span>
                <span className={styles.infoValue}>{supplier.address}</span>
              </div>
            )}
            {supplier.notes && (
              <div className={`${styles.infoCell} ${styles.infoCellFull}`}>
                <span className={styles.infoLabel}>Notes</span>
                <span className={styles.infoValue}>{supplier.notes}</span>
              </div>
            )}
          </div>
        ) : (
          <div className={styles.formGrid}>
            {/* Identity */}
            <EditField label="Credit Account *" value={form.code} onChange={(v) => setF("code", v)} />
            <EditField label="Company Name *" value={form.name} onChange={(v) => setF("name", v)} />
            <EditField label="Supplier Type" value={form.supplierType} onChange={(v) => setF("supplierType", v)} placeholder="Matrix / Distributor / Maker" />
            {/* Product-layer note: plain text (2990s used the furniture pool picker). */}
            <EditField label="Supply Category" value={form.category} onChange={(v) => setF("category", v)} />
            <EditField label="TIN Number" value={form.tinNumber} onChange={(v) => setF("tinNumber", v)} />
            <EditField label="Business Reg No" value={form.businessRegNo} onChange={(v) => setF("businessRegNo", v)} />
            {/* Contact */}
            <EditField label="Contact Person" value={form.contactPerson} onChange={(v) => setF("contactPerson", v)} />
            <EditField label="Attention" value={form.attention} onChange={(v) => setF("attention", v)} />
            <EditField label="Email" value={form.email} onChange={(v) => setF("email", v)} />
            {/* Product-layer note: phone fields plain text (2990s used PhoneInput E.164). */}
            <EditField label="Phone" value={form.phone} onChange={(v) => setF("phone", v)} />
            <EditField label="Mobile" value={form.mobile} onChange={(v) => setF("mobile", v)} />
            <EditField label="Fax" value={form.fax} onChange={(v) => setF("fax", v)} />
            <EditField label="WhatsApp" value={form.whatsappNumber} onChange={(v) => setF("whatsappNumber", v)} />
            <EditField label="Website" value={form.website} onChange={(v) => setF("website", v)} />
            {/* Commercial */}
            <EditField label="Payment Terms" value={form.paymentTerms} onChange={(v) => setF("paymentTerms", v)} />
            <EditField label="Business Nature" value={form.businessNature} onChange={(v) => setF("businessNature", v)} />
            {/* Address — plain text (2990s used Country/State localities cascade). */}
            <EditField label="Country" value={form.country} onChange={(v) => setF("country", v)} />
            <EditField label="State" value={form.state} onChange={(v) => setF("state", v)} />
            <EditField label="Area" value={form.area} onChange={(v) => setF("area", v)} />
            <EditField label="Postcode" value={form.postcode} onChange={(v) => setF("postcode", v)} />
            <EditField label="Billing Address" value={form.address} onChange={(v) => setF("address", v)} multiline />
            <EditField label="Notes" value={form.notes} onChange={(v) => setF("notes", v)} multiline />
          </div>
        )}
      </div>
    </section>
  );
};

const EditField = ({
  label,
  value,
  onChange,
  multiline,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  placeholder?: string;
}) => (
  <label className={`${styles.field} ${multiline ? styles.formGridFull : ""}`}>
    <span className={styles.fieldLabel}>{label}</span>
    {multiline ? (
      <textarea
        className={styles.fieldInput}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ minHeight: 60, resize: "vertical" }}
      />
    ) : (
      <input
        className={styles.fieldInput}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    )}
  </label>
);
