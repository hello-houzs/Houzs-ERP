// ----------------------------------------------------------------------------
// Purchase Orders (manufacturer-side) — list page.
//
// 1:1 clone of 2990s apps/backend/src/pages/PurchaseOrders.tsx. Same status
// chips (Outstanding / All), same per-row items preview, same row-click → detail,
// same Cancel / Reopen actions and the same "From Sales Order" + "New PO" entry
// points. The wire shapes (PoHeaderRow / PoItemRow) match 2990s exactly.
//
// SEAM changes (the only deviations from 2990s — same playbook as the Suppliers
// slice):
//   - Data layer: 2990s lib/suppliers-queries (authedFetch + TanStack) -> Houzs
//     api client (frontend/src/api/client.ts) + @tanstack/react-query. Query /
//     response SHAPES are identical to 2990s (rule #7). The PO query hooks are
//     co-located here and re-exported for the other three PO pages (the slice
//     ships its files; no shared lib).
//   - Components: @2990s/design-system Button -> Houzs components/Button; 2990s
//     DataGrid -> a plain <table> with the verbatim Suppliers.module.css classes
//     (DataGrid is a large 2990s-only tree; inlining keeps the look) (rule #9).
//   - Routing: react-router -> react-router-dom (same hooks).
//
// Strategy-2 product-layer notes:
//   - "From Sales Order" navigates to the picker page, which renders an
//     "available after the Sales Orders slice" empty state (the SO slice is not
//     cloned yet). Kept so the entry point + route exist verbatim.
//   - Batch "Print documentation" (jspdf, multi-PO PDF) + the per-row
//     drill-down "Received" column both depend on furniture PDF labels / the GRN
//     slice; dropped here. A single per-PO Print lives on the detail page.
//     TODO: wire batch PDF + Received column when the GRN/print slices land.
//   - has_children (GRN downstream-lock) is always false until the GRN slice
//     lands, so Edit/Cancel are never hidden by it.
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, ArrowRightLeft } from "lucide-react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { Button } from "../../components/Button";
import { api } from "../../api/client";
import styles from "../Suppliers.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/* ════════════════════════════════════════════════════════════════════════
   Types + query hooks — ported from 2990s lib/suppliers-queries.ts (the PO
   slice of it). Shapes identical to 2990s; the fetch layer is Houzs's `api`
   client. Re-exported for PurchaseOrderDetail / PurchaseOrderNew /
   PurchaseOrderFromSo.
   ════════════════════════════════════════════════════════════════════════ */

export type PoStatus = "SUBMITTED" | "PARTIALLY_RECEIVED" | "RECEIVED" | "CANCELLED";
export type Currency = "MYR" | "RMB" | "USD" | "SGD";
export type MaterialKind = "mfg_product" | "fabric" | "raw";

export type PoLineReceipt = { grnNumber: string; qty: number; status: string };

export type PoItemRow = {
  id: string;
  purchase_order_id: string;
  binding_id: string | null;
  material_kind: MaterialKind;
  material_code: string;
  material_name: string;
  supplier_sku: string | null;
  qty: number;
  unit_price_centi: number;
  line_total_centi: number;
  received_qty: number;
  notes: string | null;
  gap_inches: number | null;
  divan_height_inches: number | null;
  divan_price_sen: number;
  leg_height_inches: number | null;
  leg_price_sen: number;
  custom_specials: unknown;
  line_suffix: string | null;
  special_order_price_sen: number;
  variants: Record<string, unknown> | null;
  item_group: string | null;
  description: string | null;
  description2: string | null;
  uom: string;
  discount_centi: number;
  unit_cost_centi: number;
  delivery_date: string | null;
  warehouse_id: string | null;
  so_item_id: string | null;
  from_mrp: boolean;
  created_at: string;
  /* Detail-route extras (faithful empty until GRN/SO slices land). */
  receipts?: PoLineReceipt[];
  so_doc_no?: string | null;
  so_drift?: null | { specPo: string; specSo: string; itemPo: string; itemSo: string; itemChanged: boolean };
};

export type PoSupplierLite = {
  id: string;
  code: string;
  name: string;
  contact_person?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
};

