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

export default scm;
