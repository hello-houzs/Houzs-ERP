import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { auth } from "./middleware/auth";
import { idempotency } from "./middleware/idempotency";
import { requestLog } from "./middleware/requestLog";
import orders from "./routes/orders";
import sync from "./routes/sync";
import balance from "./routes/balance";
import po from "./routes/po";
import assr from "./routes/assr";
import overdue from "./routes/overdue";
import logs from "./routes/logs";
import auditRoutes from "./routes/audit";
import systemHealthRoutes from "./routes/systemHealth";
import udf from "./routes/udf";
import authRoutes from "./routes/auth";
import totpRoutes from "./routes/totp";
import users from "./routes/users";
import roles from "./routes/roles";
import positions from "./routes/positions";
import departments from "./routes/departments";
import sales from "./routes/sales";
import salesTeam from "./routes/sales-team";
import notifications from "./routes/notifications";
import presence from "./routes/presence";
import trips from "./routes/trips";
import lorries from "./routes/lorries";
import warehouses from "./routes/warehouses";
import maps from "./routes/maps";
import planner from "./routes/planner";
import events from "./routes/events";
import fleet from "./routes/fleet";
import delivery from "./routes/delivery";
import projects from "./routes/projects";
import driverProjects from "./routes/driverProjects";
import settings from "./routes/settings";
import inbox from "./routes/inbox";
import projectsPrint from "./routes/projects_print";
import finance from "./routes/finance";
import search from "./routes/search";
import creditors from "./routes/creditors";
import suppliers from "./routes/suppliers";
import mfgPurchaseOrders from "./routes/mfg-purchase-orders";
import inventory from "./routes/inventory";
import grns from "./routes/grns";
import purchaseInvoices from "./routes/purchase-invoices";
import purchaseReturns from "./routes/purchase-returns";
import stockTransfers from "./routes/stock-transfers";
import stockTakes from "./routes/stock-takes";
import mfgSalesOrders from "./routes/mfg-sales-orders";
import mfgDeliveryOrders from "./routes/delivery-orders-mfg";
import salesInvoices from "./routes/sales-invoices";
import deliveryReturns from "./routes/delivery-returns";
import purchaseConsignmentOrders from "./routes/purchase-consignment-orders";
import purchaseConsignmentReceives from "./routes/purchase-consignment-receives";
import purchaseConsignmentReturns from "./routes/purchase-consignment-returns";
import consignmentOrders from "./routes/consignment-orders";
import consignmentNotes from "./routes/consignment-notes";
import consignmentReturns from "./routes/consignment-returns";
import mrp from "./routes/mrp";
import mrpLeadTimes from "./routes/mrp-lead-times";
// Products & Maintenance slice (#58) — FULL furniture catalogue + pricing engine.
import productsRoute from "./routes/products";
import categoriesRoute from "./routes/categories";
import productModelsRoute from "./routes/product-models";
import mfgProductsRoute from "./routes/mfg-products";
import maintenanceConfigRoute from "./routes/maintenance-config";
import fabricTrackingRoute from "./routes/fabric-tracking";
import fabricLibraryRoute from "./routes/fabric-library";
import fabricTierAddonRoute from "./routes/fabric-tier-addon";
import pwpCodesRoute from "./routes/pwp-codes";
import pwpRulesRoute from "./routes/pwp-rules";
import sofaCombosRoute from "./routes/sofa-combos";
import mfgWarehouses from "./routes/warehouse";
import stockItems from "./routes/stockItems";
import assrPrint from "./routes/assr_print";
import assrPortal from "./routes/assrPortal";
import survey from "./routes/survey";
import track from "./routes/track";
import portal from "./routes/portal";
import supplierPortal from "./routes/supplierPortal";
import gamify from "./routes/gamify";
import awards from "./routes/awards";
import ideaAttachments from "./routes/ideaAttachments";
import ideaComments from "./routes/ideaComments";
import pettyCash from "./routes/pettyCash";
import innovations from "./routes/innovations";
import suggestions from "./routes/suggestions";
import { caseTrack } from "./middleware/caseTrack";
import { supplierTrack } from "./middleware/supplierTrack";
import { dbInject, withPgDb } from "./middleware/db";
import { runPull } from "./services/pull";
import { drainEmailOutbox } from "./services/email";
import { isAutoCountSyncDisabled } from "./services/autocount";
import { runPOPull, runPODocsPull } from "./services/po";
import { runOverdue } from "./services/overdue";
import { runSlaEscalation } from "./services/assrEscalation";
import { runAssrAlerts, runAssrDailyDigest } from "./services/assrAlerts";
import { runScheduledLeadTimeActivations } from "./services/assrLeadTime";
import { runProjectDueReminders } from "./services/projectReminders";
import { runCreditorsPull } from "./services/creditors";
import { runStockItemsRefresh } from "./services/stockItems";
import {
  recomputeWeeklyStreaks,
  refreshAllLeaderboards,
  resetMonthlyGifting,
} from "./services/points";

