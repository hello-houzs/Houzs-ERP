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
import { scanPayment } from "./routes/scan-payment";
import { slips } from "./routes/slips";

import { scmAreaGuard } from "./middleware/area-guard";

export const scm = new Hono<{ Bindings: Env }>();

// ── L2 per-area WRITE authorization (ADDITIVE on top of requireScmAccess) ────
// Each sub-router is preceded by `scm.use('/<prefix>/*', scmAreaGuard('<area>'))`
// so GET/HEAD require 'view' and POST/PATCH/PUT/DELETE require 'edit' on the
// mapped L2 page key — but ONLY for users with an explicit SCM L2 config
// (user.scm_l2_configured). Users with no SCM L2 rows fall through to the coarse
// scm.access umbrella (no lockout). Owner/`*` always bypasses. The guard runs
// before each sub-router's own supabaseAuth (which replaces c.get('user')), so
// it reads the intact Houzs AuthUser. See middleware/area-guard.ts.
//
// SHARED READ HELPERS — staff, fabric-colours, localities, document-flow,
// reports, state-warehouse-mappings — are cross-area picklists/lookups consumed
// by many SCM pages (e.g. the SO salesperson dropdown, the SoLineCard colour
// picker, the document-flow graph, the report listings). Per-area write-gating
// them would over-restrict: a Storekeeper editing a transfer still needs to read
// staff + localities. They are read-mostly and not sensitive, so we leave them on
// the coarse scm.access gate (NO scmAreaGuard) rather than pick an arbitrary L2
// owner. reports + document-flow are read-only by construction; the few writes on
// the others (e.g. state-warehouse-mappings POST) stay umbrella-gated.

