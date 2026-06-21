import { Hono } from "hono";
import type { Env } from "./env";

// Ported 2990's SCM routes. Each route attaches its own scm-scoped supabase
// client via scm/middleware/auth.ts (`supabaseAuth`). Mounted under /api/scm
// (owner-gated in the main index.ts). Paths mirror 2990's so the ported pages
// can call them with just an /api/scm prefix.
import { products } from "./routes/products";
import { categoriesApi } from "./routes/categories";
import { deliveryFees } from "./routes/delivery-fees";
import { fabricTierAddonConfig } from "./routes/fabric-tier-addon";
import { pwpRules } from "./routes/pwp-rules";
import { pwpCodes } from "./routes/pwp-codes";
import { specialAddons } from "./routes/special-addons";
import { fabricLibrary } from "./routes/fabric-library";
import { mfgProducts } from "./routes/mfg-products";
import { productModels } from "./routes/product-models";
import { sofaCompartmentPhotos } from "./routes/sofa-compartment-photos";
import { maintenanceConfig } from "./routes/maintenance-config";
import { sofaCombos } from "./routes/sofa-combos";
import { sofaQuickPicks } from "./routes/sofa-quick-picks";
import { fabricTracking } from "./routes/fabric-tracking";
import { suppliers } from "./routes/suppliers";
import { mfgPurchaseOrders } from "./routes/mfg-purchase-orders";
import { grns } from "./routes/grns";
import { purchaseInvoices } from "./routes/purchase-invoices";
import { mfgSalesOrders } from "./routes/mfg-sales-orders";
import { stateWarehouseMappings } from "./routes/state-warehouse-mappings";
import { deliveryOrdersMfg } from "./routes/delivery-orders-mfg";
import { salesInvoices } from "./routes/sales-invoices";
import { deliveryReturns } from "./routes/delivery-returns";
import { purchaseReturns } from "./routes/purchase-returns";
import { consignmentOrders } from "./routes/consignment-orders";
import { consignmentNotes } from "./routes/consignment-notes";
import { consignmentReturns } from "./routes/consignment-returns";
import { purchaseConsignmentOrders } from "./routes/purchase-consignment-orders";
import { purchaseConsignmentReceives } from "./routes/purchase-consignment-receives";
import { purchaseConsignmentReturns } from "./routes/purchase-consignment-returns";
import { inventory } from "./routes/inventory";
import { warehouse } from "./routes/warehouse";
import { stockTransfers } from "./routes/stock-transfers";
import { stockTakes } from "./routes/stock-takes";
import { accounting } from "./routes/accounting";
import { mrp } from "./routes/mrp";
import { mrpLeadTimes } from "./routes/mrp-lead-times";
import { outstanding } from "./routes/outstanding";
import { localities } from "./routes/localities";
import { staff } from "./routes/staff";
import { fabricColours } from "./routes/fabric-colours";
import { addons } from "./routes/addons";
import { documentFlow } from "./routes/document-flow";
import { drivers } from "./routes/drivers";
import { soDropdownOptions } from "./routes/so-dropdown-options";
import { reports } from "./routes/reports";
import { scanSo } from "./routes/scan-so";

export const scm = new Hono<{ Bindings: Env }>();

