import { Hono } from "hono";
import type { Env } from "../types";
import { requirePageAccess } from "../middleware/auth";
import { getDb } from "../db/client";
import { sales_entries, users, projects } from "../db/schema";
import { and, desc, eq, gte, isNull, lte, like, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { syncFinanceRollup } from "../services/projects";
import {
  nextSalesEntryDocNo,
  replaceItems,
  replacePayments,
  summarisePayments,
  type SalesItemInput,
  type SalesPaymentInput,
} from "../services/salesEntries";

const app = new Hono<{ Bindings: Env }>();

const PAYMENT_TYPES = new Set(["cash", "card_cc", "card_db", "epp", "cheque", "online"]);

// Header columns added in mig 070 that the form posts and we just
// pass through to the row. Keeps validation focused on the few that
// have constraints (amounts / dates / payment-method enum) and lets
// the rest flow as TEXT.
const SO_FORM_TEXT_FIELDS = [
  "doc_no",
  "processing_date",
  "delivery_date",
  "status_2",
  "customer_address_2",
  "customer_postcode",
  "customer_state",
  "customer_phone_2",
  "customer_email",
  "venue",
  "warehouse",
  "branding",
  "po_doc_no",
  "payment_status",
  "source",
  "remarks",
] as const;

// Quick-log marker. Reps logging from a busy event capture only
// amount + ref_no; the customer_name column (NOT NULL on the
// schema) gets this sentinel so the row lands as a draft that
// can't be submitted until back-filled. Frontend / project ledger
// renderers swap it out for a friendlier "Quick log · {ref}" label.
export const QUICK_LOG_SENTINEL = "(quick log)";

/**
 * Roll the project's total_sales after a sales_entry mutation. No-op
 * for unscoped (walk-in) entries. Failures are swallowed — the rollup
 * is best-effort; a stale total is preferable to a 500 on the user's
 * "Save sale" click.
 */
async function bumpProjectFinance(env: Env, projectId: number | null | undefined) {
  if (!projectId) return;
  try {
    await syncFinanceRollup(env, projectId);
  } catch (e) {
    // Surface to Wrangler logs so a silently-failed rollup doesn't
    // hide a corrupt `project_finance.total_sales`. We still don't
    // re-throw — the rollup is best-effort and shouldn't 500 the
    // user's "Save sale" click.
    console.error("[bumpProjectFinance]", projectId, e);
  }
}

// ── Scoping helper ───────────────────────────────────────────
// Reps (role.scope_to_pic=1) without sales.manage only see entries
// they created. Anyone with sales.manage, or any unscoped role, sees
// everything.
// Returns a single WHERE-fragment (no leading/trailing AND) that the
// caller stitches into the final clause via " AND ". Returning a leading
// AND here used to double up with the join — `WHERE x AND AND y`.
function buildOwnershipWhere(user: any, canManage: boolean) {
  if (canManage) return { sql: "", binds: [] as any[] };
  if (user?.scope_to_pic) {
    return { sql: "s.created_by = ?", binds: [user.id] };
  }
  return { sql: "", binds: [] as any[] };
}

// ── List ─────────────────────────────────────────────────────
app.get("/entries", requirePageAccess("sales"), async (c) => {
  const user = c.get("user");
  const canManage = c.get("access_level") === "full";
  const status = c.req.query("status") || "";
  const projectId = parseInt(c.req.query("project_id") || "", 10);
  const search = c.req.query("search") || "";
  const dateFrom = c.req.query("date_from") || "";
  const dateTo = c.req.query("date_to") || "";
  const includeArchived = c.req.query("include_archived") === "1";
  // Quick-log filter — drives the dedicated "Quick Logs" tab on the
  // Sales page. Either narrow to *only* quick-logs (?quick_log=1) or
  // exclude them entirely (?quick_log=0) so the All view doesn't
  // double up against the dedicated tab.
  const quickLogParam = c.req.query("quick_log");
  const page = parseInt(c.req.query("page") || "1", 10);
  const perPage = Math.min(parseInt(c.req.query("per_page") || "50", 10), 200);
  const offset = (page - 1) * perPage;

  const where: string[] = [];
  const binds: any[] = [];
  if (!includeArchived) where.push("s.archived_at IS NULL");
  if (status) {
    where.push("s.status = ?");
    binds.push(status);
  }
  if (!isNaN(projectId)) {
    where.push("s.project_id = ?");
    binds.push(projectId);
  }
  if (dateFrom) {
    where.push("date(s.occurred_at) >= date(?)");
    binds.push(dateFrom);
  }
  if (dateTo) {
    where.push("date(s.occurred_at) <= date(?)");
    binds.push(dateTo);
  }
  if (search) {
    where.push(
      "(s.customer_name LIKE ? OR s.customer_phone LIKE ? OR s.ref_no LIKE ? OR s.notes LIKE ?)"
    );
    const like = `%${search}%`;
    binds.push(like, like, like, like);
  }
  if (quickLogParam === "1") {
    where.push("s.customer_name = ?");
    binds.push(QUICK_LOG_SENTINEL);
  } else if (quickLogParam === "0") {
    where.push("s.customer_name <> ?");
    binds.push(QUICK_LOG_SENTINEL);
  }

  const ownership = buildOwnershipWhere(user, canManage);
  if (ownership.sql) where.push(ownership.sql);
  const fullWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const fullBinds = [...binds, ...ownership.binds];

  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM sales_entries s ${fullWhere}`
  )
    .bind(...fullBinds)
    .first<{ count: number }>();

  const rows = await c.env.DB.prepare(
    `SELECT s.*,
            u.name as created_by_name,
            u.email as created_by_email,
            sp.id   as sales_person_id_resolved,
            sp.name as sales_person_name,
            sp.email as sales_person_email,
            p.code as project_code,
            p.name as project_name
       FROM sales_entries s
       LEFT JOIN users u ON u.id = s.created_by
       LEFT JOIN users sp ON sp.id = COALESCE(s.sales_person_id, s.created_by)
       LEFT JOIN projects p ON p.id = s.project_id
       ${fullWhere}
       ORDER BY s.occurred_at DESC, s.id DESC
       LIMIT ? OFFSET ?`
  )
    .bind(...fullBinds, perPage, offset)
    .all();

  // Sum filtered totals for the header tiles.
  const totals = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(s.amount), 0) as total_amount,
            COUNT(*) as total_count,
            COUNT(CASE WHEN s.status = 'draft' THEN 1 END) as draft_count,
            COUNT(CASE WHEN s.status = 'submitted' THEN 1 END) as submitted_count,
            COUNT(CASE WHEN s.status = 'pushed' THEN 1 END) as pushed_count
       FROM sales_entries s
       ${fullWhere}`
  )
    .bind(...fullBinds)
    .first<any>();

  // Standalone count of quick-logs awaiting completion — not bound by
  // the current filters, so the tab badge shows the inbox-style total
  // even when the user is on a narrowed view.
  const quickLogTotal = await c.env.DB.prepare(
    `SELECT COUNT(*) as count
       FROM sales_entries s
      WHERE s.archived_at IS NULL
        AND s.status = 'draft'
        AND s.customer_name = ?
        ${ownership.sql ? `AND ${ownership.sql}` : ""}`
  )
    .bind(QUICK_LOG_SENTINEL, ...ownership.binds)
    .first<{ count: number }>();

  return c.json({
    data: rows.results ?? [],
    page,
    per_page: perPage,
    total: total?.count ?? 0,
    totals: {
      amount: totals?.total_amount ?? 0,
      count: totals?.total_count ?? 0,
      by_status: {
        draft: totals?.draft_count ?? 0,
        submitted: totals?.submitted_count ?? 0,
        pushed: totals?.pushed_count ?? 0,
      },
      quick_log_pending: quickLogTotal?.count ?? 0,
    },
  });
});

