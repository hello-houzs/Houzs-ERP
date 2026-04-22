// DELETE /api/events/:a42 — remove an event (auth required)
// PATCH  /api/events/:a42 — partial update

import { Env, json, error } from "../../_shared";
import { requireAuth, logAudit } from "../../_auth";

const FIELD_MAP: Record<string, { col: string; json?: boolean }> = {
  status:                   { col: "status" },
  progress:                 { col: "progress" },
  year:                     { col: "year" },
  month:                    { col: "month" },
  startDate:                { col: "start_date" },
  endDate:                  { col: "end_date" },
  durationDays:             { col: "duration_days" },
  organizer:                { col: "organizer" },
  state:                    { col: "state" },
  venue:                    { col: "venue" },
  brand:                    { col: "brand" },
  eventType:                { col: "event_type" },
  contractor:               { col: "contractor" },
  agreementApproval:        { col: "agreement_approval" },
  floorplan:                { col: "floorplan" },
  boothNo:                  { col: "booth_no" },
  sizeSqm:                  { col: "size_sqm" },
  sendFloorplanToDesigner:  { col: "send_floorplan_to_designer" },
  threeDCheckedByMgt:       { col: "three_d_checked_by_mgt" },
  threeDApprovedByPeter:    { col: "three_d_approved_by_peter" },
  threeDUploadedInNotion:   { col: "three_d_uploaded_in_notion" },
  weekendActivityTheme:     { col: "weekend_activity_theme" },
  licenseMajlis:            { col: "license_majlis" },
  workLoadingBayPermit:     { col: "work_loading_bay_permit" },
  decoCoffeeTable:          { col: "deco_coffee_table" },
  secDepoRefund:            { col: "sec_depo_refund" },
  totalSalesRm:             { col: "total_sales_rm" },
  rentalRm:                 { col: "rental_rm" },
  linkNotion:               { col: "link_notion" },
  gcalId:                   { col: "gcal_id" },
  pic:                      { col: "pic" },
  bdPic:                    { col: "bd_pic" },
  salesPic:                 { col: "sales_pic" },
  preparationCondition:     { col: "preparation_condition" },
  setupDriver:              { col: "setup_driver" },
  setupLori:                { col: "setup_lori" },
  setupDatetime:            { col: "setup_datetime" },
  dismantleDatetime:        { col: "dismantle_datetime" },
  setupDismantleStatus:     { col: "setup_dismantle_status" },
  assignedSales:            { col: "assigned_sales", json: true },
  setupDrivers:             { col: "setup_drivers", json: true },
  setupLoris:               { col: "setup_loris", json: true },
};

export const onRequestPatch: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;
  const a42 = decodeURIComponent(params.a42 as string);
  const body = await request.json<Record<string, unknown>>();

  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, meta] of Object.entries(FIELD_MAP)) {
    if (!(k in body)) continue;
    const v = body[k];
    const encoded = meta.json ? JSON.stringify(v ?? []) : (v ?? null);
    sets.push(`${meta.col} = ?`);
    vals.push(encoded);
  }
  if (!sets.length) return error("No fields to update");
  sets.push(`updated_at = datetime('now')`);
  vals.push(a42);
  await env.DB.prepare(`UPDATE events SET ${sets.join(", ")} WHERE a42 = ?`).bind(...vals).run();

  await logAudit(env, request, user, {
    action: "update", entityType: "event", entityId: a42, changes: body,
  });
  return json({ ok: true });
};

export const onRequestDelete: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;
  const a42 = decodeURIComponent(params.a42 as string);
  const r = await env.DB.prepare(`DELETE FROM events WHERE a42 = ?`).bind(a42).run();
  await logAudit(env, request, user, {
    action: "delete", entityType: "event", entityId: a42,
  });
  return json({ ok: true, changes: r.meta.changes });
};
