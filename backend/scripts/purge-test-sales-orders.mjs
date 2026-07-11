// Purge TEST sales orders (and every dependent row) from prod Supabase.
//
// WHY THIS EXISTS
//   ~18 test sales orders (doc_no SO-2607-* / SO-2606-*) were seeded directly
//   into PROD during pre-launch testing. There is no SO-level DELETE endpoint
//   in the API, and local machines cannot reach the Supabase pooler, so this
//   runs from GitHub Actions with the prod DATABASE_URL secret.
//
// WHAT IT DELETES (FK-safe order, single transaction)
//   The SCM schema lives in the `scm` Postgres schema on Houzs. mfg_sales_orders
//   is keyed by doc_no (text PRIMARY KEY). Children were enumerated by reading
//   backend/scripts/scm-schema/2990s-full-schema.sql (the base scm DDL) and the
//   later migrations-pg/*.sql. Two kinds of children exist:
//     A. Hard FKs to mfg_sales_orders(doc_no)      — ON DELETE cascade
//     B. Hard FKs to mfg_sales_order_items(id)     — cascade or set null
//     C. SOFT references (no FK) by doc_no / so_item_id text/uuid columns
//   We delete A + B(cascade) + C explicitly and in order, rather than trusting
//   the DB cascade, so DRY_RUN can report an exact per-table count.
//
// STOCK / LEDGER SAFETY
//   A sales order does NOT itself write inventory_movements / inventory_lots /
//   inventory_lot_consumptions — those are written only by DO / DR / GRN /
//   PURCHASE_RETURN / STOCK_TAKE / ADJUSTMENT (verified against the FIFO trigger
//   and route source_doc_type values). Allocation/readiness is COMPUTED, not a
//   stored reservation. So purging a DRAFT/processing SO leaves NO orphaned
//   stock effect.
//   The ONE exception: if a test SO was progressed far enough to generate a
//   delivery_order / sales_invoice / grn / purchase_order, those downstream docs
//   carry real stock movements and their FK back to the SO is ON DELETE SET NULL
//   (deleting the SO would silently orphan them). We do NOT auto-delete or
//   auto-reverse those — that is a separate, higher-risk operation. Instead we
//   DETECT them and print a LOUD WARNING listing exactly what is linked, and (in
//   DRY_RUN) refuse nothing but flag it; (in apply) we still refuse to touch
//   them and leave the SO's own rows purged, warning the operator to handle the
//   downstream docs by hand. For the seeded DRAFT test SOs this list is empty.
//
// USAGE
//   DRY_RUN defaults to TRUE. Nothing is committed unless DRY_RUN=false.
//     DATABASE_URL=... node scripts/purge-test-sales-orders.mjs
//     DATABASE_URL=... PREFIXES="SO-2607-,SO-2606-" DRY_RUN=false node scripts/purge-test-sales-orders.mjs
//   Prefixes may also be passed as CLI args:
//     node scripts/purge-test-sales-orders.mjs SO-2607- SO-2606-
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL missing"); process.exit(1); }

// DRY_RUN defaults to true. Only the literal string "false" turns it off.
const DRY_RUN = String(process.env.DRY_RUN ?? "true").toLowerCase() !== "false";

// Prefixes from args first, else PREFIXES env, else the known test batches.
const argPrefixes = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const envPrefixes = (process.env.PREFIXES ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const PREFIXES = (argPrefixes.length ? argPrefixes
  : envPrefixes.length ? envPrefixes
  : ["SO-2607-", "SO-2606-"]);

if (!PREFIXES.length) { console.error("no prefixes given"); process.exit(1); }

const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });

// Pretty banner helpers.
const line = "-".repeat(72);
const hr = () => console.log(line);
function report(rows) {
  for (const r of rows) {
    console.log(`  ${String(r.n).padStart(6)}  ${r.table}${r.detail ? "   " + r.detail : ""}`);
  }
}

