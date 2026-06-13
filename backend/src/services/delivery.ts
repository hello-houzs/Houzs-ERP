import type { Env } from "../types";
import { sendEmail, documentEmailHtml } from "./email";

/**
 * Delivery tracking service — unified per-order lifecycle.
 *
 * Status pipelines by region:
 *   WEST: do_ready → out_for_delivery → delivered
 *   SG:   do_ready → pending_shipout → shipped → delivered
 *   EM:   do_ready → pending_shipout → shipped → in_transit →
 *         at_warehouse → out_for_delivery → delivered
 */

// Valid next statuses per region
const TRANSITIONS: Record<string, Record<string, string[]>> = {
  WEST: {
    do_ready: ["out_for_delivery"],
    out_for_delivery: ["delivered", "failed"],
  },
  SG: {
    do_ready: ["pending_shipout"],
    pending_shipout: ["shipped"],
    shipped: ["delivered", "failed"],
  },
  EAST: {
    do_ready: ["pending_shipout"],
    pending_shipout: ["shipped"],
    shipped: ["in_transit"],
    in_transit: ["at_warehouse"],
    at_warehouse: ["out_for_delivery"],
    out_for_delivery: ["delivered", "failed"],
  },
};

// ── Create delivery record ───────────────────────────────────────

export async function createDeliveryRecord(
  env: Env,
  docNo: string,
  opts: {
    region: string;
    tripId?: number;
    createdBy?: number;
  }
) {
  // Fetch order revenue
  const order = await env.DB.prepare(
    `SELECT local_total FROM sales_orders WHERE doc_no = ?`
  )
    .bind(docNo)
    .first<{ local_total: number }>();

  const revenue = order?.local_total ?? 0;
  const budgetPct = await getSettingNumber(env, "logistics_budget_pct", 3);
  const budgetAmount = (revenue * budgetPct) / 100;

  // Determine EM warehouse from order_details if EAST
  let emWarehouse: string | null = null;
  if (opts.region === "EAST") {
    const od = await env.DB.prepare(
      `SELECT warehouse FROM order_details WHERE doc_no = ?`
    )
      .bind(docNo)
      .first<{ warehouse: string | null }>();
    // For now defaults to null; dispatcher sets it manually
    emWarehouse = od?.warehouse ?? null;
  }

  await env.DB.prepare(
    `INSERT INTO delivery_tracking
       (doc_no, region, status, order_revenue, budget_pct, budget_amount,
        trip_id, em_warehouse, do_ready_at, created_by)
     VALUES (?, ?, 'do_ready', ?, ?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(doc_no) DO UPDATE SET
       trip_id = COALESCE(excluded.trip_id, delivery_tracking.trip_id),
       updated_at = datetime('now')`
  )
    .bind(
      docNo,
      opts.region,
      revenue,
      budgetPct,
      budgetAmount,
      opts.tripId ?? null,
      emWarehouse,
      opts.createdBy ?? null
    )
    .run();

  return { doc_no: docNo, status: "do_ready" };
}

// ── Advance status ───────────────────────────────────────────────

