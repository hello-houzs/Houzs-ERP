// GET  /api/payments?docNo=SO-xxx
// POST /api/payments

import { Env, json, error, norm } from "../../_shared";

function rowToPayment(r: Record<string, unknown>) {
  return {
    id: r.id,
    docNo: r.doc_no,
    date: r.date,
    method: r.method,
    amount: Number(r.amount || 0),
    accountSheet: r.account_sheet ?? "",
    approvalCode: r.approval_code ?? "",
    collectedBy: r.collected_by ?? "",
  };
}

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const url = new URL(request.url);
  const docNo = url.searchParams.get("docNo");
  const query = docNo
    ? env.DB.prepare(`SELECT * FROM so_payments WHERE doc_no = ? ORDER BY date`).bind(docNo)
    : env.DB.prepare(`SELECT * FROM so_payments ORDER BY date DESC`);
  const { results } = await query.all<Record<string, unknown>>();
  return json(results.map(rowToPayment));
};

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const body = await request.json<Record<string, unknown>>();
  const id = (body.id as string) || crypto.randomUUID();
  const docNo = norm(body.docNo as string);
  if (!docNo) return error("docNo required");
  await env.DB.prepare(
    `INSERT INTO so_payments (id, doc_no, date, method, amount, account_sheet, approval_code, collected_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, docNo,
    (body.date as string) || new Date().toISOString().slice(0, 10),
    (body.method as string) || "CASH",
    Number(body.amount || 0),
    (body.accountSheet as string) || null,
    (body.approvalCode as string) || null,
    (body.collectedBy as string) || null,
  ).run();
  return json({ ok: true, id });
};
