import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { hasPermission } from "../services/permissions";
import {
  getDriverProfile, patchProfile, listDriversAndHelpers,
  clockIn, clockOut, getClockStatus, listClockRecords,
  submitInspection, getTodayInspection, listMissingInspections,
  getLorryDetail, patchLorry, addMaintenance, addIncident, getExpiringCompliance,
  getSalaryView, getTodayEarnings,
} from "../services/fleet";

const app = new Hono<{ Bindings: Env }>();

// ── Drivers & helpers ─────────────────────────────────────────────

// List all drivers and helpers (dispatcher view)
app.get("/staff", requirePermission("users.read"), async (c) => {
  const data = await listDriversAndHelpers(c.env);
  return c.json({ data });
});

// Driver/helper profile detail
app.get("/staff/:id", requirePermission("users.read"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Bad id" }, 400);
  const profile = await getDriverProfile(c.env, id);
  if (!profile) return c.json({ error: "Not found" }, 404);
  return c.json(profile);
});

// Update driver/helper profile
app.patch("/staff/:id", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Bad id" }, 400);
  const body = await c.req.json<any>();
  const ok = await patchProfile(c.env, id, body);
  return c.json({ ok });
});

// ── My profile (driver/helper self-service) ───────────────────────

app.get("/me", async (c) => {
  const user = c.get("user");
  const profile = await getDriverProfile(c.env, user.id);
  return c.json(profile);
});

app.patch("/me", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<any>();
  // Self-service: only allow name + contact fields, never salary/type/role.
  const allowed = ["name", "phone", "emergency_contact_name", "emergency_contact_phone"];
  const filtered: Record<string, any> = {};
  for (const k of allowed) {
    if (k in body) filtered[k] = body[k];
  }
  const ok = await patchProfile(c.env, user.id, filtered);
  return c.json({ ok });
});

// ── Clock in/out ──────────────────────────────────────────────────

app.post("/clock/in", async (c) => {
  const user = c.get("user");
  const result = await clockIn(c.env, user.id);
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

app.post("/clock/out", async (c) => {
  const user = c.get("user");
  const result = await clockOut(c.env, user.id);
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

app.get("/clock/status", async (c) => {
  const user = c.get("user");
  const record = await getClockStatus(c.env, user.id);
  return c.json({ record });
});

app.get("/clock/history", async (c) => {
  const user = c.get("user");
  const month = c.req.query("month");
  const records = await listClockRecords(c.env, user.id, month || undefined);
  return c.json({ data: records });
});

// ── Daily inspection ──────────────────────────────────────────────

app.post("/inspection", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<any>();
  if (!body.lorry_id) return c.json({ error: "lorry_id required" }, 400);
  const result = await submitInspection(c.env, body.lorry_id, user.id, {
    checklist: body.checklist || {},
    passed: body.passed ?? true,
    notes: body.notes,
  });
  return c.json(result);
});

app.get("/inspection/today/:lorryId", async (c) => {
  const lorryId = parseInt(c.req.param("lorryId"), 10);
  if (Number.isNaN(lorryId)) return c.json({ error: "Bad id" }, 400);
  const record = await getTodayInspection(c.env, lorryId);
  return c.json({ record });
});

app.get("/inspection/missing", requirePermission("fleet.read"), async (c) => {
  const data = await listMissingInspections(c.env);
  return c.json({ data });
});

// ── Lorry management ──────────────────────────────────────────────

app.get("/lorries/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Bad id" }, 400);
  const detail = await getLorryDetail(c.env, id);
  if (!detail) return c.json({ error: "Not found" }, 404);
  return c.json(detail);
});

app.patch("/lorries/:id", requirePermission("fleet.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Bad id" }, 400);
  const body = await c.req.json<any>();
  const ok = await patchLorry(c.env, id, body);
  return c.json({ ok });
});

app.post("/lorries/:id/maintenance", requirePermission("fleet.manage"), async (c) => {
  const lorryId = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(lorryId)) return c.json({ error: "Bad id" }, 400);
  const user = c.get("user");
  const body = await c.req.json<any>();
  if (!body.maintenance_date) return c.json({ error: "maintenance_date required" }, 400);
  const id = await addMaintenance(c.env, lorryId, body, user.id);
  return c.json({ id });
});

app.post("/lorries/:id/incidents", requirePermission("fleet.manage"), async (c) => {
  const lorryId = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(lorryId)) return c.json({ error: "Bad id" }, 400);
  const user = c.get("user");
  const body = await c.req.json<any>();
  if (!body.incident_date) return c.json({ error: "incident_date required" }, 400);
  const id = await addIncident(c.env, lorryId, body, user.id);
  return c.json({ id });
});

app.get("/compliance/expiring", requirePermission("fleet.read"), async (c) => {
  const days = parseInt(c.req.query("days") || "30", 10);
  const data = await getExpiringCompliance(c.env, days);
  return c.json(data);
});

// ── Salary (self-service for drivers/helpers) ─────────────────────

app.get("/salary", async (c) => {
  const user = c.get("user");
  const period = c.req.query("period");
  const data = await getSalaryView(c.env, user.id, period || undefined);
  return c.json(data);
});

app.get("/salary/today", async (c) => {
  const user = c.get("user");
  const data = await getTodayEarnings(c.env, user.id);
  return c.json(data);
});

// Admin: view any user's salary
app.get("/salary/:userId", requirePermission("fleet.manage"), async (c) => {
  const userId = parseInt(c.req.param("userId"), 10);
  if (Number.isNaN(userId)) return c.json({ error: "Bad id" }, 400);
  const period = c.req.query("period");
  const data = await getSalaryView(c.env, userId, period || undefined);
  return c.json(data);
});

export default app;
