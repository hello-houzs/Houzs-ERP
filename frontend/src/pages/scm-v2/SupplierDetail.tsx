// ----------------------------------------------------------------------------
// SupplierDetail — full-page route at /suppliers/:id.
//
// HOOKKA-fidelity port (see hookka-erp/src/pages/suppliers/detail.tsx):
//   1. Header: back button + Building2 icon + code · name + status pill
//   2. Supplier Info card: Contact / Email / Phone / Payment terms / Address
//   3. 3 KPI tiles: On-Time Rate (%) / Defect Rate (%) / Avg Lead Days
//        - tone classes: green ≥90 / amber ≥75 / red below (only for OTR + DR)
//   4. SKU Mappings table with "+ Add SKU Mapping" button + edit / delete
//      icons per row. Double-click row to edit. Star toggles main supplier.
//   5. Last 10 POs table: PO no, status, ordered/received qty, total,
//      expected vs actual delivery, delta chip (on-time / N d late / early).
//
// Wires:
//   GET  /suppliers/:id              → supplier + bindings
//   GET  /suppliers/:id/scorecard    → KPIs + last10POs
//   POST /suppliers/:id/bindings     → add SKU mapping
//   PATCH /suppliers/:id/bindings/:bindingId → edit + toggle main
//   DELETE /suppliers/:id/bindings/:bindingId
// ----------------------------------------------------------------------------

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft, Building2, Clock, AlertTriangle, CheckCircle2,
  TrendingUp, Package, Plus, Pencil, Trash2, Star, X, Save, Search,
  Tag, ChevronDown, ChevronRight, Download, Upload, Anchor,
} from 'lucide-react';
// Products wave un-stubbed these: the REAL MaintenanceTab (+ MaintenanceSection)
// is exported from the vendored Products page, and the REAL supplier-scoped
// SofaComboTab from the vendored components. (Was ./SupplierDetailStubs.)
import { MaintenanceTab, type MaintenanceSection } from './Products';
import { SofaComboTab } from '../../vendor/scm/components/SofaComboTab';
import { FabricTracking } from './FabricTracking';
import { Button } from '@2990s/design-system';
import {
  useSupplierDetail,
  useSupplierScorecard,
  useUpdateSupplier,
  useCreateBinding,
  useCreateBindingsBatch,
  useUpdateBinding,
  useDeleteBinding,
  useSetCostAnchor,
  type BindingRow,
  type MaterialKind,
  type Currency,
  type SupplierRow,
  type SupplierStatus,
  type NewBinding,
  type PriceMatrix,
  type SofaPriceMatrix,
  type BedframePriceMatrix,
} from '../../vendor/scm/lib/suppliers-queries';
import { useMfgProducts, useMaintenanceConfig, type MfgCategory, type MfgProductRow } from '../../vendor/scm/lib/mfg-products-queries';
import { useProductModels, type ProductModelRow } from '../../vendor/scm/lib/product-models-queries';
import {
  useLocalities,
  distinctStates,
  COUNTRIES,
  PAYMENT_TERMS_OPTIONS,
} from '../../vendor/scm/lib/localities-queries';
import { composeSupplierSku, looksAmbiguous } from '../../vendor/scm/lib/supplier-sku-helpers';
import { parseSupplierCategories, displaySupplierCategories } from '../../vendor/scm/lib/supplier-categories';
import { SupplyCategoryPicker, useSupplierCategoryPool } from '../../vendor/scm/components/SupplyCategoryPicker';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { formatPhone } from '@2990s/shared/phone';
import { maintValues } from '@2990s/shared';
import { PhoneInput } from '../../vendor/scm/components/PhoneInput';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import styles from './SupplierDetail.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;
const LG_ICON = { size: 20, strokeWidth: 1.75 } as const;

const STATUS_CLASS: Record<SupplierStatus, string> = {
  ACTIVE: styles.statusActive ?? '',
  INACTIVE: styles.statusInactive ?? '',
  BLOCKED: styles.statusBlocked ?? '',
};

const fmtCurrency = (centi: number, currency: Currency): string => {
  const v = (centi / 100).toLocaleString('en-MY', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency === 'MYR' ? `RM ${v}` : `${v} ${currency}`;
};

const fmtDate = (iso: string | null): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit' });
};

