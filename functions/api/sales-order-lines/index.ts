// GET  /api/sales-order-lines           — list all lines (optionally ?docNo=SO-xxx)
// POST /api/sales-order-lines           — create line
// PATCH /api/sales-order-lines (id in body) — update line
// DELETE /api/sales-order-lines/:id — in [id].ts

import { Env, json, error, norm } from "../../_shared";

function rowToLine(r: Record<string, unknown>) {
  return {
    id: r.id,
    docNo: r.doc_no,
    date: r.date,
    debtorCode: r.debtor_code ?? "",
    debtorName: r.debtor_name ?? "",
    agent: r.agent ?? "",
    itemGroup: r.item_group,
    itemCode: r.item_code,
    description: r.description ?? "",
    description2: r.description2 ?? "",
    uom: r.uom,
    location: r.location ?? "",
    qty: Number(r.qty || 1),
    unitPrice: Number(r.unit_price || 0),
    discount: Number(r.discount || 0),
    total: Number(r.total || 0),
    tax: Number(r.tax || 0),
    totalInc: Number(r.total_inc || 0),
    balance: Number(r.balance || 0),
    paymentStatus: r.payment_status,
    venue: r.venue ?? "",
    branding: r.branding ?? "",
    remark: r.remark ?? "",
    cancelled: !!r.cancelled,
    variants: r.variants ? JSON.parse(r.variants as string) : undefined,
    unitCost: Number(r.unit_cost || 0),
    lineCost: Number(r.line_cost || 0),
    lineMargin: Number(r.line_margin || 0),
  };
}

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const url = new URL(request.url);
  const docNo = url.searchParams.get("docNo");
  const query = docNo
    ? env.DB.prepare(`SELECT * FROM so_lines WHERE doc_no = ? ORDER BY id`).bind(docNo)
    : env.DB.prepare(`SELECT * FROM so_lines ORDER BY date DESC, id`);
  const { results } = await query.all<Record<string, unknown>>();
  return json(results.map(rowToLine));
};

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const l = await request.json<Record<string, unknown>>();
  const id = (l.id as string) || `sol-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const docNo = norm(l.docNo as string);
  const itemCode = norm(l.itemCode as string);
  if (!docNo || !itemCode) return error("docNo and itemCode required");
  await env.DB.prepare(
    `INSERT INTO so_lines (
       id, doc_no, date, debtor_code, debtor_name, agent, item_group, item_code,
       description, description2, uom, location, qty, unit_price, discount, total,
       tax, total_inc, balance, payment_status, venue, branding, remark, cancelled,
       variants, unit_cost, line_cost, line_margin
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, docNo, l.date || new Date().toISOString().slice(0, 10),
    l.debtorCode || null, l.debtorName || null, l.agent || null,
    l.itemGroup || "OTHERS", itemCode.toUpperCase(),
    l.description || "", l.description2 || null,
    l.uom || "UNIT", l.location || null,
    Number(l.qty || 1), Number(l.unitPrice || 0),
    Number(l.discount || 0), Number(l.total || 0),
    Number(l.tax || 0), Number(l.totalInc || 0), Number(l.balance || 0),
    l.paymentStatus || "Unchecked",
    l.venue || null, l.branding || null, l.remark || null,
    l.cancelled ? 1 : 0,
    l.variants ? JSON.stringify(l.variants) : null,
    Number(l.unitCost || 0), Number(l.lineCost || 0), Number(l.lineMargin || 0),
  ).run();
  return json({ ok: true, id });
};
