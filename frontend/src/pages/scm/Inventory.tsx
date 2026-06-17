// ----------------------------------------------------------------------------
// Inventory — AutoCount-style stock view (1:1 clone of 2990s
// apps/backend/src/pages/Inventory.tsx). 4 tabs:
//   1. Balances   — one row per SKU, Total Qty + value. Double-click a row →
//                   per-warehouse + attribute breakdown drawer.
//   2. Batches    — open FIFO batches (batch = source PO) + component SKUs.
//   3. Warehouses — CRUD for stock locations.
//   4. Analytics  — aging / turnover / dead-stock / ABC (from lots + COGS).
// COGS auto-posted via the DB trigger trg_inventory_movement_fifo (migration 0026).
//
// SEAM changes (same playbook as the PO slice):
//   - Data layer: 2990s lib/inventory-queries -> Houzs api client + react-query
//     (co-located ./inventory-queries). Shapes identical (rule #7).
//   - formatVariantKey: 2990s @2990s/shared -> Houzs @shared/index (ported).
//   - Components: @2990s/design-system Button (size) -> Houzs Button (variant);
//     2990s DataGrid (sortable/expandable grid) -> plain <table> + the verbatim
//     Inventory.module.css classes (rule #9). The DataGrid row-expansion
//     (per-SKU variant panel / per-batch component panel) is reached via the
//     breakdown drawer (double-click) + an inline expand toggle here.
//   - react-router -> react-router-dom; doc deep-links target detail pages that
//     land in LATER slices (harmless 404 until then).
//
// STRATEGY-2 product-layer note: the Balances tab reads /inventory/products and
// the breakdown drawer reads /inventory/breakdown. The backend returns a faithful
// EMPTY product list until a Houzs product layer lands, so the Balances + Batches
// tabs render their empty states; Analytics + the per-warehouse breakdown (driven
// by movements, not a catalogue) work fully. Category chips are kept verbatim.
//   TODO: wire /products to a Houzs product source in the Products slice.
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Search, ArrowUpRight, ArrowDownLeft, DollarSign, Star, X, Plus,
  Warehouse as WarehouseIcon, ChevronRight, ChevronDown,
} from "lucide-react";
import { Button } from "../../components/Button";
import { formatVariantKey } from "@shared/index";
import {
  useWarehouses,
  useInventoryProductTotals,
  useInventoryProductBreakdown,
  useInventoryMovements,
  useInventoryLots,
  useInventoryBatches,
  useCogsEntries,
  useInventoryAnalytics,
  useCreateWarehouse,
  useUpdateWarehouse,
  type InventoryBatch,
  type InventoryMovement,
  type InventoryProductTotal,
  type Warehouse,
} from "./inventory-queries";
import { useToast } from "../../hooks/useToast";
import styles from "./Inventory.module.css";

const ICON = { size: 14, strokeWidth: 1.75 } as const;
const ICON_MD = { size: 16, strokeWidth: 1.75 } as const;

type Tab = "balances" | "batches" | "warehouses" | "analytics";
type Category = "all" | "ACCESSORY" | "BEDFRAME" | "SOFA" | "MATTRESS" | "SERVICE";

const CATEGORIES: { value: Category; label: string }[] = [
  { value: "all", label: "All" },
  { value: "ACCESSORY", label: "Accessory" },
  { value: "BEDFRAME", label: "Bedframe" },
  { value: "SOFA", label: "Sofa" },
  { value: "MATTRESS", label: "Mattress" },
  { value: "SERVICE", label: "Service" },
];

const fmtRm = (sen: number | null | undefined): string => {
  if (sen == null) return "—";
  return `RM ${(sen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const fmtAgeDays = (iso: string | null): string => {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const d = Math.floor(ms / 86_400_000);
  return d === 0 ? "today" : `${d}d`;
};

const fmtDateTime = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const date = d.toLocaleDateString("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/-/g, "/");
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${date} ${time}`;
};

const docHrefFor = (m: InventoryMovement): string | null => {
  switch (m.source_doc_type) {
    case "GRN":
      return m.source_doc_id ? `/grns/${m.source_doc_id}` : null;
    case "DO":
      return m.source_doc_id ? `/mfg-delivery-orders/${m.source_doc_id}` : null;
    case "DR":
      return m.source_doc_id ? `/delivery-returns/${m.source_doc_id}` : null;
    case "PURCHASE_RETURN":
      return m.source_doc_id ? `/purchase-returns/${m.source_doc_id}` : null;
    case "STOCK_TRANSFER":
      return m.source_doc_id ? `/inventory/transfers/${m.source_doc_id}` : null;
    case "STOCK_TAKE":
      return m.source_doc_id ? `/inventory/stock-takes/${m.source_doc_id}` : null;
    case "ADJUSTMENT":
      return "/stock-adjustments";
    default:
      return null;
  }
};

