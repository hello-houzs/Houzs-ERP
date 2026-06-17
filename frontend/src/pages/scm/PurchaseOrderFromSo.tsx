// ----------------------------------------------------------------------------
// PurchaseOrderFromSo — multi-select Sales-Order → PO picker (route
// /purchase-orders/from-so).
//
// 2990s renders a DataGrid of outstanding SO lines (qty > po_qty_picked, pooled
// MRP shortage) with per-line pick checkboxes + qty inputs, then emits one PO per
// main supplier via POST /from-sos.
//
// Strategy-2 STUB (per the brief): the Sales Orders slice (mfg_sales_orders /
// mfg_sales_order_items) is NOT cloned yet, so there is no outstanding-SO data to
// pick from. This page renders the faithful empty state — it does NOT fake SO
// data. The route + the "From Sales Order" entry points exist verbatim so wiring
// the real picker when the SO slice lands is a drop-in replacement.
//   - useOutstandingSoItems() returns { items: [] } from the guarded endpoint.
//   - The page shows an "available after the Sales Orders slice" notice.
// TODO: port the full DataGrid picker + per-supplier PO emit (with the
// Strategy-2-trimmed pricing) when the SO slice lands.
//
// SEAM: react-router -> react-router-dom; @2990s/design-system Button -> Houzs
// components/Button; the verbatim PO-detail CSS module for the page shell.
// ----------------------------------------------------------------------------

import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRightLeft } from "lucide-react";
import { Button } from "../../components/Button";
import { useOutstandingSoItems } from "./PurchaseOrders";
import styles from "./PurchaseOrderDetail.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

export const PurchaseOrderFromSo = () => {
  // Calls the guarded endpoint (returns { items: [] } until the SO slice lands)
  // so the wiring + query key are in place verbatim.
  const itemsQ = useOutstandingSoItems();
  const items = itemsQ.data ?? [];

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/purchase-orders" className={styles.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Purchase Orders</span>
          </Link>
          <h1 className={styles.title}>
            <ArrowRightLeft size={14} strokeWidth={1.75} style={{ color: "var(--c-burnt)" }} />
            Create POs from Sales Orders
          </h1>
        </div>
      </div>

      {/* Empty state — SO slice not cloned yet. */}
      <section className={styles.card}>
        <div className={styles.cardBody}>
          {items.length === 0 ? (
            <div style={{ textAlign: "center", padding: "var(--space-6)", color: "var(--fg-muted)" }}>
              <p style={{ fontFamily: "var(--font-title)", fontSize: "var(--fs-15)", color: "var(--c-ink)", margin: "0 0 var(--space-2)" }}>
                Convert from Sales Order is coming with the Sales Orders module.
              </p>
              <p style={{ margin: 0, fontSize: "var(--fs-13)" }}>
                There are no outstanding Sales Order lines to convert yet. Once the Sales Orders slice lands, this picker
                lists every outstanding SO line and creates one purchase order per supplier.
              </p>
              <div style={{ marginTop: "var(--space-4)" }}>
                <Link to="/purchase-orders/new">
                  <Button variant="primary">Create a Purchase Order manually instead</Button>
                </Link>
              </div>
            </div>
          ) : (
            // Unreachable until the SO slice lands (endpoint returns []); kept so
            // the future picker has a render target.
            <p className={styles.eyebrow}>{items.length} outstanding Sales Order line(s)</p>
          )}
        </div>
      </section>
    </div>
  );
};
