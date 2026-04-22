// GET  /api/events     — list all events (all authed users)
// POST /api/events     — create or upsert (auth required; Phase 2 perm gate later)

import { Env, json, error } from "../../_shared";
import { requireAuth, logAudit } from "../../_auth";

function rowToEvent(r: Record<string, unknown>) {
  const parseJson = <T>(v: unknown, fallback: T): T => {
    if (typeof v !== "string") return fallback;
    try { return JSON.parse(v) as T; } catch { return fallback; }
  };
  return {
    a42: r.a42,
    status: r.status,
    progress: r.progress,
    year: Number(r.year ?? 0),
    month: r.month,
    startDate: r.start_date,
    endDate: r.end_date,
    durationDays: Number(r.duration_days ?? 1),
    organizer: r.organizer,
    state: r.state,
    venue: r.venue,
    brand: r.brand,
    eventType: r.event_type,
    contractor: r.contractor ?? "",
    agreementApproval: r.agreement_approval ?? "",
    floorplan: r.floorplan ?? "",
    boothNo: r.booth_no ?? "",
    sizeSqm: Number(r.size_sqm ?? 0),
    sendFloorplanToDesigner: r.send_floorplan_to_designer ?? "",
    threeDCheckedByMgt: r.three_d_checked_by_mgt ?? "",
    threeDApprovedByPeter: r.three_d_approved_by_peter ?? "",
    threeDUploadedInNotion: r.three_d_uploaded_in_notion ?? "",
    weekendActivityTheme: r.weekend_activity_theme ?? "",
    licenseMajlis: r.license_majlis ?? "",
    workLoadingBayPermit: r.work_loading_bay_permit ?? "",
    decoCoffeeTable: r.deco_coffee_table ?? "",
    secDepoRefund: r.sec_depo_refund ?? "",
    totalSalesRm: Number(r.total_sales_rm ?? 0),
    rentalRm: Number(r.rental_rm ?? 0),
    linkNotion: r.link_notion ?? undefined,
    gcalId: r.gcal_id ?? undefined,
    pic: r.pic ?? undefined,
    bdPic: r.bd_pic ?? undefined,
    salesPic: r.sales_pic ?? undefined,
    preparationCondition: r.preparation_condition ?? undefined,
    setupDriver: r.setup_driver ?? undefined,
    setupLori: r.setup_lori ?? undefined,
    setupDatetime: r.setup_datetime ?? undefined,
    dismantleDatetime: r.dismantle_datetime ?? undefined,
    setupDismantleStatus: r.setup_dismantle_status ?? undefined,
    assignedSales: parseJson<string[]>(r.assigned_sales, []),
    setupDrivers: parseJson<Record<string, string>[]>(r.setup_drivers, []),
    setupLoris: parseJson<string[]>(r.setup_loris, []),
  };
}

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;
  const { results } = await env.DB.prepare(
    `SELECT * FROM events ORDER BY start_date, a42`
  ).all<Record<string, unknown>>();
  return json(results.map(rowToEvent));
};

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;

  const e = await request.json<Record<string, unknown>>();
  const a42 = (e.a42 as string)?.trim();
  if (!a42) return error("a42 required");

  await env.DB.prepare(
    `INSERT INTO events (
       a42, status, progress, year, month, start_date, end_date, duration_days,
       organizer, state, venue, brand, event_type, contractor,
       agreement_approval, floorplan, booth_no, size_sqm,
       send_floorplan_to_designer, three_d_checked_by_mgt, three_d_approved_by_peter,
       three_d_uploaded_in_notion, weekend_activity_theme, license_majlis,
       work_loading_bay_permit, deco_coffee_table, sec_depo_refund,
       total_sales_rm, rental_rm,
       link_notion, gcal_id, pic, bd_pic, sales_pic, preparation_condition,
       setup_driver, setup_lori, setup_datetime, dismantle_datetime, setup_dismantle_status,
       assigned_sales, setup_drivers, setup_loris, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(a42) DO UPDATE SET
       status = excluded.status, progress = excluded.progress,
       year = excluded.year, month = excluded.month,
       start_date = excluded.start_date, end_date = excluded.end_date,
       duration_days = excluded.duration_days,
       organizer = excluded.organizer, state = excluded.state, venue = excluded.venue,
       brand = excluded.brand, event_type = excluded.event_type,
       contractor = excluded.contractor,
       agreement_approval = excluded.agreement_approval,
       floorplan = excluded.floorplan, booth_no = excluded.booth_no, size_sqm = excluded.size_sqm,
       send_floorplan_to_designer = excluded.send_floorplan_to_designer,
       three_d_checked_by_mgt = excluded.three_d_checked_by_mgt,
       three_d_approved_by_peter = excluded.three_d_approved_by_peter,
       three_d_uploaded_in_notion = excluded.three_d_uploaded_in_notion,
       weekend_activity_theme = excluded.weekend_activity_theme,
       license_majlis = excluded.license_majlis,
       work_loading_bay_permit = excluded.work_loading_bay_permit,
       deco_coffee_table = excluded.deco_coffee_table,
       sec_depo_refund = excluded.sec_depo_refund,
       total_sales_rm = excluded.total_sales_rm, rental_rm = excluded.rental_rm,
       link_notion = excluded.link_notion, gcal_id = excluded.gcal_id,
       pic = excluded.pic, bd_pic = excluded.bd_pic, sales_pic = excluded.sales_pic,
       preparation_condition = excluded.preparation_condition,
       setup_driver = excluded.setup_driver, setup_lori = excluded.setup_lori,
       setup_datetime = excluded.setup_datetime, dismantle_datetime = excluded.dismantle_datetime,
       setup_dismantle_status = excluded.setup_dismantle_status,
       assigned_sales = excluded.assigned_sales, setup_drivers = excluded.setup_drivers,
       setup_loris = excluded.setup_loris, updated_at = datetime('now')`
  ).bind(
    a42,
    (e.status as string) || "CONFIRMED",
    (e.progress as string) || "NOT STARTED",
    Number(e.year ?? 0),
    (e.month as string) || "",
    (e.startDate as string) || "",
    (e.endDate as string) || "",
    Number(e.durationDays ?? 1),
    (e.organizer as string) || "",
    (e.state as string) || "",
    (e.venue as string) || "",
    (e.brand as string) || "OTHER",
    (e.eventType as string) || "EXHIBITION",
    (e.contractor as string) || null,
    (e.agreementApproval as string) || null,
    (e.floorplan as string) || null,
    (e.boothNo as string) || null,
    Number(e.sizeSqm ?? 0),
    (e.sendFloorplanToDesigner as string) || null,
    (e.threeDCheckedByMgt as string) || null,
    (e.threeDApprovedByPeter as string) || null,
    (e.threeDUploadedInNotion as string) || null,
    (e.weekendActivityTheme as string) || null,
    (e.licenseMajlis as string) || null,
    (e.workLoadingBayPermit as string) || null,
    (e.decoCoffeeTable as string) || null,
    (e.secDepoRefund as string) || null,
    Number(e.totalSalesRm ?? 0),
    Number(e.rentalRm ?? 0),
    (e.linkNotion as string) || null,
    (e.gcalId as string) || null,
    (e.pic as string) || null,
    (e.bdPic as string) || null,
    (e.salesPic as string) || null,
    (e.preparationCondition as string) || null,
    (e.setupDriver as string) || null,
    (e.setupLori as string) || null,
    (e.setupDatetime as string) || null,
    (e.dismantleDatetime as string) || null,
    (e.setupDismantleStatus as string) || null,
    JSON.stringify(e.assignedSales ?? []),
    JSON.stringify(e.setupDrivers ?? []),
    JSON.stringify(e.setupLoris ?? []),
  ).run();

  await logAudit(env, request, user, {
    action: "update", entityType: "event", entityId: a42,
    changes: { status: e.status, progress: e.progress, brand: e.brand },
  });
  return json({ ok: true, a42 });
};
