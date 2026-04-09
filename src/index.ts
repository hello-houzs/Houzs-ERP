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
import presence from "./routes/presence";
import trips from "./routes/trips";
import lorries from "./routes/lorries";
import warehouses from "./routes/warehouses";
import maps from "./routes/maps";
import planner from "./routes/planner";
import events from "./routes/events";
import { runPull } from "./services/pull";
import { runOverdue } from "./services/overdue";

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

app.get("/", (c) => c.json({ ok: true, service: "autocount-sync-api" }));
app.get("/health", (c) => c.json({ ok: true }));

// /api/auth/* is unauthenticated (login, bootstrap, accept-invite, status,
// me, logout). It must be mounted BEFORE the auth middleware below.
app.route("/api/auth", authRoutes);

// Auth gate for everything else under /api/*
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
app.route("/api/presence", presence);
app.route("/api/trips", trips);
app.route("/api/lorries", lorries);
app.route("/api/warehouses", warehouses);
app.route("/api/maps", maps);
app.route("/api/planner", planner);
app.route("/api/events", events);

app.onError((err, c) => {
  console.error("[onError]", err);
  return c.json({ error: err.message || "Internal error" }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (event.cron === "*/5 * * * *") {
      ctx.waitUntil(runPull(env, "SCHEDULED").catch((e) => console.error("[cron pull]", e)));
    } else if (event.cron === "0 2 * * *") {
      ctx.waitUntil(runOverdue(env, "SCHEDULED").catch((e) => console.error("[cron overdue]", e)));
    }
  },
};
