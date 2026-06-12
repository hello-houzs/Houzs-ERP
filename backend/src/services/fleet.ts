import type { Env } from "../types";

// ── Driver / Helper profiles ─────────────────────────────────────

const PROFILE_FIELDS = [
  "name", "phone", "company_phone", "ic_number", "license_no", "license_expiry",
  "emergency_contact_name", "emergency_contact_phone",
  "base_salary", "trip_allowance_rate", "ot_rate", "max_continuous_hours",
  "user_type",
] as const;

export async function getDriverProfile(env: Env, userId: number) {
  return env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.phone, u.company_phone, u.status, u.user_type,
            u.ic_number, u.license_no, u.license_expiry,
            u.emergency_contact_name, u.emergency_contact_phone,
            u.base_salary, u.trip_allowance_rate, u.ot_rate, u.max_continuous_hours,
            u.role_id, r.name as role_name,
            u.joined_at, u.last_login_at, u.created_at
       FROM users u
       JOIN roles r ON r.id = u.role_id
      WHERE u.id = ?`
  )
    .bind(userId)
    .first<any>();
}

export async function patchProfile(env: Env, userId: number, body: Record<string, any>) {
  const sets: string[] = [];
  const binds: any[] = [];
  for (const k of PROFILE_FIELDS) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push(body[k] ?? null);
    }
  }
  if (!sets.length) return false;
  binds.push(userId);
  const r = await env.DB.prepare(
    `UPDATE users SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run();
  return r.meta.changes > 0;
}