export type PoHeaderRow = {
  id: string;
  po_number: string;
  supplier_id: string;
  status: PoStatus;
  po_date: string;
  expected_at: string | null;
  purchase_location_id: string | null;
  currency: Currency;
  subtotal_centi: number;
  tax_centi: number;
  total_centi: number;
  notes: string | null;
  submitted_at: string | null;
  received_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  created_by: number | null;
  updated_at: string;
  supplier?: PoSupplierLite | null;
  items?: Array<{ material_code: string; material_name: string; qty: number }>;
  has_children?: boolean;
};

/** Per-line draft sent to POST /purchase-orders (mirrors 2990s NewPoItem). */
export type NewPoItem = {
  materialKind: MaterialKind;
  materialCode: string;
  materialName: string;
  supplierSku?: string;
  qty: number;
  unitPriceCenti: number;
  bindingId?: string;
  discountCenti?: number;
  deliveryDate?: string;
  warehouseId?: string;
  itemGroup?: string;
  variants?: Record<string, unknown>;
  description?: string;
  soItemId?: string | null;
};

export type OutstandingSoItem = {
  soItemId: string;
  soDocNo: string;
  debtorName: string | null;
  branding: string | null;
  soStatus: string;
  soDate: string;
  deliveryDate: string | null;
  itemCode: string;
  description: string | null;
  itemGroup: string;
  qty: number;
  poQtyPicked: number;
  remainingQty: number;
  unitPriceCenti: number;
  variants: Record<string, unknown> | null;
  lineSuffix: string | null;
  processingDate: string | null;
  salesLocation: string | null;
  lineDeliveryDate: string | null;
  mainSupplierCode: string | null;
  mainSupplierName: string | null;
};

/* ── List + detail ──────────────────────────────────────────────────── */

export function usePurchaseOrders(opts?: { status?: PoStatus; supplierId?: string }) {
  return useQuery({
    queryKey: ["mfg-purchase-orders", opts?.status ?? "all", opts?.supplierId ?? ""],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts?.status) params.set("status", opts.status);
      if (opts?.supplierId) params.set("supplierId", opts.supplierId);
      const res = await api.get<{ purchaseOrders: PoHeaderRow[] }>(
        `/api/purchase-orders${params.toString() ? `?${params.toString()}` : ""}`,
      );
      return res.purchaseOrders;
    },
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export type PoDetail = { purchaseOrder: PoHeaderRow; items: PoItemRow[] };

export async function fetchPurchaseOrderDetail(id: string): Promise<PoDetail> {
  return api.get<PoDetail>(`/api/purchase-orders/${id}`);
}

export function usePurchaseOrderDetail(id: string | null) {
  return useQuery({
    queryKey: ["mfg-purchase-order-detail", id],
    queryFn: () => fetchPurchaseOrderDetail(id!),
    enabled: Boolean(id),
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export function useCreatePurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      supplierId: string;
      currency?: string;
      poDate?: string;
      expectedAt?: string;
      notes?: string;
      purchaseLocationId?: string;
      items: NewPoItem[];
    }) => api.post<{ id: string; poNumber: string }>(`/api/purchase-orders`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mfg-purchase-orders"] }),
  });
}

export function useUpdatePurchaseOrderHeader() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Record<string, unknown> & { id: string }) =>
      api.patch<{ purchaseOrder: PoHeaderRow }>(`/api/purchase-orders/${id}`, body),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["mfg-purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["mfg-purchase-order-detail", vars.id] });
    },
  });
}

export function useUpdatePurchaseOrderItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ poId, itemId, ...body }: Record<string, unknown> & { poId: string; itemId: string }) =>
      api.patch<{ ok: true }>(`/api/purchase-orders/${poId}/items/${itemId}`, body),
    onSuccess: (_, vars) => qc.invalidateQueries({ queryKey: ["mfg-purchase-order-detail", vars.poId] }),
  });
}

export function useDeletePurchaseOrderItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ poId, itemId }: { poId: string; itemId: string }) =>
      api.del<void>(`/api/purchase-orders/${poId}/items/${itemId}`),
    onSuccess: (_, vars) => qc.invalidateQueries({ queryKey: ["mfg-purchase-order-detail", vars.poId] }),
  });
}