try {
  hr();
  console.log(`PURGE TEST SALES ORDERS  ${DRY_RUN ? "[DRY RUN — nothing will be committed]" : "[APPLY — WILL COMMIT]"}`);
  console.log(`prefixes: ${PREFIXES.join(", ")}`);
  hr();

  await sql.begin(async (tx) => {
    // Match the parent SOs by doc_no prefix (case-sensitive; doc_no is uppercase).
    // Build an OR of "doc_no like prefix%" across all prefixes.
    const like = PREFIXES.map((p) => p.replace(/[%_]/g, (m) => "\\" + m) + "%");
    const sos = await tx`
      select doc_no, status
        from scm.mfg_sales_orders
       where doc_no like any(${like})
       order by doc_no`;
    const docNos = sos.map((s) => s.doc_no);

    if (!docNos.length) {
      console.log("No matching sales orders found. Nothing to do.");
      return; // empty tx — nothing written, commit/rollback is a no-op
    }

    console.log(`Matched ${docNos.length} sales order(s):`);
    for (const s of sos) console.log(`  ${s.doc_no}  (status=${s.status})`);
    console.log("");

    // Collect the SO item ids — several child tables key off item id, not doc_no.
    const items = await tx`
      select id from scm.mfg_sales_order_items where doc_no = any(${docNos})`;
    const itemIds = items.map((r) => r.id);

    const plan = []; // { table, n, detail, run: async () => count }

    // ---- helper: count + (optionally) delete, recording the plan row ----
    const step = async (table, detail, countQ, delQ) => {
      const c = Number((await countQ())[0]?.n ?? 0);
      plan.push({ table, n: c, detail });
      if (!DRY_RUN && c > 0) await delQ();
      return c;
    };

    // =========================================================================
    // STOCK / DOWNSTREAM-DOC SAFETY CHECK (detect, warn, DO NOT auto-delete)
    // =========================================================================
    // Downstream docs whose FK back to the SO is ON DELETE SET NULL. If any of
    // these exist for the matched SOs, deleting the SO orphans real stock docs.
    const doDocs = await tx`
      select doc_no, id from scm.delivery_orders where so_doc_no = any(${docNos})`;
    const siDocs = await tx`
      select doc_no, id from scm.sales_invoices where so_doc_no = any(${docNos})`;
    // PO items / lines and DO / SI items can also carry so_item_id back-links.
    const poItemsLinked = itemIds.length
      ? await tx`select count(*)::int n from scm.purchase_order_items where so_item_id = any(${itemIds})`
      : [{ n: 0 }];
    const poLinesLinked = itemIds.length
      ? await tx`select count(*)::int n from scm.purchase_order_lines where so_item_id = any(${itemIds})`
      : [{ n: 0 }];
    const doItemsLinked = itemIds.length
      ? await tx`select count(*)::int n from scm.delivery_order_items where so_item_id = any(${itemIds})`
      : [{ n: 0 }];
    const siItemsLinked = itemIds.length
      ? await tx`select count(*)::int n from scm.sales_invoice_items where so_item_id = any(${itemIds})`
      : [{ n: 0 }];

    const hasDownstream =
      doDocs.length || siDocs.length ||
      Number(doItemsLinked[0].n) || Number(siItemsLinked[0].n);

    // =========================================================================
    // DELETE PLAN — leaf-first / FK-safe order
    // =========================================================================

    // (1) mfg_so_price_overrides — FK doc_no + item_id -> cascade. Delete by doc_no
    //     (covers both, since every override row has a doc_no).
    await step(
      "scm.mfg_so_price_overrides", "(FK doc_no -> mfg_sales_orders.doc_no)",
      () => tx`select count(*)::int n from scm.mfg_so_price_overrides where doc_no = any(${docNos})`,
      () => tx`delete from scm.mfg_so_price_overrides where doc_no = any(${docNos})`,
    );

    // (2) mfg_so_status_changes — FK doc_no -> cascade.
    await step(
      "scm.mfg_so_status_changes", "(FK doc_no -> mfg_sales_orders.doc_no)",
      () => tx`select count(*)::int n from scm.mfg_so_status_changes where doc_no = any(${docNos})`,
      () => tx`delete from scm.mfg_so_status_changes where doc_no = any(${docNos})`,
    );

    // (3) mfg_so_audit_log — FK so_doc_no -> cascade.
    await step(
      "scm.mfg_so_audit_log", "(FK so_doc_no -> mfg_sales_orders.doc_no)",
      () => tx`select count(*)::int n from scm.mfg_so_audit_log where so_doc_no = any(${docNos})`,
      () => tx`delete from scm.mfg_so_audit_log where so_doc_no = any(${docNos})`,
    );

    // (4) mfg_sales_order_payments — FK so_doc_no -> cascade (payment records).
    await step(
      "scm.mfg_sales_order_payments", "(FK so_doc_no -> mfg_sales_orders.doc_no)",
      () => tx`select count(*)::int n from scm.mfg_sales_order_payments where so_doc_no = any(${docNos})`,
      () => tx`delete from scm.mfg_sales_order_payments where so_doc_no = any(${docNos})`,
    );

    // (5) pwp_codes — NO FK. Soft ref via source_doc_no (issued by the SO) and
    //     redeemed_doc_no (redeemed on the SO). A RESERVED pwp code issued by a
    //     test SO must be purged too, else it dangles.
    await step(
      "scm.pwp_codes", "(SOFT ref source_doc_no / redeemed_doc_no)",
      () => tx`select count(*)::int n from scm.pwp_codes
                where source_doc_no = any(${docNos}) or redeemed_doc_no = any(${docNos})`,
      () => tx`delete from scm.pwp_codes
                where source_doc_no = any(${docNos}) or redeemed_doc_no = any(${docNos})`,
    );

    // (6) scan_jobs — NO FK. Soft ref via so_doc_no (the minted DRAFT SO) and
    //     duplicate_of (a doc_no of the suspected original). Clean both.
    await step(
      "scm.scan_jobs", "(SOFT ref so_doc_no / duplicate_of)",
      () => tx`select count(*)::int n from scm.scan_jobs
                where so_doc_no = any(${docNos}) or duplicate_of = any(${docNos})`,
      () => tx`delete from scm.scan_jobs
                where so_doc_no = any(${docNos}) or duplicate_of = any(${docNos})`,
    );

    // (7) NULL-OUT surviving downstream so_item_id back-links BEFORE we delete
    //     the SO items, so that (a) we never rely on SET NULL firing implicitly
    //     and (b) any DO/SI/PO rows we intentionally keep don't point at a gone
    //     item. (If downstream docs exist they are also flagged in the warning
    //     block; here we simply detach the pointer safely.)
    if (itemIds.length && !DRY_RUN) {
      await tx`update scm.purchase_order_items set so_item_id = null where so_item_id = any(${itemIds})`;
      await tx`update scm.purchase_order_lines set so_item_id = null where so_item_id = any(${itemIds})`;
      await tx`update scm.delivery_order_items  set so_item_id = null where so_item_id = any(${itemIds})`;
      await tx`update scm.sales_invoice_items   set so_item_id = null where so_item_id = any(${itemIds})`;
    }
    plan.push({
      table: "(detach so_item_id back-links)",
      n: Number(poItemsLinked[0].n) + Number(poLinesLinked[0].n) +
         Number(doItemsLinked[0].n) + Number(siItemsLinked[0].n),
      detail: `po_items=${poItemsLinked[0].n} po_lines=${poLinesLinked[0].n} do_items=${doItemsLinked[0].n} si_items=${siItemsLinked[0].n} (SET NULL, rows kept)`,
    });

    // (8) mfg_sales_order_items — FK doc_no -> cascade. Delete AFTER back-links
    //     detached.
    await step(
      "scm.mfg_sales_order_items", "(FK doc_no -> mfg_sales_orders.doc_no)",
      () => tx`select count(*)::int n from scm.mfg_sales_order_items where doc_no = any(${docNos})`,
      () => tx`delete from scm.mfg_sales_order_items where doc_no = any(${docNos})`,
    );

    // (9) mfg_sales_orders — the parent, last.
    await step(
      "scm.mfg_sales_orders", "(parent)",
      () => tx`select count(*)::int n from scm.mfg_sales_orders where doc_no = any(${docNos})`,
      () => tx`delete from scm.mfg_sales_orders where doc_no = any(${docNos})`,
    );

    // =========================================================================
    // REPORT
    // =========================================================================
    console.log("Rows " + (DRY_RUN ? "that WOULD be deleted / detached:" : "deleted / detached:"));
    report(plan);
    console.log("");

    if (hasDownstream) {
      console.log("!".repeat(72));
      console.log("!! LOUD WARNING — downstream stock documents are linked to these SOs !!");
      console.log("!! These carry REAL inventory movements and are NOT auto-deleted /   !!");
      console.log("!! auto-reversed by this script. Handle them by hand:                !!");
      if (doDocs.length) console.log("!!   delivery_orders: " + doDocs.map((d) => d.doc_no).join(", "));
      if (siDocs.length) console.log("!!   sales_invoices : " + siDocs.map((d) => d.doc_no).join(", "));
      if (Number(doItemsLinked[0].n)) console.log(`!!   delivery_order_items with so_item_id: ${doItemsLinked[0].n}`);
      if (Number(siItemsLinked[0].n)) console.log(`!!   sales_invoice_items with so_item_id : ${siItemsLinked[0].n}`);
      console.log("!!   -> reverse their inventory_movements / inventory_lots /         !!");
      console.log("!!      inventory_lot_consumptions before deleting the docs.         !!");
      console.log("!".repeat(72));
      console.log("");
    } else {
      console.log("Stock/ledger check: OK — no delivery orders, sales invoices, or");
      console.log("linked stock documents found for these SOs. Clean to purge.");
      console.log("");
    }

    if (DRY_RUN) {
      // Roll the whole transaction back — commit NOTHING.
      throw new Error("__DRY_RUN_ROLLBACK__");
    }
  }).catch((e) => {
    if (e && e.message === "__DRY_RUN_ROLLBACK__") {
      hr();
      console.log("DRY RUN complete — transaction rolled back, nothing committed.");
      console.log("Re-run with DRY_RUN=false to apply.");
      hr();
      return;
    }
    throw e;
  });

  if (!DRY_RUN) {
    hr();
    console.log("APPLY complete — transaction committed.");
    hr();
  }
} catch (err) {
  console.error("PURGE FAILED:", err?.message ?? err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