export async function listDriversAndHelpers(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.phone, u.company_phone, u.status, u.user_type,
            u.ic_number, u.license_no, u.license_expiry,
            u.base_salary, u.trip_allowance_rate, u.ot_rate,
            u.role_id, r.name as role_name,
            u.created_at
       FROM users u
       JOIN roles r ON r.id = u.role_id
      WHERE r.name IN ('Driver','Helper','Storekeeper')
        -- Include 'invited' (not-yet-logged-in) crew so they can be
        -- assigned to project setup/dismantle before their first login.
        -- 'disabled' (soft-deleted) accounts stay excluded.
        AND u.status IN ('active','invited')
      ORDER BY r.name, u.name`
  ).all();
  return rows.results ?? [];
}

// ── Clock in/out ─────────────────────────────────────────────────

export async function clockIn(env: Env, userId: number) {
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  const existing = await env.DB.prepare(
    `SELECT id, clock_out FROM driver_clock_records WHERE user_id = ? AND clock_date = ?`
  )
    .bind(userId, today)
    .first<{ id: number; clock_out: string | null }>();

  if (existing && !existing.clock_out) {
    return { error: "Already clocked in today", id: existing.id };
  }

  // Allow re-clock-in if already clocked out (update the record)
  if (existing) {
    await env.DB.prepare(
      `UPDATE driver_clock_records SET clock_out = NULL, total_hours = NULL,
              is_overtime = 0, fatigue_alert = 0, updated_at = datetime('now')
        WHERE id = ?`
    )
      .bind(existing.id)
      .run();
    return { id: existing.id, clock_in: now };
  }

  const r = await env.DB.prepare(
    `INSERT INTO driver_clock_records (user_id, clock_date, clock_in)
     VALUES (?, ?, ?)`
  )
    .bind(userId, today, now)
    .run();
  return { id: r.meta.last_row_id, clock_in: now };
}

export async function clockOut(env: Env, userId: number) {
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  const rec = await env.DB.prepare(
    `SELECT id, clock_in FROM driver_clock_records
      WHERE user_id = ? AND clock_date = ? AND clock_out IS NULL`
  )
    .bind(userId, today)
    .first<{ id: number; clock_in: string }>();

  if (!rec) return { error: "Not clocked in today" };

  const hours = (Date.parse(now) - Date.parse(rec.clock_in)) / 3_600_000;

  // Check fatigue
  const maxHours = await getSettingNumber(env, "fatigue_max_hours", 8);
  const isOt = hours > 8;
  const fatigueAlert = hours > maxHours;

  await env.DB.prepare(
    `UPDATE driver_clock_records
        SET clock_out = ?, total_hours = ?, is_overtime = ?, fatigue_alert = ?,
            updated_at = datetime('now')
      WHERE id = ?`
  )
    .bind(now, Math.round(hours * 100) / 100, isOt ? 1 : 0, fatigueAlert ? 1 : 0, rec.id)
    .run();

  return { id: rec.id, clock_out: now, total_hours: Math.round(hours * 100) / 100, fatigue_alert: fatigueAlert };
}

export async function getClockStatus(env: Env, userId: number) {
  const today = new Date().toISOString().slice(0, 10);
  return env.DB.prepare(
    `SELECT * FROM driver_clock_records WHERE user_id = ? AND clock_date = ?`
  )
    .bind(userId, today)
    .first<any>();
}

export async function listClockRecords(env: Env, userId: number, month?: string) {
  const where = month
    ? `WHERE user_id = ? AND clock_date LIKE ?`
    : `WHERE user_id = ?`;
  const binds = month ? [userId, `${month}%`] : [userId];
  const rows = await env.DB.prepare(
    `SELECT * FROM driver_clock_records ${where} ORDER BY clock_date DESC LIMIT 60`
  )
    .bind(...binds)
    .all();
  return rows.results ?? [];
}

// ── Daily inspection ─────────────────────────────────────────────

export async function submitInspection(
  env: Env,
  lorryId: number,
  driverId: number,
  body: { checklist: Record<string, boolean>; passed: boolean; notes?: string }
) {
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  const r = await env.DB.prepare(
    `INSERT INTO daily_inspections (lorry_id, driver_user_id, inspection_date, checklist_json, passed, notes, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(lorry_id, inspection_date) DO UPDATE SET
       checklist_json = excluded.checklist_json,
       passed = excluded.passed,
       notes = excluded.notes,
       submitted_at = excluded.submitted_at`
  )
    .bind(lorryId, driverId, today, JSON.stringify(body.checklist), body.passed ? 1 : 0, body.notes ?? null, now)
    .run();
  return { id: r.meta.last_row_id, date: today };
}

export async function getTodayInspection(env: Env, lorryId: number) {
  const today = new Date().toISOString().slice(0, 10);
  return env.DB.prepare(
    `SELECT * FROM daily_inspections WHERE lorry_id = ? AND inspection_date = ?`
  )
    .bind(lorryId, today)
    .first<any>();
}

export async function listMissingInspections(env: Env) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await env.DB.prepare(
    `SELECT l.id, l.plate, l.size, l.warehouse, u.name as driver_name
       FROM lorries l
       LEFT JOIN users u ON u.id = l.default_driver_user_id
      WHERE l.is_active = 1 AND l.status = 'active'
        AND l.id NOT IN (
          SELECT lorry_id FROM daily_inspections WHERE inspection_date = ?
        )`
  )
    .bind(today)
    .all();
  return rows.results ?? [];
}

// ── Lorry management ─────────────────────────────────────────────

const LORRY_PATCH_FIELDS = [
  "plate", "size", "model", "warehouse", "is_internal",
  "default_driver_user_id", "capacity_m3", "capacity_kg",
  "purchase_date", "road_tax_expiry", "insurance_expiry",
  "puspakom_expiry", "status", "is_active",
] as const;

export async function getLorryDetail(env: Env, id: number) {
  const lorry = await env.DB.prepare(
    `SELECT l.*, u.name as default_driver_name
       FROM lorries l
       LEFT JOIN users u ON u.id = l.default_driver_user_id
      WHERE l.id = ?`
  )
    .bind(id)
    .first<any>();
  if (!lorry) return null;

  const maintenance = await env.DB.prepare(
    `SELECT * FROM lorry_maintenance WHERE lorry_id = ? ORDER BY maintenance_date DESC LIMIT 20`
  )
    .bind(id)
    .all();

  const compliance = await env.DB.prepare(
    `SELECT * FROM lorry_compliance WHERE lorry_id = ? ORDER BY expiry_date DESC`
  )
    .bind(id)
    .all();

  const incidents = await env.DB.prepare(
    `SELECT * FROM lorry_incidents WHERE lorry_id = ? ORDER BY incident_date DESC LIMIT 20`
  )
    .bind(id)
    .all();

  // Cumulative maintenance cost
  const costRow = await env.DB.prepare(
    `SELECT COALESCE(SUM(cost), 0) as total_cost FROM lorry_maintenance WHERE lorry_id = ?`
  )
    .bind(id)
    .first<{ total_cost: number }>();

  // Total revenue from trips using this lorry
  const revenueRow = await env.DB.prepare(
    `SELECT COALESCE(SUM(total_revenue), 0) as total_revenue
       FROM trips WHERE lorry_id = ? AND status = 'completed'`
  )
    .bind(id)
    .first<{ total_revenue: number }>();

  return {
    lorry,
    maintenance: maintenance.results ?? [],
    compliance: compliance.results ?? [],
    incidents: incidents.results ?? [],
    total_maintenance_cost: costRow?.total_cost ?? 0,
    total_revenue: revenueRow?.total_revenue ?? 0,
  };
}

export async function patchLorry(env: Env, id: number, body: Record<string, any>) {
  const sets: string[] = [];
  const binds: any[] = [];
  for (const k of LORRY_PATCH_FIELDS) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push(body[k] ?? null);
    }
  }
  if (!sets.length) return false;
  binds.push(id);
  const r = await env.DB.prepare(
    `UPDATE lorries SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run();
  return r.meta.changes > 0;
}

export async function addMaintenance(env: Env, lorryId: number, body: any, createdBy: number) {
  const r = await env.DB.prepare(
    `INSERT INTO lorry_maintenance
       (lorry_id, type, description, cost, vendor_name, maintenance_date, unavailable_from, unavailable_to, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      lorryId,
      body.type || "service",
      body.description ?? null,
      body.cost ?? 0,
      body.vendor_name ?? null,
      body.maintenance_date,
      body.unavailable_from ?? null,
      body.unavailable_to ?? null,
      createdBy
    )
    .run();
  return r.meta.last_row_id;
}

export async function addIncident(env: Env, lorryId: number, body: any, createdBy: number) {
  const r = await env.DB.prepare(
    `INSERT INTO lorry_incidents
       (lorry_id, trip_id, incident_date, type, description, cost_estimate, liability, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      lorryId,
      body.trip_id ?? null,
      body.incident_date,
      body.type || "damage",
      body.description ?? null,
      body.cost_estimate ?? 0,
      body.liability ?? "houzs",
      createdBy
    )
    .run();
  return r.meta.last_row_id;
}

export async function getExpiringCompliance(env: Env, daysAhead: number = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + daysAhead);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const rows = await env.DB.prepare(
    `SELECT l.plate, l.id as lorry_id,
            lc.doc_type, lc.expiry_date
       FROM lorries l
       JOIN lorry_compliance lc ON lc.lorry_id = l.id
      WHERE l.is_active = 1
        AND lc.expiry_date <= ?
      ORDER BY lc.expiry_date ASC`
  )
    .bind(cutoffStr)
    .all();

  // Also check the inline expiry fields on lorries
  const lorryRows = await env.DB.prepare(
    `SELECT id, plate,
            road_tax_expiry, insurance_expiry, puspakom_expiry
       FROM lorries
      WHERE is_active = 1
        AND (road_tax_expiry <= ? OR insurance_expiry <= ? OR puspakom_expiry <= ?)`
  )
    .bind(cutoffStr, cutoffStr, cutoffStr)
    .all();

  return {
    compliance_docs: rows.results ?? [],
    lorry_expiries: lorryRows.results ?? [],
  };
}

// ── Salary computation ───────────────────────────────────────────

export async function createTripSalaryLines(env: Env, tripId: number) {
  const trip = await env.DB.prepare(
    `SELECT id, trip_date, driver_user_id, helper_1_id, helper_2_id,
            clock_in_at, clock_out_at
       FROM trips WHERE id = ?`
  )
    .bind(tripId)
    .first<any>();
  if (!trip) return;

  const participants: { userId: number; role: "driver" | "helper" }[] = [];
  if (trip.driver_user_id) participants.push({ userId: trip.driver_user_id, role: "driver" });
  if (trip.helper_1_id) participants.push({ userId: trip.helper_1_id, role: "helper" });
  if (trip.helper_2_id) participants.push({ userId: trip.helper_2_id, role: "helper" });

  for (const p of participants) {
    const user = await env.DB.prepare(
      `SELECT trip_allowance_rate, ot_rate FROM users WHERE id = ?`
    )
      .bind(p.userId)
      .first<{ trip_allowance_rate: number; ot_rate: number }>();
    if (!user) continue;

    // Calculate OT from clock records for that day
    const clock = await env.DB.prepare(
      `SELECT total_hours FROM driver_clock_records WHERE user_id = ? AND clock_date = ?`
    )
      .bind(p.userId, trip.trip_date)
      .first<{ total_hours: number }>();

    const otHours = clock && clock.total_hours > 8 ? clock.total_hours - 8 : 0;
    const otAmount = otHours * (user.ot_rate || 0);

    await env.DB.prepare(
      `INSERT INTO salary_trip_lines (user_id, trip_id, trip_date, role, trip_allowance, ot_hours, ot_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, trip_id) DO UPDATE SET
         trip_allowance = excluded.trip_allowance,
         ot_hours = excluded.ot_hours,
         ot_amount = excluded.ot_amount`
    )
      .bind(p.userId, tripId, trip.trip_date, p.role, user.trip_allowance_rate || 0, otHours, otAmount)
      .run();
  }
}

export async function getSalaryView(env: Env, userId: number, period?: string) {
  const targetPeriod = period || new Date().toISOString().slice(0, 7);

  const user = await env.DB.prepare(
    `SELECT base_salary FROM users WHERE id = ?`
  )
    .bind(userId)
    .first<{ base_salary: number }>();

  const lines = await env.DB.prepare(
    `SELECT stl.*, t.trip_no
       FROM salary_trip_lines stl
       LEFT JOIN trips t ON t.id = stl.trip_id
      WHERE stl.user_id = ? AND stl.trip_date LIKE ?
      ORDER BY stl.trip_date ASC`
  )
    .bind(userId, `${targetPeriod}%`)
    .all();

  const tripLines = lines.results ?? [];
  const tripCount = tripLines.length;
  const tripAllowanceTotal = tripLines.reduce((s: number, l: any) => s + (l.trip_allowance || 0), 0);
  const otHoursTotal = tripLines.reduce((s: number, l: any) => s + (l.ot_hours || 0), 0);
  const otAmountTotal = tripLines.reduce((s: number, l: any) => s + (l.ot_amount || 0), 0);
  const basePay = user?.base_salary || 0;
  const gross = basePay + tripAllowanceTotal + otAmountTotal;

  // Check if a confirmed salary record exists
  const record = await env.DB.prepare(
    `SELECT * FROM salary_records WHERE user_id = ? AND period = ?`
  )
    .bind(userId, targetPeriod)
    .first<any>();

  return {
    period: targetPeriod,
    base_pay: basePay,
    trip_count: tripCount,
    trip_allowance_total: tripAllowanceTotal,
    ot_hours: otHoursTotal,
    ot_amount: otAmountTotal,
    gross,
    deductions_total: record?.deductions_total || 0,
    net: record ? record.net : gross,
    status: record?.status || "draft",
    lines: tripLines,
  };
}

// Today's earnings (for driver app real-time view)
export async function getTodayEarnings(env: Env, userId: number) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await env.DB.prepare(
    `SELECT stl.*, t.trip_no
       FROM salary_trip_lines stl
       LEFT JOIN trips t ON t.id = stl.trip_id
      WHERE stl.user_id = ? AND stl.trip_date = ?`
  )
    .bind(userId, today)
    .all();
  const lines = rows.results ?? [];
  const total = lines.reduce((s: number, l: any) => s + (l.trip_allowance || 0) + (l.ot_amount || 0), 0);
  return { date: today, total, trips: lines };
}

// ── Helpers ──────────────────────────────────────────────────────

async function getSettingNumber(env: Env, key: string, fallback: number): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT value FROM system_settings WHERE key = ?`
  )
    .bind(key)
    .first<{ value: string }>();
  const n = parseFloat(row?.value ?? "");
  return isNaN(n) ? fallback : n;
}