export async function advanceStatus(
  env: Env,
  docNo: string,
  newStatus: string,
  changedBy: number,
  updates?: Record<string, any>
) {
  const rec = await env.DB.prepare(
    `SELECT doc_no, region, status FROM delivery_tracking WHERE doc_no = ?`
  )
    .bind(docNo)
    .first<{ doc_no: string; region: string; status: string }>();

  if (!rec) throw new Error("Delivery record not found");

  const allowed = TRANSITIONS[rec.region]?.[rec.status] ?? [];
  if (!allowed.includes(newStatus)) {
    throw new Error(
      `Cannot transition ${rec.region} order from '${rec.status}' to '${newStatus}'. Allowed: ${allowed.join(", ") || "none"}`
    );
  }

  // Auto-stamp milestone dates
  const stamps: Record<string, any> = { status: newStatus, updated_at: "datetime('now')" };
  const now = new Date().toISOString();

  switch (newStatus) {
    case "pending_shipout":
      // shipout_date set via updates
      break;
    case "shipped":
      stamps.pickup_confirmed_at = now;
      break;
    case "in_transit":
      // est_arrival_date set via updates
      break;
    case "at_warehouse":
      stamps.arrived_warehouse_at = now;
      break;
    case "out_for_delivery":
      stamps.out_for_delivery_at = now;
      break;
    case "delivered":
      stamps.delivered_at = now;
      break;
    case "failed":
      stamps.failed_at = now;
      break;
  }

  // Merge any additional field updates (dates, costs, notes)
  const ALLOWED_FIELDS = [
    "shipout_date", "est_arrival_date", "est_delivery_date",
    "freight_cost", "last_mile_cost", "customer_transport_fee",
    "delivery_method", "vendor_name", "em_warehouse", "notes",
  ];
  if (updates) {
    for (const k of ALLOWED_FIELDS) {
      if (k in updates) stamps[k] = updates[k];
    }
  }

  // Auto-compute total_cost
  const freightCost = stamps.freight_cost ?? undefined;
  const lastMileCost = stamps.last_mile_cost ?? undefined;

  const sets: string[] = [];
  const binds: any[] = [];

  for (const [k, v] of Object.entries(stamps)) {
    if (k === "updated_at") {
      sets.push("updated_at = datetime('now')");
    } else {
      sets.push(`${k} = ?`);
      binds.push(v ?? null);
    }
  }

  // Recompute total_cost
  sets.push("total_cost = COALESCE(?, freight_cost) + COALESCE(?, last_mile_cost)");
  binds.push(freightCost ?? null, lastMileCost ?? null);

  binds.push(docNo);
  await env.DB.prepare(
    `UPDATE delivery_tracking SET ${sets.join(", ")} WHERE doc_no = ?`
  )
    .bind(...binds)
    .run();

  // Log the transition
  await env.DB.prepare(
    `INSERT INTO delivery_status_log (doc_no, from_status, to_status, changed_by, notes)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(docNo, rec.status, newStatus, changedBy, updates?.notes ?? null)
    .run();

  // Dispatch = the customer-notification moment (goods have left for the
  // customer). Region-aware "left for customer" milestone: WEST/EAST
  // 'out_for_delivery', SG 'shipped'. Fires AFTER the durable status update +
  // log above; best-effort (never blocks the transition); gated OFF by the
  // 'delivery_order' channel and a no-op when the order has no customer_email.
  const DISPATCH_STATUS: Record<string, string> = {
    WEST: "out_for_delivery",
    EAST: "out_for_delivery",
    SG: "shipped",
  };
  if (newStatus === DISPATCH_STATUS[rec.region]) {
    await maybeSendDeliveryOrderEmail(env, docNo).catch(() => {});
  }

  return { doc_no: docNo, from: rec.status, to: newStatus };
}

// ── Customer notification on dispatch (auto-send D.O.) ────────────
// Pre-built + GATED OFF. Sends the customer their Delivery Order when goods are
// dispatched, off the existing Resend + email_outbox stack. Three safety layers:
// the 'delivery_order' channel is seeded OFF (mig 098), it no-ops without a
// customer_email, and do_email_sent_at makes it once-only (a retried dispatch
// can't re-notify). Invoice/report will mirror this shape.

// Build the DO email from real delivery + order data. Returns null when the
// order has no customer_email (caller treats null as "nothing to send").
export async function buildDeliveryOrderEmail(
  env: Env,
  docNo: string,
): Promise<{ to: string; subject: string; html: string } | null> {
  const row = await env.DB.prepare(
    `SELECT dt.doc_no, dt.est_delivery_date,
            so.debtor_name, so.customer_email,
            so.inv_addr1, so.inv_addr2, so.inv_addr3, so.inv_addr4,
            od.delivery_date, od.time_range, od.driver_name, od.driver_contact, od.lorry_plate
       FROM delivery_tracking dt
       LEFT JOIN sales_orders so ON so.doc_no = dt.doc_no
       LEFT JOIN order_details od ON od.doc_no = dt.doc_no
      WHERE dt.doc_no = ?`,
  )
    .bind(docNo)
    .first<any>();
  if (!row || !row.customer_email) return null;

  const addr = [row.inv_addr1, row.inv_addr2, row.inv_addr3, row.inv_addr4]
    .filter(Boolean)
    .join(", ");
  const rows: Array<{ label: string; value: string }> = [
    { label: "Order No", value: row.doc_no },
    { label: "Delivery To", value: addr || row.debtor_name || "" },
    { label: "Scheduled", value: row.delivery_date || row.est_delivery_date || "To be confirmed" },
  ];
  if (row.time_range) rows.push({ label: "Time", value: row.time_range });
  if (row.driver_name)
    rows.push({
      label: "Driver",
      value: row.driver_name + (row.driver_contact ? ` (${row.driver_contact})` : ""),
    });
  if (row.lorry_plate) rows.push({ label: "Lorry", value: row.lorry_plate });

  return {
    to: row.customer_email,
    subject: `Houzs Century — Delivery Order ${row.doc_no}`,
    html: documentEmailHtml({
      docTypeLabel: "Delivery Order",
      docNo: row.doc_no,
      recipientName: row.debtor_name || "Customer",
      rows,
      note: "Your order is on its way and will arrive as scheduled above.",
    }),
  };
}

export async function maybeSendDeliveryOrderEmail(env: Env, docNo: string): Promise<void> {
  try {
    // Once-only guard: skip if this order was already notified.
    const guard = await env.DB.prepare(
      `SELECT do_email_sent_at FROM delivery_tracking WHERE doc_no = ?`,
    )
      .bind(docNo)
      .first<{ do_email_sent_at: string | null }>();
    if (guard?.do_email_sent_at) return;

    const msg = await buildDeliveryOrderEmail(env, docNo);
    if (!msg) return; // no customer_email → nothing to send

    const result = await sendEmail(env, {
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      purpose: "delivery_order",
      refType: "delivery",
      refId: null,
    });
    // Only stamp the guard on a real send — if the channel is OFF (gated) the
    // result is 'skipped', leaving do_email_sent_at null so flipping the channel
    // on later still lets future dispatches notify.
    if (result.status === "sent") {
      await env.DB.prepare(
        `UPDATE delivery_tracking SET do_email_sent_at = datetime('now') WHERE doc_no = ?`,
      )
        .bind(docNo)
        .run();
    }
  } catch (e) {
    console.warn("[delivery] DO email best-effort failed", e);
  }
}

// ── Patch fields (without changing status) ────────────────────────

export async function patchDelivery(
  env: Env,
  docNo: string,
  body: Record<string, any>
) {
  const PATCH_FIELDS = [
    "shipout_date", "est_arrival_date", "est_delivery_date",
    "freight_cost", "last_mile_cost", "customer_transport_fee",
    "delivery_method", "vendor_name", "em_warehouse", "notes",
    "trip_id",
  ];

  const sets: string[] = [];
  const binds: any[] = [];
  for (const k of PATCH_FIELDS) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push(body[k] ?? null);
    }
  }
  if (!sets.length) return false;

  // Recompute total_cost if cost fields changed
  if ("freight_cost" in body || "last_mile_cost" in body) {
    sets.push("total_cost = COALESCE(?, freight_cost) + COALESCE(?, last_mile_cost)");
    binds.push(body.freight_cost ?? null, body.last_mile_cost ?? null);
  }

  sets.push("updated_at = datetime('now')");
  binds.push(docNo);

  const r = await env.DB.prepare(
    `UPDATE delivery_tracking SET ${sets.join(", ")} WHERE doc_no = ?`
  )
    .bind(...binds)
    .run();
  return r.meta.changes > 0;
}

// ── List / filter ────────────────────────────────────────────────

export interface DeliveryFilters {
  region?: string;
  status?: string;
  search?: string;
  overdue_only?: boolean;
  page?: number;
  per_page?: number;
}

export async function listDeliveries(env: Env, f: DeliveryFilters) {
  const where: string[] = [];
  const binds: any[] = [];

  if (f.region) {
    where.push("dt.region = ?");
    binds.push(f.region);
  }
  if (f.status) {
    const statuses = f.status.split(",").map((s) => s.trim()).filter(Boolean);
    if (statuses.length === 1) {
      where.push("dt.status = ?");
      binds.push(statuses[0]);
    } else if (statuses.length > 1) {
      where.push(`dt.status IN (${statuses.map(() => "?").join(",")})`);
      binds.push(...statuses);
    }
  }
  if (f.search) {
    where.push("(dt.doc_no LIKE ? OR so.debtor_name LIKE ?)");
    const like = `%${f.search}%`;
    binds.push(like, like);
  }
  if (f.overdue_only) {
    const today = new Date().toISOString().slice(0, 10);
    where.push(`(
      (dt.status = 'pending_shipout' AND dt.shipout_date < ?) OR
      (dt.status = 'in_transit' AND dt.est_arrival_date < ?) OR
      (dt.status IN ('out_for_delivery','at_warehouse') AND dt.est_delivery_date < ?)
    )`);
    binds.push(today, today, today);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const page = f.page && f.page > 0 ? f.page : 1;
  const perPage = Math.min(f.per_page ?? 50, 200);
  const offset = (page - 1) * perPage;

  const total = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM delivery_tracking dt
       LEFT JOIN sales_orders so ON so.doc_no = dt.doc_no
     ${whereSql}`
  )
    .bind(...binds)
    .first<{ count: number }>();

  const rows = await env.DB.prepare(
    `SELECT dt.*,
            so.debtor_name, so.phone, so.sales_location,
            so.inv_addr1, so.inv_addr2, so.inv_addr3, so.inv_addr4
       FROM delivery_tracking dt
       LEFT JOIN sales_orders so ON so.doc_no = dt.doc_no
     ${whereSql}
     ORDER BY
       CASE dt.status
         WHEN 'do_ready' THEN 1
         WHEN 'pending_shipout' THEN 2
         WHEN 'shipped' THEN 3
         WHEN 'in_transit' THEN 4
         WHEN 'at_warehouse' THEN 5
         WHEN 'out_for_delivery' THEN 6
         WHEN 'delivered' THEN 7
         WHEN 'failed' THEN 8
       END,
       dt.updated_at DESC
     LIMIT ? OFFSET ?`
  )
    .bind(...binds, perPage, offset)
    .all();

  return {
    data: rows.results ?? [],
    page,
    per_page: perPage,
    total: total?.count ?? 0,
  };
}

