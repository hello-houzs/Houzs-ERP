#!/usr/bin/env node
// Backfill free-text `branding` on 2990's SKUs / models / SO lines to the
// canonical project_brands dropdown value. Owner 2026-07-23: "backfill 的
// product 那边 match 回我的 dropdown 了维护 ... 现在很多跟着我的维护去做的
// 很多都是 free text".
//
// Mapping is the SAME category-aware logic diag-branding-match.mjs prints, so
// the owner reviews that diag output FIRST, deletes duplicate brands, and only
// then runs this. Only EXACT (canonicalise casing) + confident MAP rows are
// written; NO-MATCH rows are LEFT ALONE (they need an owner decision) and
// BLANK rows are left to the write-path auto-derive / a separate blank
// backfill. Idempotent.
//
// APPLY=1 to write, DRY-RUN otherwise. Prints every rewrite it would make.
import postgres from "postgres";
const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const normCat = (raw) => {
  const g = String(raw ?? "").trim().toUpperCase();
  if (g.includes("BEDFRAME")) return "BEDFRAME";
  if (g.includes("SOFA")) return "SOFA";
  if (g.includes("MATTRESS")) return "MATTRESS";
  if (g.includes("ACCESSOR")) return "ACCESSORY";
  return "OTHER";
};

// EXACT (case fix) + confident MAP only. Returns the canonical string to write,
// or null to LEAVE UNCHANGED (blank / no-match / already canonical-exact).
function resolveCanonical(freeText, category, canonicalList) {
  const ft = norm(freeText);
  if (!ft) return null; // blank — leave for auto-derive / blank backfill
  const exact = canonicalList.find((c) => norm(c) === ft);
  if (exact) return exact === freeText ? null : exact; // fix casing only if differs
  const catWord = category === "SOFA" ? "sofa" : category === "MATTRESS" ? "mattress" : category === "BEDFRAME" ? "bedframe" : null;
  if (catWord) {
    const catMatch = canonicalList.find((c) => {
      const nc = norm(c);
      return nc.includes(catWord) && (nc.includes(ft) || ft.includes(nc.replace(` ${catWord}`, "")));
    });
    if (catMatch) return catMatch;
  }
  const loose = canonicalList.find((c) => {
    const nc = norm(c);
    return nc.startsWith(ft) || ft.startsWith(nc) || nc.includes(ft) || ft.includes(nc);
  });
  if (loose) return loose;
  return null; // NO-MATCH — leave alone, owner decides
}

// Rewrite one table. `catExpr` resolves the row's category for the mapping.
async function backfillTable(cid, table, canonicalList) {
  log("");
  log(`=== ${table} ===`);
  // Pull id + current branding + category. mfg_sales_order_items has no own
  // category; resolve it via the product catalog by item_code.
  let rows;
  if (table === "mfg_sales_order_items") {
    rows = await dst.unsafe(`
      SELECT i.id, i.branding, p.category
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders o ON o.doc_no = i.doc_no
        LEFT JOIN scm.mfg_products p ON p.code = i.item_code AND p.company_id = o.company_id
       WHERE o.company_id=${cid} AND i.branding IS NOT NULL AND btrim(i.branding) <> ''`);
  } else {
    rows = await dst.unsafe(`
      SELECT id, branding, category FROM scm.${table}
       WHERE company_id=${cid} AND branding IS NOT NULL AND btrim(branding) <> ''`);
  }
  let changed = 0, unchanged = 0;
  // Batch updates by target value to keep it simple + auditable.
  const updates = new Map(); // id -> newBranding
  for (const r of rows) {
    const to = resolveCanonical(r.branding, normCat(r.category), canonicalList);
    if (to && to !== r.branding) { updates.set(r.id, to); changed++; }
    else unchanged++;
  }
  // Show a per-value summary (not one line per row).
  const byPair = new Map();
  for (const r of rows) {
    const to = updates.get(r.id);
    if (!to) continue;
    const k = `${JSON.stringify(r.branding)} -> ${JSON.stringify(to)}`;
    byPair.set(k, (byPair.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...byPair.entries()].sort((a, b) => b[1] - a[1])) log(`  ${k}  (${n} rows)`);
  log(`  would change ${changed}, leave ${unchanged}`);

  if (APPLY && updates.size) {
    let done = 0;
    for (const [id, to] of updates) {
      await dst.unsafe(`UPDATE scm.${table} SET branding=$1 WHERE id=$2`, [to, id]);
      done++;
    }
    log(`  APPLIED ${done} updates`);
  }
  return changed;
}

async function main() {
  const [c2990] = await dst`SELECT id FROM companies WHERE code='2990'`;
  const cid = Number(c2990.id);
  log(`2990 company_id=${cid}  mode=${APPLY ? "APPLY" : "DRY-RUN"}`);

  const brands = await dst`SELECT name FROM project_brands WHERE company_id=${cid} AND active=1 ORDER BY sort_order, name`;
  const canonicalList = brands.map((b) => b.name);
  log(`canonical (ACTIVE project_brands): ${canonicalList.map((b) => `"${b}"`).join(", ")}`);
  if (canonicalList.length === 0) {
    log("no active canonical brands — refusing to run (owner must maintain the dropdown first)");
    return;
  }

  let total = 0;
  total += await backfillTable(cid, "mfg_products", canonicalList);
  total += await backfillTable(cid, "product_models", canonicalList);
  total += await backfillTable(cid, "mfg_sales_order_items", canonicalList);

  log("");
  log(`TOTAL rows ${APPLY ? "updated" : "that would change"}: ${total}`);
  log("NO-MATCH + BLANK rows are left untouched by design — see diag-branding-match.");
}
main().then(() => dst.end()).catch(async (e) => {
  console.error("BACKFILL_FAIL", e.message);
  try { await dst.end(); } catch {}
  process.exit(1);
});