scm.route("/products", products);
scm.route("/admin/categories", categoriesApi);
scm.route("/delivery-fees", deliveryFees);
scm.route("/fabric-tier-addon", fabricTierAddonConfig);
scm.route("/pwp-rules", pwpRules);
scm.route("/pwp-codes", pwpCodes);
scm.route("/special-addons", specialAddons);
scm.route("/fabric-library", fabricLibrary);
scm.route("/mfg-products", mfgProducts);
scm.route("/product-models", productModels);
// Static prefix must precede the parent /maintenance-config.
scm.route("/maintenance-config/sofa-compartments", sofaCompartmentPhotos);
scm.route("/maintenance-config", maintenanceConfig);
scm.route("/sofa-combos", sofaCombos);
scm.route("/sofa-quick-picks", sofaQuickPicks);
scm.route("/fabric-tracking", fabricTracking);
scm.route("/suppliers", suppliers);
scm.route("/mfg-purchase-orders", mfgPurchaseOrders);
scm.route("/grns", grns);
scm.route("/purchase-invoices", purchaseInvoices);
scm.route("/mfg-sales-orders", mfgSalesOrders);
scm.route("/state-warehouse-mappings", stateWarehouseMappings);
scm.route("/delivery-orders-mfg", deliveryOrdersMfg);
// Ported 2026-06-20 — SI backend (skipped in the earlier sync; the vendored SI
// pages 404'd on /sales-invoices). NEEDS scm.sales_invoice_payments +
// scm.customer_credits applied (scripts/scm-schema/0103-0110-si-payments-and-credits.sql)
// and scm.accounts seeded (codes 1100/4000) for GL posting.
scm.route("/sales-invoices", salesInvoices);
scm.route("/delivery-returns", deliveryReturns);
scm.route("/purchase-returns", purchaseReturns);
scm.route("/consignment-orders", consignmentOrders);
scm.route("/consignment-notes", consignmentNotes);
scm.route("/consignment-returns", consignmentReturns);
// NOTE: purchase_consignment_* tables are not built yet (2990's consignment
// schema drift) — these three 500 at runtime until the tables exist.
scm.route("/purchase-consignment-orders", purchaseConsignmentOrders);
scm.route("/purchase-consignment-receives", purchaseConsignmentReceives);
scm.route("/purchase-consignment-returns", purchaseConsignmentReturns);
scm.route("/inventory", inventory);
scm.route("/warehouse", warehouse);
scm.route("/stock-transfers", stockTransfers);
scm.route("/stock-takes", stockTakes);
scm.route("/accounting", accounting);
scm.route("/mrp", mrp);
scm.route("/mrp-lead-times", mrpLeadTimes);
// Ported 2026-06-20 — Outstanding dashboard (v_*_outstanding views), MY
// State/City/Postcode reference (my_localities). /fabric-library already
// mounted above — its GET list was added to the existing route, not remounted.
scm.route("/outstanding", outstanding);
scm.route("/localities", localities);
// Wired 2026-06-20 — SCM stub-wiring wave: SO Salesperson dropdown (staff),
// SoLineCard fabric-colour picker (fabric-colours). /product-models gained a
// GET /by-code/:code for the SoLineCard saved-line allowed_options resolve.
scm.route("/staff", staff);
scm.route("/fabric-colours", fabricColours);
// Wired 2026-06-20 — Order Add-ons tab (Products page). CRUD over scm.addons,
// replacing the supabase-direct read/write the 2990 UI used.
scm.route("/addons", addons);
// Ported 2026-06-21 — vendored SCM consumers already shipped (404'd at runtime).
// document-flow: read-only SAP-B1 relationship graph GET /document-flow/:type/:id
// (SO/DO/SI/Payment/PO/GRN/PI/DR/PR + consignment family). drivers: CRUD over
// scm.drivers (DO driver picker). All referenced tables exist in the scm schema.
scm.route("/document-flow", documentFlow);
scm.route("/drivers", drivers);
// Ported 2026-06-21 — SO Maintenance picklists (so_dropdown_options). Backs the
// vendored SO Maintenance mini-tables (customer_type / building_type /
// relationship / payment_method cascade / venue). Seeded by
// scripts/scm-schema/seed-scm-reference-data.sql.
scm.route("/so-dropdown-options", soDropdownOptions);
// Ported 2026-06-21 — AutoCount-style Detail Listing reports. The vendored
// report pages (reports-queries.ts) call GET /reports/{sales-order,delivery-order,
// sales-invoice,delivery-return}-detail-listing; never mounted before, so all
// four 404'd. Read-only nested-join reads over mfg_sales_order_items /
// delivery_order_items / sales_invoice_items / delivery_return_items (+ headers
// + mfg_sales_order_payments + staff). All referenced tables exist in the scm
// schema. paid_centi on mfg_sales_orders does NOT exist in Houzs (dropped on
// port) — paid totals derive from the payments ledger.
scm.route("/reports", reports);
// Ported 2026-06-21 — Sales Order ICR: photo of a handwritten order slip →
// Claude vision extract → review → prefill New SO, with self-evolution
// (per-salesperson learned rules + few-shot + global aliases). Reads/writes
// scm.so_scan_samples + scm.so_scan_rules (migration 0023) and the scm catalog
// tables (mfg_products / fabric_trackings / maintenance_config_history /
// so_dropdown_options). ANTHROPIC_API_KEY optional — /scan-so/extract returns
// 503 anthropic_key_missing when absent. FOLLOW-UP: weekly distill cron
// (distillAllSalespersonRules) not yet wired to a scheduled trigger; the
// per-confirm fire-and-forget distill is the live learning path.
scm.route("/scan-so", scanSo);

export default scm;