// ── Products & Maintenance (scm.procurement.products) ───────────────────────
scm.use("/products/*", scmAreaGuard("scm.procurement.products"));
scm.route("/products", products);
scm.use("/admin/categories/*", scmAreaGuard("scm.procurement.products"));
scm.route("/admin/categories", categoriesApi);
scm.use("/delivery-fees/*", scmAreaGuard("scm.procurement.products"));
scm.route("/delivery-fees", deliveryFees);
scm.use("/fabric-tier-addon/*", scmAreaGuard("scm.procurement.products"));
scm.route("/fabric-tier-addon", fabricTierAddonConfig);
scm.use("/pwp-rules/*", scmAreaGuard("scm.procurement.products"));
scm.route("/pwp-rules", pwpRules);
scm.use("/pwp-codes/*", scmAreaGuard("scm.procurement.products"));
scm.route("/pwp-codes", pwpCodes);
scm.use("/special-addons/*", scmAreaGuard("scm.procurement.products"));
scm.route("/special-addons", specialAddons);
scm.use("/fabric-library/*", scmAreaGuard("scm.procurement.products"));
scm.route("/fabric-library", fabricLibrary);
scm.use("/mfg-products/*", scmAreaGuard("scm.procurement.products"));
scm.route("/mfg-products", mfgProducts);
scm.use("/product-models/*", scmAreaGuard("scm.procurement.products"));
scm.route("/product-models", productModels);
// Static prefix must precede the parent /maintenance-config.
scm.use("/maintenance-config/sofa-compartments/*", scmAreaGuard("scm.procurement.products"));
scm.route("/maintenance-config/sofa-compartments", sofaCompartmentPhotos);
scm.use("/maintenance-config/*", scmAreaGuard("scm.procurement.products"));
scm.route("/maintenance-config", maintenanceConfig);
scm.use("/sofa-combos/*", scmAreaGuard("scm.procurement.products"));
scm.route("/sofa-combos", sofaCombos);
scm.use("/sofa-quick-picks/*", scmAreaGuard("scm.procurement.products"));
scm.route("/sofa-quick-picks", sofaQuickPicks);
scm.use("/fabric-tracking/*", scmAreaGuard("scm.procurement.products"));
scm.route("/fabric-tracking", fabricTracking);
// ── Suppliers (scm.procurement.suppliers) ───────────────────────────────────
scm.use("/suppliers/*", scmAreaGuard("scm.procurement.suppliers"));
scm.route("/suppliers", suppliers);
// ── Purchase Orders / GRN / PI (scm.procurement.*) ──────────────────────────
scm.use("/mfg-purchase-orders/*", scmAreaGuard("scm.procurement.po"));
scm.route("/mfg-purchase-orders", mfgPurchaseOrders);
scm.use("/grns/*", scmAreaGuard("scm.procurement.grn"));
scm.route("/grns", grns);
scm.use("/purchase-invoices/*", scmAreaGuard("scm.procurement.pi"));
scm.route("/purchase-invoices", purchaseInvoices);
// ── Sales Orders (scm.sales.orders) ─────────────────────────────────────────
scm.use("/mfg-sales-orders/*", scmAreaGuard("scm.sales.orders"));
scm.route("/mfg-sales-orders", mfgSalesOrders);
// state-warehouse-mappings: cross-area lookup (SO/DO warehouse routing) — left
// on the coarse gate, see SHARED READ HELPERS note above.
scm.route("/state-warehouse-mappings", stateWarehouseMappings);
scm.use("/delivery-orders-mfg/*", scmAreaGuard("scm.sales.delivery"));
scm.route("/delivery-orders-mfg", deliveryOrdersMfg);
// Ported 2026-06-20 — SI backend (skipped in the earlier sync; the vendored SI
// pages 404'd on /sales-invoices). NEEDS scm.sales_invoice_payments +
// scm.customer_credits applied (scripts/scm-schema/0103-0110-si-payments-and-credits.sql)
// and scm.accounts seeded (codes 1100/4000) for GL posting.
scm.use("/sales-invoices/*", scmAreaGuard("scm.sales.invoices"));
scm.route("/sales-invoices", salesInvoices);
scm.use("/delivery-returns/*", scmAreaGuard("scm.sales.returns"));
scm.route("/delivery-returns", deliveryReturns);
scm.use("/purchase-returns/*", scmAreaGuard("scm.procurement.pr"));
scm.route("/purchase-returns", purchaseReturns);
// ── Consignment (scm.consignment.*) ─────────────────────────────────────────
scm.use("/consignment-orders/*", scmAreaGuard("scm.consignment.orders"));
scm.route("/consignment-orders", consignmentOrders);
scm.use("/consignment-notes/*", scmAreaGuard("scm.consignment.notes"));
scm.route("/consignment-notes", consignmentNotes);
scm.use("/consignment-returns/*", scmAreaGuard("scm.consignment.returns"));
scm.route("/consignment-returns", consignmentReturns);
// NOTE: purchase_consignment_* tables are not built yet (2990's consignment
// schema drift) — these three 500 at runtime until the tables exist.
scm.use("/purchase-consignment-orders/*", scmAreaGuard("scm.consignment.po_orders"));
scm.route("/purchase-consignment-orders", purchaseConsignmentOrders);
scm.use("/purchase-consignment-receives/*", scmAreaGuard("scm.consignment.po_receives"));
scm.route("/purchase-consignment-receives", purchaseConsignmentReceives);
scm.use("/purchase-consignment-returns/*", scmAreaGuard("scm.consignment.po_returns"));
scm.route("/purchase-consignment-returns", purchaseConsignmentReturns);
// ── Warehouse (scm.warehouse.*) ─────────────────────────────────────────────
scm.use("/inventory/*", scmAreaGuard("scm.warehouse.inventory"));
scm.route("/inventory", inventory);
scm.use("/warehouse/*", scmAreaGuard("scm.warehouse.inventory"));
scm.route("/warehouse", warehouse);
scm.use("/stock-transfers/*", scmAreaGuard("scm.warehouse.transfers"));
scm.route("/stock-transfers", stockTransfers);
scm.use("/stock-takes/*", scmAreaGuard("scm.warehouse.stock_take"));
scm.route("/stock-takes", stockTakes);
// ── SCM Finance (scm.finance.accounting) ────────────────────────────────────
scm.use("/accounting/*", scmAreaGuard("scm.finance.accounting"));
scm.route("/accounting", accounting);
// ── MRP (scm.procurement.mrp) ───────────────────────────────────────────────
scm.use("/mrp/*", scmAreaGuard("scm.procurement.mrp"));
scm.route("/mrp", mrp);
scm.use("/mrp-lead-times/*", scmAreaGuard("scm.procurement.mrp"));
scm.route("/mrp-lead-times", mrpLeadTimes);
// Ported 2026-06-20 — Outstanding dashboard (v_*_outstanding views), MY
// State/City/Postcode reference (my_localities). /fabric-library already
// mounted above — its GET list was added to the existing route, not remounted.
scm.use("/outstanding/*", scmAreaGuard("scm.finance.outstanding"));
scm.route("/outstanding", outstanding);
// localities: MY State/City/Postcode reference — cross-area lookup, left on the
// coarse gate (see SHARED READ HELPERS note above).
scm.route("/localities", localities);
// Wired 2026-06-20 — SCM stub-wiring wave: SO Salesperson dropdown (staff),
// SoLineCard fabric-colour picker (fabric-colours). /product-models gained a
// GET /by-code/:code for the SoLineCard saved-line allowed_options resolve.
// staff + fabric-colours: cross-area picklists read by SO/DO/PO etc. — left on
// the coarse gate (see SHARED READ HELPERS note above).
scm.route("/staff", staff);
scm.route("/fabric-colours", fabricColours);
// Wired 2026-06-20 — Order Add-ons tab (Products page). CRUD over scm.addons,
// replacing the supabase-direct read/write the 2990 UI used.
scm.use("/addons/*", scmAreaGuard("scm.procurement.products"));
scm.route("/addons", addons);
// Ported 2026-06-21 — vendored SCM consumers already shipped (404'd at runtime).
// document-flow: read-only SAP-B1 relationship graph GET /document-flow/:type/:id
// (SO/DO/SI/Payment/PO/GRN/PI/DR/PR + consignment family). drivers: CRUD over
// scm.drivers (DO driver picker). All referenced tables exist in the scm schema.
// document-flow: read-only cross-area graph — left on the coarse gate (see
// SHARED READ HELPERS note above).
scm.route("/document-flow", documentFlow);
scm.use("/drivers/*", scmAreaGuard("scm.transportation.drivers"));
scm.route("/drivers", drivers);
// Ported 2026-06-21 — SO Maintenance picklists (so_dropdown_options). Backs the
// vendored SO Maintenance mini-tables (customer_type / building_type /
// relationship / payment_method cascade / venue). Seeded by
// scripts/scm-schema/seed-scm-reference-data.sql. Mapped to products (the SO
// Maintenance config lives under Products & Maintenance).
scm.use("/so-dropdown-options/*", scmAreaGuard("scm.procurement.products"));
scm.route("/so-dropdown-options", soDropdownOptions);
// Ported 2026-06-21 — AutoCount-style Detail Listing reports. The vendored
// report pages (reports-queries.ts) call GET /reports/{sales-order,delivery-order,
// sales-invoice,delivery-return}-detail-listing; never mounted before, so all
// four 404'd. Read-only nested-join reads over mfg_sales_order_items /
// delivery_order_items / sales_invoice_items / delivery_return_items (+ headers
// + mfg_sales_order_payments + staff). All referenced tables exist in the scm
// schema. paid_centi on mfg_sales_orders does NOT exist in Houzs (dropped on
// port) — paid totals derive from the payments ledger.
// reports: read-only cross-area detail listings — left on the coarse gate (see
// SHARED READ HELPERS note above).
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
// scan-so / scan-payment / slips feed SO creation → gated as scm.sales.orders.
scm.use("/scan-so/*", scmAreaGuard("scm.sales.orders"));
scm.route("/scan-so", scanSo);
// Re-added 2026-06-23 — card-terminal / EPP receipt OCR for the Payments panel.
// The receipt IS the payment row's slip (one upload, both uses): the frontend
// POSTs the image here in parallel with the slip upload and fill-blanks-only
// auto-fills the row's method/bank/online-type/installment/approval/amount
// fields. Reads the live active so_dropdown_options (payment_method /
// payment_merchant / online_type / installment_plan); never invents a value.
// Extraction-only (no samples/learning). ANTHROPIC_API_KEY optional —
// /scan-payment/extract returns 503 anthropic_key_missing when absent.
scm.use("/scan-payment/*", scmAreaGuard("scm.sales.orders"));
scm.route("/scan-payment", scanPayment);
// Ported 2026-06-24 — payment-slip upload session (init → browser presigned
// PUT → confirm). PRODUCES the pending_slip_uploads row that the SO-create +
// add-payment handlers (mfg-sales-orders.ts) CONSUME by upload_session_id;
// without it the New-SO payment-slip upload 404'd on /slips/init. Needs the
// SLIPS R2 binding + R2 S3 creds (intentionally unbound until configured —
// slipBindings() throws a clear r2_not_configured error until then).
scm.use("/slips/*", scmAreaGuard("scm.sales.orders"));
scm.route("/slips", slips);

export default scm;
