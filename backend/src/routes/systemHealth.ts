import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";

// ---------------------------------------------------------------------------
// /api/admin/health — owner-only ("*") System Health, "real data" phase 1.
//
// Ported from Hookka ERP's /admin/health, trimmed to what Houzs can show
// WITHOUT Cloudflare Analytics Engine (Houzs has no AE binding). The
// latency-percentile / slow-SQL / front-end-RUM panels Hookka feeds from AE
// are deferred to a phase 2 that would stand up an AE dataset + query token.
//
// What this serves with REAL data today:
//   GET /live        — a live DB ping (the true request-path latency, so the
//                      Hyperdrive cold-start stall is visible), KV reachability,
//                      and headcount + audit counts.
//   GET /audit-feed  — recent business mutations from audit_events, plus a
//                      by-action / by-resource rollup, and a sensitive-action
//                      filter (the closest real-data stand-in for Hookka's
//                      security panel, which needs auth events Houzs doesn't
//                      capture yet).
//
// Every query is wrapped so a DB stall surfaces as { ok:false } in the JSON
// instead of throwing — the health page must stay readable even when the
// thing it monitors is unhealthy.
// ---------------------------------------------------------------------------
const app = new Hono<{ Bindings: Env }>();

// Sensitive-action matcher (SQL): security-relevant mutations worth a
// dedicated eye. Kept in one place so /live counts and /audit-feed agree.
const SENSITIVE_SQL =
  "(action LIKE 'user.disable%' OR action LIKE 'user.delete%' OR action LIKE 'user.reset_password%' OR action LIKE 'role.%' OR action LIKE 'user.totp%' OR action = 'finance.update')";

const RANGE_MS: Record<string, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};
function cutoffIso(range: string | undefined): string {
  const ms = RANGE_MS[range || "24h"] ?? RANGE_MS["24h"];
  return new Date(Date.now() - ms).toISOString();
}

app.get("/live", requirePermission("*"), async (c) => {
  // DB ping FIRST so it captures any cold-connection establishment cost —
  // this is the headline number the operator watches for the "Failed to
  // fetch" cold-start stall.
  const db: { ok: boolean; latency_ms: number; error?: string } = {
    ok: false,
    latency_ms: 0,
  };
  const t0 = Date.now();
  try {
    const r = await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    db.ok = !!r?.ok;
    db.latency_ms = Date.now() - t0;
  } catch (e: any) {
    db.latency_ms = Date.now() - t0;
    db.error = e?.message || "DB ping failed";
  }

  // KV reachability — a cheap GET of a probe key (null is fine; we time the
  // round-trip, not the value). Optional binding, so guard it.
  const kv = { bound: !!c.env.SESSION_CACHE, ok: false, latency_ms: 0 };
  if (c.env.SESSION_CACHE) {
    const k0 = Date.now();
    try {
      await c.env.SESSION_CACHE.get("health:probe");
      kv.ok = true;
      kv.latency_ms = Date.now() - k0;
    } catch {
      kv.latency_ms = Date.now() - k0;
    }
  }

  // Counts — reuse the (now-warm) connection. Each wrapped so one failure
  // doesn't blank the rest of the payload.
  const counts = {
    users_active: 0,
    users_invited: 0,
    users_disabled: 0,
    audit_24h: 0,
    audit_7d: 0,
    sensitive_24h: 0,
    last_event_at: null as string | null,
  };
  if (db.ok) {
    const iso24 = cutoffIso("24h");
    const iso7 = cutoffIso("7d");
    try {
      const byStatus = await c.env.DB.prepare(
        "SELECT status, COUNT(*) AS c FROM users GROUP BY status",
      ).all<{ status: string; c: number }>();
      for (const row of byStatus.results ?? []) {
        if (row.status === "active") counts.users_active = Number(row.c);
        else if (row.status === "invited") counts.users_invited = Number(row.c);
        else if (row.status === "disabled") counts.users_disabled = Number(row.c);
      }
    } catch {}
    try {
      const a24 = await c.env.DB.prepare(
        "SELECT COUNT(*) AS c FROM audit_events WHERE created_at >= ?",
      )
        .bind(iso24)
        .first<{ c: number }>();
      counts.audit_24h = Number(a24?.c ?? 0);
      const a7 = await c.env.DB.prepare(
        "SELECT COUNT(*) AS c FROM audit_events WHERE created_at >= ?",
      )
        .bind(iso7)
        .first<{ c: number }>();
      counts.audit_7d = Number(a7?.c ?? 0);
      const sens = await c.env.DB.prepare(
        `SELECT COUNT(*) AS c FROM audit_events WHERE created_at >= ? AND ${SENSITIVE_SQL}`,
      )
        .bind(iso24)
        .first<{ c: number }>();
      counts.sensitive_24h = Number(sens?.c ?? 0);
      const last = await c.env.DB.prepare(
        "SELECT created_at FROM audit_events ORDER BY created_at DESC LIMIT 1",
      ).first<{ created_at: string }>();
      counts.last_event_at = last?.created_at ?? null;
    } catch {}
  }

  return c.json({
    ok: db.ok,
    time: new Date().toISOString(),
    db,
    kv,
    counts,
  });
});

app.get("/audit-feed", requirePermission("*"), async (c) => {
  const range = c.req.query("range") || "24h";
  const cutoff = cutoffIso(range);
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10) || 100, 200);
  const sensitiveOnly = c.req.query("sensitive") === "1";
  const filterSql = sensitiveOnly ? ` AND ${SENSITIVE_SQL}` : "";

  try {
    const rows = await c.env.DB.prepare(
      `SELECT id, created_at, actor_id, actor_email, action, entity_type, entity_id, summary
         FROM audit_events
        WHERE created_at >= ?${filterSql}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
      .bind(cutoff, limit)
      .all();

    const byAction = await c.env.DB.prepare(
      `SELECT action, COUNT(*) AS n FROM audit_events WHERE created_at >= ?${filterSql} GROUP BY action ORDER BY n DESC LIMIT 8`,
    )
      .bind(cutoff)
      .all<{ action: string; n: number }>();

    const byResource = await c.env.DB.prepare(
      `SELECT entity_type, COUNT(*) AS n FROM audit_events WHERE created_at >= ?${filterSql} AND entity_type IS NOT NULL GROUP BY entity_type ORDER BY n DESC LIMIT 8`,
    )
      .bind(cutoff)
      .all<{ entity_type: string; n: number }>();

    return c.json({
      success: true,
      data: rows.results ?? [],
      summary: {
        byAction: (byAction.results ?? []).map((r) => ({ action: r.action, n: Number(r.n) })),
        byResource: (byResource.results ?? []).map((r) => ({
          resource: r.entity_type,
          n: Number(r.n),
        })),
      },
    });
  } catch (e: any) {
    return c.json({ success: false, error: e?.message || "audit-feed failed", data: [], summary: { byAction: [], byResource: [] } });
  }
});

export default app;