const fmtRm = (centi: number): string =>
  `RM ${(centi / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/* ────────────────────────────────────────────────────────────────────────
   usePersistedOpen — collapsible-panel state persisted per panel in
   localStorage. '1' = open, '0' = collapsed; absent = defaultOpen.
   Used by the Supplier Info card, the SKU Mappings card and each per-
   category SKU group so commander's collapse choices survive reloads.
   ──────────────────────────────────────────────────────────────────────── */
function usePersistedOpen(storageKey: string, defaultOpen = true): [boolean, () => void] {
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return defaultOpen;
    try {
      const raw = window.localStorage.getItem(storageKey);
      return raw == null ? defaultOpen : raw === '1';
    } catch { return defaultOpen; }
  });
  const toggle = useCallback(() => {
    setOpen((v) => {
      try { window.localStorage.setItem(storageKey, v ? '0' : '1'); } catch { /* quota */ }
      return !v;
    });
  }, [storageKey]);
  return [open, toggle];
}

type DeliveryDelta = { label: string; tone: 'ok' | 'late' | 'neutral' };

function deliveryDelta(expected: string | null, received: string | null): DeliveryDelta {
  if (!expected || !received) return { label: '—', tone: 'neutral' };
  const exp = new Date(expected).getTime();
  const rec = new Date(received).getTime();
  if (!Number.isFinite(exp) || !Number.isFinite(rec)) return { label: '—', tone: 'neutral' };
  const diffDays = Math.round((rec - exp) / 86400000);
  if (diffDays <= 0) {
    return { label: diffDays === 0 ? 'on time' : `${-diffDays}d early`, tone: 'ok' };
  }
  return { label: `${diffDays}d late`, tone: 'late' };
}

/* ════════════════════════════════════════════════════════════════════════
   PR #208 — Supplier category + per-supplier maintenance config.

   `SupplierCategory` is the canonical set commander asked for: SOFA /
   BEDFRAME / MATTRESS / ACCESSORY / SERVICE / MIXED. The MIXED slot covers
   fabric / hardware / multi-category resellers — surfaces every Maintenance
   tab so commander can edit any surcharge that might apply.

   `MAINTENANCE_SECTIONS_FOR_CATEGORY` filters the Pricing tab's left rail.
   Sofa supplier → Sofa + Common (Fabrics). Bedframe supplier → Bedframe +
   Common. Mattress supplier → Products Maintenance only (size pool). Etc.
   ════════════════════════════════════════════════════════════════════════ */

const SUPPLIER_CATEGORIES = ['SOFA', 'BEDFRAME', 'MATTRESS', 'ACCESSORY', 'SERVICE', 'MIXED'] as const;
type SupplierCategory = typeof SUPPLIER_CATEGORIES[number];

const SUPPLIER_CATEGORY_LABEL: Record<SupplierCategory, string> = {
  SOFA:      'Sofa',
  BEDFRAME:  'Bedframe',
  MATTRESS:  'Mattress',
  ACCESSORY: 'Accessory',
  SERVICE:   'Service',
  MIXED:     'Mixed / Other',
};

const isSupplierCategory = (v: string | null | undefined): v is SupplierCategory =>
  typeof v === 'string' && (SUPPLIER_CATEGORIES as readonly string[]).includes(v);

/** Owner spec 2026-06-12 — suppliers.category is now a comma-joined Supply
 *  Category list ("Sofa, Bedframe"). Derive the single canonical gating
 *  category for the Pricing/Combo/Fabric tab filters:
 *    • exactly ONE value that matches a canonical category (any casing,
 *      legacy uppercase 'SOFA' included) → that category;
 *    • two or more values → 'MIXED' (every section surfaces);
 *    • one unknown value → 'MIXED';
 *    • empty/null → null (default behaviour, everything shows). */
function deriveGatingCategory(text: string | null | undefined): SupplierCategory | null {
  const list = parseSupplierCategories(text);
  if (list.length === 0) return null;
  if (list.length >= 2) return 'MIXED';
  const up = list[0]!.toUpperCase();
  return isSupplierCategory(up) ? up : 'MIXED';
}

/** Section allow-list per supplier category. Returns undefined when the
 *  category is MIXED or null — show every section (default behaviour). */
function maintenanceSectionsForCategory(
  cat: SupplierCategory | null,
): MaintenanceSection[] | undefined {
  if (!cat || cat === 'MIXED') return undefined;
  switch (cat) {
    case 'BEDFRAME':  return ['Bedframe', 'Common', 'Products Maintenance'];
    case 'SOFA':      return ['Sofa', 'Common', 'Products Maintenance'];
    case 'MATTRESS':  return ['Common', 'Products Maintenance'];
    case 'ACCESSORY': return ['Products Maintenance'];
    case 'SERVICE':   return ['Common'];
    default:          return undefined;
  }
}

/** MfgCategory mapping for the Model picker filter — sofa Models hidden
 *  from bedframe suppliers, etc. MIXED returns null (no filter). */
function mfgCategoryFromSupplierCategory(
  cat: SupplierCategory | null,
): MfgCategory | null {
  if (!cat || cat === 'MIXED') return null;
  switch (cat) {
    case 'BEDFRAME':  return 'BEDFRAME';
    case 'SOFA':      return 'SOFA';
    case 'MATTRESS':  return 'MATTRESS';
    case 'ACCESSORY': return 'ACCESSORY';
    case 'SERVICE':   return 'SERVICE';
    default:          return null;
  }
}

type SupplierDetailTab = 'overview' | 'sku-pricing' | 'maintenance' | 'combos' | 'fabric';

export const SupplierDetail = () => {
  const { id } = useParams<{ id: string }>();
  const detail = useSupplierDetail(id ?? null);
  const scorecard = useSupplierScorecard(id ?? null);

  const supplier = detail.data?.supplier;
  const bindings = detail.data?.bindings ?? [];
  const score = scorecard.data;

  // Top-level tabs on the SupplierDetail page:
  //   Overview      — KPIs + recent PO history (the supplier scorecard).
  //   SKU Pricing   — the supplier's SKU mappings + per-SKU price matrix.
  //   Maintenance   — supplier-scoped MaintenanceTab (surcharges), same UI as
  //                   Products, filtered by the supplier's category.
  //   Combo Pricing — supplier-scoped Sofa Combo deals (feeds PO auto-pricing
  //                   in a later phase).
  const [activeTab, setActiveTab] = useState<SupplierDetailTab>('overview');
  const supplierCategory: SupplierCategory | null = deriveGatingCategory(supplier?.category);
  /* Commander 2026-05-29 — surface the Products config tabs on the supplier,
     scoped to what the supplier actually supplies:
       • Combo Pricing  → SOFA suppliers (sofa module-set deals)
       • Fabric Converter → SOFA + BEDFRAME (fabric/colour pool)
     MIXED / unknown shows both. (Maintenance is the existing Pricing tab.) */
  const showCombo  = supplierCategory == null || supplierCategory === 'SOFA' || supplierCategory === 'MIXED';
  const showFabric = supplierCategory == null || supplierCategory === 'SOFA' || supplierCategory === 'BEDFRAME' || supplierCategory === 'MIXED';

  // KPI tone selection — same thresholds as HOOKKA.
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
  //   'closed'      — nothing open
  //   'multi'       — multi-select picker from Products (batch-add bindings)
  //   'edit:row'    — edit one existing binding
  const [skuDialog, setSkuDialog] = useState<
    { mode: 'closed' } | { mode: 'multi' } | { mode: 'edit'; binding: BindingRow }
  >({ mode: 'closed' });

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
        <Link to="/scm/suppliers" className={styles.backBtn}>
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
          <Link to="/scm/suppliers" className={styles.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>
              {/* PR — Commander 2026-05-27: shrink from LG_ICON (20px) → 14px
                  to balance the fs-15 title. */}
              <Building2 size={14} strokeWidth={1.75} style={{ color: 'var(--c-burnt)' }} />
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

      {/* ── Tab strip: Overview / SKU Pricing / Maintenance / Combo ── */}
      <div
        role="tablist"
        style={{
          display: 'flex',
          gap: 0,
          borderBottom: '1px solid var(--line)',
          marginTop: 'var(--space-4)',
        }}
      >
        <SupplierTabButton
          active={activeTab === 'overview'}
          onClick={() => setActiveTab('overview')}
        >
          Overview
        </SupplierTabButton>
        <SupplierTabButton
          active={activeTab === 'sku-pricing'}
          onClick={() => setActiveTab('sku-pricing')}
        >
          SKU Pricing
          <span
            style={{
              marginLeft: 'var(--space-2)',
              padding: '0 var(--space-2)',
              borderRadius: 'var(--radius-pill)',
              background: 'var(--c-paper)',
              border: '1px solid var(--line)',
              fontSize: 'var(--fs-11)',
              color: 'var(--fg-muted)',
            }}
          >
            {bindings.length}
          </span>
        </SupplierTabButton>
        <SupplierTabButton
          active={activeTab === 'maintenance'}
          onClick={() => setActiveTab('maintenance')}
        >
          Maintenance
          {supplierCategory && (
            <span
              style={{
                marginLeft: 'var(--space-2)',
                padding: '0 var(--space-2)',
                borderRadius: 'var(--radius-pill)',
                background: 'var(--c-paper)',
                border: '1px solid var(--line)',
                fontSize: 'var(--fs-11)',
                color: 'var(--fg-muted)',
              }}
            >
              {SUPPLIER_CATEGORY_LABEL[supplierCategory]}
            </span>
          )}
        </SupplierTabButton>
        {showCombo && (
          <SupplierTabButton
            active={activeTab === 'combos'}
            onClick={() => setActiveTab('combos')}
          >
            Combo Pricing
          </SupplierTabButton>
        )}
        {/* Commander 2026-05-29 — Fabric Converter tab ported from PR #312.
            Gated to SOFA / BEDFRAME / MIXED suppliers (showFabric), since the
            fabric master only drives sofa + bedframe pricing. */}
        {showFabric && (
          <SupplierTabButton
            active={activeTab === 'fabric'}
            onClick={() => setActiveTab('fabric')}
          >
            Fabric Converter
          </SupplierTabButton>
        )}
      </div>

      {activeTab === 'overview' && (
        <SupplierOverviewPanel
          score={score}
          otrTone={otrTone}
          defectTone={defectTone}
        />
      )}
      {activeTab === 'sku-pricing' && (
        <SupplierSkuPricingPanel
          id={id!}
          supplierCode={supplier.code}
          bindings={bindings}
          setSkuDialog={setSkuDialog}
        />
      )}
      {activeTab === 'maintenance' && (
        <SupplierPricingPanel
          supplierId={id!}
          supplierName={supplier.name}
          supplierCategory={supplierCategory}
        />
      )}
      {activeTab === 'combos' && showCombo && (
        <section className={styles.card} style={{ marginTop: 'var(--space-3)' }}>
          <header className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>
              <Tag {...ICON} style={{ color: 'var(--c-burnt)' }} />
              Combo Pricing · {supplier.name}
            </h2>
          </header>
          <div className={styles.cardBody}>
            <SofaComboTab supplierId={id!} />
          </div>
        </section>
      )}
      {/* Commander 2026-05-29 — Fabric Converter render case from PR #312.
          FabricTracking renders its own page header, so mount it bare (no
          card wrapper) to avoid a doubled "Fabric Converter" title. */}
      {activeTab === 'fabric' && showFabric && <FabricTracking />}

      {/* ── SKU dialogs (modals) ──────────────────────────────────── */}
      {skuDialog.mode === 'multi' && (
        <ModelSkuPickerDialog
          supplierId={id!}
          existingBindings={bindings}
          supplierCategory={supplierCategory}
          onClose={() => setSkuDialog({ mode: 'closed' })}
        />
      )}
      {skuDialog.mode === 'edit' && (
        <SkuFormDialog
          supplierId={id!}
          editing={skuDialog.binding}
          onClose={() => setSkuDialog({ mode: 'closed' })}
        />
      )}
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Tab pill + the four SupplierDetail panels.

   Overview     — KPI tiles + recent PO history (the supplier scorecard).
   SKU Pricing  — SKU mappings + per-SKU price matrix (SupplierSkuPricingPanel).
   Maintenance  — shared MaintenanceTab (surcharges) scoped to this supplier,
                  with a section allow-list derived from the category.
   Combo Pricing — supplier-scoped Sofa Combo deals (SofaComboTab), feeding PO
                  auto-pricing in a later phase.
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
      padding: 'var(--space-3) var(--space-4)',
      background: 'transparent',
      border: 'none',
      borderBottom: active ? '2px solid var(--c-burnt)' : '2px solid transparent',
      color: active ? 'var(--c-ink)' : 'var(--fg-muted)',
      fontFamily: 'var(--font-button)',
      fontSize: 'var(--fs-14)',
      fontWeight: 600,
      cursor: 'pointer',
      display: 'inline-flex',
      alignItems: 'center',
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
  score: ReturnType<typeof useSupplierScorecard>['data'];
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
            <CheckCircle2 {...ICON} style={{ color: 'var(--c-secondary-a, #2F5D4F)' }} />
          </div>
          <p className={`${styles.kpiValue} ${(score?.receivedPOs ?? 0) > 0 ? otrTone : ''}`}>
            {(score?.receivedPOs ?? 0) > 0 ? `${(score?.onTimeRate ?? 0).toFixed(1)}%` : '—'}
          </p>
          <p className={styles.kpiCaption}>
            {(score?.receivedPOs ?? 0) > 0
              ? `${score?.onTimeCount ?? 0} of ${score?.receivedPOs ?? 0} received POs on time`
              : 'No received POs yet'}
          </p>
        </div>

        <div className={styles.kpiCard}>
          <div className={styles.kpiHead}>
            <span className={styles.kpiLabel}>Defect Rate</span>
            <AlertTriangle {...ICON} style={{ color: 'var(--c-festive-b, #B8331F)' }} />
          </div>
          <p className={`${styles.kpiValue} ${(score?.receivedPOs ?? 0) > 0 ? defectTone : ''}`}>
            {(score?.receivedPOs ?? 0) > 0 ? `${(score?.defectRate ?? 0).toFixed(2)}%` : '—'}
          </p>
        </div>

        <div className={styles.kpiCard}>
          <div className={styles.kpiHead}>
            <span className={styles.kpiLabel}>Avg Lead Days</span>
            <Clock {...ICON} style={{ color: 'var(--c-burnt)' }} />
          </div>
          <p className={styles.kpiValue}>
            {(score?.receivedPOs ?? 0) > 0 ? (score?.averageLeadDays ?? 0).toFixed(1) : '—'}
          </p>
        </div>
      </section>

    {/* ── Last 10 POs ───────────────────────────────────────────── */}
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>
          <TrendingUp {...ICON} style={{ color: 'var(--c-burnt)' }} />
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
   SupplierSkuPricingPanel — the SKU Mappings card + per-SKU price matrix.

   Split out of the old Overview panel into its own "SKU Pricing" tab. Keeps
   the per-supplier CSV round-trip, the Product-Maintenance-shaped grouping,
   and the SKU dialog wiring (the dialogs live at the page root and are driven
   via setSkuDialog).
   ════════════════════════════════════════════════════════════════════════ */

const SupplierSkuPricingPanel = ({
  id,
  supplierCode,
  bindings,
  setSkuDialog,
}: {
  id: string;
  /** PR — Commander 2026-05-28: passed through to the Export filename
   *  (`supplier-{code}-bindings-{date}.csv`). */
  supplierCode: string;
  bindings: BindingRow[];
  setSkuDialog: (s: { mode: 'closed' } | { mode: 'multi' } | { mode: 'edit'; binding: BindingRow }) => void;
}) => {
  /* PR — Commander 2026-05-28 ("我需要一个 import 跟 export 的功能"):
     supplier-scoped CSV round-trip for the SKU MAPPINGS card. Mirrors the
     Products page Export/Import toolbar but per-supplier (different shape:
     one row per binding, per-category price-matrix columns). */
  const [importing, setImporting] = useState(false);
  const sofaConfig = useMaintenanceConfig('master');
  const sofaHeights = sofaConfig.data?.data?.sofaSizes
    ? maintValues(sofaConfig.data.data.sofaSizes)
    : SOFA_HEIGHT_FALLBACK.map(String);
  /* PR — Commander 2026-05-27 ("为什么 SKU Mapping 那边没有根据我的
     Product Maintenance 做出相对的排版呢"):
     Group bindings using the SAME sub-section labels the Product Maintenance
     sidebar uses, so Supplier Detail and Products feel like the same shape:
       Bedframe Sizes  ← mfg_products where category = BEDFRAME
       Mattress Sizes  ← mfg_products where category = MATTRESS
       Sofa Compartments ← SOFA SKUs that belong to a Model (model_id != null)
       Sofa (other)    ← legacy / non-Model sofa SKUs
       Accessories     ← ACCESSORY
       Services        ← SERVICE
       Others          ← orphan codes (fabric / raw / unknown)

     We look up the product client-side via the same mfg-products cache the
     picker uses (no new endpoint). Order is fixed so the UI doesn't
     reshuffle as bindings are added.

     TODO (commander follow-up): per-tier supplier pricing per category. E.g.
     Sofa: one row per Model with columns for compartment widths 24/26/28/30.
     Bedframe: one row per Model with columns for size variants 3FT/5FT/6FT.
     Needs a new supplier_material_binding_prices child table (or JSONB
     price_tiers column on supplier_material_bindings) — out of scope for
     this PR per task brief. */
  const products = useMfgProducts();

  const CATEGORY_ORDER: readonly string[] = [
    'BEDFRAME_SIZES',
    'MATTRESS_SIZES',
    'SOFA_COMPARTMENTS',
    'SOFA_OTHER',
    'ACCESSORIES',
    'SERVICES',
    'OTHERS',
  ];
  const CATEGORY_LABEL: Record<string, string> = {
    BEDFRAME_SIZES:    'Bedframe Sizes',
    MATTRESS_SIZES:    'Mattress Sizes',
    SOFA_COMPARTMENTS: 'Sofa Compartments',
    SOFA_OTHER:        'Sofa (other)',
    ACCESSORIES:       'Accessories',
    SERVICES:          'Services',
    OTHERS:            'Others',
  };

  const byCategory = useMemo(() => {
    const productByCode = new Map<string, MfgProductRow>(
      (products.data ?? []).map((p) => [p.code, p]),
    );
    /* Classify each binding's underlying mfg_product into one of the
       Product Maintenance sub-sections. Anything we can't look up (no
       cache hit — fabric / raw / orphan code) lands in OTHERS. */
    const classify = (p: MfgProductRow | undefined): string => {
      if (!p) return 'OTHERS';
      switch (p.category) {
        case 'BEDFRAME':  return 'BEDFRAME_SIZES';
        case 'MATTRESS':  return 'MATTRESS_SIZES';
        case 'SOFA':      return p.model_id ? 'SOFA_COMPARTMENTS' : 'SOFA_OTHER';
        case 'ACCESSORY': return 'ACCESSORIES';
        case 'SERVICE':   return 'SERVICES';
        default:          return 'OTHERS';
      }
    };
    const buckets = new Map<string, BindingRow[]>();
    for (const b of bindings) {
      const key = classify(productByCode.get(b.material_code));
      const arr = buckets.get(key) ?? [];
      arr.push(b);
      buckets.set(key, arr);
    }
    // Stable order — buckets with no bindings are omitted.
    return CATEGORY_ORDER
      .filter((c) => buckets.has(c))
      .map((c) => [c, buckets.get(c)!] as const);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- CATEGORY_ORDER is a fixed display order, not a reactive value
  }, [bindings, products.data]);

  /* Collapsible panel — click the SKU Mappings header bar to fold every
     category group away. Persisted per panel in localStorage. */
  const [open, toggleOpen] = usePersistedOpen('panel-supplier-sku-mappings');

  return (
    <section className={styles.card} style={{ marginTop: 'var(--space-3)' }}>
      <header
        className={styles.cardHeader}
        onClick={toggleOpen}
        aria-expanded={open}
        title={open ? 'Click to collapse' : 'Click to expand'}
        style={{ cursor: 'pointer', userSelect: 'none' }}
      >
        <h2 className={styles.cardTitle}>
          {open
            ? <ChevronDown {...SM_ICON} style={{ color: 'var(--fg-muted)' }} />
            : <ChevronRight {...SM_ICON} style={{ color: 'var(--fg-muted)' }} />}
          <Package {...ICON} style={{ color: 'var(--c-burnt)' }} />
          SKU Mappings
          <span className={styles.cardTitleCount}>
            {bindings.length === 0
              ? '(no codes yet)'
              : byCategory.length === 1
                ? `(${bindings.length} ${bindings.length === 1 ? 'code' : 'codes'})`
                : `(${byCategory.length} categories · ${bindings.length} codes)`}
          </span>
        </h2>
        {/* stopPropagation so the toolbar buttons don't toggle the collapse. */}
        <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
          {/* PR — Commander 2026-05-27: one-click cleanup for the legacy
              literal-"5539" rows from before the per-SKU auto-suffix fix.
              Surfaces a count + button when ≥2 bindings share an ambiguous
              (no '-') supplier_sku. */}
          <AutoSuffixButton supplierId={id} bindings={bindings} />
          {/* PR — Commander 2026-05-28: per-supplier CSV round-trip.
              Export = one row per binding (with per-category price-matrix
              columns expanded); Import = update-in-place against
              internal_code matches (unknown codes skip — won't auto-create
              bindings to avoid wiring N missing SKUs by accident). */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => exportBindingsCsv(bindings, supplierCode, sofaHeights, products.data ?? [])}
            disabled={bindings.length === 0}
            title="Download CSV of every SKU mapping for this supplier"
          >
            <Download {...ICON} />
            <span>Export Bindings</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setImporting(true)}
            title="Update existing bindings from a CSV (rows matched by internal_code)"
          >
            <Upload {...ICON} />
            <span>Import Bindings</span>
          </Button>
          <Button variant="primary" size="sm" onClick={() => setSkuDialog({ mode: 'multi' })}>
            <Plus {...ICON} />
            <span>Add SKU Mappings</span>
          </Button>
        </span>
      </header>
      {importing && (
        <ImportBindingsDialog
          supplierId={id}
          bindings={bindings}
          products={products.data ?? []}
          sofaHeights={sofaHeights}
          onClose={() => setImporting(false)}
        />
      )}
      {open && (bindings.length === 0 ? (
        <div className={styles.cardBody}>
          <p className={styles.emptyRow}>No SKU mappings yet for this supplier.</p>
        </div>
      ) : (
        byCategory.map(([category, rows]) => (
          <CategorySection
            key={category}
            label={CATEGORY_LABEL[category] ?? category}
            count={rows.length}
          >
            <SkuMappingsTable
              supplierId={id}
              bindings={rows}
              groupKind={groupKindFromCategory(category)}
              storageKey={`dg-supplier-bindings-${category.toLowerCase()}`}
              onEdit={(b) => setSkuDialog({ mode: 'edit', binding: b })}
            />
          </CategorySection>
        ))
      ))}
    </section>
  );
};

// SupplierPricingPanel — the "Maintenance" tab. Mounts the shared
// MaintenanceTab (surcharge config) scoped to this supplier. Always shown (no
// category gate) — a supplier can supply multiple categories, so we surface the
// Bedframe + Sofa + Common surcharge pools by default.
const SupplierPricingPanel = ({
  supplierId,
  supplierName,
  supplierCategory,
}: {
  supplierId: string;
  supplierName: string;
  supplierCategory: SupplierCategory | null;
}) => {
  // A supplier can supply multiple categories (e.g. Hookka = bedframe + sofa),
  // so there is no single category to gate on. When no specific category is
  // set, show the Bedframe + Sofa + Common surcharge pools by default.
  const sectionFilter: MaintenanceSection[] =
    maintenanceSectionsForCategory(supplierCategory) ?? ['Bedframe', 'Sofa', 'Common'];
  return (
    <section className={styles.card} style={{ marginTop: 'var(--space-3)' }}>
      <header className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>
          <Tag {...ICON} style={{ color: 'var(--c-burnt)' }} />
          Maintenance · {supplierName}
          {supplierCategory && (
            <span className={styles.cardTitleCount}>
              ({SUPPLIER_CATEGORY_LABEL[supplierCategory]} surcharges)
            </span>
          )}
        </h2>
      </header>
      <div className={styles.cardBody}>
        <MaintenanceTab
          scope={`supplier:${supplierId}`}
          sectionFilter={sectionFilter}
          singleCostColumn
          emptyHint={
            <>
              No supplier-specific surcharges yet. The master / selling-price
              config will be used by default; commander can override below
              by editing + saving a row scoped to this supplier.
            </>
          }
        />
      </div>
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
   CategorySection — collapsible wrapper for one category's SKU mappings.

   PR — Commander 2026-05-27. Default open; click the header row to toggle.
   Uses native <details>-style behaviour via useState so we can persist the
   open/closed state across re-renders (which a raw <details> would lose on
   key-change). No localStorage — the user's task brief explicitly says
   "Persist nothing".
   ════════════════════════════════════════════════════════════════════════ */

const CategorySection = ({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
}) => {
  /* Collapse state now persists per panel in localStorage (owner request
     2026-06-12 — same treatment as the Supplier Info / SKU Mappings bars). */
  const [open, toggleOpen] = usePersistedOpen(`panel-skumap-${label}`);
  /* PR — Commander 2026-05-27: switched from inline-style fs-12/700 eyebrow
     to the .subGroupHead class (fs-9/700 letter-spacing 0.12em). Matches the
     other card eyebrows on this page. */
  return (
    <div style={{ borderTop: '1px solid var(--line)' }}>
      <button
        type="button"
        onClick={toggleOpen}
        aria-expanded={open}
        className={styles.subGroupHead}
        style={{ borderBottom: open ? '1px solid var(--line)' : 'none' }}
      >
        {open
          ? <ChevronDown size={10} strokeWidth={1.75} style={{ color: 'var(--fg-muted)' }} />
          : <ChevronRight size={10} strokeWidth={1.75} style={{ color: 'var(--fg-muted)' }} />}
        <span>{label}</span>
        <span className={styles.subGroupHeadCount}>
          {count} {count === 1 ? 'code' : 'codes'}
        </span>
      </button>
      {open && children}
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   SKU Mappings table — inline edit (main toggle, delete) + open dialog.

   PR — Commander 2026-05-27 ("跟着 Product Maintenance 的排版"): the column
   layout now depends on which Products Maintenance sub-section the group
   belongs to. Sofa Compartments → seat-height matrix × P1/P2/P3 tier toggle.
   Bedframe Sizes → Price 1 + Price 2. Mattress / Accessory / Service / Other
   → unchanged single Unit Price column.
   ════════════════════════════════════════════════════════════════════════ */

export type SkuGroupKind = 'sofa' | 'bedframe' | 'mattress' | 'other';

/** Map a CATEGORY_ORDER key (set inside SupplierOverviewPanel) to the
 *  column layout this table should render. New buckets default to 'other'. */
function groupKindFromCategory(category: string): SkuGroupKind {
  switch (category) {
    case 'SOFA_COMPARTMENTS':
    case 'SOFA_OTHER':
      return 'sofa';
    case 'BEDFRAME_SIZES':
      return 'bedframe';
    case 'MATTRESS_SIZES':
      return 'mattress';
    default:
      return 'other';
  }
}

const SkuMappingsTable = ({
  supplierId,
  bindings,
  groupKind,
  storageKey,
  onEdit,
}: {
  supplierId: string;
  bindings: BindingRow[];
  /** PR — Commander 2026-05-27: which column layout to render. Derived from
   *  the parent group label so Sofa Compartments / Bedframe Sizes / etc.
   *  match the Products Maintenance shape. */
  groupKind: SkuGroupKind;
  /** Unique localStorage key for the DataGrid column-layout persistence —
   *  one per category section so e.g. Accessories and Services keep
   *  independent layouts. */
  storageKey: string;
  onEdit: (b: BindingRow) => void;
}) => {
  if (bindings.length === 0) {
    return (
      <div className={styles.cardBody}>
        <p className={styles.emptyRow}>No SKU mappings yet for this supplier.</p>
      </div>
    );
  }

  if (groupKind === 'sofa') {
    return (
      <SofaSkuMappingsTable
        supplierId={supplierId}
        bindings={bindings}
        storageKey={storageKey}
        onEdit={onEdit}
      />
    );
  }
  if (groupKind === 'bedframe') {
    return (
      <BedframeSkuMappingsTable
        supplierId={supplierId}
        bindings={bindings}
        storageKey={storageKey}
        onEdit={onEdit}
      />
    );
  }
  // Mattress / Accessory / Service / Other — single Unit Price column.
  return (
    <DefaultSkuMappingsTable
      supplierId={supplierId}
      bindings={bindings}
      storageKey={storageKey}
      onEdit={onEdit}
    />
  );
};

/* ────────────────────────────────────────────────────────────────────────
   DataGrid conversion (owner request 2026-06-12) — the three SKU mapping
   table variants now render through the shared DataGrid, gaining sorting,
   per-column filters, column show/hide, reorder/pin and layout persistence.
   Inline cell editors (supplier SKU, prices), the Main star and the row
   Edit/Delete actions are preserved inside cell accessors; CellStop keeps
   clicks in those editors from bubbling into the grid's row handlers
   (mirrors the old td-level stopPropagation).
   ──────────────────────────────────────────────────────────────────────── */

const CellStop = ({ children }: { children: React.ReactNode }) => (
  <span
    onClick={(e) => e.stopPropagation()}
    onDoubleClick={(e) => e.stopPropagation()}
    style={{ display: 'inline-flex', alignItems: 'center' }}
  >
    {children}
  </span>
);

const bindingRowKey = (b: BindingRow) => b.id;

/** Leading columns shared by all three binding grids. */
function bindingHeadColumns(
  supplierId: string,
  update: ReturnType<typeof useUpdateBinding>,
): DataGridColumn<BindingRow>[] {
  return [
    {
      key: 'code',
      label: 'Internal Code',
      width: 150,
      accessor: (b) => <span className={styles.codeCell}>{b.material_code}</span>,
      searchValue: (b) => b.material_code,
      filterValue: (b) => b.material_code,
      sortFn: (a, b) => a.material_code.localeCompare(b.material_code),
    },
    {
      key: 'name',
      label: 'Internal Description',
      width: 220,
      accessor: (b) => b.material_name,
    },
    {
      key: 'sku',
      label: 'Supplier SKU',
      width: 150,
      accessor: (b) => (
        <CellStop>
          <InlineSupplierSku binding={b} supplierId={supplierId} update={update} />
        </CellStop>
      ),
      searchValue: (b) => b.supplier_sku,
      filterValue: (b) => b.supplier_sku,
      sortFn: (a, b) => a.supplier_sku.localeCompare(b.supplier_sku),
    },
  ];
}

/** Trailing columns shared by all three binding grids — lead / MOQ / price-
 *  matrix indicator / cost-anchor toggle / main-supplier star / row actions. */
function bindingTailColumns(
  supplierId: string,
  update: ReturnType<typeof useUpdateBinding>,
  remove: ReturnType<typeof useDeleteBinding>,
  onEdit: (b: BindingRow) => void,
  setAnchor: ReturnType<typeof useSetCostAnchor>,
): DataGridColumn<BindingRow>[] {
  return [
    {
      key: 'lead',
      label: 'Lead',
      width: 70,
      align: 'right',
      accessor: (b) => `${b.lead_time_days}d`,
      filterValue: (b) => `${b.lead_time_days}d`,
      sortFn: (a, b) => a.lead_time_days - b.lead_time_days,
    },
    {
      key: 'moq',
      label: 'MOQ',
      width: 70,
      align: 'right',
      accessor: (b) => String(b.moq),
      sortFn: (a, b) => a.moq - b.moq,
    },
    {
      key: 'matrix',
      label: 'Matrix',
      width: 70,
      accessor: (b) => (b.price_matrix ? 'Yes' : '—'),
      filterValue: (b) => (b.price_matrix ? 'Yes' : '—'),
      sortFn: (a, b) => Number(Boolean(a.price_matrix)) - Number(Boolean(b.price_matrix)),
    },
    {
      key: 'anchor',
      label: 'Cost anchor',
      width: 100,
      accessor: (b) => (
        <CellStop>
          <AnchorCell binding={b} supplierId={supplierId} setAnchor={setAnchor} />
        </CellStop>
      ),
      searchValue: (b) => (b.is_cost_anchor ? 'anchor' : ''),
      filterValue: (b) => (b.is_cost_anchor ? 'Anchored' : '—'),
      sortFn: (a, b) => Number(a.is_cost_anchor) - Number(b.is_cost_anchor),
    },
    {
      key: 'main',
      label: 'Main',
      width: 90,
      accessor: (b) => (
        <CellStop>
          <MainStarCell binding={b} supplierId={supplierId} update={update} />
        </CellStop>
      ),
      searchValue: (b) => (b.is_main_supplier ? 'main' : ''),
      filterValue: (b) => (b.is_main_supplier ? 'Main' : '—'),
      sortFn: (a, b) => Number(a.is_main_supplier) - Number(b.is_main_supplier),
    },
    {
      key: 'actions',
      label: 'Actions',
      width: 90,
      align: 'right',
      sortable: false,
      groupable: false,
      accessor: (b) => (
        <CellStop>
          <RowActionsCell binding={b} supplierId={supplierId} remove={remove} onEdit={onEdit} />
        </CellStop>
      ),
      searchValue: () => '',
    },
  ];
}

/* ────────────────────────────────────────────────────────────────────────
   Default (mattress / accessory / service / other) — single Unit Price col.
   Unchanged from the pre-matrix layout.
   ──────────────────────────────────────────────────────────────────────── */

const DefaultSkuMappingsTable = ({
  supplierId,
  bindings,
  storageKey,
  onEdit,
}: {
  supplierId: string;
  bindings: BindingRow[];
  storageKey: string;
  onEdit: (b: BindingRow) => void;
}) => {
  const update = useUpdateBinding();
  const remove = useDeleteBinding();
  const setAnchor = useSetCostAnchor();

  const columns = useMemo<DataGridColumn<BindingRow>[]>(() => [
    ...bindingHeadColumns(supplierId, update),
    {
      key: 'price',
      label: 'Unit Price',
      width: 130,
      align: 'right',
      accessor: (b) => (
        <CellStop>
          <InlineUnitPrice binding={b} supplierId={supplierId} update={update} />
        </CellStop>
      ),
      searchValue: (b) => fmtCurrency(b.unit_price_centi, b.currency),
      filterValue: (b) => fmtCurrency(b.unit_price_centi, b.currency),
      sortFn: (a, b) => a.unit_price_centi - b.unit_price_centi,
    },
    ...bindingTailColumns(supplierId, update, remove, onEdit, setAnchor),
  ], [supplierId, update, remove, onEdit, setAnchor]);

  return (
    <DataGrid
      rows={bindings}
      columns={columns}
      storageKey={storageKey}
      exportName="Supplier Materials"
      rowKey={bindingRowKey}
      searchPlaceholder="Search mappings…"
      onRowDoubleClick={onEdit}
      groupBanner={false}
      emptyMessage="No SKU mappings yet for this supplier."
    />
  );
};

/* ────────────────────────────────────────────────────────────────────────
   Sofa SKU mappings — seat-height matrix × P1/P2/P3 tier toggle.

   PR — Commander 2026-05-27. Mirrors the Products SOFA tab: pick a tier
   chip (P1/P2/P3 — default P2) and edit one cell per seat-height. Each cell
   PATCHes a deeply-merged copy of binding.price_matrix.

   Seat-heights come from the maintenance config (`master` scope, sofaSizes
   section). Falls back to the hardcoded HOOKKA defaults [24..35] if the
   config request hasn't resolved yet — keeps the table renderable in cold-
   start cases.
   ──────────────────────────────────────────────────────────────────────── */

const SOFA_TIER_CHIPS: { value: 'P1' | 'P2' | 'P3'; label: string }[] = [
  { value: 'P1', label: 'P1' },
  { value: 'P2', label: 'P2' },
  { value: 'P3', label: 'P3' },
];

const SOFA_HEIGHT_FALLBACK = ['24', '26', '28', '30', '32', '35'];

const SofaSkuMappingsTable = ({
  supplierId,
  bindings,
  storageKey,
  onEdit,
}: {
  supplierId: string;
  bindings: BindingRow[];
  storageKey: string;
  onEdit: (b: BindingRow) => void;
}) => {
  const update = useUpdateBinding();
  const remove = useDeleteBinding();
  const setAnchor = useSetCostAnchor();
  const [selectedTier, setSelectedTier] = useState<'P1' | 'P2' | 'P3'>('P2');

  // Read seat-heights from the master maintenance config (Products Maintenance
  // → Sofa Compartments). Same source the Products page reads from, so the
  // two tables stay in lock-step when commander edits the size pool.
  const config = useMaintenanceConfig('master');
  const heights = useMemo(
    () => (config.data?.data?.sofaSizes
      ? maintValues(config.data.data.sofaSizes)
      : SOFA_HEIGHT_FALLBACK.map(String)),
    [config.data],
  );

  const columns = useMemo<DataGridColumn<BindingRow>[]>(() => [
    ...bindingHeadColumns(supplierId, update),
    ...heights.map<DataGridColumn<BindingRow>>((h) => ({
      key: `h-${h}`,
      label: `${h}"`,
      width: 110,
      align: 'right',
      accessor: (b) => (
        <CellStop>
          <InlineSofaMatrixCell
            binding={b}
            supplierId={supplierId}
            update={update}
            height={h}
            tier={selectedTier}
          />
        </CellStop>
      ),
      searchValue: () => '',
      filterValue: (b) => {
        const sen = readSofaCell(b.price_matrix, h, selectedTier);
        return sen == null ? '—' : fmtCurrency(sen, b.currency);
      },
      sortFn: (a, b) =>
        (readSofaCell(a.price_matrix, h, selectedTier) ?? -1)
        - (readSofaCell(b.price_matrix, h, selectedTier) ?? -1),
    })),
    ...bindingTailColumns(supplierId, update, remove, onEdit, setAnchor),
  ], [supplierId, update, remove, onEdit, setAnchor, heights, selectedTier]);

  return (
    <div>
      {/* Tier toggle row — same look as the Products SOFA tab.
          PR — Commander 2026-05-27: shrink the eyebrow + the help text + the
          chip cluster so the tier toggle doesn't dominate the SKU mappings
          table for sofa suppliers. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          padding: '4px var(--space-3)',
          borderBottom: '1px solid var(--line)',
          background: 'var(--c-paper)',
        }}
      >
        <span style={{ fontSize: 'var(--fs-9)', fontWeight: 700, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.12em' }}>
          Fabric tier
        </span>
        {SOFA_TIER_CHIPS.map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => setSelectedTier(c.value)}
            style={{
              fontFamily: 'var(--font-button)',
              fontSize: 'var(--fs-11)',
              fontWeight: 600,
              padding: '1px 10px',
              borderRadius: 'var(--radius-pill)',
              border: selectedTier === c.value ? '1px solid var(--c-ink)' : '1px solid var(--line)',
              background: selectedTier === c.value ? 'var(--c-ink)' : 'var(--c-paper)',
              color: selectedTier === c.value ? 'var(--c-cream)' : 'var(--c-ink)',
              cursor: 'pointer',
            }}
          >
            {c.label}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 'var(--fs-10)', color: 'var(--fg-soft)' }}>
          Cost per (seat-height × tier). Empty cell = "no price set".
        </span>
      </div>

      <DataGrid
        rows={bindings}
        columns={columns}
        storageKey={storageKey}
        exportName="Supplier Materials"
        rowKey={bindingRowKey}
        searchPlaceholder="Search mappings…"
        onRowDoubleClick={onEdit}
        groupBanner={false}
        emptyMessage="No SKU mappings yet for this supplier."
      />
    </div>
  );
};

/* ────────────────────────────────────────────────────────────────────────
   Bedframe SKU mappings — Price 1 + Price 2 columns (fabric tiers).

   PR — Commander 2026-05-27. Mirrors the Products BEDFRAME tab: two price
   columns. Cells read/write `price_matrix.P1` / `price_matrix.P2` (centi).
   ──────────────────────────────────────────────────────────────────────── */

const BedframeSkuMappingsTable = ({
  supplierId,
  bindings,
  storageKey,
  onEdit,
}: {
  supplierId: string;
  bindings: BindingRow[];
  storageKey: string;
  onEdit: (b: BindingRow) => void;
}) => {
  const update = useUpdateBinding();
  const remove = useDeleteBinding();
  const setAnchor = useSetCostAnchor();

  const columns = useMemo<DataGridColumn<BindingRow>[]>(() => [
    ...bindingHeadColumns(supplierId, update),
    ...(['P1', 'P2'] as const).map<DataGridColumn<BindingRow>>((tier) => ({
      key: `price-${tier}`,
      label: tier === 'P1' ? 'Price 1' : 'Price 2',
      width: 120,
      align: 'right',
      accessor: (b) => (
        <CellStop>
          <InlineBedframeMatrixCell
            binding={b}
            supplierId={supplierId}
            update={update}
            tier={tier}
          />
        </CellStop>
      ),
      searchValue: () => '',
      filterValue: (b) => {
        const sen = readBedframeCell(b.price_matrix, tier);
        return sen == null ? '—' : fmtCurrency(sen, b.currency);
      },
      sortFn: (a, b) =>
        (readBedframeCell(a.price_matrix, tier) ?? -1)
        - (readBedframeCell(b.price_matrix, tier) ?? -1),
    })),
    ...bindingTailColumns(supplierId, update, remove, onEdit, setAnchor),
  ], [supplierId, update, remove, onEdit, setAnchor]);

  return (
    <DataGrid
      rows={bindings}
      columns={columns}
      storageKey={storageKey}
      exportName="Supplier Materials"
      rowKey={bindingRowKey}
      searchPlaceholder="Search mappings…"
      onRowDoubleClick={onEdit}
      groupBanner={false}
      emptyMessage="No SKU mappings yet for this supplier."
    />
  );
};

/* ────────────────────────────────────────────────────────────────────────
   Shared row cells — main-star toggle + (edit / delete) icon group. Extracted
   so the three table variants (sofa / bedframe / default) share the same
   right-hand-side affordances without duplicating the JSX.
   ──────────────────────────────────────────────────────────────────────── */

const MainStarCell = ({
  binding,
  supplierId,
  update,
}: {
  binding: BindingRow;
  supplierId: string;
  update: ReturnType<typeof useUpdateBinding>;
}) => (
  <>
    <button
      type="button"
      className={styles.iconBtn}
      title={binding.is_main_supplier ? 'Main supplier' : 'Set as main'}
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
        fill={binding.is_main_supplier ? 'currentColor' : 'none'}
        style={{ color: binding.is_main_supplier ? 'var(--c-burnt)' : 'var(--fg-muted)' }}
      />
    </button>
    {binding.is_main_supplier && <span className={styles.mainPill}>Main</span>}
  </>
);

/* ────────────────────────────────────────────────────────────────────────
   AnchorCell — the ⚓ "Cost anchor" toggle (migration 0177).

   Marks THIS binding as the cost anchor for its material_code: while anchored,
   editing either side's cost (this binding's unit_price_centi / price_matrix,
   or the linked mfg_products base_price_sen / price1_sen) mirrors onto the
   other, so Product-Maintenance cost == this supplier's cost. Setting the
   anchor clears it on any other binding for the same product (one per code,
   server-enforced) and pushes the binding's current cost onto the product
   (initial sync) — so we confirm before turning it ON (it writes product cost).
   Clearing just drops the flag (no sync), so no confirm.

   SOFA bindings can be anchored but cost sync is SKIPPED server-side (a single
   SKU cost vs a per-height grid is ambiguous). We surface that in the tooltip
   so the toggle isn't silently a no-op for sofa cost. */
const looksLikeSofaMatrix = (m: PriceMatrix | null): boolean => {
  if (!m || typeof m !== 'object') return false;
  // Sofa matrix nests tier objects under height keys ({ "24": { P1,.. } });
  // bedframe is flat ({ P1, P2 }). Any object-valued cell ⇒ sofa-shaped.
  return Object.values(m as Record<string, unknown>).some(
    (v) => v !== null && typeof v === 'object',
  );
};

const AnchorCell = ({
  binding,
  supplierId,
  setAnchor,
}: {
  binding: BindingRow;
  supplierId: string;
  setAnchor: ReturnType<typeof useSetCostAnchor>;
}) => {
  const askConfirm = useConfirm();
  const anchored = binding.is_cost_anchor;
  // Anchor is meaningful only for our own SKUs (mfg_product). Fabric / raw
  // bindings have no mfg_products cost row to mirror — hide the toggle.
  if (binding.material_kind !== 'mfg_product') {
    return <span className={styles.muted}>—</span>;
  }
  const sofaSkipped = looksLikeSofaMatrix(binding.price_matrix);
  const title = anchored
    ? 'Cost anchor ON — this supplier’s cost ⇄ product cost stay in sync. Click to unlink.'
    : sofaSkipped
      ? 'Set as cost anchor. Note: sofa per-height cost is NOT auto-synced (phase-2).'
      : 'Set as cost anchor — links this supplier’s cost to the product’s cost (both update together).';
  return (
    <>
      <button
        type="button"
        className={styles.iconBtn}
        title={title}
        disabled={setAnchor.isPending}
        onClick={async (e) => {
          e.stopPropagation();
          if (!anchored) {
            // Turning ON pushes this binding's cost onto the product — confirm.
            const ok = await askConfirm({
              title: `Anchor ${binding.material_code} to this supplier’s cost?`,
              body:
                `Product-Maintenance cost will be kept equal to this supplier’s cost ` +
                `(editing either side updates the other).` +
                (sofaSkipped ? `\n\nNote: sofa per-height cost is not auto-synced.` : ''),
              confirmLabel: 'Anchor',
            });
            if (!ok) return;
          }
          setAnchor.mutate({ supplierId, bindingId: binding.id, anchor: !anchored });
        }}
      >
        <Anchor
          size={16}
          strokeWidth={1.75}
          fill={anchored ? 'currentColor' : 'none'}
          style={{ color: anchored ? 'var(--c-burnt)' : 'var(--fg-muted)' }}
        />
      </button>
      {anchored && <span className={styles.mainPill}>Anchor</span>}
    </>
  );
};

const RowActionsCell = ({
  binding,
  supplierId,
  remove,
  onEdit,
}: {
  binding: BindingRow;
  supplierId: string;
  remove: ReturnType<typeof useDeleteBinding>;
  onEdit: (b: BindingRow) => void;
}) => {
  const askConfirm = useConfirm();
  return (
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
      onClick={async (e) => {
        e.stopPropagation();
        if (await askConfirm({
          title: `Remove mapping ${binding.material_code} → ${binding.supplier_sku}?`,
          confirmLabel: 'Remove',
          danger: true,
        })) {
          remove.mutate({ supplierId, bindingId: binding.id });
        }
      }}
    >
      <Trash2 {...SM_ICON} />
    </button>
  </span>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Inline editors — supplier_sku + unit_price cells on SkuMappingsTable
   (Commander 2026-05-27). Pattern mirrors the Supplier Info card inline
   edits: local draft state, blur or Enter to commit via useUpdateBinding,
   Escape to revert. Both use the same authedFetch + react-query invalidate
   that the rest of this page relies on.
   ════════════════════════════════════════════════════════════════════════ */

const InlineSupplierSku = ({
  binding, supplierId, update,
}: {
  binding: BindingRow;
  supplierId: string;
  update: ReturnType<typeof useUpdateBinding>;
}) => {
  const [draft, setDraft] = useState(binding.supplier_sku);
  // Re-sync if the server cache returns a new value (e.g. the AutoSuffix
  // batch updates this row while it's mounted). Without this the local
  // draft would stick to the stale value.
  const [committed, setCommitted] = useState(binding.supplier_sku);
  if (committed !== binding.supplier_sku) {
    setCommitted(binding.supplier_sku);
    setDraft(binding.supplier_sku);
  }
  const commit = () => {
    const next = draft.trim();
    if (next === binding.supplier_sku) return;
    if (!next) { setDraft(binding.supplier_sku); return; }
    update.mutate({ supplierId, bindingId: binding.id, supplierSku: next });
  };
  return (
    <input
      className={styles.inlineSku}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
        if (e.key === 'Escape') { setDraft(binding.supplier_sku); (e.target as HTMLInputElement).blur(); }
      }}
      title="Click to edit · Enter to save · Esc to cancel"
    />
  );
};

const InlineUnitPrice = ({
  binding, supplierId, update,
}: {
  binding: BindingRow;
  supplierId: string;
  update: ReturnType<typeof useUpdateBinding>;
}) => {
  // Commander 2026-05-29 — shared MoneyInput: free typing, clear & retype,
  // and no clobbering from background refetches (see MoneyInput.tsx).
  return (
    <MoneyInput
      valueSen={binding.unit_price_centi}
      currency={binding.currency === 'MYR' ? 'RM' : binding.currency}
      onCommit={(sen) => {
        const next = sen ?? 0;
        if (next === binding.unit_price_centi) return;
        update.mutate({ supplierId, bindingId: binding.id, unitPriceCenti: next });
      }}
    />
  );
};

/* ════════════════════════════════════════════════════════════════════════
   InlineSofaMatrixCell / InlineBedframeMatrixCell — per-category cost cells
   (Commander 2026-05-27). Same edit ergonomics as InlineUnitPrice (draft in
   RM string, commit on blur or Enter, Esc reverts) but the commit path is a
   deep-merged PATCH against binding.price_matrix.

   We intentionally treat the matrix as a sparse object: clearing a cell sets
   the value to undefined, which `removeMatrixCell` strips out so the row's
   JSON doesn't accumulate `null`s. NULL of the entire object means "fall
   back to unit_price_centi or 0" downstream (see SO line pricing).
   ════════════════════════════════════════════════════════════════════════ */

/** Read sen value from a sofa matrix cell. Tolerant of empty / missing
 *  branches so the UI can keep rendering during a partial fill-in. */
function readSofaCell(
  matrix: PriceMatrix | null,
  height: string,
  tier: 'P1' | 'P2' | 'P3',
): number | null {
  if (!matrix || typeof matrix !== 'object') return null;
  const m = matrix as SofaPriceMatrix;
  const row = m[height];
  if (!row || typeof row !== 'object') return null;
  const v = row[tier];
  return typeof v === 'number' ? v : null;
}

/** Read sen value from a bedframe matrix cell. */
function readBedframeCell(
  matrix: PriceMatrix | null,
  tier: 'P1' | 'P2',
): number | null {
  if (!matrix || typeof matrix !== 'object') return null;
  const m = matrix as BedframePriceMatrix;
  const v = m[tier];
  return typeof v === 'number' ? v : null;
}

/** Deep-merge a new sofa cell into the existing matrix and prune any branch
 *  that ends up empty. Pure — returns a new object. */
function setSofaCell(
  matrix: PriceMatrix | null,
  height: string,
  tier: 'P1' | 'P2' | 'P3',
  valueSen: number | null,
): SofaPriceMatrix | null {
  const next: SofaPriceMatrix = { ...(matrix as SofaPriceMatrix | null ?? {}) };
  const innerSrc = (next[height] ?? {}) as { P1?: number; P2?: number; P3?: number };
  const inner: { P1?: number; P2?: number; P3?: number } = { ...innerSrc };
  if (valueSen == null || valueSen === 0) {
    delete inner[tier];
  } else {
    inner[tier] = valueSen;
  }
  if (Object.keys(inner).length === 0) delete next[height];
  else next[height] = inner;
  return Object.keys(next).length === 0 ? null : next;
}

/** Deep-merge a new bedframe price into the existing matrix. */
function setBedframeCell(
  matrix: PriceMatrix | null,
  tier: 'P1' | 'P2',
  valueSen: number | null,
): BedframePriceMatrix | null {
  const next: BedframePriceMatrix = { ...(matrix as BedframePriceMatrix | null ?? {}) };
  if (valueSen == null || valueSen === 0) {
    delete next[tier];
  } else {
    next[tier] = valueSen;
  }
  return Object.keys(next).length === 0 ? null : next;
}

/** Compact RM input shared by the sofa + bedframe matrix cells. Stays
 *  visually consistent with InlineUnitPrice but allows blank (= clear). */
const MatrixPriceInput = ({
  valueSen,
  currency,
  onCommit,
  placeholder,
}: {
  valueSen: number | null;
  currency: Currency;
  onCommit: (v: number | null) => void;
  placeholder?: string;
}) => {
  // Commander 2026-05-29 — shared MoneyInput; blank clears the cell.
  return (
    <MoneyInput
      valueSen={valueSen}
      currency={currency === 'MYR' ? 'RM' : currency}
      allowBlank
      placeholder={placeholder ?? '—'}
      onCommit={onCommit}
      title="Click to edit · Enter to save · Esc to cancel · blank to clear"
    />
  );
};

const InlineSofaMatrixCell = ({
  binding,
  supplierId,
  update,
  height,
  tier,
}: {
  binding: BindingRow;
  supplierId: string;
  update: ReturnType<typeof useUpdateBinding>;
  height: string;
  tier: 'P1' | 'P2' | 'P3';
}) => {
  const valueSen = readSofaCell(binding.price_matrix, height, tier);
  return (
    <MatrixPriceInput
      valueSen={valueSen}
      currency={binding.currency}
      onCommit={(v) => {
        const next = setSofaCell(binding.price_matrix, height, tier, v);
        update.mutate({ supplierId, bindingId: binding.id, priceMatrix: next });
      }}
    />
  );
};

const InlineBedframeMatrixCell = ({
  binding,
  supplierId,
  update,
  tier,
}: {
  binding: BindingRow;
  supplierId: string;
  update: ReturnType<typeof useUpdateBinding>;
  tier: 'P1' | 'P2';
}) => {
  const valueSen = readBedframeCell(binding.price_matrix, tier);
  return (
    <MatrixPriceInput
      valueSen={valueSen}
      currency={binding.currency}
      onCommit={(v) => {
        const next = setBedframeCell(binding.price_matrix, tier, v);
        update.mutate({ supplierId, bindingId: binding.id, priceMatrix: next });
      }}
    />
  );
};

/* ════════════════════════════════════════════════════════════════════════
   AutoSuffixButton — one-click migration of legacy bindings that store the
   bare Model-level supplier code (e.g. "5539") into every SKU's
   supplier_sku column. Computes the per-SKU suffix via composeSupplierSku
   and PATCHes each row.

   Heuristic for "ambiguous": ≥2 bindings share the same supplier_sku that
   contains no '-'. Single-SKU suppliers using a dash-less code (e.g. a
   custom service item "FREIGHT") are NOT touched — they're legitimately
   meant to be the same string.
   ════════════════════════════════════════════════════════════════════════ */

const AutoSuffixButton = ({
  supplierId, bindings,
}: { supplierId: string; bindings: BindingRow[] }) => {
  const products = useMfgProducts();
  const update = useUpdateBinding();
  const [running, setRunning] = useState(false);
  const askConfirm = useConfirm();

  // Group bindings by supplier_sku → bindings[]. Anything with ≥2 entries
  // and a dash-less key is a candidate.
  const candidates = useMemo(() => {
    const byKey = new Map<string, BindingRow[]>();
    for (const b of bindings) {
      if (!looksAmbiguous(b.supplier_sku)) continue;
      const arr = byKey.get(b.supplier_sku) ?? [];
      arr.push(b);
      byKey.set(b.supplier_sku, arr);
    }
    const list: BindingRow[] = [];
    for (const arr of byKey.values()) if (arr.length >= 2) list.push(...arr);
    return list;
  }, [bindings]);

  if (candidates.length === 0) return null;

  const onClick = async () => {
    if (running) return;
    const productsByCode = new Map((products.data ?? []).map((p) => [p.code, p]));
    const ok = await askConfirm({
      title: `Auto-suffix ${candidates.length} binding${candidates.length === 1 ? '' : 's'}?`,
      body: 'Each row will get its per-SKU suffix appended to its current supplier_sku (e.g. "5539" → "5539-1A(LHF)").',
      confirmLabel: 'Auto-suffix',
    });
    if (!ok) return;
    setRunning(true);
    try {
      for (const b of candidates) {
        const p = productsByCode.get(b.material_code);
        if (!p) continue;
        const next = composeSupplierSku(b.supplier_sku, p);
        if (next === b.supplier_sku) continue;
        // Sequential to keep server load + audit log linear.
        await update.mutateAsync({ supplierId, bindingId: b.id, supplierSku: next });
      }
    } finally {
      setRunning(false);
    }
  };

  return (
    <Button variant="ghost" size="sm" onClick={onClick} disabled={running}>
      <span>
        {running
          ? 'Auto-suffixing…'
          : `Auto-suffix supplier_sku · ${candidates.length}`}
      </span>
    </Button>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Bindings CSV Export + Import (Commander 2026-05-28).

   One row per binding. Columns:
     - internal_code, internal_description, supplier_sku
     - unit_price_rm   (RM, 2dp — for non-sofa / non-bedframe bindings)
     - sofa_{height}_P1/P2/P3  (only for sofa bindings, read from price_matrix)
     - bedframe_P1, bedframe_P2  (only for bedframe bindings)
     - lead_time_days, moq, is_main_supplier

   Sofa seat-heights come from the master maintenance config (same source the
   sofa SKU mappings table reads), so the export always matches whatever pool
   commander currently maintains.

   Import path is intentionally update-only: rows whose internal_code matches
   an existing binding for this supplier get patched; rows whose code doesn't
   match are tallied + reported in a "skipped N" summary. Auto-create would
   need the new SKU's full descriptor + risks creating drift across N missing
   codes if commander accidentally edits the wrong column.

   Bulk endpoint isn't worth the round-trip cost yet — loop sequential PATCH
   with a progress toast. Flag this as a follow-up to convert to a single
   `POST /suppliers/:id/bindings/bulk-update` if N rows ever grows past ~50.
   ════════════════════════════════════════════════════════════════════════ */

const SOFA_TIERS_FOR_EXPORT: readonly ('P1' | 'P2' | 'P3')[] = ['P1', 'P2', 'P3'];

/** RFC4180 quote when a cell contains comma / quote / newline. */
function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Centi → RM (2dp). Treat `0`/`null` as blank so the CSV doesn't write
 *  "0.00" into every cell that's never been filled. */
function fmtRmCell(centi: number | null | undefined): string {
  if (centi == null || centi === 0) return '';
  return (centi / 100).toFixed(2);
}

/** Read centi from a parsed CSV cell. Empty string / "—" → null (skip).
 *  Anything else gets coerced through Number; non-finite → null. */
function parseRmCell(raw: string | undefined): number | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t || t === '—' || t === '-') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** Classify a binding's underlying mfg_product so we know which optional
 *  matrix columns it should populate. Mirrors SupplierOverviewPanel.classify
 *  but returns the smaller set the CSV cares about. */
function bindingKindForCsv(
  binding: BindingRow,
  productByCode: Map<string, MfgProductRow>,
): 'sofa' | 'bedframe' | 'other' {
  const p = productByCode.get(binding.material_code);
  if (!p) return 'other';
  if (p.category === 'SOFA') return 'sofa';
  if (p.category === 'BEDFRAME') return 'bedframe';
  return 'other';
}

function exportBindingsCsv(
  bindings: BindingRow[],
  supplierCode: string,
  sofaHeights: string[],
  products: MfgProductRow[],
): void {
  if (bindings.length === 0) return;
  const productByCode = new Map<string, MfgProductRow>(
    products.map((p) => [p.code, p]),
  );
  /* Build a wide column set up-front: base columns + sofa matrix columns +
     bedframe matrix columns + tail. We always emit every column even if a
     given supplier only has e.g. bedframe bindings — keeps the import path
     position-stable, and commander can re-upload a partial sheet without
     losing other categories. */
  // Only emit the price-column groups for the categories this supplier actually
  // binds — a bedframe-only supplier no longer gets a wall of empty sofa_*
  // columns. internal_description is dropped (read-only echo, never imported).
  // Wei Siang 2026-06-15: keep the sheet to the match key + prices.
  const kinds = new Set(bindings.map((b) => bindingKindForCsv(b, productByCode)));
  const sofaCols: string[] = [];
  if (kinds.has('sofa')) {
    for (const h of sofaHeights) {
      for (const t of SOFA_TIERS_FOR_EXPORT) {
        sofaCols.push(`sofa_${h}_${t}`);
      }
    }
  }
  const header: string[] = [
    'internal_code',
    'supplier_sku',
    ...(kinds.has('other') ? ['unit_price_rm'] : []),
    ...sofaCols,
    ...(kinds.has('bedframe') ? ['bedframe_P1', 'bedframe_P2'] : []),
    'lead_time_days',
    'moq',
    'is_main_supplier',
  ];

  const lines: string[] = [header.map(csvCell).join(',')];
  for (const b of bindings) {
    const kind = bindingKindForCsv(b, productByCode);
    const row: Record<string, unknown> = {
      internal_code: b.material_code,
      supplier_sku: b.supplier_sku,
      // unit_price_rm only meaningful for non-matrix categories
      unit_price_rm: kind === 'other' ? fmtRmCell(b.unit_price_centi) : '',
      bedframe_P1: '',
      bedframe_P2: '',
      lead_time_days: b.lead_time_days || '',
      moq: b.moq || '',
      is_main_supplier: b.is_main_supplier ? 'true' : 'false',
    };
    if (kind === 'sofa') {
      const matrix = (b.price_matrix ?? {}) as SofaPriceMatrix;
      for (const h of sofaHeights) {
        const inner = matrix[h] ?? {};
        for (const t of SOFA_TIERS_FOR_EXPORT) {
          row[`sofa_${h}_${t}`] = fmtRmCell(inner[t]);
        }
      }
    } else if (kind === 'bedframe') {
      const matrix = (b.price_matrix ?? {}) as BedframePriceMatrix;
      row.bedframe_P1 = fmtRmCell(matrix.P1);
      row.bedframe_P2 = fmtRmCell(matrix.P2);
    }
    lines.push(header.map((col) => csvCell(row[col])).join(','));
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `supplier-${supplierCode}-bindings-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Minimal CSV parser — handles RFC4180 quoting + escaped quotes. Doesn't
 *  try to be clever about UTF-8 BOM or CRLF / mixed line endings; commander's
 *  workflow is "Export → edit in Excel → save → Import" which produces
 *  comma-separated UTF-8 with quoted strings. */
/** Read the first sheet of an uploaded Excel workbook (.xlsx/.xls) into rows of
 *  string cells — so an exported CSV that the operator edited and let Excel
 *  re-save as a workbook still imports. CSV stays on parseCsv below. */
async function readXlsxGrid(file: File): Promise<string[][]> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const first = wb.SheetNames[0];
  const sheet = first ? wb.Sheets[first] : undefined;
  if (!sheet) return [];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '' });
  return aoa
    .map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : []))
    .filter((r) => r.some((c) => c.trim().length > 0));
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r') { continue; }
    if (ch === '\n') { row.push(cell); cell = ''; rows.push(row); row = []; continue; }
    cell += ch;
  }
  // Flush trailing cell + row (no final newline).
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

const ImportBindingsDialog = ({
  supplierId,
  bindings,
  products,
  sofaHeights,
  onClose,
}: {
  supplierId: string;
  bindings: BindingRow[];
  products: MfgProductRow[];
  sofaHeights: string[];
  onClose: () => void;
}) => {
  const update = useUpdateBinding();
  const [file, setFile] = useState<File | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [summary, setSummary] = useState<string | null>(null);

  const productByCode = useMemo(
    () => new Map<string, MfgProductRow>(products.map((p) => [p.code, p])),
    [products],
  );

  const bindingByCode = useMemo(
    () => new Map<string, BindingRow>(bindings.map((b) => [b.material_code, b])),
    [bindings],
  );

  const run = async () => {
    if (!file || running) return;
    setRunning(true);
    setSummary(null);
    try {
      const fname = file.name.toLowerCase();
      let rows: string[][];
      if (fname.endsWith('.xlsx') || fname.endsWith('.xls')) {
        rows = await readXlsxGrid(file);
      } else {
        let text = await file.text();
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip Excel UTF-8 BOM
        rows = parseCsv(text);
      }
      if (rows.length < 2) { setSummary('File has no data rows.'); setRunning(false); return; }
      const header = rows[0]!.map((h) => h.trim());
      const idx = (col: string) => header.indexOf(col);
      const colCode = idx('internal_code');
      if (colCode < 0) {
        setSummary('Missing required column: internal_code');
        setRunning(false);
        return;
      }
      const dataRows = rows.slice(1);

      // Pre-classify which sofa columns are present in this CSV so we don't
      // index out of bounds when an exported file only includes a subset.
      const sofaColIndex = new Map<string, Map<'P1' | 'P2' | 'P3', number>>();
      for (const h of sofaHeights) {
        const inner = new Map<'P1' | 'P2' | 'P3', number>();
        for (const t of SOFA_TIERS_FOR_EXPORT) {
          const i = idx(`sofa_${h}_${t}`);
          if (i >= 0) inner.set(t, i);
        }
        sofaColIndex.set(h, inner);
      }
      const colBedP1 = idx('bedframe_P1');
      const colBedP2 = idx('bedframe_P2');
      const colSupSku = idx('supplier_sku');
      const colUnitPriceRm = idx('unit_price_rm');
      const colLead = idx('lead_time_days');
      const colMoq = idx('moq');
      const colMain = idx('is_main_supplier');

      let updated = 0;
      let skippedUnknown = 0;
      let failed = 0;
      const updates: Array<() => Promise<void>> = [];

      for (const r of dataRows) {
        const code = (r[colCode] ?? '').trim();
        if (!code) continue;
        const binding = bindingByCode.get(code);
        if (!binding) { skippedUnknown += 1; continue; }
        const product = productByCode.get(code);
        const kind: 'sofa' | 'bedframe' | 'other' =
          product?.category === 'SOFA' ? 'sofa'
            : product?.category === 'BEDFRAME' ? 'bedframe'
              : 'other';

        const patch: Partial<NewBinding> = {};
        if (colSupSku >= 0) {
          const v = (r[colSupSku] ?? '').trim();
          if (v && v !== binding.supplier_sku) patch.supplierSku = v;
        }
        if (kind === 'other' && colUnitPriceRm >= 0) {
          const sen = parseRmCell(r[colUnitPriceRm]);
          if (sen != null && sen !== binding.unit_price_centi) patch.unitPriceCenti = sen;
        }
        if (colLead >= 0) {
          const raw = (r[colLead] ?? '').trim();
          if (raw) {
            const n = Number(raw);
            if (Number.isFinite(n) && n >= 0 && n !== binding.lead_time_days) {
              patch.leadTimeDays = Math.round(n);
            }
          }
        }
        if (colMoq >= 0) {
          const raw = (r[colMoq] ?? '').trim();
          if (raw) {
            const n = Number(raw);
            if (Number.isFinite(n) && n >= 0 && n !== binding.moq) patch.moq = Math.round(n);
          }
        }
        if (colMain >= 0) {
          const raw = (r[colMain] ?? '').trim().toLowerCase();
          if (raw === 'true' || raw === '1') {
            if (!binding.is_main_supplier) patch.isMainSupplier = true;
          } else if (raw === 'false' || raw === '0') {
            if (binding.is_main_supplier) patch.isMainSupplier = false;
          }
        }

        // Price matrix updates are wholesale (we send the merged matrix) so
        // partial CSVs don't wipe other categories' data.
        if (kind === 'sofa') {
          const next: SofaPriceMatrix = { ...((binding.price_matrix ?? {}) as SofaPriceMatrix) };
          let changed = false;
          for (const h of sofaHeights) {
            const inner = { ...(next[h] ?? {}) } as { P1?: number; P2?: number; P3?: number };
            let innerChanged = false;
            const indices = sofaColIndex.get(h);
            if (!indices) continue;
            for (const t of SOFA_TIERS_FOR_EXPORT) {
              const colIdx = indices.get(t);
              if (colIdx == null) continue;
              const sen = parseRmCell(r[colIdx]);
              if (sen == null) {
                if (inner[t] !== undefined) { delete inner[t]; innerChanged = true; }
              } else if (inner[t] !== sen) {
                inner[t] = sen;
                innerChanged = true;
              }
            }
            if (innerChanged) {
              if (Object.keys(inner).length === 0) delete next[h];
              else next[h] = inner;
              changed = true;
            }
          }
          if (changed) {
            patch.priceMatrix = Object.keys(next).length === 0 ? null : next;
          }
        } else if (kind === 'bedframe') {
          const next: BedframePriceMatrix = { ...((binding.price_matrix ?? {}) as BedframePriceMatrix) };
          let changed = false;
          if (colBedP1 >= 0) {
            const sen = parseRmCell(r[colBedP1]);
            if (sen == null) {
              if (next.P1 !== undefined) { delete next.P1; changed = true; }
            } else if (next.P1 !== sen) { next.P1 = sen; changed = true; }
          }
          if (colBedP2 >= 0) {
            const sen = parseRmCell(r[colBedP2]);
            if (sen == null) {
              if (next.P2 !== undefined) { delete next.P2; changed = true; }
            } else if (next.P2 !== sen) { next.P2 = sen; changed = true; }
          }
          if (changed) {
            patch.priceMatrix = Object.keys(next).length === 0 ? null : next;
          }
        }

        if (Object.keys(patch).length === 0) continue; // No-op row
        const bindingId = binding.id;
        updates.push(async () => {
          try {
            await update.mutateAsync({ supplierId, bindingId, ...patch });
            updated += 1;
          } catch {
            failed += 1;
          }
        });
      }

      setProgress({ done: 0, total: updates.length });
      for (let i = 0; i < updates.length; i++) {
        await updates[i]!();
        setProgress({ done: i + 1, total: updates.length });
      }

      const parts: string[] = [];
      parts.push(`Updated ${updated} binding${updated === 1 ? '' : 's'}`);
      if (skippedUnknown > 0) parts.push(`skipped ${skippedUnknown} unknown internal_code${skippedUnknown === 1 ? '' : 's'}`);
      if (failed > 0) parts.push(`${failed} row${failed === 1 ? '' : 's'} failed`);
      setSummary(parts.join(' · '));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div
        className={styles.modal}
        style={{ width: 'min(560px, 95vw)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.modalHeader}>
          <h3 className={styles.modalTitle}>Import Bindings (CSV / Excel)</h3>
          <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Close">
            <X {...ICON} />
          </button>
        </header>
        <div className={styles.modalBody}>
          <p style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', marginBottom: 'var(--space-3)' }}>
            Upload a CSV or Excel file exported via <strong>Export Bindings</strong>. Rows whose
            <code> internal_code </code>matches an existing binding are
            <strong> updated</strong>; unknown codes are <strong>skipped</strong>
            (no auto-create — use the SKU Mappings dialog to add new bindings).
          </p>
          <input
            type="file"
            accept=".csv,.xlsx,.xls,text/csv"
            disabled={running}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            style={{ marginBottom: 'var(--space-3)' }}
          />
          {progress.total > 0 && (
            <p style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
              Updating {progress.done} / {progress.total}…
            </p>
          )}
          {summary && (
            <p style={{
              fontSize: 'var(--fs-13)',
              color: 'var(--c-ink)',
              padding: 'var(--space-2) var(--space-3)',
              background: 'var(--c-paper)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-md)',
              marginTop: 'var(--space-2)',
            }}>
              {summary}
            </p>
          )}
        </div>
        <footer className={styles.modalFooter}>
          <Button variant="ghost" size="md" onClick={onClose} disabled={running}>
            {summary ? 'Close' : 'Cancel'}
          </Button>
          <Button variant="primary" size="md" onClick={run} disabled={!file || running}>
            {running ? 'Importing…' : 'Import'}
          </Button>
        </footer>
      </div>
    </div>
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
              <td className={styles.codeCell}>
                <Link to={`/scm/purchase-orders?focus=${po.id}`} style={{ color: 'inherit' }}>
                  {po.poNo}
                </Link>
              </td>
              <td className={styles.muted}>{po.status}</td>
              <td className={`${styles.tableRight} ${styles.muted}`}>{po.orderedQty}</td>
              <td className={`${styles.tableRight} ${styles.muted}`}>{po.receivedQty}</td>
              <td className={styles.priceCell}>{fmtRm(po.totalCenti)}</td>
              <td className={styles.muted}>{fmtDate(po.expectedDate)}</td>
              <td className={styles.muted}>{fmtDate(po.receivedDate)}</td>
              <td>
                <span
                  className={
                    delta.tone === 'ok'
                      ? styles.deltaOk
                      : delta.tone === 'late'
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
   SKU form modal — create or edit a supplier_material_binding
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
  const notify = useNotify();
  /* PR — Commander 2026-05-27 ("为什么不能 auto-bind"): when commander types
     an internal SKU code and the supplier_sku field is still empty, look up
     the SKU row in the mfg_products cache and auto-derive the supplier_sku
     using composeSupplierSku() — same per-SKU suffix rule the Model-first
     picker uses. The user can still overwrite the autofill manually. We
     don't stomp an existing supplier_sku and don't run in edit mode. */
  const products = useMfgProducts();

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
          materialKind: 'mfg_product',
          materialCode: '',
          materialName: '',
          supplierSku: '',
          unitPriceCenti: 0,
          currency: 'MYR',
          leadTimeDays: 0,
          moq: 0,
          isMainSupplier: false,
        },
  );

  /* Lazy lookup by code. The mfg_products cache is module-shared across the
     page (the SKU mappings table + the Model picker already use it), so
     reading from it here is free. Returns null when the typed code isn't a
     known internal SKU — keeps the autofill no-op for free-text material
     codes (raw / fabric / one-off accessory). */
  const findProductByCode = (code: string): MfgProductRow | null => {
    if (!code.trim()) return null;
    const wanted = code.trim().toUpperCase();
    return (products.data ?? []).find((p) => (p.code ?? '').toUpperCase() === wanted) ?? null;
  };

  /* Auto-bind supplier_sku once the typed internal code resolves to a known
     mfg_products row AND the user hasn't already typed something into the
     Supplier SKU field. Only fires for the create flow (editing === null);
     editing an existing binding leaves the supplier_sku alone. */
  const supplierSkuRef = useRef(draft.supplierSku);
  supplierSkuRef.current = draft.supplierSku;
  useEffect(() => {
    if (editing) return;
    if (draft.materialKind !== 'mfg_product') return;
    if (supplierSkuRef.current.trim()) return;
    const p = findProductByCode(draft.materialCode);
    if (!p) return;
    const next = composeSupplierSku(draft.materialCode, p);
    if (!next || next === supplierSkuRef.current) return;
    setDraft((s) => ({
      ...s,
      // Also seed materialName from the resolved product if it was blank,
      // so the user doesn't have to retype the internal description.
      materialName: s.materialName.trim() || (p.name ?? s.materialName),
      supplierSku: next,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.materialCode, draft.materialKind, products.data, editing]);

  const submit = () => {
    if (!draft.materialCode.trim() || !draft.materialName.trim() || !draft.supplierSku.trim()) {
      notify({ title: 'Internal code, description and supplier SKU are required.', tone: 'error' });
      return;
    }
    if (editing) {
      update.mutate(
        { supplierId, bindingId: editing.id, ...draft },
        { onSuccess: onClose },
      );
    } else {
      create.mutate({ supplierId, ...draft }, { onSuccess: onClose });
    }
  };

  const set = <K extends keyof SkuDraft>(k: K, v: SkuDraft[K]) =>
    setDraft((s) => ({ ...s, [k]: v }));

  const pending = create.isPending || update.isPending;

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <header className={styles.modalHeader}>
          <h3 className={styles.modalTitle}>
            {editing ? 'Edit SKU Mapping' : 'Add SKU Mapping'}
          </h3>
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
                  onChange={(e) => set('materialKind', e.target.value as MaterialKind)}
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
                  onChange={(e) => set('currency', e.target.value as Currency)}
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
                onChange={(e) => set('materialCode', e.target.value)}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Supplier SKU *</span>
              <input
                className={styles.fieldInput}
                placeholder="Their code"
                value={draft.supplierSku}
                onChange={(e) => set('supplierSku', e.target.value)}
              />
            </label>

            <label className={`${styles.field} ${styles.formGridFull}`}>
              <span className={styles.fieldLabel}>Internal Description *</span>
              <input
                className={styles.fieldInput}
                placeholder="e.g. HILTON BEDFRAME (6FT)"
                value={draft.materialName}
                onChange={(e) => set('materialName', e.target.value)}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Unit Price</span>
              <MoneyInput
                bare
                valueSen={draft.unitPriceCenti}
                inputClassName={styles.fieldInput}
                align="left"
                onCommit={(sen) => set('unitPriceCenti', sen ?? 0)}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Lead Time (days)</span>
              <input
                type="number"
                className={styles.fieldInput}
                value={draft.leadTimeDays}
                onChange={(e) => set('leadTimeDays', Number(e.target.value) || 0)}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>MOQ</span>
              <input
                type="number"
                className={styles.fieldInput}
                value={draft.moq}
                onChange={(e) => set('moq', Number(e.target.value) || 0)}
              />
            </label>

            <div className={`${styles.field} ${styles.formGridFull}`}>
              <label className={styles.checkRow}>
                <input
                  type="checkbox"
                  checked={draft.isMainSupplier}
                  onChange={(e) => set('isMainSupplier', e.target.checked)}
                />
                <span className={styles.fieldLabel} style={{ margin: 0 }}>
                  Set as MAIN supplier for this material
                </span>
              </label>
            </div>
          </div>
        </div>

        <footer className={styles.modalFooter}>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" onClick={submit} disabled={pending}>
            {pending ? 'Saving…' : editing ? 'Save Changes' : 'Add Mapping'}
          </Button>
        </footer>
      </div>
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Supplier Info card with inline edit (all fields)
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
  const notify = useNotify();
  // Owner spec 2026-06-12 — maintained Supply Category pool, for rendering
  // the stored comma-joined list with canonical casing.
  const categoryPool = useSupplierCategoryPool();
  /* PR #40 — full master record form (Commander 2026-05-26 AutoCount parity) */
  const [form, setForm] = useState({
    code: supplier.code,                                     // Credit Account
    name: supplier.name,                                     // Company Name
    supplierType: supplier.supplier_type ?? '',              // 'Matrix', etc
    category: supplier.category ?? '',                       // 'Bedframe', 'Fabric', ...
    tinNumber: supplier.tin_number ?? '',
    businessRegNo: supplier.business_reg_no ?? '',
    contactPerson: supplier.contact_person ?? '',
    attention: supplier.attention ?? '',
    email: supplier.email ?? '',
    phone: supplier.phone ?? '',
    mobile: supplier.mobile ?? '',
    fax: supplier.fax ?? '',
    website: supplier.website ?? '',
    whatsappNumber: supplier.whatsapp_number ?? '',
    paymentTerms: supplier.payment_terms ?? '',
    address: supplier.address ?? '',
    postcode: supplier.postcode ?? '',
    area: supplier.area ?? '',
    state: supplier.state ?? '',
    country: supplier.country ?? 'Malaysia',
    businessNature: supplier.business_nature ?? '',
    notes: supplier.notes ?? '',
  });

  const setF = (k: keyof typeof form, v: string) => setForm((s) => ({ ...s, [k]: v }));

  const save = () => {
    update.mutate({ id: supplier.id, ...form } as Partial<SupplierRow> & { id: string }, {
      onSuccess: onClose,
      // Never fail silently (Commander 2026-06-16 — "Save 没有反应"): surface the
      // real error so a server reject (e.g. a stale DB constraint) is visible.
      onError: (err) => notify({ title: 'Save failed', body: `${err instanceof Error ? err.message : String(err)}`, tone: 'error' }),
    });
  };

  /* Collapsible panel — click the header bar to fold the whole info grid
     away (chevron flips). Persisted per panel in localStorage. Entering
     edit mode force-expands so the form is never hidden mid-edit. */
  const [open, toggleOpen] = usePersistedOpen('panel-supplier-info');
  const bodyVisible = open || editing;

  return (
    <section className={styles.card}>
      <header
        className={styles.cardHeader}
        onClick={toggleOpen}
        aria-expanded={bodyVisible}
        title={bodyVisible ? 'Click to collapse' : 'Click to expand'}
        style={{ cursor: 'pointer', userSelect: 'none' }}
      >
        <h2 className={styles.cardTitle}>
          {bodyVisible
            ? <ChevronDown {...SM_ICON} style={{ color: 'var(--fg-muted)' }} />
            : <ChevronRight {...SM_ICON} style={{ color: 'var(--fg-muted)' }} />}
          Supplier Info
        </h2>
        {/* stopPropagation so the Edit / Save / Cancel buttons don't also
            toggle the collapse state. */}
        <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
          {!editing ? (
            <Button variant="ghost" size="sm" onClick={onEdit}>
              <Pencil {...ICON} />
              <span>Edit</span>
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={save} disabled={update.isPending}>
                <Save {...ICON} />
                <span>{update.isPending ? 'Saving…' : 'Save'}</span>
              </Button>
            </>
          )}
        </span>
      </header>
      {bodyVisible && (
      <div className={styles.cardBody}>
        {!editing ? (
          <div className={styles.infoGrid}>
            <InfoCell label="Credit Account" value={supplier.code} />
            <InfoCell label="Company Name" value={supplier.name} />
            <InfoCell label="Supplier Type" value={supplier.supplier_type ?? '—'} />
            <InfoCell
              label="Supply Category"
              value={displaySupplierCategories(supplier.category, categoryPool) || '—'}
            />
            <InfoCell label="TIN Number" value={supplier.tin_number ?? '—'} />
            <InfoCell label="Business Reg No" value={supplier.business_reg_no ?? '—'} />
            <InfoCell label="Contact Person" value={supplier.contact_person ?? '—'} />
            <InfoCell label="Attention" value={supplier.attention ?? '—'} />
            <InfoCell label="Email" value={supplier.email ?? '—'} />
            {/* Task #91 — formatPhone() displays stored E.164 as the pretty
                Malaysian convention. Fax intentionally left raw (rarely MY-
                formatted), as does an empty value which renders as "—". */}
            <InfoCell label="Phone" value={supplier.phone ? formatPhone(supplier.phone) : '—'} />
            <InfoCell label="Mobile" value={supplier.mobile ? formatPhone(supplier.mobile) : '—'} />
            <InfoCell label="Fax" value={supplier.fax ?? '—'} />
            <InfoCell label="WhatsApp" value={supplier.whatsapp_number ? formatPhone(supplier.whatsapp_number) : '—'} />
            <InfoCell label="Website" value={supplier.website ?? '—'} />
            <InfoCell label="Payment Terms" value={supplier.payment_terms ?? '—'} />
            <InfoCell label="Currency" value={supplier.currency} />
            <InfoCell label="Country" value={supplier.country ?? 'Malaysia'} />
            <InfoCell label="State" value={supplier.state ?? '—'} />
            <InfoCell label="Postcode" value={supplier.postcode ?? '—'} />
            <InfoCell label="Area" value={supplier.area ?? '—'} />
            <InfoCell label="Business Nature" value={supplier.business_nature ?? '—'} />
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
            <EditField label="Credit Account *" value={form.code} onChange={(v) => setF('code', v)} />
            <EditField label="Company Name *" value={form.name} onChange={(v) => setF('name', v)} />
            <EditField label="Supplier Type" value={form.supplierType} onChange={(v) => setF('supplierType', v)} placeholder="Matrix / Distributor / Maker" />
            {/* Owner spec 2026-06-12 — Supply Category is a multi-select chip
                toggle fed by the maintained pool (a supplier can supply
                multiple categories; stored comma-joined). The Pricing tab
                still gates its maintenance sub-tabs off the derived single
                category (multi → every section shows). */}
            <SupplyCategoryPicker
              value={form.category}
              onChange={(v) => setF('category', v)}
              fieldClassName={styles.field}
              labelClassName={styles.fieldLabel}
            />
            <EditField label="TIN Number" value={form.tinNumber} onChange={(v) => setF('tinNumber', v)} />
            <EditField label="Business Reg No" value={form.businessRegNo} onChange={(v) => setF('businessRegNo', v)} />
            {/* Contact */}
            <EditField label="Contact Person" value={form.contactPerson} onChange={(v) => setF('contactPerson', v)} />
            <EditField label="Attention" value={form.attention} onChange={(v) => setF('attention', v)} />
            <EditField label="Email" value={form.email} onChange={(v) => setF('email', v)} />
            {/* Task #91 — phone/mobile/WhatsApp use the unified phone field so
                they normalize to E.164 on blur. Fax stays plain (non-MY format,
                edge case). */}
            <PhoneEditField label="Phone" value={form.phone} onChange={(v) => setF('phone', v)} />
            <PhoneEditField label="Mobile" value={form.mobile} onChange={(v) => setF('mobile', v)} />
            <EditField label="Fax" value={form.fax} onChange={(v) => setF('fax', v)} />
            <PhoneEditField label="WhatsApp" value={form.whatsappNumber} onChange={(v) => setF('whatsappNumber', v)} />
            <EditField label="Website" value={form.website} onChange={(v) => setF('website', v)} />
            {/* Commercial */}
            <PaymentTermsSelect value={form.paymentTerms} onChange={(v) => setF('paymentTerms', v)} />
            <EditField label="Business Nature" value={form.businessNature} onChange={(v) => setF('businessNature', v)} />
            {/* Address — PR #47: Country + State cascade */}
            <CountrySelect value={form.country} onChange={(v) => {
              setF('country', v);
              // Reset state if country changes (states are country-specific)
              if (v !== form.country) setF('state', '');
            }} />
            <StateSelect country={form.country} value={form.state} onChange={(v) => setF('state', v)} />
            <EditField label="Area" value={form.area} onChange={(v) => setF('area', v)} />
            <EditField label="Postcode" value={form.postcode} onChange={(v) => setF('postcode', v)} />
            <EditField label="Billing Address" value={form.address} onChange={(v) => setF('address', v)} multiline />
            <EditField label="Notes" value={form.notes} onChange={(v) => setF('notes', v)} multiline />
          </div>
        )}
      </div>
      )}
    </section>
  );
};

const EditField = ({
  label, value, onChange, multiline, placeholder,
}: {
  label: string; value: string; onChange: (v: string) => void;
  multiline?: boolean; placeholder?: string;
}) => (
  <label className={`${styles.field} ${multiline ? styles.formGridFull : ''}`}>
    <span className={styles.fieldLabel}>{label}</span>
    {multiline ? (
      <textarea
        className={styles.fieldInput}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ minHeight: 60, resize: 'vertical' }}
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

/* Task #91 — Phone variant of EditField. Wraps PhoneInput with the same
   label/field styling so it slots into the supplier grid without disruption. */
const PhoneEditField = ({
  label, value, onChange,
}: {
  label: string; value: string; onChange: (v: string) => void;
}) => (
  <label className={styles.field}>
    <span className={styles.fieldLabel}>{label}</span>
    <PhoneInput className={styles.fieldInput} value={value} onChange={onChange} />
  </label>
);

/* ════════════════════════════════════════════════════════════════════════
   ModelSkuPickerDialog — supplier-mapping-by-model (Commander 2026-05-27).

   The original per-SKU multi-select picker (kept below as the legacy
   MultiSkuPickerDialog and reachable via "Advanced (per-SKU)") made commander
   tick every size + handedness variant under a Model one by one
   (BOOQIT-1A(LHF), -1A(RHF), -1B(LHF) …) and type a supplier code N times.
   New default flow:

     Step 1  Pick Model(s)  ─ filter by category, multi-select Models. Each
                              row shows: model_code · name · #SKUs · binding
                              status ("not mapped" / "mixed N/T" / "all").
     Step 2  Fill code      ─ ONE row per Model. Supplier code, unit price,
                              lead time, MOQ, main toggle. Same values fan
                              out across every ACTIVE SKU under that Model.
     Save                   ─ Per Model, expand the picked supplier-code
                              over every ACTIVE SKU under that model_id and
                              POST them via the existing /bindings/batch
                              endpoint (which de-dupes against bindings
                              already present for this supplier).

   No schema change. supplier_material_bindings stays per-SKU; this is purely
   a write-path convenience over the existing storage. The retreat hatch is
   the Advanced toggle which restores the per-SKU picker for the rare case
   where one Model genuinely needs different supplier codes per size variant.
   ════════════════════════════════════════════════════════════════════════ */

const MODEL_CATEGORY_CHIPS: { value: 'all' | MfgCategory; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'BEDFRAME', label: 'Bedframe' },
  { value: 'SOFA', label: 'Sofa' },
  { value: 'MATTRESS', label: 'Mattress' },
  { value: 'ACCESSORY', label: 'Accessory' },
  { value: 'SERVICE', label: 'Service' },
];

type ModelDraft = {
  modelId: string;
  modelCode: string;
  modelName: string;
  category: MfgCategory;
  /** PR — Commander 2026-05-27: full SKU rows (not just codes) so the
      preview / save path can derive a per-SKU `supplier_sku` suffix via
      composeSupplierSku(). Previously held string[] which lost size_code /
      category context. */
  skus: MfgProductRow[];
  alreadyBoundCodes: string[]; // subset of sku codes already bound for this supplier
  supplierCode: string;
  // PR — Commander follow-up to PR #206: free-text description the supplier
  // uses for that model line (e.g. "Foam B grade, 6-week lead"). Persisted
  // into supplier_material_bindings.notes for every SKU fanned out from
  // this Model. Same value applied across the batch.
  description: string;
  unitPriceCenti: number;
  leadTimeDays: number;
  moq: number;
  isMainSupplier: boolean;
};

/** Build the "status" badge text for a Model: not mapped / mixed N/T / all. */
function bindingStatus(skuCount: number, boundCount: number): {
  tone: 'none' | 'mixed' | 'all';
  label: string;
} {
  if (boundCount === 0) return { tone: 'none', label: 'not mapped' };
  if (boundCount >= skuCount) return { tone: 'all', label: `all ${skuCount} mapped` };
  return { tone: 'mixed', label: `mixed ${boundCount}/${skuCount}` };
}

const ModelSkuPickerDialog = ({
  supplierId,
  existingBindings,
  supplierCategory,
  onClose,
}: {
  supplierId: string;
  existingBindings: BindingRow[];
  /** PR #208 — pre-filter the Model picker to the supplier's category so
   *  e.g. sofa Models don't appear for a bedframe supplier. Null/MIXED =
   *  no filter (the chip row defaults to "All"). */
  supplierCategory: SupplierCategory | null;
  onClose: () => void;
}) => {
  const batch = useCreateBindingsBatch();
  const notify = useNotify();
  const [step, setStep] = useState<1 | 2>(1);
  // PR #208 — seed the category chip from the supplier's category. Commander
  // can still flip to "All" if they need to bind a Model from another category
  // (rare — flagged by the chip row staying visible).
  const initialCategory: 'all' | MfgCategory =
    mfgCategoryFromSupplierCategory(supplierCategory) ?? 'all';
  const [category, setCategory] = useState<'all' | MfgCategory>(initialCategory);
  const [search, setSearch] = useState('');
  const [advanced, setAdvanced] = useState(false);

  // We fetch BOTH Models (for the picker) and ALL active SKUs (so we can
  // group SKUs by model_id client-side and compute "already bound" status
  // per Model without N round-trips). Both queries are short-listed —
  // 2990's catalogue has < a few hundred Models / SKUs.
  const modelsQ = useProductModels(
    category === 'all' ? undefined : { category },
  );
  const productsQ = useMfgProducts(
    category === 'all' ? undefined : { category },
  );

  /* Index SKUs by model_id so we can compute count + already-bound per Model
     in a single pass. Orphan SKUs (model_id NULL) are intentionally ignored
     here — they're only reachable via the Advanced (per-SKU) toggle. */
  const skusByModel = useMemo(() => {
    const map = new Map<string, MfgProductRow[]>();
    for (const p of productsQ.data ?? []) {
      if (!p.model_id) continue;
      const arr = map.get(p.model_id) ?? [];
      arr.push(p);
      map.set(p.model_id, arr);
    }
    return map;
  }, [productsQ.data]);

  const boundCodes = useMemo(
    () => new Set(existingBindings.map((b) => `${b.material_kind}|${b.material_code}`)),
    [existingBindings],
  );

  /* Filtered Model rows with their pre-computed counts + binding status. */
  const modelRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (modelsQ.data ?? []).filter((m) => {
      // Show inactive Models too (purchaser 2026-06: "price info did not show
      // item active or no"). They render dimmed + "Inactive" and are not
      // pickable (you don't map prices on a deactivated item) — but visible.
      if (!q) return true;
      return (
        m.model_code.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        (m.branding ?? '').toLowerCase().includes(q)
      );
    });
    return list.map((m) => {
      const skus = skusByModel.get(m.id) ?? [];
      const bound = skus.filter((s) => boundCodes.has(`mfg_product|${s.code}`));
      return { model: m, skus, boundCount: bound.length };
    });
  }, [modelsQ.data, skusByModel, search, boundCodes]);

  const [pickedIds, setPickedIds] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, ModelDraft>>({});
  // PR — Commander 2026-05-27 follow-up: per-Model SKU-preview expander so
  // commander can see exactly which internal SKU codes are about to be
  // bulk-mapped under one supplier code before pressing Save. Collapsed by
  // default to keep step 2 scannable for a 5+ Model batch.
  const [expandedSkuPreview, setExpandedSkuPreview] = useState<Set<string>>(new Set());
  const toggleSkuPreview = (modelId: string) => {
    setExpandedSkuPreview((s) => {
      const next = new Set(s);
      if (next.has(modelId)) next.delete(modelId); else next.add(modelId);
      return next;
    });
  };

  const togglePick = (m: ProductModelRow, skus: MfgProductRow[]) => {
    setPickedIds((s) => {
      const next = new Set(s);
      if (next.has(m.id)) next.delete(m.id);
      else if (skus.length > 0) next.add(m.id);
      return next;
    });
  };

  const pickedCount = pickedIds.size;

  const goNext = () => {
    const seeded: Record<string, ModelDraft> = {};
    for (const id of pickedIds) {
      const row = modelRows.find((r) => r.model.id === id);
      if (!row) continue;
      const existing = drafts[id];
      // Seed unitPrice from the average base_price_sen of the Model's SKUs
      // (decent default for commander; he can edit it).
      const prices = row.skus
        .map((s) => s.base_price_sen ?? 0)
        .filter((v) => v > 0);
      const avgPrice = prices.length
        ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length)
        : 0;
      seeded[id] = existing ?? {
        modelId: row.model.id,
        modelCode: row.model.model_code,
        modelName: row.model.name,
        category: row.model.category,
        skus: row.skus,
        alreadyBoundCodes: row.skus
          .filter((s) => boundCodes.has(`mfg_product|${s.code}`))
          .map((s) => s.code),
        supplierCode: '',
        description: '',
        unitPriceCenti: avgPrice,
        leadTimeDays: 7,
        moq: 1,
        isMainSupplier: false,
      };
    }
    setDrafts(seeded);
    setStep(2);
  };

  const setDraft = (id: string, patch: Partial<ModelDraft>) => {
    setDrafts((s) => ({ ...s, [id]: { ...s[id]!, ...patch } }));
  };

  const submit = () => {
    const list: NewBinding[] = [];
    for (const d of Object.values(drafts)) {
      const code = d.supplierCode.trim();
      // Skip Models with no supplier code (commander left the field empty —
      // safer than auto-defaulting to the internal code which produces N
      // misleading rows).
      if (!code) continue;
      for (const sku of d.skus) {
        // Skip SKUs already bound for this supplier; the batch endpoint also
        // de-dupes server-side but pre-filtering keeps the inserted/skipped
        // counts accurate for the toast.
        if (d.alreadyBoundCodes.includes(sku.code)) continue;
        // PR — Commander 2026-05-27: per-SKU supplier_sku auto-suffix.
        // composeSupplierSku("5539", sofaSku) → "5539-1A(LHF)" etc., instead
        // of writing the literal model-level code into every binding row.
        const supplierSku = composeSupplierSku(code, sku);
        list.push({
          materialKind: 'mfg_product' as MaterialKind,
          materialCode: sku.code,
          materialName: sku.name ?? sku.code,
          supplierSku,
          unitPriceCenti: d.unitPriceCenti,
          currency: 'MYR' as Currency,
          leadTimeDays: d.leadTimeDays,
          moq: d.moq,
          isMainSupplier: d.isMainSupplier,
          // PR — description fans out across every SKU under this Model.
          // Empty string → undefined so we don't overwrite an existing null
          // with "".
          notes: d.description.trim() || undefined,
        });
      }
    }
    if (list.length === 0) { onClose(); return; }
    batch.mutate({ supplierId, bindings: list }, {
      onSuccess: async (res) => {
        if (res.skipped > 0) {
          await notify({
            title:
              `Inserted ${res.inserted} SKU mapping${res.inserted === 1 ? '' : 's'}; ` +
              `skipped ${res.skipped} already bound.`,
          });
        }
        onClose();
      },
    });
  };

  // The Advanced toggle swaps in the legacy per-SKU picker, kept verbatim
  // below so it's still available when one Model needs different supplier
  // codes per size variant.
  if (advanced) {
    return (
      <MultiSkuPickerDialog
        supplierId={supplierId}
        existingBindings={existingBindings}
        onClose={onClose}
      />
    );
  }

  const loading = modelsQ.isLoading || productsQ.isLoading;

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div
        className={styles.modal}
        style={{ width: 'min(900px, 95vw)', maxHeight: '90vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.modalHeader}>
          <h3 className={styles.modalTitle}>
            {step === 1
              ? `Pick Model(s) to map · ${pickedCount} selected`
              : `Supplier codes by Model · ${pickedCount} Model${pickedCount === 1 ? '' : 's'}`}
          </h3>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <label
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', cursor: 'pointer',
              }}
              title="Switch to per-SKU picker (for Models needing different codes per size)"
            >
              <input
                type="checkbox"
                checked={false}
                onChange={() => setAdvanced(true)}
              />
              Advanced (per-SKU)
            </label>
            <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Close">
              <X {...ICON} />
            </button>
          </span>
        </header>

        {step === 1 ? (
          <>
            <div className={styles.modalBody} style={{ paddingBottom: 'var(--space-3)' }}>
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center', marginBottom: 'var(--space-3)' }}>
                {MODEL_CATEGORY_CHIPS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => setCategory(c.value)}
                    style={{
                      fontFamily: 'var(--font-button)', fontSize: 'var(--fs-13)', fontWeight: 600,
                      padding: 'var(--space-2) var(--space-3)',
                      borderRadius: 'var(--radius-pill)',
                      border: category === c.value ? '1px solid var(--c-ink)' : '1px solid var(--line)',
                      background: category === c.value ? 'var(--c-ink)' : 'var(--c-paper)',
                      color: category === c.value ? 'var(--c-cream)' : 'var(--c-ink)',
                      cursor: 'pointer',
                    }}
                  >
                    {c.label}
                  </button>
                ))}
                <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
                  <Search {...ICON} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--fg-muted)', pointerEvents: 'none' }} />
                  <input
                    type="search"
                    placeholder="Search Model code / name / branding…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    style={{
                      width: '100%', fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-14)',
                      background: 'var(--c-paper)', border: '1px solid var(--line)',
                      borderRadius: 'var(--radius-md)',
                      padding: 'var(--space-2) var(--space-3) var(--space-2) var(--space-7)',
                      outline: 'none',
                    }}
                  />
                </div>
              </div>
              <div style={{ maxHeight: '50vh', overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)' }}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}></th>
                      <th>Model Code</th>
                      <th>Name</th>
                      <th>Category</th>
                      <th className={styles.tableRight}>SKUs</th>
                      <th>Mapping status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading && (
                      <tr><td colSpan={6} className={styles.emptyRow}>Loading…</td></tr>
                    )}
                    {!loading && modelRows.length === 0 && (
                      <tr><td colSpan={6} className={styles.emptyRow}>No Models match.</td></tr>
                    )}
                    {!loading && modelRows.map(({ model, skus, boundCount }) => {
                      const isPicked = pickedIds.has(model.id);
                      const inactive = !model.active;
                      const noSkus = skus.length === 0;
                      const fullyBound = boundCount >= skus.length && skus.length > 0;
                      const disabled = inactive || noSkus || fullyBound;
                      const status = bindingStatus(skus.length, boundCount);
                      return (
                        <tr
                          key={model.id}
                          onClick={() => !disabled && togglePick(model, skus)}
                          style={{
                            cursor: disabled ? 'not-allowed' : 'pointer',
                            opacity: disabled ? 0.4 : 1,
                            background: isPicked ? 'rgba(232, 107, 58, 0.06)' : undefined,
                          }}
                          title={
                            inactive
                              ? 'Model is inactive — activate it in SKU Master before mapping prices'
                              : noSkus
                                ? 'No active SKUs under this Model'
                                : fullyBound
                                  ? 'All SKUs under this Model already mapped'
                                  : ''
                          }
                        >
                          <td>
                            <input
                              type="checkbox"
                              checked={isPicked}
                              disabled={disabled}
                              onChange={() => togglePick(model, skus)}
                              onClick={(e) => e.stopPropagation()}
                            />
                          </td>
                          <td className={styles.codeCell}>{model.model_code}</td>
                          <td>
                            {model.name}
                            {inactive && (
                              <span style={{ marginLeft: 6, fontSize: 'var(--fs-11)', fontWeight: 700, color: 'var(--c-burnt)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                                · Inactive
                              </span>
                            )}
                          </td>
                          <td className={styles.muted}>{model.category}</td>
                          <td className={`${styles.tableRight} ${styles.muted}`}>{skus.length}</td>
                          <td>
                            <span
                              style={{
                                fontSize: 'var(--fs-12)',
                                fontWeight: 600,
                                color:
                                  status.tone === 'all'
                                    ? 'var(--c-secondary-a, #2F5D4F)'
                                    : status.tone === 'mixed'
                                      ? 'var(--c-burnt)'
                                      : 'var(--fg-muted)',
                              }}
                            >
                              {status.label}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <footer className={styles.modalFooter}>
              <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
              <Button variant="primary" size="md" onClick={goNext} disabled={pickedCount === 0}>
                <span>Next · Fill supplier codes ({pickedCount})</span>
              </Button>
            </footer>
          </>
        ) : (
          <>
            <div className={styles.modalBody} style={{ paddingBottom: 'var(--space-3)' }}>
              {/* Commander 2026-06-16 — trimmed the intro + 6-bullet explainer
                  ("提示词太多了"): the column headers + placeholders already say
                  what to type. Keep ONE short line for context. */}
              <p className={styles.infoLabel} style={{ marginBottom: 'var(--space-2)' }}>
                Fill each Model's supplier code + note. Save binds every active SKU under it (same code + price). Prices here are COST, not selling.
              </p>
              <div style={{ maxHeight: '50vh', overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)' }}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Model · #SKUs</th>
                      <th>Supplier Code</th>
                      <th>Description</th>
                      <th className={styles.tableRight}>Unit Price (RM)</th>
                      <th className={styles.tableRight}>Lead (d)</th>
                      <th className={styles.tableRight}>MOQ</th>
                      <th>Main</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.values(drafts).map((d) => {
                      const remaining = d.skus.length - d.alreadyBoundCodes.length;
                      const expanded = expandedSkuPreview.has(d.modelId);
                      const skusToMap = d.skus.filter((s) => !d.alreadyBoundCodes.includes(s.code));
                      const toMap = skusToMap.map((s) => s.code);
                      // PR — Commander 2026-05-27: compute the per-SKU
                      // supplier_sku preview so commander sees
                      // "BOOQIT-1A(LHF) → 5539-1A(LHF)" before Save.
                      const previewMap = d.supplierCode.trim()
                        ? Object.fromEntries(
                            skusToMap.map((s) => [s.code, composeSupplierSku(d.supplierCode, s)]),
                          )
                        : undefined;
                      return (
                        <Fragment key={d.modelId}>
                          <tr>
                            <td>
                              <div className={styles.codeCell}>{d.modelCode}</div>
                              <div className={styles.muted}>{d.modelName}</div>
                              {/* PR — SKU preview expander. Click "N SKUs" to
                                  see exactly which internal codes get fanned
                                  out under this supplier mapping. Collapsed
                                  by default so step 2 stays scannable. */}
                              <button
                                type="button"
                                onClick={() => toggleSkuPreview(d.modelId)}
                                className={styles.muted}
                                style={{
                                  background: 'transparent',
                                  border: 'none',
                                  padding: 0,
                                  marginTop: 2,
                                  fontSize: 'var(--fs-12)',
                                  cursor: d.skus.length === 0 ? 'default' : 'pointer',
                                  color: expanded ? 'var(--c-burnt)' : 'var(--fg-muted)',
                                  textDecoration: 'underline',
                                  textUnderlineOffset: 2,
                                }}
                                title={expanded ? 'Hide SKU list' : 'Show SKU list'}
                              >
                                {expanded ? '▾' : '▸'} {remaining} of {d.skus.length} SKUs to map
                                {d.alreadyBoundCodes.length > 0 ? ` (${d.alreadyBoundCodes.length} already)` : ''}
                              </button>
                            </td>
                            <td>
                              <input
                                value={d.supplierCode}
                                onChange={(e) => setDraft(d.modelId, { supplierCode: e.target.value })}
                                placeholder="Their code for the whole Model"
                                style={smallInputStyle}
                              />
                            </td>
                            <td>
                              <input
                                value={d.description}
                                onChange={(e) => setDraft(d.modelId, { description: e.target.value })}
                                placeholder='e.g. "Foam B grade, 6-week lead"'
                                style={{ ...smallInputStyle, width: '100%', minWidth: 180 }}
                              />
                            </td>
                            <td className={styles.tableRight}>
                              <MoneyInput
                                bare
                                valueSen={d.unitPriceCenti}
                                onCommit={(sen) => setDraft(d.modelId, { unitPriceCenti: sen ?? 0 })}
                                style={{ ...smallInputStyle, width: 100, textAlign: 'right' }}
                              />
                            </td>
                            <td className={styles.tableRight}>
                              <input
                                type="number"
                                value={d.leadTimeDays}
                                onChange={(e) => setDraft(d.modelId, { leadTimeDays: Number(e.target.value) || 0 })}
                                style={{ ...smallInputStyle, width: 60, textAlign: 'right' }}
                              />
                            </td>
                            <td className={styles.tableRight}>
                              <input
                                type="number"
                                value={d.moq}
                                onChange={(e) => setDraft(d.modelId, { moq: Number(e.target.value) || 0 })}
                                style={{ ...smallInputStyle, width: 60, textAlign: 'right' }}
                              />
                            </td>
                            <td>
                              <input
                                type="checkbox"
                                checked={d.isMainSupplier}
                                onChange={(e) => setDraft(d.modelId, { isMainSupplier: e.target.checked })}
                              />
                            </td>
                          </tr>
                          {expanded && d.skus.length > 0 && (
                            <tr>
                              <td colSpan={7} style={{
                                background: 'var(--c-cream)',
                                padding: 'var(--space-2) var(--space-3)',
                                borderTop: '1px dashed var(--line)',
                              }}>
                                <SkuPreviewStrip
                                  toMap={toMap}
                                  alreadyBound={d.alreadyBoundCodes}
                                  previewMap={previewMap}
                                />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <footer className={styles.modalFooter}>
              <Button variant="ghost" size="md" onClick={() => setStep(1)}>← Back</Button>
              <Button variant="primary" size="md" onClick={submit} disabled={batch.isPending}>
                {batch.isPending
                  ? 'Saving…'
                  : `Save ${pickedCount} Model${pickedCount === 1 ? '' : 's'}`}
              </Button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Multi-SKU Picker — pick N products from mfg_products, then fill in
   supplier_sku / price / lead time / moq for each, batch-create.

   Legacy: kept available via "Advanced (per-SKU)" toggle in
   ModelSkuPickerDialog. Use when one Model needs different supplier codes
   per size variant. Default flow is the Model-first picker above.
   ════════════════════════════════════════════════════════════════════════ */

type MultiDraft = {
  materialCode: string;
  materialName: string;
  supplierSku: string;
  unitPriceCenti: number;
  leadTimeDays: number;
  moq: number;
  isMainSupplier: boolean;
};

const CATEGORY_CHIPS: { value: 'all' | MfgCategory; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'BEDFRAME', label: 'Bedframe' },
  { value: 'SOFA', label: 'Sofa' },
  { value: 'MATTRESS', label: 'Mattress' },
  { value: 'ACCESSORY', label: 'Accessory' },
  { value: 'SERVICE', label: 'Service' },
];

const MultiSkuPickerDialog = ({
  supplierId,
  existingBindings,
  onClose,
}: {
  supplierId: string;
  existingBindings: BindingRow[];
  onClose: () => void;
}) => {
  const batch = useCreateBindingsBatch();
  const notify = useNotify();
  const [step, setStep] = useState<1 | 2>(1);
  const [category, setCategory] = useState<'all' | MfgCategory>('all');
  const [search, setSearch] = useState('');
  const products = useMfgProducts({
    category: category === 'all' ? undefined : category,
    search: search.trim() || undefined,
  });

  const alreadyBound = useMemo(
    () => new Set(existingBindings.map((b) => `${b.material_kind}|${b.material_code}`)),
    [existingBindings],
  );

  const [picked, setPicked] = useState<Record<string, MfgProductRow>>({});
  const pickedCount = Object.keys(picked).length;
  const [drafts, setDrafts] = useState<Record<string, MultiDraft>>({});

  const toggleProduct = (p: MfgProductRow) => {
    if (alreadyBound.has(`mfg_product|${p.code}`)) return;
    setPicked((s) => {
      const next = { ...s };
      if (next[p.id]) delete next[p.id];
      else next[p.id] = p;
      return next;
    });
  };

  const goNext = () => {
    const seeded: Record<string, MultiDraft> = {};
    for (const p of Object.values(picked)) {
      seeded[p.code] = drafts[p.code] ?? {
        materialCode: p.code,
        materialName: p.name,
        supplierSku: '',
        unitPriceCenti: p.base_price_sen ?? 0,
        leadTimeDays: 7,
        moq: 1,
        isMainSupplier: false,
      };
    }
    setDrafts(seeded);
    setStep(2);
  };

  const setDraft = (code: string, patch: Partial<MultiDraft>) => {
    setDrafts((s) => ({ ...s, [code]: { ...s[code]!, ...patch } }));
  };

  const submit = () => {
    const list: NewBinding[] = Object.values(drafts).map((d) => ({
      materialKind: 'mfg_product' as MaterialKind,
      materialCode: d.materialCode,
      materialName: d.materialName,
      supplierSku: d.supplierSku.trim() || d.materialCode,
      unitPriceCenti: d.unitPriceCenti,
      currency: 'MYR' as Currency,
      leadTimeDays: d.leadTimeDays,
      moq: d.moq,
      isMainSupplier: d.isMainSupplier,
    }));
    if (list.length === 0) { onClose(); return; }
    batch.mutate({ supplierId, bindings: list }, {
      onSuccess: async (res) => {
        if (res.skipped > 0) {
          await notify({ title: `Inserted ${res.inserted} mapping${res.inserted === 1 ? '' : 's'}; skipped ${res.skipped} already bound.` });
        }
        onClose();
      },
    });
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div
        className={styles.modal}
        style={{ width: 'min(900px, 95vw)', maxHeight: '90vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.modalHeader}>
          <h3 className={styles.modalTitle}>
            {step === 1 ? `Pick products to map · ${pickedCount} selected` : `Fill in supplier codes · ${pickedCount} products`}
          </h3>
          <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Close">
            <X {...ICON} />
          </button>
        </header>

        {step === 1 ? (
          <>
            <div className={styles.modalBody} style={{ paddingBottom: 'var(--space-3)' }}>
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center', marginBottom: 'var(--space-3)' }}>
                {CATEGORY_CHIPS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => setCategory(c.value)}
                    style={{
                      fontFamily: 'var(--font-button)', fontSize: 'var(--fs-13)', fontWeight: 600,
                      padding: 'var(--space-2) var(--space-3)',
                      borderRadius: 'var(--radius-pill)',
                      border: category === c.value ? '1px solid var(--c-ink)' : '1px solid var(--line)',
                      background: category === c.value ? 'var(--c-ink)' : 'var(--c-paper)',
                      color: category === c.value ? 'var(--c-cream)' : 'var(--c-ink)',
                      cursor: 'pointer',
                    }}
                  >
                    {c.label}
                  </button>
                ))}
                <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
                  <Search {...ICON} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--fg-muted)', pointerEvents: 'none' }} />
                  <input
                    type="search"
                    placeholder="Search code / name / description…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    style={{
                      width: '100%', fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-14)',
                      background: 'var(--c-paper)', border: '1px solid var(--line)',
                      borderRadius: 'var(--radius-md)',
                      padding: 'var(--space-2) var(--space-3) var(--space-2) var(--space-7)',
                      outline: 'none',
                    }}
                  />
                </div>
              </div>
              <div style={{ maxHeight: '50vh', overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)' }}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}></th>
                      <th>Code</th>
                      <th>Description</th>
                      <th>Category</th>
                      <th>Size</th>
                      <th className={styles.tableRight}>Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.isLoading && (
                      <tr><td colSpan={6} className={styles.emptyRow}>Loading…</td></tr>
                    )}
                    {!products.isLoading && (products.data ?? []).length === 0 && (
                      <tr><td colSpan={6} className={styles.emptyRow}>No products match.</td></tr>
                    )}
                    {!products.isLoading && (products.data ?? []).map((p) => {
                      const bound = alreadyBound.has(`mfg_product|${p.code}`);
                      const isPicked = Boolean(picked[p.id]);
                      return (
                        <tr
                          key={p.id}
                          onClick={() => toggleProduct(p)}
                          style={{
                            cursor: bound ? 'not-allowed' : 'pointer',
                            opacity: bound ? 0.4 : 1,
                            background: isPicked ? 'rgba(232, 107, 58, 0.06)' : undefined,
                          }}
                          title={bound ? 'Already bound to this supplier' : ''}
                        >
                          <td>
                            <input
                              type="checkbox"
                              checked={isPicked}
                              disabled={bound}
                              onChange={() => toggleProduct(p)}
                              onClick={(e) => e.stopPropagation()}
                            />
                          </td>
                          <td className={styles.codeCell}>{p.code}</td>
                          <td>{p.name}</td>
                          <td className={styles.muted}>{p.category}</td>
                          <td className={styles.muted}>{p.size_label ?? '—'}</td>
                          <td className={styles.priceCell}>{p.base_price_sen ? `RM ${(p.base_price_sen / 100).toFixed(2)}` : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <footer className={styles.modalFooter}>
              <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
              <Button variant="primary" size="md" onClick={goNext} disabled={pickedCount === 0}>
                <span>Next · Fill supplier codes ({pickedCount})</span>
              </Button>
            </footer>
          </>
        ) : (
          <>
            <div className={styles.modalBody} style={{ paddingBottom: 'var(--space-3)' }}>
              <p className={styles.infoLabel} style={{ marginBottom: 'var(--space-3)' }}>
                Fill in each product's supplier-side code + price + lead time. Leave Supplier SKU blank to use our internal code.
              </p>
              <div style={{ maxHeight: '50vh', overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)' }}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Our Code · Name</th>
                      <th>Supplier SKU</th>
                      <th className={styles.tableRight}>Unit Price (RM)</th>
                      <th className={styles.tableRight}>Lead (d)</th>
                      <th className={styles.tableRight}>MOQ</th>
                      <th>Main</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.values(drafts).map((d) => (
                      <tr key={d.materialCode}>
                        <td>
                          <div className={styles.codeCell}>{d.materialCode}</div>
                          <div className={styles.muted}>{d.materialName}</div>
                        </td>
                        <td>
                          <input
                            value={d.supplierSku}
                            onChange={(e) => setDraft(d.materialCode, { supplierSku: e.target.value })}
                            placeholder="(blank = same as our code)"
                            style={smallInputStyle}
                          />
                        </td>
                        <td className={styles.tableRight}>
                          <MoneyInput
                            bare
                            valueSen={d.unitPriceCenti}
                            onCommit={(sen) => setDraft(d.materialCode, { unitPriceCenti: sen ?? 0 })}
                            style={{ ...smallInputStyle, width: 100, textAlign: 'right' }}
                          />
                        </td>
                        <td className={styles.tableRight}>
                          <input
                            type="number"
                            value={d.leadTimeDays}
                            onChange={(e) => setDraft(d.materialCode, { leadTimeDays: Number(e.target.value) || 0 })}
                            style={{ ...smallInputStyle, width: 60, textAlign: 'right' }}
                          />
                        </td>
                        <td className={styles.tableRight}>
                          <input
                            type="number"
                            value={d.moq}
                            onChange={(e) => setDraft(d.materialCode, { moq: Number(e.target.value) || 0 })}
                            style={{ ...smallInputStyle, width: 60, textAlign: 'right' }}
                          />
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            checked={d.isMainSupplier}
                            onChange={(e) => setDraft(d.materialCode, { isMainSupplier: e.target.checked })}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <footer className={styles.modalFooter}>
              <Button variant="ghost" size="md" onClick={() => setStep(1)}>← Back</Button>
              <Button variant="primary" size="md" onClick={submit} disabled={batch.isPending}>
                {batch.isPending ? 'Saving…' : `Save ${pickedCount} mapping${pickedCount === 1 ? '' : 's'}`}
              </Button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
};

/* SKU-preview chip strip shared by ModelSkuPickerDialog (SupplierDetail) and
   ModularAssignSupplierDialog (ProductModels). Renders the SKUs about to be
   bulk-mapped as monospaced pills + the ones being skipped as struck-through
   pills. Pure presentational — no state.

   PR — Commander 2026-05-27: optional `previewMap` shows the COMPUTED
   per-SKU `supplier_sku` next to the internal code so commander sees the
   final string before Save (e.g. `BOOQIT-1A(LHF) → 5539-1A(LHF)`). Falls
   back to the bare internal code for callers that don't pass a map. */
export function SkuPreviewStrip({
  toMap, alreadyBound, previewMap,
}: {
  toMap:         string[];
  alreadyBound:  string[];
  previewMap?:   Record<string, string>;
}) {
  return (
    <div style={{
      display: 'flex',
      flexWrap: 'wrap',
      gap: 6,
      alignItems: 'center',
    }}>
      <span style={{
        fontSize: 'var(--fs-11)',
        color: 'var(--fg-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        marginRight: 8,
      }}>
        Will bulk-map →
      </span>
      {toMap.length === 0 ? (
        <span style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-12)' }}>
          All SKUs already mapped.
        </span>
      ) : toMap.map((c) => {
        const resolved = previewMap?.[c];
        return (
          <code
            key={c}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-12)',
              background: 'var(--c-paper)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-sm)',
              padding: '2px 8px',
            }}
          >
            {c}
            {resolved && (
              <span style={{ color: 'var(--fg-muted)' }}>
                {' → '}
                <span style={{ color: 'var(--c-burnt)', fontWeight: 600 }}>{resolved}</span>
              </span>
            )}
          </code>
        );
      })}
      {alreadyBound.length > 0 && (
        <>
          <span style={{
            fontSize: 'var(--fs-11)',
            color: 'var(--fg-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            margin: '0 8px',
          }}>
            · skip (already bound):
          </span>
          {alreadyBound.map((c) => (
            <code
              key={c}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-12)',
                background: 'var(--c-cream)',
                border: '1px dashed var(--line)',
                borderRadius: 'var(--radius-sm)',
                padding: '2px 8px',
                color: 'var(--fg-muted)',
                textDecoration: 'line-through',
              }}
            >
              {c}
            </code>
          ))}
        </>
      )}
    </div>
  );
}

const smallInputStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-13)',
  background: 'var(--c-cream)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius-sm)',
  padding: '4px 8px',
  outline: 'none',
};

/* ════════════════════════════════════════════════════════════════════════
   PR #47 — Country + State + Payment Terms dropdowns (commander 2026-05-26)
   (Supply Category moved to the shared multi-select SupplyCategoryPicker —
   owner spec 2026-06-12.)
   ════════════════════════════════════════════════════════════════════════ */

const CountrySelect = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
  <label className={styles.field}>
    <span className={styles.fieldLabel}>Country</span>
    <span className={styles.selectWrap}>
      <select className={styles.fieldSelect} value={value || 'Malaysia'} onChange={(e) => onChange(e.target.value)}>
        {COUNTRIES.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
    </span>
  </label>
);

const StateSelect = ({
  country, value, onChange,
}: { country: string; value: string; onChange: (v: string) => void }) => {
  const localities = useLocalities();
  // Only Malaysia has a locality dataset; other countries fall back to free text.
  const malaysiaStates = useMemo(
    () => (localities.data ? distinctStates(localities.data) : []),
    [localities.data],
  );

  if (country === 'Malaysia') {
    return (
      <label className={styles.field}>
        <span className={styles.fieldLabel}>State</span>
        <span className={styles.selectWrap}>
          <select className={styles.fieldSelect} value={value} onChange={(e) => onChange(e.target.value)}
            disabled={localities.isLoading}>
            <option value="">{localities.isLoading ? 'Loading…' : '— Pick state —'}</option>
            {malaysiaStates.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
        </span>
      </label>
    );
  }
  // Other countries — free text fallback
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>State / Province</span>
      <input className={styles.fieldInput} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
};

const PaymentTermsSelect = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => {
  /* When user picks "Custom", we surface a second input so they can type a
     bespoke term (e.g. "NET 45 with 2% early discount"). We treat any value
     not in the preset list as "Custom" mode. */
  const isPreset = PAYMENT_TERMS_OPTIONS.includes(value as (typeof PAYMENT_TERMS_OPTIONS)[number]) && value !== 'Custom';
  const [customMode, setCustomMode] = useState(!isPreset && Boolean(value));

  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>Payment Terms</span>
      <div style={{ display: 'flex', gap: 6 }}>
        <span className={styles.selectWrap} style={{ flex: customMode ? 0.5 : 1 }}>
          <select className={styles.fieldSelect}
            value={customMode ? 'Custom' : (isPreset ? value : '')}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'Custom') { setCustomMode(true); onChange(''); }
              else { setCustomMode(false); onChange(v); }
            }}>
            <option value="">— Pick term —</option>
            {PAYMENT_TERMS_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
        </span>
        {customMode && (
          <input className={styles.fieldInput} style={{ flex: 1 }}
            placeholder="Type custom term"
            value={value}
            onChange={(e) => onChange(e.target.value)} />
        )}
      </div>
    </label>
  );
};
