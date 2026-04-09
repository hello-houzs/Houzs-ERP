import { Hono } from "hono";
import type { Env } from "../types";
import { runPull } from "../services/pull";
import { retryErrors } from "../services/push";
import { isAutoCountWritesDisabled } from "../services/autocount";

const app = new Hono<{ Bindings: Env }>();

app.post("/pull", async (c) => {
  const mode = c.req.query("mode") === "all" ? "all" : "filtered";
  const result = await runPull(c.env, "MANUAL", mode);
  return c.json(result);
});

app.post("/retry-errors", async (c) => {
  const result = await retryErrors(c.env);
  return c.json(result);
});

app.get("/status", async (c) => {
  const cp = await c.env.DB.prepare(
    `SELECT value FROM system_settings WHERE key = 'pull_checkpoint'`
  ).first<{ value: string }>();

  const lastPull = await c.env.DB.prepare(
    `SELECT started_at, ended_at, status, message FROM execution_logs
     WHERE type LIKE 'PULL\_MANUAL%' ESCAPE '\' OR type LIKE 'PULL\_SCHEDULED%' ESCAPE '\'
     ORDER BY id DESC LIMIT 1`
  ).first();

  const lastPullAll = await c.env.DB.prepare(
    `SELECT started_at, ended_at, status, message FROM execution_logs
     WHERE type LIKE 'PULL\_ALL\_%' ESCAPE '\' ORDER BY id DESC LIMIT 1`
  ).first();

  const errorCount = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM sales_orders WHERE sync_status = 'ERROR'`
  ).first<{ count: number }>();

  return c.json({
    checkpoint: cp?.value || null,
    last_pull: lastPull,
    last_pull_all: lastPullAll,
    error_count: errorCount?.count || 0,
    autocount_writes_disabled: isAutoCountWritesDisabled(),
  });
});

export default app;
