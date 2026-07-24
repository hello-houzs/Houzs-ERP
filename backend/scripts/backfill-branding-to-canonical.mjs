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
  if (g.includes("SERVICE")) return "SERVICE";
  return "OTHER";
};

// EXACT (case fix) + confident MAP only. Returns the canonical string to write,
// or null to LEAVE UNCHANGED (blank main-cat / no-match / already exact).
function resolveCanonical(freeText, category, canonicalList) {
  // Owner 2026-07-23: a PURE service / accessory item takes its CATEGORY as the
  // brand ("如果是单纯 service、单纯 accessories，你就放 accessories 或者
  // service as branding吧。就是category"). This fires even on BLANK rows — most
  // service / accessory SKUs have no branding today. Only writes if the
  // company's dropdown actually carries that brand (exact, case-insensitive);
  // if it does not, leave the row alone so the owner adds the brand first
  // rather than us inventing a value the picker cannot show.
  if (category === "ACCESSORY" || category === "SERVICE") {
    const want = category === "ACCESSORY" ? "accessories" : "service";
    const canon = canonicalList.find((c) => norm(c) === want);
    if (!canon) return null;
    return canon === freeText ? null : canon;
  }
  const ft = norm(freeText);
  if (!ft) return null; // blank main-category — leave for auto-derive / owner
  // Main categories (sofa / mattress / bedframe): confident free-text -> the
  // canonical dropdown value. A category word must be present so an accessory
  // "2990s" can never map to "2990s Sofa" (the wrong-guess class from before).
  const catWord = category === "SOFA" ? "sofa" : category === "MATTRESS" ? "mattress" : category === "BEDFRAME" ? "bedframe" : null;
  if (!catWord) return null; // OTHER — leave untouched
  const exact = canonicalList.find((c) => norm(c) === ft);
  if (exact) return exact === freeText ? null : exact; // fix casing only if differs
  const catMatch = canonicalList.find((c) => {
    const nc = norm(c);
    return nc.includes(catWord) && (nc.includes(ft) || ft.includes(nc.replace(` ${catWord}`, "")));
  });
  return catMatch ?? null; // no confident category match -> leave alone
}

// Rewrite one table. `catExpr` resolves the row's category for the mapping.
async function backfillTable(cid, table, canonicalList) {
  log("");
  log(`=== ${table} ===`);
  // Pull id + current branding + category. mfg_sales_order_items has no own
  // category; resolve it via the product catalog by item_code.
  // Pull ALL rows (no branding filter): a blank service / accessory row must be
  // fillable to its category brand. resolveCanonical returns null for a blank
  // MAIN-category row, so pulling the blanks in costs a scan but writes nothing
  // it should not.
  let rows;
  if (table === "mfg_sales_order_items") {
    rows = await dst.unsafe(`
      SELECT i.id, i.branding, p.category
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders o ON o.doc_no = i.doc_no
        LEFT JOIN scm.mfg_products p ON p.code = i.item_code AND p.company_id = o.company_id
       WHERE o.company_id=${cid}`);
  } else {
    rows = await dst.unsafe(`
      SELECT id, branding, category FROM scm.${table}
       WHERE company_id=${cid}`);
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
  // Run for EVERY company that maintains a brand dropdown (owner 2026-07-23:
  // "Houzs 也是一樣"). Each company maps against its OWN canonical list, so
  // 2990 free-text resolves to 2990's brands and Houzs to Houzs's. ONLY=<code>
  // narrows to one company for a surgical apply.
  const only = (process.env.ONLY || "").trim();
  const companies = await dst`SELECT id, code, name FROM companies ORDER BY id`;
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}${only ? `  ONLY=${only}` : "  (all companies)"}`);

  let grand = 0;
  for (const co of companies) {
    if (only && String(co.code) !== only) continue;
    const cid = Number(co.id);
    const brands = await dst`SELECT name FROM project_brands WHERE company_id=${cid} AND active=1 ORDER BY sort_order, name`;
    const canonicalList = brands.map((b) => b.name);
    log("");
    log(`########## COMPANY ${co.code} (id=${cid}) — ${co.name} ##########`);
    if (canonicalList.length === 0) {
      log("  no active canonical brands — skip (owner must maintain the dropdown first)");
      continue;
    }
    log(`  canonical (ACTIVE project_brands): ${canonicalList.map((b) => `"${b}"`).join(", ")}`);

    let total = 0;
    total += await backfillTable(cid, "mfg_products", canonicalList);
    total += await backfillTable(cid, "product_models", canonicalList);
    total += await backfillTable(cid, "mfg_sales_order_items", canonicalList);
    log(`  COMPANY ${co.code} subtotal ${APPLY ? "updated" : "would change"}: ${total}`);
    grand += total;
  }

  log("");
  log(`GRAND TOTAL rows ${APPLY ? "updated" : "that would change"}: ${grand}`);
  log("Blank MAIN-category + no-match rows are left untouched by design — see diag-branding-match.");
}
main().then(() => dst.end()).catch(async (e) => {
  console.error("BACKFILL_FAIL", e.message);
  try { await dst.end(); } catch {}
  process.exit(1);
});
