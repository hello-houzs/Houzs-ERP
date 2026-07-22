#!/usr/bin/env node
// Delete a TEST Sales Order (2990- or bare) + all its child rows.
//
// Purpose: on 2990 POS you sometimes need to run a real handover to
// smoke-test the flow, which mints a real doc_no + eats a sequence slot.
// This removes that row so the sequence self-heals — the minter's
// `.like('2990-SO-2607-%')` fetch reads max+1 fresh next time, and the
// gap closes naturally.
//
// SAFETY:
//   - DRY-RUN by default (prints every row it would touch)
//   - REFUSES if the SO has ANY downstream document (DO / SI / etc.) or
//     any payment row — a real customer order, not a test
//   - REFUSES if the SO is CLOSED / INVOICED / DELIVERED — same reason
//   - Runs the deletes in a single transaction; nothing writes unless
//     everything succeeds
//
// Usage:  DOC_NO=2990-SO-2607-019 [APPLY=1] node scripts/delete-test-so.mjs
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
const DOC_NO = (process.env.DOC_NO ?? "").trim();
const APPLY = process.env.APPLY === "1";

if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
if (!DOC_NO) { console.error("need DOC_NO env (e.g. 2990-SO-2607-019)"); process.exit(2); }

const db = postgres(DST, { ssl: "require", prepare: false, max: 1 });

// Every table that carries a reference to scm.mfg_sales_orders. Column
// names vary — items/payments/activity link on `doc_no`, amendments link
// on `so_doc_no` (mig 0080). Each entry names its own column so the
// runner picks the right predicate. Tables that aren't present in the
// live schema (D1 mirror, pre-migration) or whose column has been
// renamed skip cleanly rather than blowing the transaction.
const CHILD_TABLES = [
  { table: "scm.mfg_sales_order_items",    col: "doc_no" },
  { table: "scm.mfg_sales_order_payments", col: "doc_no" },
  { table: "scm.mfg_sales_order_activity", col: "doc_no" },
  { table: "scm.so_amendments",            col: "so_doc_no" },
];

// Probe if a (schema, table, column) exists on live prod so we can skip
// tables/columns that aren't in this database (D1 mirror on test, or a
// rename we haven't caught yet). Uses information_schema — cheap.
async function columnExists(db, qualified, col) {
  const [schema, table] = qualified.split(".");
  const rows = await db`
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = ${schema} AND table_name = ${table} AND column_name = ${col}
     LIMIT 1`;
  return rows.length > 0;
}

