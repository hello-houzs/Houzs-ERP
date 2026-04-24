import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { auth } from "./middleware/auth";
import orders from "./routes/orders";
import sync from "./routes/sync";
import balance from "./routes/balance";
import po from "./routes/po";
import assr from "./routes/assr";
import overdue from "./routes/overdue";
import logs from "./routes/logs";
import udf from "./routes/udf";
import authRoutes from "./routes/auth";
import users from "./routes/users";
import roles from "./routes/roles";
import departments from "./routes/departments";
import sales from "./routes/sales";
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
import settings from "./routes/settings";
import inbox from "./routes/inbox";
import projectsPrint from "./routes/projects_print";
import finance from "./routes/finance";
import search from "./routes/search";
import creditors from "./routes/creditors";
import stockItems from "./routes/stockItems";
import assrPrint from "./routes/assr_print";
import survey from "./routes/survey";
import track from "./routes/track";
import portal from "./routes/portal";
import { caseTrack } from "./middleware/caseTrack";
import { runPull } from "./services/pull";
import { runPOPull, runPODocsPull } from "./services/po";
import { runOverdue } from "./services/overdue";
import { runSlaEscalation } from "./services/assrEscalation";
import { runProjectDueReminders } from "./services/projectReminders";
import { runCreditorsPull } from "./services/creditors";
import { runStockItemsRefresh } from "./services/stockItems";

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

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

// Auth gate for everything else under /api/*. Mounted AFTER the
// public API routes above so they stay unauthenticated.
app.use("/api/*", auth);

app.route("/api/orders", orders);
app.route("/api/sync", sync);
app.route("/api/balance", balance);
app.route("/api/po", po);
app.route("/api/assr", assr);
app.route("/api/overdue", overdue);
app.route("/api/logs", logs);
app.route("/api/udf", udf);
app.route("/api/users", users);
app.route("/api/roles", roles);
app.route("/api/departments", departments);
app.route("/api/sales", sales);
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
app.route("/api/settings", settings);
app.route("/api/inbox", inbox);
app.route("/api/projects-print", projectsPrint);
app.route("/api/finance", finance);
app.route("/api/search", search);
app.route("/api/creditors", creditors);
app.route("/api/stockitems", stockItems);
app.route("/api/assr-print", assrPrint);

app.onError((err, c) => {
  console.error("[onError]", err);
  return c.json({ error: err.message || "Internal error" }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (event.cron === "*/5 * * * *") {
      // Tight loop: incremental SO pull. Everything else waits for slower slots.
      ctx.waitUntil(runPull(env, "SCHEDULED").catch((e) => console.error("[cron pull]", e)));
    } else if (event.cron === "*/30 * * * *") {
      // Procurement data: PO docs (/getAll) + outstanding lines (/getOutstanding).
      // Each wrapped independently so one failure doesn't hide the other.
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
    } else if (event.cron === "0 2 * * *") {
      ctx.waitUntil(runOverdue(env, "SCHEDULED").catch((e) => console.error("[cron overdue]", e)));
      // Piggyback the daily 02:00 slot: run SLA escalation right after
      // overdue. Cheap (single query + ≤ N updates) so no separate cron.
      ctx.waitUntil(
        runSlaEscalation(env)
          .then((r) => console.log(`[cron sla] escalated ${r.escalated} case(s)`))
          .catch((e) => console.error("[cron sla]", e))
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
      ctx.waitUntil(
        runCreditorsPull(env, "SCHEDULED")
          .then((r) => console.log(`[cron creditors] ${r.message}`))
          .catch((e) => console.error("[cron creditors]", e))
      );
      // Refresh the stock-items cache (item → MainSupplier) and
      // re-resolve creditor_code on any ASSR case whose item's
      // supplier changed upstream.
      ctx.waitUntil(
        runStockItemsRefresh(env, {})
          .then((r) => console.log(`[cron stockitems] ${r.message}`))
          .catch((e) => console.error("[cron stockitems]", e))
      );
    }
  },
};
