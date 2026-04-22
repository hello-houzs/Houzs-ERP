// GET  /api/sales-orders       — list all headers (with pagination optional)
// POST /api/sales-orders       — create new header

import { Env, json, error, norm } from "../../_shared";

function rowToHeader(r: Record<string, unknown>) {
  return {
    docNo: r.doc_no,
    transferTo: r.transfer_to ?? "",
    date: r.date,
    branding: r.branding ?? "",
    debtorName: r.debtor_name,
    agent: r.agent ?? "",
    salesLocation: r.sales_location ?? "",
    ref: r.ref ?? "",
    localTotal: Number(r.local_total || 0),
    mattressSofa: Number(r.mattress_sofa || 0),
    bedframe: Number(r.bedframe || 0),
    accessories: Number(r.accessories || 0),
    others: Number(r.others || 0),
    balance: Number(r.balance || 0),
    remark2: r.remark2 ?? "",
    remark4: r.remark4 ?? "",
    remark3: r.remark3 ?? "",
    processingDate: r.processing_date ?? "",
    salesExemptionExpiry: r.sales_exemption_expiry ?? "",
    note: r.note ?? "",
    poDocNo: r.po_doc_no ?? "",
    address1: r.address1 ?? "",
    address2: r.address2 ?? "",
    address3: r.address3 ?? "",
    address4: r.address4 ?? "",
    phone: r.phone ?? "",
    venue: r.venue ?? "",
    totalCost: Number(r.total_cost || 0),
    totalRevenue: Number(r.total_revenue || 0),
    totalMargin: Number(r.total_margin || 0),
    marginPct: Number(r.margin_pct || 0),
    lineCount: Number(r.line_count || 0),
  };
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const { results } = await env.DB.prepare(
    `SELECT * FROM so_headers ORDER BY date DESC, doc_no DESC`
  ).all<Record<string, unknown>>();
  return json(results.map(rowToHeader));
};

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const h = await request.json<Record<string, unknown>>();
  const docNo = norm(h.docNo as string);
  if (!docNo) return error("docNo required");
  await env.DB.prepare(
    `INSERT INTO so_headers (
       doc_no, transfer_to, date, branding, debtor_name, agent, sales_location, ref,
       local_total, mattress_sofa, bedframe, accessories, others, balance,
       remark2, remark4, remark3, processing_date, sales_exemption_expiry, note,
       po_doc_no, address1, address2, address3, address4, phone, venue,
       total_cost, total_revenue, total_margin, margin_pct, line_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(doc_no) DO UPDATE SET
       date = excluded.date, debtor_name = excluded.debtor_name, agent = excluded.agent,
       local_total = excluded.local_total, balance = excluded.balance,
       processing_date = excluded.processing_date, note = excluded.note,
       venue = excluded.venue, phone = excluded.phone, address1 = excluded.address1,
       address2 = excluded.address2, address3 = excluded.address3, address4 = excluded.address4,
       updated_at = datetime('now')`
  ).bind(
    docNo,
    h.transferTo || null,
    h.date || new Date().toISOString().slice(0, 10),
    h.branding || null,
    h.debtorName || "",
    h.agent || null,
    h.salesLocation || null,
    h.ref || null,
    Number(h.localTotal || 0),
    Number(h.mattressSofa || 0),
    Number(h.bedframe || 0),
    Number(h.accessories || 0),
    Number(h.others || 0),
    Number(h.balance || 0),
    h.remark2 || null, h.remark4 || null, h.remark3 || null,
    h.processingDate || null, h.salesExemptionExpiry || null, h.note || null,
    h.poDocNo || null,
    h.address1 || null, h.address2 || null, h.address3 || null, h.address4 || null,
    h.phone || null, h.venue || null,
    Number(h.totalCost || 0), Number(h.totalRevenue || 0),
    Number(h.totalMargin || 0), Number(h.marginPct || 0),
    Number(h.lineCount || 0),
  ).run();
  return json({ ok: true, docNo });
};