const app = new Hono<{ Bindings: Env }>();

// Outermost: one structured access-log line + X-Request-Id per request.
app.use("*", requestLog);

app.use("*", cors());

// D1 -> Supabase cutover: swap env.DB for the Postgres-backed shim on every
// request, before auth + routes. Remove once all paths use Drizzle/postgres.js.
app.use("*", dbInject);

app.get("/", (c) => c.json({ ok: true, service: "autocount-sync-api" }));
app.get("/health", (c) => c.json({ ok: true }));

// /api/auth/* is unauthenticated (login, bootstrap, accept-invite, status,
// me, logout). It must be mounted BEFORE the auth middleware below.
app.route("/api/auth", authRoutes);

// Public customer survey — unauthenticated, token-based. Lives under
// /api/survey (not /survey) so it doesn't collide with the SPA route
// at /survey/:token. The SPA page fetches from /api/survey.
app.route("/api/survey", survey);

// Customer Portal — tokenised per-case tracking.
//   POST /api/track               public: verify ASSR no + phone
//   /api/portal/*   (caseTrack)   single-case scoped API
// Both live under /api so the existing /api/* rewrite in _redirects
// forwards them correctly, and they never collide with SPA paths
// like /track or /portal/case/:token.
app.route("/api/track", track);
app.use("/api/portal/*", caseTrack);
app.route("/api/portal", portal);

// Supplier portal — same shape as customer portal, different middleware.
app.use("/api/supplier-portal/*", supplierTrack);
app.route("/api/supplier-portal", supplierPortal);

// Auth gate for everything else under /api/*. Mounted AFTER the
// public API routes above so they stay unauthenticated.
app.use("/api/*", auth);

// Opt-in request idempotency (no-op unless the client sends an
// `Idempotency-Key` header). Mounted after auth so `userId` is set, and
// before the routes so it can replay a stored response. Fail-open.
app.use("/api/*", idempotency);