export const Inventory = () => {
  const [tab, setTab] = useState<Tab>("balances");
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [category, setCategory] = useState<Category>("all");
  const [search, setSearch] = useState("");

  const warehouses = useWarehouses();
  const [breakdownFor, setBreakdownFor] = useState<{ code: string; name: string } | null>(null);

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.title}>Inventory</h1>
        </div>
        <div className={styles.tabRow}>
          <button type="button" className={styles.tab} data-active={tab === "balances"} onClick={() => setTab("balances")}>
            Balances
          </button>
          <button type="button" className={styles.tab} data-active={tab === "batches"} onClick={() => setTab("batches")}>
            Batches
          </button>
          <button type="button" className={styles.tab} data-active={tab === "warehouses"} onClick={() => setTab("warehouses")}>
            Warehouses
          </button>
          <button type="button" className={styles.tab} data-active={tab === "analytics"} onClick={() => setTab("analytics")}>
            Analytics
          </button>
        </div>
      </div>

      {tab === "balances" && (
        <div className={styles.warehouseChips}>
          {CATEGORIES.map((cat) => (
            <button key={cat.value} type="button" className={styles.chip} data-active={category === cat.value} onClick={() => setCategory(cat.value)}>
              {cat.label}
            </button>
          ))}
        </div>
      )}

      {tab === "balances" && (
        <>
          <div className={styles.filterRow}>
            <div className={styles.searchBox} style={{ width: "100%" }}>
              <Search {...ICON} className={styles.searchIcon} />
              <input
                type="search"
                className={styles.searchInput}
                placeholder="Search code / description…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
          <BalancesTab category={category} search={search} onDrilldown={(code, name) => setBreakdownFor({ code, name })} />
        </>
      )}
      {tab === "batches" && (
        <BatchesTab
          warehouseId={warehouseId}
          setWarehouseId={setWarehouseId}
          warehouses={warehouses.data ?? []}
          search={search}
          setSearch={setSearch}
        />
      )}
      {tab === "warehouses" && <WarehousesTab />}
      {tab === "analytics" && <AnalyticsTab warehouseId={warehouseId} />}

      {breakdownFor && (
        <ProductBreakdownDrawer code={breakdownFor.code} name={breakdownFor.name} onClose={() => setBreakdownFor(null)} />
      )}
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Analytics tab — aging / turnover / dead stock / ABC (from open lots + COGS).
   ════════════════════════════════════════════════════════════════════════ */
const WINDOWS = [30, 90, 180, 365];
const fmtDay = (iso: string | null): string => {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" });
};