// ── CSV export ───────────────────────────────────────────────
// Returns a CSV with the columns the sales team uses for chasing up
// balances post-event: ref_no, date, customer, amount, deposit (with
// payment method), balance (derived = amount - deposit), sales person.
// Honours the same project_id / status / search / date filters as the
// list endpoint and the same row-ownership scoping (scoped reps only
// get their own entries unless they have sales.manage). Written in
// Drizzle per the new-code convention.
//
// MUST be declared before /entries/:id — Hono matches in order, so the
// :id route would otherwise eat /entries/export with id="export".
app.get("/entries/export", requirePageAccess("sales"), async (c) => {
  const user = c.get("user");
  const canManage =
    c.get("access_level") === "full";

  const projectIdQ = c.req.query("project_id");
  const projectId = projectIdQ ? parseInt(projectIdQ, 10) : NaN;
  const status = c.req.query("status") || "";
  const search = c.req.query("search") || "";
  const dateFrom = c.req.query("date_from") || "";
  const dateTo = c.req.query("date_to") || "";
  const includeArchived = c.req.query("include_archived") === "1";

  const db = getDb(c.env);
  const sp = alias(users, "sp");

  const conds: any[] = [];
  if (!includeArchived) conds.push(isNull(sales_entries.archived_at));
  if (status) conds.push(eq(sales_entries.status, status));
  if (!isNaN(projectId)) conds.push(eq(sales_entries.project_id, projectId));
  if (dateFrom) conds.push(gte(sql`date(${sales_entries.occurred_at})`, sql`date(${dateFrom})`));
  if (dateTo) conds.push(lte(sql`date(${sales_entries.occurred_at})`, sql`date(${dateTo})`));
  if (search) {
    const likeStr = `%${search}%`;
    conds.push(
      or(
        like(sales_entries.customer_name, likeStr),
        like(sales_entries.customer_phone, likeStr),
        like(sales_entries.ref_no, likeStr),
        like(sales_entries.notes, likeStr)
      )!
    );
  }
  // Reps without sales.manage only export their own rows. Same rule as
  // the list endpoint's buildOwnershipWhere.
  if (!canManage && user?.scope_to_pic) {
    conds.push(eq(sales_entries.created_by, user.id));
  }

  const rows = await db
    .select({
      id: sales_entries.id,
      ref_no: sales_entries.ref_no,
      occurred_at: sales_entries.occurred_at,
      customer_name: sales_entries.customer_name,
      customer_phone: sales_entries.customer_phone,
      customer_address: sales_entries.customer_address,
      amount: sales_entries.amount,
      deposit_amount: sales_entries.deposit_amount,
      deposit_payment_type: sales_entries.deposit_payment_type,
      currency: sales_entries.currency,
      status: sales_entries.status,
      project_code: projects.code,
      project_name: projects.name,
      sales_person_name: sp.name,
      sales_person_email: sp.email,
      created_by_name: users.name,
      created_by_email: users.email,
    })
    .from(sales_entries)
    .leftJoin(users, eq(users.id, sales_entries.created_by))
    .leftJoin(sp, eq(sp.id, sql`COALESCE(${sales_entries.sales_person_id}, ${sales_entries.created_by})`))
    .leftJoin(projects, eq(projects.id, sales_entries.project_id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(sales_entries.occurred_at), desc(sales_entries.id));

  const PAYMENT_LABEL: Record<string, string> = {
    cash: "Cash",
    card_cc: "Credit Card",
    card_db: "Debit Card",
    epp: "EPP",
  };

  const header = [
    "Ref No",
    "Date",
    "Customer",
    "Phone",
    "Address",
    "Project",
    "Sales Amount",
    "Deposit",
    "Deposit Payment",
    "Balance",
    "Currency",
    "Status",
    "Sales Person",
  ];

  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const lines: string[] = [header.join(",")];
  for (const r of rows) {
    const amount = r.amount ?? 0;
    const deposit = r.deposit_amount ?? amount;
    const balance = amount - deposit;
    const projectLabel = r.project_code
      ? `${r.project_code}${r.project_name ? ` ${r.project_name}` : ""}`
      : "";
    const salesPerson =
      r.sales_person_name ||
      r.sales_person_email ||
      r.created_by_name ||
      r.created_by_email ||
      "";
    lines.push(
      [
        r.ref_no ?? "",
        r.occurred_at ? r.occurred_at.slice(0, 10) : "",
        r.customer_name,
        r.customer_phone ?? "",
        r.customer_address ?? "",
        projectLabel,
        amount.toFixed(2),
        deposit.toFixed(2),
        r.deposit_payment_type ? PAYMENT_LABEL[r.deposit_payment_type] || r.deposit_payment_type : "",
        balance.toFixed(2),
        r.currency ?? "MYR",
        r.status ?? "",
        salesPerson,
      ]
        .map(escape)
        .join(",")
    );
  }

  // BOM so Excel opens UTF-8 cleanly.
  const csv = "﻿" + lines.join("\r\n") + "\r\n";
  const today = new Date().toISOString().slice(0, 10);
  const filename = !isNaN(projectId)
    ? `sales_project_${projectId}_${today}.csv`
    : `sales_${today}.csv`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});

// ── Detail ───────────────────────────────────────────────────
app.get("/entries/:id", requirePageAccess("sales"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Bad id" }, 400);
  const user = c.get("user");
  const canManage = c.get("access_level") === "full";

  const row = await c.env.DB.prepare(
    `SELECT s.*,
            u.name as created_by_name,
            u.email as created_by_email,
            sp.id   as sales_person_id_resolved,
            sp.name as sales_person_name,
            sp.email as sales_person_email,
            p.code as project_code,
            p.name as project_name
       FROM sales_entries s
       LEFT JOIN users u ON u.id = s.created_by
       LEFT JOIN users sp ON sp.id = COALESCE(s.sales_person_id, s.created_by)
       LEFT JOIN projects p ON p.id = s.project_id
      WHERE s.id = ?`
  )
    .bind(id)
    .first<any>();
  if (!row) return c.json({ error: "Not found" }, 404);

  // Scoped rep can only see own entries.
  if (!canManage && user?.scope_to_pic && row.created_by !== user.id) {
    return c.json({ error: "Not found" }, 404);
  }

  // Fetch UDF values. The UDF layer expects row_key as TEXT so cast id.
  const udf = await c.env.DB.prepare(
    `SELECT field_key, value FROM udf_values
      WHERE table_name = 'sales_entries' AND row_key = ?`
  )
    .bind(String(id))
    .all<{ field_key: string; value: string | null }>();

  const custom: Record<string, string | null> = {};
  for (const r of udf.results ?? []) custom[r.field_key] = r.value;

  // Mig 070 — items + payments
  const itemsRes = await c.env.DB.prepare(
    `SELECT id, entry_id, line_no, item_code, item_description, remarks,
            qty, unit_price, amount, group_tag
       FROM sales_entry_items
      WHERE entry_id = ?
      ORDER BY line_no, id`
  )
    .bind(id)
    .all();
  const paymentsRes = await c.env.DB.prepare(
    `SELECT id, entry_id, paid_at, payment_method, amount,
            account_sheet, approval_code, collected_by
       FROM sales_entry_payments
      WHERE entry_id = ?
      ORDER BY paid_at, id`
  )
    .bind(id)
    .all();

  return c.json({
    entry: row,
    custom,
    items: itemsRes.results ?? [],
    payments: paymentsRes.results ?? [],
  });
});

// ── Create ───────────────────────────────────────────────────
app.post("/entries", requirePageAccess("sales"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    project_id?: number | null;
    ref_no?: string | null;
    customer_name?: string;
    customer_code?: string | null;
    customer_address?: string | null;
    customer_phone?: string | null;
    amount?: number;
    deposit_amount?: number | null;
    deposit_payment_type?: string | null;
    sales_person_id?: number | null;
    currency?: string;
    occurred_at?: string;
    notes?: string | null;
    custom?: Record<string, any>;
    // Mig 070 form fields — header text columns + line items + payments.
    items?: SalesItemInput[];
    payments?: SalesPaymentInput[];
    [k: string]: any;
    // Quick-log path — rep is on the floor and only has amount + ref_no.
    // The row lands as a draft tagged with the QUICK_LOG_SENTINEL in
    // customer_name. The /submit endpoint blocks the rep from
    // promoting this to 'submitted' until they back-fill a real name.
    quick_log?: boolean;
  }>();

  const customerNameInput = (body.customer_name || "").trim();
  const isQuickLog = body.quick_log === true || !customerNameInput;
  const customerName = isQuickLog ? QUICK_LOG_SENTINEL : customerNameInput;
  const amount = Number(body.amount);
  if (!isFinite(amount)) return c.json({ error: "amount must be a number" }, 400);
  const occurredAt = (body.occurred_at || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(occurredAt)) {
    return c.json({ error: "occurred_at must be a yyyy-mm-dd date" }, 400);
  }

  const items = Array.isArray(body.items) ? body.items : [];
  const payments = Array.isArray(body.payments) ? body.payments : [];

  // Validate payment dates / methods up front so we don't insert the
  // header and orphan a bad payment.
  for (const p of payments) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(String(p.paid_at || ""))) {
      return c.json({ error: "payments[].paid_at must be yyyy-mm-dd" }, 400);
    }
    if (!p.payment_method || typeof p.payment_method !== "string") {
      return c.json({ error: "payments[].payment_method is required" }, 400);
    }
    const a = Number(p.amount);
    if (!isFinite(a) || a < 0) {
      return c.json({ error: "payments[].amount must be a non-negative number" }, 400);
    }
  }

  // Deposit derives from payments when supplied; otherwise honour the
  // legacy single-deposit body fields (quick-log + old client paths).
  const paySummary = summarisePayments(payments);
  let depositAmount: number | null = null;
  let paymentType: string | null = null;
  if (payments.length > 0) {
    depositAmount = paySummary.total;
    paymentType = paySummary.firstMethod;
  } else if (body.deposit_amount === null) {
    depositAmount = null;
    paymentType = body.deposit_payment_type?.trim() || null;
  } else if (body.deposit_amount === undefined) {
    depositAmount = amount;
    paymentType = body.deposit_payment_type?.trim() || null;
  } else {
    const d = Number(body.deposit_amount);
    if (!isFinite(d) || d < 0) {
      return c.json({ error: "deposit_amount must be a non-negative number" }, 400);
    }
    if (d > amount) {
      return c.json({ error: "deposit_amount cannot exceed amount" }, 400);
    }
    depositAmount = d;
    paymentType = body.deposit_payment_type?.trim() || null;
  }

  if (paymentType && !PAYMENT_TYPES.has(paymentType)) {
    return c.json(
      { error: "deposit_payment_type must be one of cash, card_cc, card_db, epp, cheque, online" },
      400
    );
  }

  // Mint doc_no if the client didn't supply one.
  const docNo = (body.doc_no?.trim() as string | undefined) || (await nextSalesEntryDocNo(c.env));

  // Build the dynamic insert. Static columns first, then the new
  // mig-070 text fields driven by SO_FORM_TEXT_FIELDS minus doc_no
  // (which we already minted above).
  const cols: string[] = [
    "doc_no",
    "project_id", "ref_no", "customer_name", "customer_code",
    "customer_address", "customer_phone", "amount",
    "deposit_amount", "deposit_payment_type",
    "currency", "occurred_at", "notes", "created_by", "sales_person_id",
  ];
  const vals: any[] = [
    docNo,
    body.project_id ?? null,
    body.ref_no?.trim() || null,
    customerName,
    body.customer_code?.trim() || null,
    body.customer_address?.trim() || null,
    body.customer_phone?.trim() || null,
    amount,
    depositAmount,
    paymentType,
    body.currency?.trim() || "MYR",
    occurredAt,
    body.notes?.trim() || null,
    user?.id ?? 0,
    body.sales_person_id ?? user?.id ?? null,
  ];
  for (const k of SO_FORM_TEXT_FIELDS) {
    if (k === "doc_no") continue;
    cols.push(k);
    const v = body[k];
    vals.push(typeof v === "string" ? v.trim() || null : v ?? null);
  }

  const placeholders = cols.map(() => "?").join(", ");
  const r = await c.env.DB.prepare(
    `INSERT INTO sales_entries (${cols.join(", ")}) VALUES (${placeholders})`
  )
    .bind(...vals)
    .run();

  const id = r.meta.last_row_id as number;

  if (items.length) await replaceItems(c.env, id, items);
  if (payments.length) await replacePayments(c.env, id, payments);

  // Persist custom field values via the existing UDF store. Silent-drop
  // anything with an unknown key so a renamed field doesn't 500 the
  // create — the matching GET will just omit it.
  if (body.custom) {
    await writeCustomFields(c.env, id, body.custom);
  }

  await bumpProjectFinance(c.env, body.project_id ?? null);

  return c.json({ id, doc_no: docNo }, 201);
});