app.route("/api/orders", orders);
app.route("/api/sync", sync);
app.route("/api/balance", balance);
app.route("/api/po", po);
// Mount the Lead Time Portal first so /api/assr/portal/* doesn't
// fall through into the catch-all /:id handler on the main module.
app.route("/api/assr/portal", assrPortal);
app.route("/api/assr", assr);
app.route("/api/overdue", overdue);
app.route("/api/logs", logs);
app.route("/api/audit", auditRoutes);
app.route("/api/admin/health", systemHealthRoutes);
app.route("/api/udf", udf);
app.route("/api/totp", totpRoutes);
app.route("/api/users", users);
app.route("/api/roles", roles);
app.route("/api/positions", positions);
app.route("/api/departments", departments);
app.route("/api/sales", sales);
app.route("/api/sales-team", salesTeam);
app.route("/api/notifications", notifications);
app.route("/api/presence", presence);
app.route("/api/trips", trips);
app.route("/api/lorries", lorries);
app.route("/api/warehouses", warehouses);
app.route("/api/maps", maps);
app.route("/api/planner", planner);
app.route("/api/events", events);
app.route("/api/fleet", fleet);
app.route("/api/delivery", delivery);
app.route("/api/projects", projects);
app.route("/api/driver/projects", driverProjects);
app.route("/api/settings", settings);
app.route("/api/inbox", inbox);
app.route("/api/projects-print", projectsPrint);
app.route("/api/finance", finance);
app.route("/api/search", search);
app.route("/api/creditors", creditors);
app.route("/api/suppliers", suppliers);
// SCM 1:1 clone — manufacturer-side Purchase Orders. DISTINCT from the existing
// AutoCount /api/po route/page (do NOT touch that one). Owner-only (perm "*").
app.route("/api/purchase-orders", mfgPurchaseOrders);
// SCM 1:1 clone — Inventory (FIFO ledger/lots/valuation) + Warehouse rack mgmt.
// Inventory is /api/inventory. Rack management is /api/mfg-warehouses — DISTINCT
// from the live AutoCount /api/warehouses route above (do NOT touch that one);
// the clone's warehouse table is mfg_warehouses. Owner-only (perm "*").
app.route("/api/inventory", inventory);
app.route("/api/mfg-warehouses", mfgWarehouses);
// SCM 1:1 clone — Goods Receipt (GRN): PO -> GRN -> (PI/PR later). GRN POST rolls
// received_qty onto mfg_purchase_order_items + writes an inventory IN movement +
// places lines on racks. No AutoCount collision -> /api/grns. Owner-only (perm "*").
app.route("/api/grns", grns);
// SCM 1:1 clone — Purchase Invoice (AP record, no stock impact) + Purchase Return
// (return to supplier, stock OUT). PO -> GRN -> {PI, PR}. No AutoCount collision
// -> /api/purchase-invoices + /api/purchase-returns. Owner-only (perm "*").
app.route("/api/purchase-invoices", purchaseInvoices);
app.route("/api/purchase-returns", purchaseReturns);
// SCM 1:1 clone — Stock Transfers (paired OUT@from + IN@to inventory movements,
// FIFO cost handoff) + Stock Takes (cycle count -> signed ADJUSTMENT movements).
// Both write into the inventory ledger via lib/inventory-movements. No AutoCount
// collision -> /api/stock-transfers + /api/stock-takes. Owner-only (perm "*").
app.route("/api/stock-transfers", stockTransfers);
app.route("/api/stock-takes", stockTakes);
// SCM 1:1 clone — Sales Orders (the biggest slice). Generic document lifecycle
// (CONFIRMED..CANCELLED), line CRUD, payments-as-transactions, price overrides,
// stock-status flip + auto-advance, unified audit trail; stock readiness/
// allocation wired to the inventory ledger (lib/so-stock-allocation). Furniture
// pricing engine + DO/SI/DR aggregates dropped per Strategy-2 (see route header).
// Houzs has `sales_orders` (AutoCount, different name) -> /api/mfg-sales-orders.
// Owner-only (perm "*").
app.route("/api/mfg-sales-orders", mfgSalesOrders);
// SCM 1:1 clone — Delivery Orders + Sales Invoices + Delivery Returns
// (order-to-cash downstream). DO post = ship stock (inventory OUT via
// lib/inventory-movements, source_doc_type:'DO') + advance the SO via
// so-delivery-sync. DR = return from customer (inventory IN, source_doc_type:'DR').
// SI = AR finance doc, no stock impact (GL/AR posting out of SCM-clone scope).
// The bare /api/delivery is Houzs's existing AutoCount logistics route (NOT
// touched) -> DO mounts at /api/mfg-delivery-orders. No collision for SI/DR.
// Owner-only (perm "*").
app.route("/api/mfg-delivery-orders", mfgDeliveryOrders);
app.route("/api/sales-invoices", salesInvoices);
app.route("/api/delivery-returns", deliveryReturns);
// SCM 1:1 clone — CONSIGNMENT (last document-flow group). PURCHASE consignment:
// PC Order (order only) -> PC Receive (inventory IN via lib/inventory-movements,
// source_doc_type 'PC_RECEIVE') -> PC Return (inventory OUT, 'PC_RETURN'); cancel/
// line-edit emit STOCK_TRANSFER delta movements. No AutoCount collision -> bare
// mounts. Owner-only (perm "*").
app.route("/api/purchase-consignment-orders", purchaseConsignmentOrders);
app.route("/api/purchase-consignment-receives", purchaseConsignmentReceives);
app.route("/api/purchase-consignment-returns", purchaseConsignmentReturns);
// SALES consignment (#67 part 2): Consignment Order (order only, audit ->
// consignment_so_audit_log) -> Consignment Note (ships goods OUT, source_doc_type
// 'CS_DO') -> Consignment Return (goods back IN, 'CS_DR'); cancel/line-edit emit
// STOCK_TRANSFER deltas. Owner-only (perm "*").
app.route("/api/consignment-orders", consignmentOrders);
app.route("/api/consignment-notes", consignmentNotes);
app.route("/api/consignment-returns", consignmentReturns);
// SCM 1:1 clone — MRP · Stock Status (slice #64). /api/mrp is the PURE CALCULATOR
// (demand = open SO lines, supply = inventory_balances + open PO lines, greedy
// allocation by delivery date per warehouse+product+variant; NO persistence,
// recomputed every GET). /api/mrp-lead-times is the one persisted config table
// (mrp_category_lead_times, migration 0032) feeding the order-by-date calc.
// Furniture sofa-SET grouping dropped per Strategy-2 (generic by product_code).
// Owner-only (perm "*").
app.route("/api/mrp", mrp);
app.route("/api/mrp-lead-times", mrpLeadTimes);
// Products & Maintenance slice (#58) — FULL clone of 2990s's furniture catalogue
// + pricing engine (NOT Strategy-2-stripped; owner: clone it all). All routes
// owner-only (perm "*"); BARE table names (migration 0033). /products = retail
// catalogue, /mfg-products = manufacturer SKU master.
app.route("/api/products", productsRoute);
app.route("/api/categories", categoriesRoute);
app.route("/api/product-models", productModelsRoute);
app.route("/api/mfg-products", mfgProductsRoute);
app.route("/api/maintenance-config", maintenanceConfigRoute);
app.route("/api/fabric-tracking", fabricTrackingRoute);
app.route("/api/fabric-library", fabricLibraryRoute);
app.route("/api/fabric-tier-addon", fabricTierAddonRoute);
app.route("/api/pwp-codes", pwpCodesRoute);
app.route("/api/pwp-rules", pwpRulesRoute);
app.route("/api/sofa-combos", sofaCombosRoute);
app.route("/api/stockitems", stockItems);
app.route("/api/assr-print", assrPrint);
app.route("/api/gamify", gamify);
app.route("/api/awards", awards);
app.route("/api/innovations", innovations);
app.route("/api/suggestions", suggestions);
app.route("/api/idea-attachments", ideaAttachments);
app.route("/api/idea-comments", ideaComments);
app.route("/api/petty-cash", pettyCash);

