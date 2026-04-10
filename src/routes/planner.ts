import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { generatePlan, confirmProposal } from "../services/planner";

const app = new Hono<{ Bindings: Env }>();

/**
 * POST /api/planner/generate { horizon_days }
 * Runs the scheduling agent and returns the new draft proposal id.
 * Only one draft proposal at a time — old drafts are auto-discarded.
 */
app.post("/generate", requirePermission("planner.run"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<any>().catch(() => ({}));
  const horizon = Math.min(Math.max(parseInt(body?.horizon_days ?? "7", 10), 1), 30);

  // Discard any existing drafts so the dispatcher only ever has one to review
  await c.env.DB.prepare(
    `UPDATE trip_proposals SET status = 'discarded' WHERE status = 'draft'`
  ).run();

  const { proposalId, summary } = await generatePlan(c.env, horizon, user.id);
  return c.json({ proposal_id: proposalId, summary });
});

/**
 * GET /api/planner/current
 * Returns the active draft proposal (if any) with all trips.
 */
app.get("/current", requirePermission("planner.run"), async (c) => {
  const proposal = await c.env.DB.prepare(
    `SELECT * FROM trip_proposals WHERE status = 'draft' ORDER BY id DESC LIMIT 1`
  ).first<any>();
  if (!proposal) return c.json({ proposal: null });

  const trips = await c.env.DB.prepare(
    `SELECT pt.*, l.plate as lorry_plate, l.size as lorry_size, l.is_internal as lorry_is_internal,
            u.name as driver_name, u.email as driver_email,
            w.name as warehouse_name, w.lat as warehouse_lat, w.lng as warehouse_lng
       FROM trip_proposal_trips pt
       LEFT JOIN lorries l ON l.id = pt.suggested_lorry_id
       LEFT JOIN users u ON u.id = pt.suggested_driver_user_id
       LEFT JOIN warehouses w ON w.code = pt.warehouse
      WHERE pt.proposal_id = ?
      ORDER BY pt.trip_date ASC, pt.id ASC`
  )
    .bind(proposal.id)
    .all<any>();

  return c.json({
    proposal: {
      ...proposal,
      summary: proposal.summary_json ? JSON.parse(proposal.summary_json) : null,
    },
    trips: (trips.results ?? []).map((t: any) => ({
      ...t,
      payload: JSON.parse(t.payload_json),
    })),
  });
});

/**
 * PATCH /api/planner/trips/:id
 * Edit a single proposed trip — change date, lorry, driver, or rewrite stops.
 * Body may contain: trip_date, suggested_lorry_id, suggested_driver_user_id,
 * is_outsourced, stops (full replacement: array of { doc_no, sequence }).
 */
app.patch("/trips/:id", requirePermission("planner.run"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Bad id" }, 400);
  const body = await c.req.json<any>();

  const existing = await c.env.DB.prepare(
    `SELECT * FROM trip_proposal_trips WHERE id = ?`
  )
    .bind(id)
    .first<any>();
  if (!existing) return c.json({ error: "Not found" }, 404);

  const sets: string[] = [];
  const binds: any[] = [];
  for (const k of [
    "trip_date",
    "suggested_lorry_id",
    "suggested_driver_user_id",
    "is_outsourced",
    "warehouse",
    "trip_type",
  ]) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push(body[k]);
    }
  }

  // If stops are being rewritten, recompute revenue + count and rewrite payload.
  if (Array.isArray(body.stops)) {
    const docNos: string[] = body.stops.map((s: any) => s.doc_no);
    let revenue = 0;
    const enriched: any[] = [];
    if (docNos.length) {
      const placeholders = docNos.map(() => "?").join(",");
      const rows = await c.env.DB.prepare(
        `SELECT so.doc_no, so.local_total, so.debtor_name, so.expiry_date,
                od.lat, od.lng
           FROM sales_orders so
           LEFT JOIN order_details od ON od.doc_no = so.doc_no
          WHERE so.doc_no IN (${placeholders})`
      )
        .bind(...docNos)
        .all<any>();
      const map = new Map<string, any>();
      for (const r of rows.results ?? []) map.set(r.doc_no, r);

      body.stops.forEach((s: any, i: number) => {
        const r = map.get(s.doc_no);
        if (!r) return;
        revenue += r.local_total ?? 0;
        enriched.push({
          doc_no: r.doc_no,
          sequence: i + 1,
          debtor_name: r.debtor_name,
          lat: r.lat,
          lng: r.lng,
          local_total: r.local_total ?? 0,
          expiry_date: r.expiry_date,
        });
      });
    }
    const oldPayload = JSON.parse(existing.payload_json);
    const newPayload = { ...oldPayload, stops: enriched };
    sets.push("total_revenue = ?");
    binds.push(revenue);
    sets.push("stop_count = ?");
    binds.push(enriched.length);
    sets.push("payload_json = ?");
    binds.push(JSON.stringify(newPayload));
  }

  if (!sets.length) return c.json({ error: "No fields" }, 400);
  binds.push(id);

  await c.env.DB.prepare(
    `UPDATE trip_proposal_trips SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run();

  return c.json({ ok: true });
});

/**
 * DELETE /api/planner/trips/:id
 * Drop a single proposed trip from the draft.
 */
app.delete("/trips/:id", requirePermission("planner.run"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Bad id" }, 400);
  await c.env.DB.prepare(`DELETE FROM trip_proposal_trips WHERE id = ?`).bind(id).run();
  return c.json({ ok: true });
});

/**
 * POST /api/planner/:id/confirm
 * Materialize proposed trips into real trips.
 * Body may contain { trip_ids: number[] } to confirm only specific
 * proposals. Omit or pass empty to confirm all.
 */
app.post("/:id/confirm", requirePermission("planner.run"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Bad id" }, 400);
  const user = c.get("user");
  const body = await c.req.json<any>().catch(() => ({}));
  const tripIds: number[] | undefined = Array.isArray(body?.trip_ids) ? body.trip_ids : undefined;
  try {
    const r = await confirmProposal(c.env, id, user.id, tripIds);
    return c.json(r);
  } catch (e: any) {
    return c.json({ error: e?.message || "Confirm failed" }, 400);
  }
});

/**
 * POST /api/planner/:id/discard
 */
app.post("/:id/discard", requirePermission("planner.run"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Bad id" }, 400);
  await c.env.DB.prepare(
    `UPDATE trip_proposals SET status = 'discarded' WHERE id = ?`
  )
    .bind(id)
    .run();
  return c.json({ ok: true });
});

export default app;
