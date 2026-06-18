import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";

/**
 * Retained headless after the strip-to-core cutover ONLY for the Projects
 * Setup/Dismantle + Logistics crew pickers, which call GET /api/fleet/staff.
 * The rest of the Fleet module (clock, salary, inspections, lorry maintenance/
 * incidents, compliance) was deleted — do not re-add it here.
 */
const app = new Hono<{ Bindings: Env }>();

// List drivers / helpers / storekeepers for the Projects crew dropdowns.
app.get("/staff", requirePermission("users.read"), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.phone, u.company_phone, u.status, u.user_type,
            u.ic_number, u.license_no, u.license_expiry,
            u.base_salary, u.trip_allowance_rate, u.ot_rate,
            u.role_id, r.name as role_name, u.created_at
       FROM users u
       JOIN roles r ON r.id = u.role_id
      WHERE r.name IN ('Driver','Helper','Storekeeper')
        AND u.status IN ('active','invited')
      ORDER BY r.name, u.name`,
  ).all();
  return c.json({ data: rows.results ?? [] });
});

export default app;