// ── Patch ────────────────────────────────────────────────────
app.patch("/entries/:id", requirePageAccess("sales"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Bad id" }, 400);
  const user = c.get("user");
  const canManage = c.get("access_level") === "full";

  const current = await c.env.DB.prepare(
    `SELECT id, created_by, status, project_id FROM sales_entries WHERE id = ?`
  )
    .bind(id)
    .first<{ id: number; created_by: number; status: string; project_id: number | null }>();
  if (!current) return c.json({ error: "Not found" }, 404);

  // Writers can only edit their own drafts. Managers can edit anything.
  if (!canManage) {
    if (current.created_by !== user?.id) {
      return c.json({ error: "You can only edit your own entries" }, 403);
    }
    if (current.status !== "draft") {
      return c.json({ error: "Only draft entries are editable" }, 400);
    }
  }

  const body = await c.req.json<Record<string, any>>();

  // Validate payment type before queueing the SET. Cheaper than a 500
  // from a CHECK and surfaces the real error to the form.
  if ("deposit_payment_type" in body && body.deposit_payment_type) {
    if (!PAYMENT_TYPES.has(String(body.deposit_payment_type))) {
      return c.json(
        { error: "deposit_payment_type must be one of cash, card_cc, card_db, epp" },
        400
      );
    }
  }
  // If both amount and deposit_amount land in the patch, enforce
  // deposit ≤ amount. If only one moves, fall back to the existing
  // value on the row.
  if ("deposit_amount" in body && body.deposit_amount != null) {
    const d = Number(body.deposit_amount);
    if (!isFinite(d) || d < 0) {
      return c.json({ error: "deposit_amount must be a non-negative number" }, 400);
    }
    const amt =
      "amount" in body && body.amount != null
        ? Number(body.amount)
        : await c.env.DB.prepare(`SELECT amount FROM sales_entries WHERE id = ?`)
            .bind(id)
            .first<{ amount: number }>()
            .then((r) => r?.amount ?? 0);
    if (d > amt) {
      return c.json({ error: "deposit_amount cannot exceed amount" }, 400);
    }
  }

  const sets: string[] = [];
  const binds: any[] = [];
  const FIELDS = [
    "project_id",
    "ref_no",
    "customer_name",
    "customer_code",
    "customer_address",
    "customer_phone",
    "amount",
    "deposit_amount",
    "deposit_payment_type",
    "sales_person_id",
    "currency",
    "occurred_at",
    "notes",
    ...SO_FORM_TEXT_FIELDS,
  ] as const;
  for (const k of FIELDS) {
    if (k in body) {
      sets.push(`${k} = ?`);
      const v = body[k];
      binds.push(typeof v === "string" ? v.trim() || null : v ?? null);
    }
  }

  // Items + payments — replace-all when arrays are supplied. Mirrors
  // the deposit_amount / deposit_payment_type to keep the legacy list
  // view rendering correctly for these rows.
  if (Array.isArray(body.items)) {
    await replaceItems(c.env, id, body.items as SalesItemInput[]);
  }
  if (Array.isArray(body.payments)) {
    const pays = body.payments as SalesPaymentInput[];
    for (const p of pays) {
      if (!/^\d{4}-\d{2}-\d{2}/.test(String(p.paid_at || ""))) {
        return c.json({ error: "payments[].paid_at must be yyyy-mm-dd" }, 400);
      }
      if (!p.payment_method) {
        return c.json({ error: "payments[].payment_method is required" }, 400);
      }
      const a = Number(p.amount);
      if (!isFinite(a) || a < 0) {
        return c.json({ error: "payments[].amount must be a non-negative number" }, 400);
      }
    }
    await replacePayments(c.env, id, pays);
    const sum = summarisePayments(pays);
    if (!("deposit_amount" in body)) {
      sets.push("deposit_amount = ?");
      binds.push(sum.total);
    }
    if (!("deposit_payment_type" in body)) {
      sets.push("deposit_payment_type = ?");
      binds.push(sum.firstMethod);
    }
  }

  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    binds.push(id);
    await c.env.DB.prepare(
      `UPDATE sales_entries SET ${sets.join(", ")} WHERE id = ?`
    )
      .bind(...binds)
      .run();
  }

  if (body.custom) {
    await writeCustomFields(c.env, id, body.custom);
  }

  // Roll up the new project (if any). If the patch re-targeted the entry
  // to a different project, also refresh the old one so it doesn't keep
  // double-counting the moved row.
  const nextProjectId =
    "project_id" in body ? (body.project_id ?? null) : current.project_id;
  await bumpProjectFinance(c.env, nextProjectId);
  if (current.project_id && current.project_id !== nextProjectId) {
    await bumpProjectFinance(c.env, current.project_id);
  }

  return c.json({ ok: true });
});

