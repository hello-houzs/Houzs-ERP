// ----------------------------------------------------------------------------
// /api/pos — POS auth on Houzs (Phase 1 of the 2990-backend replacement).
//
// Lets the 2990 POS log into HOUZS (session auth) so it can stop using Supabase
// Auth. Mounted BEFORE the global /api/* auth gate; the two write endpoints
// re-apply `auth` per-route.
//   POST /pin-login   {staffId, pin}  -> mints a Houzs session      (PRE-AUTH)
//   GET  /sales-staff                 -> PIN-login picker list        (PRE-AUTH)
//   POST /set-pin      {pin}          -> set the caller's own PIN      (authed)
//   POST /verify-pin   {pin}          -> re-verify for sensitive ops   (authed)
//   GET  /sales-stats                 -> caller's MTD KPI tiles        (authed)
//
// staffId = an scm.staff uuid (from /sales-staff). scm.staff.user_id links to the
// public.users integer (migration 0066); we mint the session for THAT user.
// PIN store + brute-force RPCs live in migration 0099 (scm.pos_pins /
// scm.pos_pin_attempts / scm.pin_attempt_*).
// ----------------------------------------------------------------------------
import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { auth } from "../middleware/auth";
import { companyContext } from "../middleware/companyContext";
import {
  createSession,
  verifyPassword,
  hashPassword,
  SESSION_ORIGIN_POS,
} from "../services/auth";

type Vars = { user?: { id: number }; companyId?: number };
const pos = new Hono<{ Bindings: Env; Variables: Vars }>();