const AnalyticsTab = ({ warehouseId }: { warehouseId: string | null }) => {
  const [days, setDays] = useState(90);
  const { data, isLoading, error } = useInventoryAnalytics({ days, warehouseId });

  if (isLoading) return <div className={styles.emptyRow} style={{ padding: "var(--space-6)" }}>Loading analytics…</div>;
  if (error || !data) return <div className={styles.emptyRow} style={{ padding: "var(--space-6)" }}>Could not load analytics.</div>;

  const agingMax = Math.max(1, ...data.aging.map((b) => b.valueSen));
  const turns = data.turnover.annualizedTurns;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
      <div className={styles.warehouseChips}>
        {WINDOWS.map((w) => (
          <button key={w} type="button" className={styles.chip} data-active={days === w} onClick={() => setDays(w)}>
            Last {w} days
          </button>
        ))}
      </div>

      <div className={styles.statGrid}>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Inventory Value</span>
          <span className={styles.statValue}>{fmtRm(data.totalValueSen)}</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Distinct SKUs in stock</span>
          <span className={styles.statValue}>{data.distinctSkus.toLocaleString("en-MY")}</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Stock Turn (annualised)</span>
          <span className={styles.statValue}>{turns > 0 ? `${turns.toFixed(1)}×` : "—"}</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Days of Stock on Hand</span>
          <span className={styles.statValue}>{data.turnover.daysOnHand != null ? `${Math.round(data.turnover.daysOnHand)}d` : "—"}</span>
        </div>
      </div>

      <p className={styles.eyebrow}>Stock Aging — by date received</p>
      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Age Bucket</th>
              <th style={{ textAlign: "right" }}>Qty</th>
              <th style={{ textAlign: "right" }}>Value</th>
              <th style={{ width: "34%" }}>Share of value</th>
            </tr>
          </thead>
          <tbody>
            {data.aging.map((b) => (
              <tr key={b.key}>
                <td>{b.label}</td>
                <td className={`${styles.numCell} ${b.qty > 0 ? styles.numCellPos : styles.numCellZero}`}>{b.qty.toLocaleString("en-MY")}</td>
                <td className={styles.numCell} style={{ fontWeight: 700 }}>{b.valueSen > 0 ? fmtRm(b.valueSen) : "—"}</td>
                <td>
                  <div style={{ height: 10, borderRadius: 5, background: "var(--c-paper)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${(b.valueSen / agingMax) * 100}%`, background: "var(--c-burnt)" }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className={styles.eyebrow}>ABC Classification — by sales value over the window</p>
      <div className={styles.statGrid}>
        {(["A", "B", "C"] as const).map((cls) => (
          <div key={cls} className={styles.statCard}>
            <span className={styles.statLabel}>
              Class {cls} {cls === "A" ? "· top sellers" : cls === "B" ? "· steady" : "· slow / idle"}
            </span>
            <span className={styles.statValue}>{data.abc.summary[cls].count}</span>
            <span className={styles.statLabel}>{fmtRm(data.abc.summary[cls].valueSen)} on hand</span>
          </div>
        ))}
      </div>

      <p className={styles.eyebrow}>Dead Stock — has stock, no sale in {days} days</p>
      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Product</th>
              <th style={{ textAlign: "right" }}>Qty</th>
              <th style={{ textAlign: "right" }}>Value</th>
              <th>Last Sold</th>
            </tr>
          </thead>
          <tbody>
            {data.deadStock.length === 0 && (
              <tr>
                <td colSpan={4} className={styles.emptyRow}>No dead stock — every SKU in stock sold within {days} days.</td>
              </tr>
            )}
            {data.deadStock.map((d) => (
              <tr key={d.product_code}>
                <td>
                  <span className={styles.codeChip}>{d.product_code}</span> {d.product_name}
                </td>
                <td className={`${styles.numCell} ${styles.numCellPos}`}>{d.qty.toLocaleString("en-MY")}</td>
                <td className={styles.numCell} style={{ fontWeight: 700 }}>{fmtRm(d.valueSen)}</td>
                <td className={styles.numCellZero}>{fmtDay(d.lastSoldAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Balances tab — one row per SKU + Total Qty. Double-click → breakdown drawer;
   click the chevron → inline per-variant expansion (lazy fetch).
   ════════════════════════════════════════════════════════════════════════ */
const BalancesTab = ({
  category,
  search,
  onDrilldown,
}: {
  category: Category;
  search: string;
  onDrilldown: (code: string, name: string) => void;
}) => {
  const { data, isLoading, error } = useInventoryProductTotals({
    search: search.trim() || undefined,
    category: category === "all" ? undefined : category,
  });
  const rows: InventoryProductTotal[] = useMemo(() => data ?? [], [data]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const stats = useMemo(
    () => ({
      totalQty: rows.reduce((s, r) => s + (r.total_qty ?? 0), 0),
      distinctSku: rows.length,
      totalValue: rows.reduce((s, r) => s + (r.total_value_sen ?? 0), 0),
    }),
    [rows],
  );

  const toggle = (code: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });

  return (
    <>
      <div className={styles.statGrid}>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Total Qty</span>
          <span className={styles.statValue}>{stats.totalQty.toLocaleString("en-MY")}</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Distinct SKUs</span>
          <span className={styles.statValue}>{stats.distinctSku}</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Inventory Value</span>
          <span className={styles.statValue}>{fmtRm(stats.totalValue)}</span>
        </div>
      </div>

      <p className={styles.eyebrow}>
        {isLoading ? "Loading…" : `${rows.length} SKU rows · double-click a row to see per-warehouse breakdown`}
      </p>

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load.</strong> {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th style={{ width: 28 }} />
              <th>Product Code</th>
              <th>Description</th>
              <th>Category</th>
              <th style={{ textAlign: "right" }}>Stock</th>
              <th style={{ textAlign: "right" }}>Incoming</th>
              <th style={{ textAlign: "right" }}>Reserve 7d</th>
              <th style={{ textAlign: "right" }}>Reserve 14d</th>
              <th style={{ textAlign: "right" }}>Available</th>
              <th style={{ textAlign: "right" }}>Value</th>
              <th style={{ textAlign: "right" }}>Unit Cost</th>
              <th>Age</th>
            </tr>
          </thead>
          <tbody>
            {!isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={12} className={styles.emptyRow}>No SKUs match the filters.</td>
              </tr>
            )}
            {rows.map((r) => {
              const qtyClass = r.total_qty > 0 ? styles.numCellPos : r.total_qty < 0 ? styles.numCellNeg : styles.numCellZero;
              const isOpen = expanded.has(r.product_code);
              const unitCost = r.total_qty > 0 && r.total_value_sen > 0 ? Math.round(r.total_value_sen / r.total_qty) : 0;
              return (
                <>
                  <tr
                    key={r.product_code}
                    onDoubleClick={() => onDrilldown(r.product_code, r.product_name)}
                    style={{ cursor: "pointer" }}
                  >
                    <td onClick={(e) => { e.stopPropagation(); toggle(r.product_code); }} style={{ cursor: "pointer", textAlign: "center" }}>
                      {isOpen ? <ChevronDown size={14} strokeWidth={1.75} /> : <ChevronRight size={14} strokeWidth={1.75} />}
                    </td>
                    <td>
                      <Link
                        to={`/stock-card/${encodeURIComponent(r.product_code)}`}
                        className={styles.codeChip}
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                        title="Open Stock Card"
                        style={{ textDecoration: "none" }}
                      >
                        {r.product_code}
                      </Link>
                    </td>
                    <td>
                      {r.product_name}
                      {r.branding && <span className={styles.numCellZero}> · {r.branding}</span>}
                    </td>
                    <td className={styles.numCellZero}>{r.category}</td>
                    <td className={`${styles.numCell} ${qtyClass}`}>{r.total_qty.toLocaleString("en-MY")}</td>
                    <td className={`${styles.numCell} ${r.incoming_qty > 0 ? styles.numCellPos : styles.numCellZero}`}>
                      {r.incoming_qty > 0 ? `+${r.incoming_qty.toLocaleString("en-MY")}` : "—"}
                    </td>
                    <td className={`${styles.numCell} ${r.reserve_7d > 0 ? "" : styles.numCellZero}`}>
                      {r.reserve_7d > 0 ? r.reserve_7d.toLocaleString("en-MY") : "—"}
                    </td>
                    <td className={`${styles.numCell} ${r.reserve_14d > 0 ? "" : styles.numCellZero}`}>
                      {r.reserve_14d > 0 ? r.reserve_14d.toLocaleString("en-MY") : "—"}
                    </td>
                    <td
                      className={`${styles.numCell} ${r.available_qty < 0 ? styles.numCellNeg : r.available_qty > 0 ? styles.numCellPos : styles.numCellZero}`}
                      title="Stock − reserved (open SO demand)"
                    >
                      {r.available_qty.toLocaleString("en-MY")}
                    </td>
                    <td className={`${styles.numCell} ${styles.numCellZero}`}>{r.total_value_sen > 0 ? fmtRm(r.total_value_sen) : "—"}</td>
                    <td className={`${styles.numCell} ${styles.numCellZero}`}>{unitCost > 0 ? fmtRm(unitCost) : "—"}</td>
                    <td className={styles.numCellZero} title={r.oldest_lot_at ?? undefined}>{fmtAgeDays(r.oldest_lot_at)}</td>
                  </tr>
                  {isOpen && (
                    <tr key={`${r.product_code}-exp`}>
                      <td colSpan={12} style={{ padding: 0 }}>
                        <SkuVariantPanel code={r.product_code} />
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
};

/* Variant breakdown — sums each attribute composition (variant_key) across
   warehouses. Lazy: only fetches when the row is expanded. */
const SkuVariantPanel = ({ code }: { code: string }) => {
  const bd = useInventoryProductBreakdown(code);
  const balances = (bd.data?.balances ?? []).filter((b) => b.product_code === code);
  const variants = useMemo(() => {
    const m = new Map<string, { vk: string; qty: number; value: number }>();
    for (const b of balances) {
      const vk = b.variant_key ?? "";
      const cur = m.get(vk) ?? { vk, qty: 0, value: 0 };
      cur.qty += b.qty ?? 0;
      cur.value += b.value_sen ?? 0;
      m.set(vk, cur);
    }
    return [...m.values()].sort((a, b) => (formatVariantKey(a.vk) || "Standard").localeCompare(formatVariantKey(b.vk) || "Standard"));
  }, [balances]);

  if (bd.isLoading) {
    return <div className={styles.numCellZero} style={{ padding: "8px 16px" }}>Loading variants…</div>;
  }
  if (variants.length === 0) {
    return <div className={styles.numCellZero} style={{ padding: "8px 16px" }}>No stock buckets yet.</div>;
  }
  return (
    <table className={styles.table} style={{ background: "var(--c-cream)" }}>
      <tbody>
        {variants.map((v) => {
          const qtyClass = v.qty > 0 ? styles.numCellPos : v.qty < 0 ? styles.numCellNeg : styles.numCellZero;
          return (
            <tr key={v.vk}>
              <td style={{ width: 280 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, paddingLeft: 22 }}>
                  <span className={styles.numCellZero}>↳</span>
                  <span>{formatVariantKey(v.vk) || "Standard"}</span>
                </span>
              </td>
              <td className={`${styles.numCell} ${qtyClass}`} style={{ width: 100, textAlign: "right" }}>
                {v.qty.toLocaleString("en-MY")}
              </td>
              <td className={`${styles.numCell} ${styles.numCellZero}`} style={{ width: 130, textAlign: "right" }}>
                {v.value > 0 ? fmtRm(v.value) : "—"}
              </td>
              <td />
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Batches tab — open FIFO batches (batch = source PO) + component SKUs.
   ════════════════════════════════════════════════════════════════════════ */
const BatchesTab = ({
  warehouseId,
  setWarehouseId,
  warehouses,
  search,
  setSearch,
}: {
  warehouseId: string | null;
  setWarehouseId: (id: string | null) => void;
  warehouses: Warehouse[];
  search: string;
  setSearch: (s: string) => void;
}) => {
  const { data, isLoading, error } = useInventoryBatches({ warehouseId: warehouseId ?? undefined });
  const allBatches: InventoryBatch[] = useMemo(() => data ?? [], [data]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const q = search.trim().toLowerCase();
  const batches = useMemo(() => {
    if (!q) return allBatches;
    return allBatches.filter(
      (b) =>
        b.batchNo.toLowerCase().includes(q) ||
        (b.supplierName ?? "").toLowerCase().includes(q) ||
        b.components.some((c) => c.productCode.toLowerCase().includes(q) || (c.productName ?? "").toLowerCase().includes(q)),
    );
  }, [allBatches, q]);

  const stats = useMemo(
    () => ({
      batchCount: batches.length,
      totalQty: batches.reduce((s, b) => s + b.totalRemaining, 0),
      skuCount: new Set(batches.flatMap((b) => b.components.map((c) => c.productCode))).size,
    }),
    [batches],
  );

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <>
      <div className={styles.warehouseChips}>
        <button type="button" className={styles.chip} data-active={warehouseId === null} onClick={() => setWarehouseId(null)}>
          All warehouses
        </button>
        {warehouses.map((w) => (
          <button key={w.id} type="button" className={styles.chip} data-active={warehouseId === w.id} onClick={() => setWarehouseId(w.id)}>
            {w.name}
          </button>
        ))}
      </div>

      <div className={styles.filterRow}>
        <div className={styles.searchBox} style={{ width: "100%" }}>
          <Search {...ICON} className={styles.searchIcon} />
          <input
            type="search"
            className={styles.searchInput}
            placeholder="Search batch / PO / supplier / component…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className={styles.statGrid}>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Open Batches</span>
          <span className={styles.statValue}>{stats.batchCount}</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Modules On Hand</span>
          <span className={styles.statValue}>{stats.totalQty.toLocaleString("en-MY")}</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Distinct SKUs</span>
          <span className={styles.statValue}>{stats.skuCount}</span>
        </div>
      </div>

      <p className={styles.eyebrow}>
        {isLoading ? "Loading…" : `${batches.length} open batch${batches.length === 1 ? "" : "es"} · click a row to see component SKUs`}
      </p>

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load.</strong> {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th style={{ width: 28 }} />
              <th>Batch / PO</th>
              <th>Warehouse</th>
              <th>Supplier</th>
              <th style={{ textAlign: "right" }}>Components</th>
              <th style={{ textAlign: "right" }}>Modules</th>
              <th>Received</th>
            </tr>
          </thead>
          <tbody>
            {!isLoading && batches.length === 0 && (
              <tr>
                <td colSpan={7} className={styles.emptyRow}>No open batches{q ? " match the search" : ""}.</td>
              </tr>
            )}
            {batches.map((b) => {
              const key = `${b.warehouseId}|${b.batchNo}`;
              const isOpen = expanded.has(key);
              return (
                <>
                  <tr key={key} onClick={() => toggle(key)} style={{ cursor: "pointer" }}>
                    <td style={{ textAlign: "center" }}>
                      {isOpen ? <ChevronDown size={14} strokeWidth={1.75} /> : <ChevronRight size={14} strokeWidth={1.75} />}
                    </td>
                    <td>
                      <span className={styles.codeChip}>{b.batchNo}</span>
                    </td>
                    <td>{b.warehouseName ?? "—"}</td>
                    <td>{b.supplierName ?? <span className={styles.numCellZero}>—</span>}</td>
                    <td className={`${styles.numCell} ${styles.numCellZero}`}>{b.components.length}</td>
                    <td className={`${styles.numCell} ${b.totalRemaining > 0 ? styles.numCellPos : styles.numCellZero}`}>
                      {b.totalRemaining.toLocaleString("en-MY")}
                    </td>
                    <td className={styles.numCellZero} title={b.receivedAt ?? undefined}>{fmtAgeDays(b.receivedAt)}</td>
                  </tr>
                  {isOpen && (
                    <tr key={`${key}-exp`}>
                      <td colSpan={7} style={{ padding: 0 }}>
                        <BatchComponentsPanel batch={b} />
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
};

const BatchComponentsPanel = ({ batch }: { batch: InventoryBatch }) => (
  <table className={styles.table} style={{ background: "var(--c-cream)" }}>
    <tbody>
      {batch.components.map((c) => (
        <tr key={`${c.productCode}|${c.variantKey ?? ""}`}>
          <td style={{ paddingLeft: 28, width: 190 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span className={styles.numCellZero}>↳</span>
              <Link
                to={`/stock-card/${encodeURIComponent(c.productCode)}`}
                className={styles.codeChip}
                onClick={(e) => e.stopPropagation()}
                title="Open Stock Card"
                style={{ textDecoration: "none" }}
              >
                {c.productCode}
              </Link>
            </span>
          </td>
          <td>
            {c.productName ?? "—"}
            {c.variantKey && <span className={styles.numCellZero}> · {formatVariantKey(c.variantKey) || "Standard"}</span>}
          </td>
          <td className={`${styles.numCell} ${styles.numCellZero}`} style={{ width: 110, textAlign: "right" }}>
            {fmtRm(c.unitCostSen)}
          </td>
          <td className={`${styles.numCell} ${c.qtyRemaining > 0 ? styles.numCellPos : styles.numCellZero}`} style={{ width: 90, textAlign: "right" }}>
            {c.qtyRemaining.toLocaleString("en-MY")}
          </td>
          <td className={styles.numCellZero} style={{ width: 90 }} title={c.receivedAt ?? undefined}>
            {fmtAgeDays(c.receivedAt)}
          </td>
        </tr>
      ))}
    </tbody>
  </table>
);

/* ════════════════════════════════════════════════════════════════════════
   Product breakdown drawer — per-warehouse Location | Qty | Unit Cost + FIFO
   lots + collapsible Movements + COGS.
   ════════════════════════════════════════════════════════════════════════ */
const ProductBreakdownDrawer = ({ code, name, onClose }: { code: string; name: string; onClose: () => void }) => {
  const breakdown = useInventoryProductBreakdown(code);
  const lots = useInventoryLots(code);
  const movements = useInventoryMovements({ productCode: code });
  const cogs = useCogsEntries({ productCode: code });
  const warehouses = useWarehouses();

  const [movementsOpen, setMovementsOpen] = useState(false);
  const [cogsOpen, setCogsOpen] = useState(false);

  const whById = useMemo(() => new Map((warehouses.data ?? []).map((w) => [w.id, w])), [warehouses.data]);

  const movementsWithBalance = useMemo(() => {
    const desc = movements.data ?? [];
    const asc = [...desc].reverse();
    let running = 0;
    const out: Array<(typeof desc)[number] & { runningBalance: number }> = [];
    for (const m of asc) {
      running += m.movement_type === "OUT" ? -m.qty : m.qty;
      out.push({ ...m, runningBalance: running });
    }
    return out.reverse();
  }, [movements.data]);

  const balances = (breakdown.data?.balances ?? []).filter((b) => b.product_code === code);
  const totalQty = balances.reduce((s, b) => s + (b.qty ?? 0), 0);
  const totalVal = balances.reduce((s, b) => s + (b.value_sen ?? 0), 0);

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.32)", zIndex: 50, display: "flex", justifyContent: "flex-end" }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: 720, maxWidth: "95vw", background: "var(--c-cream)", padding: "var(--space-5)", overflow: "auto" }}>
        <div className={styles.headerRow}>
          <div>
            <h2 className={styles.title} style={{ fontSize: "var(--fs-22)" }}>Stock Breakdown</h2>
            <p className={styles.subtitle}>
              <span className={styles.codeChip}>{code}</span> {name}
            </p>
          </div>
          <button type="button" className={styles.chip} onClick={onClose}>
            <X {...ICON} />
            <span>Close</span>
          </button>
        </div>

        <div className={styles.statGrid} style={{ marginTop: "var(--space-4)" }}>
          <div className={styles.statCard}>
            <span className={styles.statLabel}>Total Qty</span>
            <span className={styles.statValue}>{totalQty.toLocaleString("en-MY")}</span>
          </div>
          <div className={styles.statCard}>
            <span className={styles.statLabel}>Total Value</span>
            <span className={styles.statValue}>{fmtRm(totalVal)}</span>
          </div>
        </div>

        <p className={styles.eyebrow} style={{ marginTop: "var(--space-4)" }}>
          Stock by Warehouse &amp; Attributes
        </p>
        <div className={styles.tableCard}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Location</th>
                <th>Attributes</th>
                <th style={{ textAlign: "right" }}>Qty</th>
                <th style={{ textAlign: "right" }}>Avg Unit Cost</th>
                <th style={{ textAlign: "right" }}>Value</th>
              </tr>
            </thead>
            <tbody>
              {breakdown.isLoading && (
                <tr>
                  <td colSpan={5} className={styles.emptyRow}>Loading…</td>
                </tr>
              )}
              {!breakdown.isLoading && balances.length === 0 && (
                <tr>
                  <td colSpan={5} className={styles.emptyRow}>No stock rows yet.</td>
                </tr>
              )}
              {!breakdown.isLoading &&
                balances.map((b) => {
                  const avgCost = b.qty > 0 && b.value_sen ? b.value_sen / b.qty : 0;
                  const attrs = formatVariantKey(b.variant_key);
                  return (
                    <tr key={`${b.warehouse_id}|${b.variant_key ?? ""}`}>
                      <td>
                        {b.warehouse_code} · {b.warehouse_name}
                      </td>
                      <td>{attrs || <span className={styles.numCellZero}>Standard</span>}</td>
                      <td className={`${styles.numCell} ${b.qty > 0 ? styles.numCellPos : styles.numCellZero}`}>
                        {b.qty.toLocaleString("en-MY")}
                      </td>
                      <td className={`${styles.numCell} ${styles.numCellZero}`}>{avgCost > 0 ? fmtRm(avgCost) : "—"}</td>
                      <td className={styles.numCell} style={{ fontWeight: 700 }}>
                        {b.value_sen && b.value_sen > 0 ? fmtRm(b.value_sen) : "—"}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>

        <p className={styles.eyebrow} style={{ marginTop: "var(--space-4)" }}>
          FIFO Lots (oldest first — these are consumed first on the next DO)
        </p>
        <div className={styles.tableCard}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Received</th>
                <th>Warehouse</th>
                <th style={{ textAlign: "right" }}>Qty Left</th>
                <th style={{ textAlign: "right" }}>Unit Cost</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {lots.isLoading && (
                <tr>
                  <td colSpan={5} className={styles.emptyRow}>Loading lots…</td>
                </tr>
              )}
              {!lots.isLoading && (lots.data ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} className={styles.emptyRow}>No open lots.</td>
                </tr>
              )}
              {(lots.data ?? []).map((l) => (
                <tr key={l.id}>
                  <td className={styles.numCellZero}>{fmtDateTime(l.received_at)}</td>
                  <td>{l.warehouse_code ?? "—"}</td>
                  <td className={`${styles.numCell} ${styles.numCellPos}`}>{l.qty_remaining.toLocaleString("en-MY")}</td>
                  <td className={`${styles.numCell} ${styles.numCellZero}`}>{fmtRm(l.unit_cost_sen)}</td>
                  <td className={styles.numCellZero}>{l.source_doc_no ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <button
          type="button"
          onClick={() => setMovementsOpen((v) => !v)}
          style={{ marginTop: "var(--space-4)", cursor: "pointer", background: "transparent", border: "none", padding: 0, display: "inline-flex", alignItems: "center", gap: 4 }}
        >
          <span className={styles.eyebrow} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            {movementsOpen ? <ChevronDown size={12} strokeWidth={1.75} /> : <ChevronRight size={12} strokeWidth={1.75} />}
            Movements ({(movements.data ?? []).length}) — every stock change for this SKU
          </span>
        </button>
        {movementsOpen && (
          <div className={styles.tableCard}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Type</th>
                  <th>Warehouse</th>
                  <th style={{ textAlign: "right" }}>Qty</th>
                  <th style={{ textAlign: "right" }}>Running</th>
                  <th>Source Doc</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {movements.isLoading && (
                  <tr>
                    <td colSpan={7} className={styles.emptyRow}>Loading…</td>
                  </tr>
                )}
                {!movements.isLoading && movementsWithBalance.length === 0 && (
                  <tr>
                    <td colSpan={7} className={styles.emptyRow}>No movements yet for this SKU.</td>
                  </tr>
                )}
                {movementsWithBalance.map((m) => {
                  const href = docHrefFor(m);
                  const qtySign = m.movement_type === "IN" ? "+" : m.movement_type === "OUT" ? "−" : m.qty > 0 ? "+" : m.qty < 0 ? "−" : "";
                  const qtyClass = m.qty > 0 ? styles.numCellPos : m.qty < 0 ? styles.numCellNeg : styles.numCellZero;
                  const wh = m.warehouse_id ? whById.get(m.warehouse_id) : null;
                  return (
                    <tr key={m.id}>
                      <td className={styles.numCellZero}>{fmtDateTime(m.created_at)}</td>
                      <td>
                        <span
                          className={`${styles.movementPill} ${
                            m.movement_type === "IN" ? styles.movementIn : m.movement_type === "OUT" ? styles.movementOut : styles.movementAdj
                          }`}
                        >
                          {m.movement_type}
                        </span>
                      </td>
                      <td>{wh ? wh.code : "—"}</td>
                      <td className={`${styles.numCell} ${qtyClass}`}>
                        {qtySign}
                        {Math.abs(m.qty).toLocaleString("en-MY")}
                      </td>
                      <td className={styles.numCell} style={{ fontWeight: 700 }}>
                        {m.runningBalance.toLocaleString("en-MY")}
                      </td>
                      <td>
                        {m.source_doc_no ? (
                          href ? (
                            <Link to={href} className={styles.docLink}>
                              {m.source_doc_no}
                            </Link>
                          ) : (
                            <span className={styles.docLink}>{m.source_doc_no}</span>
                          )
                        ) : (
                          <span className={styles.numCellZero}>—</span>
                        )}
                      </td>
                      <td className={styles.numCellZero}>{m.notes ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <button
          type="button"
          onClick={() => setCogsOpen((v) => !v)}
          style={{ marginTop: "var(--space-4)", cursor: "pointer", background: "transparent", border: "none", padding: 0, display: "inline-flex", alignItems: "center", gap: 4 }}
        >
          <span className={styles.eyebrow} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            {cogsOpen ? <ChevronDown size={12} strokeWidth={1.75} /> : <ChevronRight size={12} strokeWidth={1.75} />}
            COGS ({(cogs.data ?? []).length}) — FIFO consumptions for this SKU
          </span>
        </button>
        {cogsOpen && (
          <div className={styles.tableCard}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Consumed at</th>
                  <th>Source Doc</th>
                  <th style={{ textAlign: "right" }}>Qty</th>
                  <th style={{ textAlign: "right" }}>Unit Cost</th>
                  <th style={{ textAlign: "right" }}>Total Cost</th>
                  <th>From Lot</th>
                </tr>
              </thead>
              <tbody>
                {cogs.isLoading && (
                  <tr>
                    <td colSpan={6} className={styles.emptyRow}>Loading…</td>
                  </tr>
                )}
                {!cogs.isLoading && (cogs.data ?? []).length === 0 && (
                  <tr>
                    <td colSpan={6} className={styles.emptyRow}>No COGS entries yet for this SKU.</td>
                  </tr>
                )}
                {(cogs.data ?? []).map((c) => (
                  <tr key={c.id}>
                    <td className={styles.numCellZero}>{fmtDateTime(c.consumed_at)}</td>
                    <td>
                      <span className={styles.docLink}>{c.source_doc_no ?? "—"}</span>
                    </td>
                    <td className={`${styles.numCell} ${styles.numCellNeg}`}>−{c.qty_consumed.toLocaleString("en-MY")}</td>
                    <td className={`${styles.numCell} ${styles.numCellZero}`}>{fmtRm(c.unit_cost_sen)}</td>
                    <td className={styles.numCell} style={{ fontWeight: 700 }}>{fmtRm(c.total_cost_sen)}</td>
                    <td className={styles.numCellZero}>{c.lot_source_doc_no ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Warehouses tab — CRUD for stock locations.
   ════════════════════════════════════════════════════════════════════════ */
const WarehousesTab = () => {
  const [includeInactive, setIncludeInactive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Warehouse | null>(null);
  const warehouses = useWarehouses({ includeInactive });

  return (
    <>
      <div className={styles.filterRow} style={{ justifyContent: "space-between" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "var(--fs-13)" }}>
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          Show inactive
        </label>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus {...ICON_MD} />
          <span>New Warehouse</span>
        </Button>
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
              <th />
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
                <td>{w.is_default ? <Star size={12} strokeWidth={2} style={{ color: "var(--c-orange)", fill: "var(--c-orange)" }} /> : "—"}</td>
                <td>
                  <span className={`${styles.movementPill} ${w.is_active ? styles.movementIn : styles.movementAdj}`}>
                    {w.is_active ? "Active" : "Inactive"}
                  </span>
                </td>
                <td>
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
    </>
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
        { id: editing.id, code: form.code, name: form.name, location: form.location, isActive: form.isActive, isDefault: form.isDefault },
        { onSuccess: onClose },
      );
    } else {
      create.mutate({ code: form.code, name: form.name, location: form.location || undefined, isDefault: form.isDefault }, { onSuccess: onClose });
    }
  };

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.32)", zIndex: 50, display: "flex", justifyContent: "flex-end" }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: 480, maxWidth: "95vw", background: "var(--c-cream)", padding: "var(--space-5)", overflow: "auto" }}>
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
            <input type="checkbox" checked={form.isDefault} onChange={(e) => setForm((s) => ({ ...s, isDefault: e.target.checked }))} />
            Default warehouse
          </label>
          {editing && (
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={form.isActive} onChange={(e) => setForm((s) => ({ ...s, isActive: e.target.checked }))} />
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