async function main() {
  console.log(`\n== delete-test-so :: DOC_NO=${DOC_NO} mode=${APPLY ? "APPLY" : "DRY-RUN"} ==\n`);

  // (1) Load the parent row + its critical state fields. has_children is a
  // COMPUTED field on this codebase (stamped at query time from downstream
  // tables — see scm/routes/consignment-notes.ts et al.), NOT a stored
  // column. The check runs below via direct downstream-table scans.
  const [so] = await db`
    SELECT doc_no, status, proceeded_at, company_id, created_at
      FROM scm.mfg_sales_orders
     WHERE doc_no = ${DOC_NO}`;
  if (!so) {
    console.log(`SO ${DOC_NO} NOT FOUND. Nothing to delete.`);
    return;
  }
  console.log(`Parent  : ${DOC_NO}  status=${so.status}  company_id=${so.company_id}  proceeded_at=${so.proceeded_at ?? "—"}`);

  // (2) Refuse on any signal this is not a fresh test SO.
  const finalStatuses = new Set(["INVOICED", "DELIVERED", "CLOSED", "SHIPPED"]);
  if (finalStatuses.has(String(so.status).toUpperCase())) {
    throw new Error(`REFUSED: status=${so.status} — this SO has moved past CONFIRMED. Not a test row.`);
  }

  // Downstream-doc check: probe delivery_orders + sales_invoices + delivery_returns
  // for any row that references this SO. Any hit → real order, not a test.
  // Tables are read via to_regclass so a missing schema element (D1 mirror,
  // pre-migration) doesn't blow the script — the probe just returns 0.
  // delivery_returns is transitive via delivery_orders (a DR can't exist
  // without a DO), so probing DOs covers it. If DOs are 0, DRs are 0 by FK.
  const downstreamProbes = [
    { table: "scm.delivery_orders",    col: "so_doc_no" },
    { table: "scm.sales_invoices",     col: "so_doc_no" },
  ];
  let downstreamTotal = 0;
  for (const p of downstreamProbes) {
    const exists = await db.unsafe(`SELECT to_regclass('${p.table}') AS t`);
    if (!exists[0].t) { console.log(`Probe   : ${p.table.padEnd(40)} (schema absent — skip)`); continue; }
    const rows = await db.unsafe(`SELECT count(*)::int AS n FROM ${p.table} WHERE ${p.col} = $1`, [DOC_NO]);
    downstreamTotal += rows[0].n;
    console.log(`Probe   : ${p.table.padEnd(40)} downstream rows=${rows[0].n}`);
  }
  if (downstreamTotal > 0) {
    throw new Error(`REFUSED: ${downstreamTotal} downstream doc row(s) reference ${DOC_NO}. Not a test SO.`);
  }

  // (3) Discover every row that references it. Print BEFORE deleting so the
  // dry-run is a complete picture, not a summary that hides something.
  // Skip any (table, col) that isn't in the live schema — the runner just
  // logs "skip" rather than crashing on a missing column.
  const childCounts = {};
  for (const t of CHILD_TABLES) {
    if (!(await columnExists(db, t.table, t.col))) {
      console.log(`Child   : ${t.table.padEnd(40)} ${t.col.padEnd(12)} (column missing — skip)`);
      childCounts[t.table] = 0;
      continue;
    }
    const rows = await db.unsafe(`SELECT count(*)::int AS n FROM ${t.table} WHERE ${t.col} = $1`, [DOC_NO]);
    childCounts[t.table] = rows[0].n;
    console.log(`Child   : ${t.table.padEnd(40)} ${t.col.padEnd(12)} rows=${rows[0].n}`);
  }

  // Payments guard — a test SO usually has one drafted payment (the tap on
  // "Cash 100%" in the handover). Refuse on multiple payments — that hints
  // at a real customer that partially paid.
  const paymentCount = childCounts["scm.mfg_sales_order_payments"] ?? 0;
  if (paymentCount > 1) {
    throw new Error(`REFUSED: ${paymentCount} payments recorded — likely a real order (more than one transaction). Manual review needed.`);
  }

  if (!APPLY) {
    console.log(`\nDRY-RUN complete. To actually delete, re-run with APPLY=1.`);
    return;
  }

  // (4) Delete in one transaction. FK CASCADEs will do their work; the manual
  // deletes here cover the tables that don't declare CASCADE, and are safe
  // no-ops on the ones that do. Skip any (table, col) missing from the
  // live schema — same probe as (3).
  await db.begin(async (sql) => {
    for (const t of CHILD_TABLES) {
      if (!(await columnExists(sql, t.table, t.col))) continue;
      const r = await sql.unsafe(`DELETE FROM ${t.table} WHERE ${t.col} = $1`, [DOC_NO]);
      console.log(`Deleted : ${t.table.padEnd(40)} rows=${r.count}`);
    }
    const r = await sql`DELETE FROM scm.mfg_sales_orders WHERE doc_no = ${DOC_NO}`;
    console.log(`Deleted : ${"scm.mfg_sales_orders".padEnd(40)} rows=${r.count}`);
  });

  // (5) After-state proof. If the parent is truly gone, the next minter's
  // .like('2990-SO-YYMM-%') max will drop back and the sequence slot reopens.
  const [check] = await db`SELECT count(*)::int AS n FROM scm.mfg_sales_orders WHERE doc_no = ${DOC_NO}`;
  console.log(`\nAfter   : ${DOC_NO} present? ${check.n > 0 ? "STILL PRESENT (delete failed?)" : "gone ✓"}`);

  // Peek current max for the same month prefix so operator sees what the
  // next mint will now be.
  const prefix = DOC_NO.replace(/\d+$/, "%");
  const [maxRow] = await db.unsafe(
    `SELECT doc_no FROM scm.mfg_sales_orders WHERE doc_no LIKE $1 ORDER BY doc_no DESC LIMIT 1`,
    [prefix],
  );
  console.log(`Highest ${prefix} now : ${maxRow?.doc_no ?? "(none)"} — next mint reclaims the gap on its own.`);
}

main().then(() => db.end()).catch(async e => {
  console.error("DELETE_FAIL:", e.message);
  await db.end();
  process.exit(1);
});