// ── Submit (lock as ready for push) ─────────────────────────
app.post("/entries/:id/submit", requirePageAccess("sales"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Bad id" }, 400);
  const user = c.get("user");
  const canManage = c.get("access_level") === "full";

  const current = await c.env.DB.prepare(
    `SELECT id, created_by, status, customer_name FROM sales_entries WHERE id = ?`
  )
    .bind(id)
    .first<{ id: number; created_by: number; status: string; customer_name: string }>();
  if (!current) return c.json({ error: "Not found" }, 404);
  if (!canManage && current.created_by !== user?.id) {
    return c.json({ error: "Forbidden" }, 403);
  }
  if (current.status !== "draft") {
    return c.json({ error: `Can't submit a ${current.status} entry` }, 400);
  }
  // Quick-log gate: a row sitting on the QUICK_LOG_SENTINEL hasn't
  // been back-filled with real customer details. Don't let it
  // promote to 'submitted' (and from there toward AutoCount push).
  if (current.customer_name === QUICK_LOG_SENTINEL) {
    return c.json(
      { error: "Fill customer details before submitting" },
      400,
    );
  }

  await c.env.DB.prepare(
    `UPDATE sales_entries SET status = 'submitted', updated_at = datetime('now') WHERE id = ?`
  )
    .bind(id)
    .run();
  return c.json({ ok: true });
});