export function useCancelPurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.patch<{ purchaseOrder: PoHeaderRow }>(`/api/purchase-orders/${id}/cancel`, {}),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["mfg-purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["mfg-purchase-order-detail", id] });
    },
  });
}

export function useReopenPurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.patch<{ purchaseOrder: PoHeaderRow }>(`/api/purchase-orders/${id}/reopen`, {}),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["mfg-purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["mfg-purchase-order-detail", id] });
    },
  });
}

export function useDeletePurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: true; deleted: string }>(`/api/purchase-orders/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mfg-purchase-orders"] }),
  });
}

export function useOutstandingSoItems() {
  return useQuery({
    queryKey: ["po-outstanding-so-items"],
    queryFn: async () => {
      const res = await api.get<{ items: OutstandingSoItem[] }>(`/api/purchase-orders/outstanding-so-items`);
      return res.items;
    },
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export function useCreatePosFromSoItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ created: unknown[]; total: number }>(`/api/purchase-orders/from-sos`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mfg-purchase-orders"] }),
  });
}

export type CancelPoMutation = UseMutationResult<{ purchaseOrder: PoHeaderRow }, Error, string>;
export type ReopenPoMutation = UseMutationResult<{ purchaseOrder: PoHeaderRow }, Error, string>;

/* ════════════════════════════════════════════════════════════════════════
   Purchase Orders list page
   ════════════════════════════════════════════════════════════════════════ */

// 2990s collapsed the filter pills to Outstanding / All. Outstanding =
// SUBMITTED ∪ PARTIALLY_RECEIVED (the buyer's 95% view), filtered client-side
// since the API supports one status at a time.
type StatusFilter = "all" | "outstanding";
const STATUS_CHIPS: { value: StatusFilter; label: string }[] = [
  { value: "outstanding", label: "Outstanding" },
  { value: "all", label: "All" },
];

const STATUS_CLASS: Record<PoStatus, string> = {
  SUBMITTED: styles.statusActive ?? "",
  PARTIALLY_RECEIVED: styles.statusActive ?? "",
  RECEIVED: styles.statusActive ?? "",
  CANCELLED: styles.statusBlocked ?? "",
};

const poStatusLabel = (s: PoStatus): string => {
  // Mirror 2990s's convert-vocabulary relabel (PARTIALLY_RECEIVED → "Partially
  // Converted", RECEIVED → "Converted").
  switch (s) {
    case "SUBMITTED":
      return "Submitted";
    case "PARTIALLY_RECEIVED":
      return "Partially Converted";
    case "RECEIVED":
      return "Converted";
    case "CANCELLED":
      return "Cancelled";
  }
};

const fmtMoney = (centi: number, currency: Currency): string =>
  `${currency} ${(centi / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDateOrDash = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

/** Per-row items preview, AutoCount style: `CODE×qty · CODE×qty · +N more`. */
const summarizeItems = (items: PoHeaderRow["items"]): string | null => {
  if (!items || items.length === 0) return null;
  const HEAD = 3;
  const shown = items
    .slice(0, HEAD)
    .map((it) => `${it.material_code}×${it.qty}`)
    .join(" · ");
  const extra = items.length - HEAD;
  return extra > 0 ? `${shown} · +${extra} more` : shown;
};

export const PurchaseOrders = () => {
  const navigate = useNavigate();
  // Default to Outstanding (the 95% view).
  const [status, setStatus] = useState<StatusFilter>("outstanding");

  const cancelPo = useCancelPurchaseOrder();
  const reopenPo = useReopenPurchaseOrder();

  // Always fetch all rows; filter Outstanding client-side (one trip, small set).
  const { data, isLoading, error } = usePurchaseOrders();
  const rows = useMemo(() => {
    const all = data ?? [];
    if (status === "all") return all;
    return all.filter((r) => r.status === "SUBMITTED" || r.status === "PARTIALLY_RECEIVED");
  }, [data, status]);

  const doCancelPo = (po: PoHeaderRow) => {
    if (!confirm(`Cancel ${po.po_number}? It will stop proceeding and any converted SO lines are released back.`)) return;
    cancelPo.mutate(po.id, {
      onError: (e) => alert(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`),
    });
  };
  const doReopenPo = (po: PoHeaderRow) => {
    if (!confirm(`Reopen ${po.po_number}? Status returns to SUBMITTED and its converted SO lines re-claim their quota.`)) return;
    reopenPo.mutate(po.id, {
      onError: (e) => alert(`Reopen failed: ${e instanceof Error ? e.message : String(e)}`),
    });
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.title}>Purchase Orders</h1>
        </div>
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          {/* From Sales Order — picker renders the "after the SO slice" empty
              state for now (Strategy-2). Entry point kept verbatim. */}
          <Button variant="ghost" onClick={() => navigate("/purchase-orders/from-so")}>
            <ArrowRightLeft {...ICON} />
            <span>From Sales Order</span>
          </Button>
          <Button variant="primary" onClick={() => navigate("/purchase-orders/new")}>
            <Plus {...ICON} />
            <span>New Purchase Order</span>
          </Button>
        </div>
      </div>

      <div className={styles.statusChips}>
        {STATUS_CHIPS.map((c) => (
          <StatusChip key={c.value} active={status === c.value} onClick={() => setStatus(c.value)}>
            {c.label}
          </StatusChip>
        ))}
      </div>

      <p className={styles.eyebrow}>{isLoading ? "Loading POs…" : `${rows.length} purchase orders`}</p>

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load POs.</strong>{" "}
          {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>PO No.</th>
              <th>Supplier</th>
              <th>Items</th>
              <th>Date</th>
              <th>Expected</th>
              <th>Currency</th>
              <th style={{ textAlign: "right" }}>Total</th>
              <th>Status</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !isLoading ? (
              <tr>
                <td colSpan={9}>
                  <p className={styles.emptyRow}>No POs yet — click "New Purchase Order" to start.</p>
                </td>
              </tr>
            ) : (
              rows.map((po) => {
                const summary = summarizeItems(po.items);
                return (
                  <tr
                    key={po.id}
                    onClick={() => navigate(`/purchase-orders/${po.id}`)}
                    style={po.status === "CANCELLED" ? { opacity: 0.55 } : undefined}
                  >
                    <td>
                      <span className={styles.codeChip}>{po.po_number}</span>
                    </td>
                    <td>{po.supplier?.name ?? po.supplier?.code ?? "—"}</td>
                    <td>
                      <span
                        title={(po.items ?? []).map((it) => `${it.material_code} × ${it.qty}`).join("\n")}
                        style={{
                          display: "block",
                          fontFamily: "var(--font-mono)",
                          fontSize: "var(--fs-12)",
                          color: summary ? "var(--c-ink)" : "var(--fg-muted)",
                          maxWidth: 320,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {summary ?? "—"}
                      </span>
                    </td>
                    <td>{fmtDateOrDash(po.po_date)}</td>
                    <td>{fmtDateOrDash(po.expected_at)}</td>
                    <td>{po.currency}</td>
                    <td style={{ textAlign: "right" }}>
                      <span style={{ fontWeight: 700, color: "var(--c-burnt)" }}>
                        {fmtMoney(po.total_centi, po.currency)}
                      </span>
                    </td>
                    <td>
                      <span className={`${styles.statusPill} ${STATUS_CLASS[po.status]}`}>{poStatusLabel(po.status)}</span>
                    </td>
                    <td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                      {(po.status === "SUBMITTED" || po.status === "PARTIALLY_RECEIVED") && (
                        <Button variant="ghost" onClick={() => doCancelPo(po)} disabled={cancelPo.isPending}>
                          Cancel
                        </Button>
                      )}
                      {po.status === "CANCELLED" && (
                        <Button variant="ghost" onClick={() => doReopenPo(po)} disabled={reopenPo.isPending}>
                          Reopen
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const StatusChip = ({
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
    onClick={onClick}
    style={{
      fontFamily: "var(--font-button)",
      fontSize: "var(--fs-13)",
      fontWeight: 600,
      padding: "var(--space-2) var(--space-4)",
      borderRadius: "var(--radius-pill)",
      border: active ? "1px solid var(--c-ink)" : "1px solid var(--line)",
      background: active ? "var(--c-ink)" : "var(--c-paper)",
      color: active ? "var(--c-cream)" : "var(--c-ink)",
      cursor: "pointer",
    }}
  >
    {children}
  </button>
);