// ── Get single delivery with status log ──────────────────────────

export async function getDelivery(env: Env, docNo: string) {
  const dt = await env.DB.prepare(
    `SELECT dt.*,
            so.debtor_name, so.phone, so.sales_location, so.local_total, so.balance,
            so.inv_addr1, so.inv_addr2, so.inv_addr3, so.inv_addr4
       FROM delivery_tracking dt
       LEFT JOIN sales_orders so ON so.doc_no = dt.doc_no
      WHERE dt.doc_no = ?`
  )
    .bind(docNo)
    .first<any>();
  if (!dt) return null;

  const log = await env.DB.prepare(
    `SELECT dsl.*, u.name as changed_by_name
       FROM delivery_status_log dsl
       LEFT JOIN users u ON u.id = dsl.changed_by
      WHERE dsl.doc_no = ?
      ORDER BY dsl.created_at DESC`
  )
    .bind(docNo)
    .all();

  // What can this record transition to?
  const nextStatuses = TRANSITIONS[dt.region]?.[dt.status] ?? [];

  return {
    ...dt,
    log: log.results ?? [],
    next_statuses: nextStatuses,
  };
}

// ── Overdue check (for cron) ─────────────────────────────────────

export async function getOverdueDeliveries(env: Env) {
  const today = new Date().toISOString().slice(0, 10);

  // Step 3: shipout date passed but not shipped
  const shipoutOverdue = await env.DB.prepare(
    `SELECT dt.doc_no, dt.region, dt.status, dt.shipout_date,
            so.debtor_name
       FROM delivery_tracking dt
       LEFT JOIN sales_orders so ON so.doc_no = dt.doc_no
      WHERE dt.status = 'pending_shipout'
        AND dt.shipout_date IS NOT NULL
        AND dt.shipout_date < ?`
  )
    .bind(today)
    .all();

  // Step 7: est delivery date passed but not delivered
  const deliveryOverdue = await env.DB.prepare(
    `SELECT dt.doc_no, dt.region, dt.status, dt.est_delivery_date,
            so.debtor_name
       FROM delivery_tracking dt
       LEFT JOIN sales_orders so ON so.doc_no = dt.doc_no
      WHERE dt.status IN ('out_for_delivery','at_warehouse')
        AND dt.est_delivery_date IS NOT NULL
        AND dt.est_delivery_date < ?`
  )
    .bind(today)
    .all();

  // EM step 4: est arrival passed but not at warehouse
  const arrivalOverdue = await env.DB.prepare(
    `SELECT dt.doc_no, dt.region, dt.status, dt.est_arrival_date,
            so.debtor_name
       FROM delivery_tracking dt
       LEFT JOIN sales_orders so ON so.doc_no = dt.doc_no
      WHERE dt.status = 'in_transit'
        AND dt.est_arrival_date IS NOT NULL
        AND dt.est_arrival_date < ?`
  )
    .bind(today)
    .all();

  return {
    shipout_overdue: shipoutOverdue.results ?? [],
    delivery_overdue: deliveryOverdue.results ?? [],
    arrival_overdue: arrivalOverdue.results ?? [],
    total: (shipoutOverdue.results?.length ?? 0) +
           (deliveryOverdue.results?.length ?? 0) +
           (arrivalOverdue.results?.length ?? 0),
  };
}

// ── Bulk create for trip stops ───────────────────────────────────

export async function createRecordsForTrip(env: Env, tripId: number, createdBy: number) {
  const trip = await env.DB.prepare(
    `SELECT id, is_outsourced FROM trips WHERE id = ?`
  )
    .bind(tripId)
    .first<{ id: number; is_outsourced: number }>();
  if (!trip) return 0;

  const stops = await env.DB.prepare(
    `SELECT ts.doc_no, so.region
       FROM trip_stops ts
       JOIN sales_orders so ON so.doc_no = ts.doc_no
      WHERE ts.trip_id = ?`
  )
    .bind(tripId)
    .all<{ doc_no: string; region: string }>();

  let count = 0;
  for (const s of stops.results ?? []) {
    await createDeliveryRecord(env, s.doc_no, {
      region: s.region,
      tripId,
      createdBy,
    });
    count++;
  }
  return count;
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