// ── Unsubmit (back to draft; managers only) ──────────────────
app.post("/entries/:id/unsubmit", requirePageAccess("sales", "full"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Bad id" }, 400);
  await c.env.DB.prepare(
    `UPDATE sales_entries SET status = 'draft', updated_at = datetime('now')
      WHERE id = ? AND status = 'submitted'`
  )
    .bind(id)
    .run();
  return c.json({ ok: true });
});

// ── Void ─────────────────────────────────────────────────────
app.post("/entries/:id/void", requirePageAccess("sales", "full"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Bad id" }, 400);
  const before = await c.env.DB.prepare(
    `SELECT project_id FROM sales_entries WHERE id = ?`
  )
    .bind(id)
    .first<{ project_id: number | null }>();
  await c.env.DB.prepare(
    `UPDATE sales_entries SET status = 'void', updated_at = datetime('now') WHERE id = ?`
  )
    .bind(id)
    .run();
  await bumpProjectFinance(c.env, before?.project_id ?? null);
  return c.json({ ok: true });
});

// ── Delete (soft) ────────────────────────────────────────────
app.delete("/entries/:id", requirePageAccess("sales"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Bad id" }, 400);
  const user = c.get("user");
  const canManage = c.get("access_level") === "full";

  const row = await c.env.DB.prepare(
    `SELECT created_by, status, project_id FROM sales_entries WHERE id = ?`
  )
    .bind(id)
    .first<{ created_by: number; status: string; project_id: number | null }>();
  if (!row) return c.json({ error: "Not found" }, 404);
  if (!canManage) {
    if (row.created_by !== user?.id) return c.json({ error: "Forbidden" }, 403);
    if (row.status !== "draft")
      return c.json({ error: "Only drafts can be deleted" }, 400);
  }

  await c.env.DB.prepare(
    `UPDATE sales_entries SET archived_at = datetime('now') WHERE id = ?`
  )
    .bind(id)
    .run();
  await bumpProjectFinance(c.env, row.project_id);
  return c.json({ ok: true });
});

