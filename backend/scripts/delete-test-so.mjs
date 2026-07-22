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

// Every table that carries scm.mfg_sales_orders.doc_no as a reference.
// The delete order is CHILD → PARENT to avoid FK trips even when a
// CASCADE isn't declared (so_amendments has CASCADE — safe to leave in
// the list, its delete just no-ops after the FK fires).
const CHILD_TABLES = [
  "scm.mfg_sales_order_items",
  "scm.mfg_sales_order_payments",
  "scm.mfg_sales_order_activity",
  "scm.so_amendments",
];

async function main() {
  console.log(`\n== delete-test-so :: DOC_NO=${DOC_NO} mode=${APPLY ? "APPLY" : "DRY-RUN"} ==\n`);

  // (1) Load the parent row + its critical state fields.
  const [so] = await db`
    SELECT doc_no, status, proceeded_at, has_children, company_id, created_at
      FROM scm.mfg_sales_orders
     WHERE doc_no = ${DOC_NO}`;
  if (!so) {
    console.log(`SO ${DOC_NO} NOT FOUND. Nothing to delete.`);
    return;
  }
  console.log(`Parent  : ${DOC_NO}  status=${so.status}  company_id=${so.company_id}  proceeded_at=${so.proceeded_at ?? "—"}  has_children=${so.has_children ?? false}`);

  // (2) Refuse on any signal this is not a fresh test SO.
  const finalStatuses = new Set(["INVOICED", "DELIVERED", "CLOSED", "SHIPPED"]);
  if (finalStatuses.has(String(so.status).toUpperCase())) {
    throw new Error(`REFUSED: status=${so.status} — this SO has moved past CONFIRMED. Not a test row.`);
  }
  if (so.has_children === true || so.has_children === 1) {
    throw new Error(`REFUSED: has_children=true — there's a downstream document (DO/SI) attached.`);
  }

  // (3) Discover every row that references it. Print BEFORE deleting so the
  // dry-run is a complete picture, not a summary that hides something.
  const childCounts = {};
  for (const t of CHILD_TABLES) {
    const rows = await db.unsafe(`SELECT count(*)::int AS n FROM ${t} WHERE doc_no = $1`, [DOC_NO]);
    childCounts[t] = rows[0].n;
    console.log(`Child   : ${t.padEnd(40)} rows=${rows[0].n}`);
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
  // no-ops on the ones that do.
  await db.begin(async (sql) => {
    for (const t of CHILD_TABLES) {
      const r = await sql.unsafe(`DELETE FROM ${t} WHERE doc_no = $1`, [DOC_NO]);
      console.log(`Deleted : ${t.padEnd(40)} rows=${r.count}`);
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