// Map raw infrastructure errors to operator-friendly messages so staff never
// see a Postgres/driver string (e.g. the "operator does not exist: date < text"
// or "CONNECTION_CLOSED" leaks seen during the cutover). Full error still goes
// to wrangler tail for us. HTTPException (thrown with an intended status) passes
// through untouched.
function humanizeError(err: Error): { status: 500 | 503; message: string } {
  const m = String(err?.message ?? err);
  if (/CONNECTION_CLOSED|Network connection lost|ECONNREFUSED|ECONNRESET|terminating connection|Timed out .*pool|server closed the connection/i.test(m))
    return { status: 503, message: "The database is briefly unavailable. Please try again in a moment." };
  if (/operator does not exist|column .* does not exist|relation .* does not exist|syntax error|invalid input syntax|violates .* constraint|duplicate key/i.test(m))
    return { status: 500, message: "Something went wrong processing that request. Our team has been notified." };
  return { status: 500, message: "Something went wrong. Please try again." };
}

app.onError((err, c) => {
  console.error("[onError]", err);
  // Preserve Hono HTTPException status/body (intentional 4xx from handlers).
  const anyErr = err as Error & { getResponse?: () => Response; status?: number };
  const base =
    typeof anyErr.getResponse === "function"
      ? anyErr.getResponse()
      : (() => {
          const { status, message } = humanizeError(err);
          return c.json({ error: message }, status);
        })();
  // The cors() middleware sets Access-Control-Allow-Origin in its post-next()
  // pass, which is SKIPPED when a handler throws — so error responses would
  // otherwise reach the browser WITHOUT CORS headers and surface as an opaque
  // "Failed to fetch" instead of the real status/message. Re-add them here so
  // every error is readable by the SPA. (Matches cors() default origin "*".)
  const res = new Response(base.body, base);
  res.headers.set("Access-Control-Allow-Origin", "*");
  return res;
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Cutover: cron services write via env.DB too — point it at Postgres.
    env = withPgDb(env);
    // Inbound AutoCount sync kill switch. When set, skip every job that PULLS
    // from AutoCount (SO/PO/overdue/creditors/stock). Non-AutoCount jobs (ASSR
    // alerts, SLA, reminders, points) still run. Set 2026-06-13 at owner request.
    const syncOff = isAutoCountSyncDisabled(env);
    if (syncOff) console.log("[cron] AutoCount sync disabled — skipping inbound pulls");
    if (event.cron === "*/5 * * * *") {
      // Keep-warm: a trivial DB ping every 5 min keeps the Hyperdrive pool
      // alive through quiet periods so the first real request never hits a
      // reaped/cold connection. Runs even when AutoCount sync is disabled
      // (which removed the SO pull that used to warm it). Cheap — SELECT 1.
      ctx.waitUntil(
        env.DB.prepare("SELECT 1 AS ok").first().catch((e) => console.error("[cron keepwarm]", e))
      );
      // Durable email: retry outbox rows whose immediate send failed. No-op
      // without RESEND_API_KEY; bounded to 25 rows / 3 attempts so a bad batch
      // can't stall the slot. Runs even when AutoCount sync is off.
      ctx.waitUntil(
        drainEmailOutbox(env)
          .then((r) => {
            if (r.processed) console.log(`[cron email-outbox] processed=${r.processed} sent=${r.sent} failed=${r.failed}`);
          })
          .catch((e) => console.error("[cron email-outbox]", e))
      );
      // Tight loop: incremental SO pull. Everything else waits for slower slots.
      if (!syncOff)
        ctx.waitUntil(runPull(env, "SCHEDULED").catch((e) => console.error("[cron pull]", e)));
    } else if (event.cron === "*/30 * * * *") {
      // Procurement data: PO docs (/getAll) + outstanding lines (/getOutstanding).
      // Each wrapped independently so one failure doesn't hide the other.
      if (!syncOff) {
      ctx.waitUntil(
        runPODocsPull(env, "SCHEDULED")
          .then((r) => console.log(`[cron po-docs] ${r.message}`))
          .catch((e) => console.error("[cron po-docs]", e))
      );
      ctx.waitUntil(
        runPOPull(env, "SCHEDULED")
          .then((r) => console.log(`[cron po-lines] ${r.message}`))
          .catch((e) => console.error("[cron po-lines]", e))
      );
      }
      // ASSR/QMS v3.1 — per-stage alert scanner (half / approaching /
      // breach). Cheap: one query over open stage_history rows,
      // idempotent via the alerts_fired bit-mask, so safe to share
      // this 30-min slot with the PO pulls.
      ctx.waitUntil(
        runAssrAlerts(env)
          .then((r) =>
            console.log(
              `[cron assr-alerts] scanned=${r.cases_scanned} half=${r.half} appr=${r.approaching} breach=${r.breach}`
            )
          )
          .catch((e) => console.error("[cron assr-alerts]", e))
      );
      // Lead-time scheduled activations (mig 080). Cheap: one indexed
      // SELECT for pending rows whose scheduled_for is past; the loop
      // only does write work when there's something due. 30-min
      // granularity is fine for "swap at the start of next Monday".
      ctx.waitUntil(
        runScheduledLeadTimeActivations(env)
          .then((r) => {
            if (r.fired > 0) console.log(`[cron lead-time-schedule] fired=${r.fired}`);
          })
          .catch((e) => console.error("[cron lead-time-schedule]", e))
      );
    } else if (event.cron === "0 2 * * *") {
      if (!syncOff)
        ctx.waitUntil(runOverdue(env, "SCHEDULED").catch((e) => console.error("[cron overdue]", e)));
      // Piggyback the daily 02:00 slot: run SLA escalation right after
      // overdue. Cheap (single query + ≤ N updates) so no separate cron.
      ctx.waitUntil(
        runSlaEscalation(env)
          .then((r) => console.log(`[cron sla] escalated ${r.escalated} case(s)`))
          .catch((e) => console.error("[cron sla]", e))
      );
      // ASSR v3.1 daily digest — runs at 02:00 UTC (10:00 MYT). A bit
      // later than proposal §9's 08:00 MYT target but folded into the
      // existing daily slot to stay under the Workers free-plan cron
      // cap. Acceptable trade-off for the internal-only audience.
      ctx.waitUntil(
        runAssrDailyDigest(env)
          .then((r) => console.log(`[cron assr-digest] sent=${r.recipients} cases=${r.cases}`))
          .catch((e) => console.error("[cron assr-digest]", e))
      );
      // Daily project checklist reminders ride the same slot.
      ctx.waitUntil(
        runProjectDueReminders(env)
          .then((r) =>
            console.log(
              `[cron proj-reminders] ${r.items} item(s) across ${r.recipients} recipient(s), ${r.sent} email(s) sent`
            )
          )
          .catch((e) => console.error("[cron proj-reminders]", e))
      );
      // Creditors change rarely — daily resync is plenty to keep the
      // mirror + any new supplier onboarded in AutoCount visible.
      if (!syncOff)
      ctx.waitUntil(
        runCreditorsPull(env, "SCHEDULED")
          .then((r) => console.log(`[cron creditors] ${r.message}`))
          .catch((e) => console.error("[cron creditors]", e))
      );
      // Refresh the stock-items cache (item → MainSupplier) and
      // re-resolve creditor_code on any ASSR case whose item's
      // supplier changed upstream.
      if (!syncOff)
      ctx.waitUntil(
        runStockItemsRefresh(env, {})
          .then((r) => console.log(`[cron stockitems] ${r.message}`))
          .catch((e) => console.error("[cron stockitems]", e))
      );
      // Houzs Points (mig 055): roll up the current ISO week's
      // qualifying activity per user, recompute current_streak, and
      // refresh every leaderboard scope/period cache.
      ctx.waitUntil(
        recomputeWeeklyStreaks(env)
          .then((r) =>
            console.log(
              `[cron streaks] week=${r.current_week} touched=${r.users_touched}`,
            ),
          )
          .catch((e) => console.error("[cron streaks]", e)),
      );
      ctx.waitUntil(
        refreshAllLeaderboards(env)
          .then((n) => console.log(`[cron leaderboards] refreshed=${n}`))
          .catch((e) => console.error("[cron leaderboards]", e)),
      );
      // Monthly gifting reset folded into the same daily slot — the
      // helper is idempotent on `users.gifting_reset_at = YYYY-MM-01`,
      // so 30/31 days a month it no-ops and on the 1st it grants the
      // monthly allowance exactly once. Avoids a 5th cron line on the
      // free plan's trigger cap.
      ctx.waitUntil(
        resetMonthlyGifting(env)
          .then((r) =>
            console.log(
              `[cron gifting-reset] ${r.users_reset} user(s) granted ${r.amount} for ${r.period}`,
            ),
          )
          .catch((e) => console.error("[cron gifting-reset]", e)),
      );
      // Idempotency-key TTL sweep. Keys only need to outlive a client's
      // retry window; 24h is generous. Cheap (indexed on created_at).
      ctx.waitUntil(
        env.DB.prepare(
          `DELETE FROM idempotency_keys WHERE created_at < datetime('now','-24 hours')`,
        )
          .run()
          .then((r) => {
            const n = r?.meta?.changes ?? 0;
            if (n) console.log(`[cron idempotency-sweep] purged ${n} expired key(s)`);
          })
          .catch((e) => console.error("[cron idempotency-sweep]", e)),
      );
    }
  },
};