// ── Push to AutoCount ────────────────────────────────────────
// Placeholder — the actual push handler lives behind AutoCount's write
// surface which is currently disabled (backend/src/services/autocount.ts
// AUTOCOUNT_WRITES_DISABLED). Flipping this to a real push is a separate
// change; for now the endpoint exists so the frontend can wire the
// "Push" button without a 404.
app.post("/entries/:id/push", requirePageAccess("sales", "full"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Bad id" }, 400);
  return c.json(
    {
      error:
        "AutoCount push is not yet enabled. Entries will be pushed once the write surface is unlocked.",
    },
    501
  );
});

// ── Helper: write custom field values ────────────────────────
async function writeCustomFields(
  env: Env,
  entryId: number,
  custom: Record<string, any>
) {
  // Fetch the defined fields once, filter incoming keys against them.
  const defs = await env.DB.prepare(
    `SELECT field_key FROM udf_fields WHERE table_name = 'sales_entries'`
  ).all<{ field_key: string }>();
  const allowed = new Set((defs.results ?? []).map((d) => d.field_key));

  for (const [key, rawValue] of Object.entries(custom)) {
    if (!allowed.has(key)) continue;
    const value =
      rawValue === null || rawValue === undefined ? null : String(rawValue);
    await env.DB.prepare(
      `INSERT INTO udf_values (table_name, row_key, field_key, value, updated_at)
       VALUES ('sales_entries', ?, ?, ?, datetime('now'))
       ON CONFLICT(table_name, row_key, field_key)
       DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    )
      .bind(String(entryId), key, value)
      .run();
  }
}

export default app;