const MAX_FAILURES = 5;
const WINDOW_SECONDS = 60;
const isPin = (v: unknown): v is string => typeof v === "string" && /^\d{6}$/.test(v);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── PRE-AUTH: PIN login → Houzs session ─────────────────────────────────────
pos.post("/pin-login", async (c) => {
  let body: { staffId?: string; pin?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  const staffId = String(body.staffId ?? "").trim();
  const pin = body.pin;
  if (!staffId) return c.json({ error: "staff_required" }, 400);
  // staff_id is a uuid column — a malformed value would 500 on the DB (22P02).
  // Treat a non-uuid like a bad login (401), not a crash, and skip the DB hit.
  if (!UUID_RE.test(staffId)) return c.json({ error: "bad_pin" }, 401);
  if (!isPin(pin)) return c.json({ error: "pin_invalid" }, 400);
  const DB = c.env.DB;

  // 1) brute-force gate (durable, 60s rolling window; fails OPEN on DB blip)
  try {
    const chk = await DB.prepare(`SELECT allowed, retry_after FROM scm.pin_attempt_check(?, ?)`)
      .bind(staffId, MAX_FAILURES).first<{ allowed: boolean; retry_after: number }>();
    if (chk && chk.allowed === false) {
      return c.json({ error: "too_many_attempts", retryAfter: Number(chk.retry_after) || 60 }, 429);
    }
  } catch { /* fail open */ }

  // 2) look up the PIN hash + the linked Houzs user
  const row = await DB.prepare(
    `SELECT p.pin_hash, s.user_id FROM scm.pos_pins p JOIN scm.staff s ON s.id = p.staff_id WHERE p.staff_id = ?`,
  ).bind(staffId).first<{ pin_hash: string; user_id: number | null }>();

  const ok = row && row.user_id != null && (await verifyPassword(pin, row.pin_hash));
  if (!ok) {
    try { await DB.prepare(`SELECT scm.pin_attempt_fail(?, ?)`).bind(staffId, WINDOW_SECONDS).run(); } catch {}
    return c.json({ error: "bad_pin" }, 401);
  }

  // 3) success → clear the counter, mint a Houzs session for the linked user.
  //
  // SESSION_ORIGIN_POS is the anti-tamper hinge and this is its ONLY writer.
  // It marks the SESSION, not the user: the same person's desktop and mobile
  // sessions stay origin-less and keep pricing freely, while everything done
  // with THIS token is held to the server's price by the SO pricing envelope
  // (scm/routes/mfg-sales-orders.ts isPosTabletCaller). The tablet is not
  // asked to declare itself and cannot decline to — it is stamped here, on
  // the way through the PIN gate, by the server.
  try { await DB.prepare(`SELECT scm.pin_attempt_reset(?)`).bind(staffId).run(); } catch {}
  const token = await createSession(c.env, Number(row!.user_id), SESSION_ORIGIN_POS);
  return c.json({ token, userId: Number(row!.user_id), staffId });
});

// ── PRE-AUTH: salesperson picker for the PIN screen ─────────────────────────
pos.get("/sales-staff", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT s.id, s.staff_code, s.name, (p.staff_id IS NOT NULL) AS has_pin
       FROM scm.staff s LEFT JOIN scm.pos_pins p ON p.staff_id = s.id
      WHERE s.active = true AND s.user_id IS NOT NULL
      ORDER BY s.name`,
  ).all<{ id: string; staff_code: string; name: string; has_pin: boolean }>();
  return c.json({ staff: rows.results ?? [] });
});

// helper: resolve the logged-in Houzs user → their scm.staff uuid
async function callerStaffId(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<string | null> {
  const uid = c.get("user")?.id;
  if (uid == null) return null;
  const s = await c.env.DB.prepare(`SELECT id FROM scm.staff WHERE user_id = ?`).bind(uid).first<{ id: string }>();
  return s?.id ?? null;
}

// ── AUTHED: set / change own PIN ────────────────────────────────────────────
pos.post("/set-pin", auth, async (c) => {
  let body: { pin?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!isPin(body.pin)) return c.json({ error: "pin_invalid" }, 400);
  const staffId = await callerStaffId(c);
  if (!staffId) return c.json({ error: "no_staff_row" }, 400);
  const hash = await hashPassword(body.pin!);
  await c.env.DB.prepare(
    `INSERT INTO scm.pos_pins (staff_id, pin_hash, updated_at) VALUES (?, ?, now())
       ON CONFLICT (staff_id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, updated_at = now()`,
  ).bind(staffId, hash).run();
  return c.json({ ok: true });
});

// ── AUTHED: re-verify PIN for a sensitive action ────────────────────────────
pos.post("/verify-pin", auth, async (c) => {
  let body: { pin?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!isPin(body.pin)) return c.json({ error: "pin_invalid" }, 400);
  const staffId = await callerStaffId(c);
  if (!staffId) return c.json({ error: "no_staff_row" }, 400);
  const row = await c.env.DB.prepare(`SELECT pin_hash FROM scm.pos_pins WHERE staff_id = ?`)
    .bind(staffId).first<{ pin_hash: string }>();
  const ok = row ? await verifyPassword(body.pin!, row.pin_hash) : false;
  return c.json({ ok });
});

// ── AUTHED: caller's month-to-date KPI tiles ────────────────────────────────
// companyContext runs here explicitly: /api/pos is mounted BEFORE the global
// /api/* companyContext (it must stay pre-auth for pin-login), so without this
// the c.get("companyId") scope below would always be undefined and the MTD
// tiles would pool BOTH companies' orders. Applied only on this authed route.
pos.get("/sales-stats", auth, companyContext, async (c) => {
  const staffId = await callerStaffId(c);
  if (!staffId) return c.json({ ordersMtd: 0, revenueMtdSen: 0 });
  const companyId = (c.get("companyId") as number | undefined) ?? null;
  const scope = companyId != null ? `AND company_id = ${Number(companyId)}` : "";
  const row = await c.env.DB.prepare(
    `SELECT count(*)::int AS orders, COALESCE(sum(total_revenue_centi),0)::bigint AS revenue
       FROM scm.mfg_sales_orders
      WHERE salesperson_id = ? AND so_date >= date_trunc('month', current_date) ${scope}`,
  ).bind(staffId).first<{ orders: number; revenue: number }>();
  return c.json({ ordersMtd: Number(row?.orders ?? 0), revenueMtdSen: Number(row?.revenue ?? 0) });
});

export default pos;
