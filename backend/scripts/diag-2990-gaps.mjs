#!/usr/bin/env node
// Phase 2 diagnostics — DETAIL layer for the completeness gaps that
// diag-2990-import.mjs surfaces as row-count deltas. Read-only.
//
// For each gap table it lists the SOURCE rows that are NOT in Houzs under
// company_id=2, with the identifying fields a human can act on (doc_no,
// code, name), and classifies each miss as:
//   COLLISION — the UUID already exists under a different company_id
//               (ON CONFLICT DO NOTHING silently skipped it during import)
//   MISSING   — the UUID is absent from dest entirely; safe to re-insert
//
// The importer copies source UUIDs verbatim (see migrate-2990-into-houzs.mjs
// line 53: `for(const c of shared)o[c]=r[c]`) so a UUID diff is the ground
// truth. Doc-number columns are NOT the join key because dest carries a
// "2990-" prefix (DOCNO_COL) and src does not.
//
// Rules-of-the-road (per CLAUDE.md):
//   read-only • no writes • one SELECT per row • manual trigger only •
//   exit 0 for every legitimate answer • never insert marker rows.
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

const SUPA_URL = process.env.SOURCE_SUPABASE_URL;
const SUPA_KEY = process.env.SOURCE_SERVICE_ROLE_KEY;
const DST = process.env.DATABASE_URL;
if (!SUPA_URL || !SUPA_KEY || !DST) {
  console.error("need SOURCE_SUPABASE_URL + SOURCE_SERVICE_ROLE_KEY + DATABASE_URL");
  process.exit(2);
}

const src = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

// Tables to inspect. `id` = the join key (source UUID); `keys` = extra columns
// to print for human identification; `scoped` = true when the dest table has
// company_id (most do); false = shared table (currencies / sync_config).
// Tables shown as MISSING in the last diag run are all listed here; the
// deliberately-excluded ones (accounts / drivers / lorries) are noted in
// the summary block at the bottom, not queried.
// natKey / natKeyIsDocNo: when a row is MISSING by UUID we ALSO check the
// natural-key column for a dest row under any UUID — that's the ON CONFLICT
// DO NOTHING silent-skip signature (importer tried to insert but a UNIQUE
// index on the business key blocked it). natKeyIsDocNo prefixes the src
// value with "2990-" before the dest lookup, mirroring importer's DOCNO_COL
// prefix.
const GAP_TABLES = [
  { table: "mfg_products",              keys: ["code", "category", "branding", "active"],                       scoped: true, natKey: "code" },
  { table: "product_models",            keys: ["code", "category", "branding", "active"],                       scoped: true, natKey: "code" },
  { table: "suppliers",                 keys: ["code", "name", "active"],                                        scoped: true, natKey: "code" },
  { table: "delivery_orders",           keys: ["do_number", "so_doc_no", "status", "created_at"],                scoped: true, natKey: "do_number", natKeyIsDocNo: true },
  { table: "delivery_order_items",      keys: ["do_number", "line_no", "item_code"],                             scoped: true },
  { table: "grns",                      keys: ["grn_number", "po_number", "status", "created_at"],               scoped: true, natKey: "grn_number", natKeyIsDocNo: true },
  { table: "grn_items",                 keys: ["grn_number", "line_no", "item_code"],                            scoped: true },
  { table: "inventory_lots",            keys: ["source_doc_no", "item_code", "qty", "warehouse_id"],             scoped: true },
  { table: "inventory_movements",       keys: ["source_doc_no", "item_code", "movement_type", "qty"],            scoped: true },
  { table: "inventory_lot_consumptions",keys: ["source_doc_no", "lot_id", "qty"],                                scoped: true },
  { table: "mfg_so_audit_log",          keys: ["doc_no", "action", "created_at"],                                scoped: true },
  { table: "mfg_so_status_changes",     keys: ["doc_no", "from_status", "to_status", "created_at"],              scoped: true },
  { table: "pending_slip_uploads",      keys: ["doc_no", "kind", "created_at"],                                  scoped: true },
  { table: "pos_carts",                 keys: ["created_by", "customer_name", "created_at"],                     scoped: true },
  { table: "so_revisions",              keys: ["doc_no", "rev_no", "created_at"],                                scoped: true },
  { table: "currencies",                keys: ["code", "name", "rate"],                                          scoped: false, natKey: "code" },
  { table: "sync_config",               keys: ["key", "value"],                                                  scoped: false, natKey: "key" },
];

// Bounded fetchAll — Supabase caps at 1000 rows per page, so paginate.
async function fetchAll(table, selectCols) {
  const out = [];
  const P = 1000;
  for (let f = 0; ; f += P) {
    const { data, error } = await src.schema("public").from(table).select(selectCols).range(f, f + P - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < P) break;
  }
  return out;
}

// Which columns actually exist on the DEST table (so we don't SELECT a
// column that was renamed on the way in).
async function destColSet(table) {
  const r = await dst`SELECT column_name FROM information_schema.columns WHERE table_schema='scm' AND table_name=${table}`;
  return new Set(r.map((x) => x.column_name));
}

async function main() {
  const cidRow = await dst`SELECT id FROM companies WHERE code='2990'`;
  if (!cidRow.length) throw new Error("no 2990 company");
  const cid = Number(cidRow[0].id);
  notice(`2990 company_id=${cid}  mode=READ-ONLY`);
  notice("");

  let grandMissing = 0;
  let grandCollision = 0;

  for (const { table, keys, scoped, natKey, natKeyIsDocNo } of GAP_TABLES) {
    const dcols = await destColSet(table);
    if (dcols.size === 0) {
      notice(`--- ${table}: dest table missing, skipped`);
      continue;
    }
    // Only ask src for columns dest also has (schema drift safety).
    const idCol = dcols.has("id") ? "id" : null;
    if (!idCol) {
      notice(`--- ${table}: no 'id' column on dest, skipped`);
      continue;
    }
    const srcCols = ["id", ...keys.filter((k) => dcols.has(k))];
    let srcRows;
    try {
      srcRows = await fetchAll(table, srcCols.join(","));
    } catch (e) {
      notice(`--- ${table}: SRC fetch failed (${e.message}), skipped`);
      continue;
    }
    if (srcRows.length === 0) {
      notice(`--- ${table}: source empty`);
      continue;
    }

    // Fetch DEST ids under this company (or globally for shared tables).
    const destIds = scoped
      ? await dst.unsafe(`SELECT id FROM scm."${table}" WHERE company_id=${cid}`)
      : await dst.unsafe(`SELECT id FROM scm."${table}"`);
    const destSet = new Set(destIds.map((r) => String(r.id)));

    const missingSrc = srcRows.filter((r) => !destSet.has(String(r.id)));
    if (missingSrc.length === 0) {
      notice(`--- ${table}: aligned (${srcRows.length} src rows all present)`);
      continue;
    }

    // For each missing row, does the UUID exist under a DIFFERENT company?
    // (This is the ON CONFLICT DO NOTHING silent-skip signature.)
    const missingIds = missingSrc.map((r) => r.id);
    let collisions = [];
    if (scoped && missingIds.length) {
      // batch to avoid oversized IN clause
      for (let i = 0; i < missingIds.length; i += 200) {
        const chunk = missingIds.slice(i, i + 200);
        const r = await dst.unsafe(
          `SELECT id, company_id FROM scm."${table}" WHERE id IN (${chunk.map((_, k) => `$${k + 1}`).join(",")})`,
          chunk,
        );
        collisions.push(...r);
      }
    }
    const collisionMap = new Map(collisions.map((r) => [String(r.id), Number(r.company_id)]));

    // Natural-key check: for MISSING rows (UUID absent from dest) whose table
    // has a business-key UNIQUE constraint, look up dest by that key. If a
    // row exists with a DIFFERENT UUID that's the ON CONFLICT DO NOTHING
    // silent-skip signature — the importer tried but the UNIQUE index blocked.
    const natKeyMap = new Map(); // src_id -> {destId, destCid, natValue}
    if (natKey && dcols.has(natKey)) {
      const missingWithNatKey = missingSrc.filter((r) => r[natKey] != null && !collisionMap.has(String(r.id)));
      for (let i = 0; i < missingWithNatKey.length; i += 200) {
        const chunk = missingWithNatKey.slice(i, i + 200);
        const values = chunk.map((r) => {
          const raw = String(r[natKey]);
          return natKeyIsDocNo && !raw.startsWith("2990-") ? `2990-${raw}` : raw;
        });
        const q = scoped
          ? `SELECT id, company_id, "${natKey}" AS nk FROM scm."${table}" WHERE "${natKey}" IN (${values.map((_, k) => `$${k + 1}`).join(",")})`
          : `SELECT id, "${natKey}" AS nk FROM scm."${table}" WHERE "${natKey}" IN (${values.map((_, k) => `$${k + 1}`).join(",")})`;
        try {
          const r = await dst.unsafe(q, values);
          const foundByNk = new Map(r.map((x) => [String(x.nk), x]));
          for (let k = 0; k < chunk.length; k++) {
            const hit = foundByNk.get(values[k]);
            if (hit) natKeyMap.set(String(chunk[k].id), { destId: hit.id, destCid: hit.company_id, natValue: values[k] });
          }
        } catch (e) {
          notice(`   natKey check ERR (${e.message}) — skipped for this table`);
        }
      }
    }

    let coll = 0, miss = 0, natColl = 0;
    notice(`--- ${table}: ${missingSrc.length} rows on src not in dest (co=${scoped ? cid : "global"})`);
    for (const r of missingSrc) {
      let kind;
      if (collisionMap.has(String(r.id))) { kind = `COLLISION[co=${collisionMap.get(String(r.id))}]`; coll++; }
      else if (natKeyMap.has(String(r.id))) {
        const h = natKeyMap.get(String(r.id));
        kind = `NATKEY_COLLISION[${natKey}=${h.natValue} dest_id=${h.destId}${scoped ? ` co=${h.destCid}` : ''}]`;
        natColl++;
      } else { kind = "MISSING"; miss++; }
      const kv = keys
        .filter((k) => dcols.has(k))
        .map((k) => `${k}=${JSON.stringify(r[k] ?? null)}`)
        .join(" ");
      notice(`   ${kind}  id=${r.id}  ${kv}`);
    }
    notice(`   -> ${coll} id-collision, ${natColl} natkey-collision, ${miss} truly missing`);
    grandMissing += miss;
    grandCollision += coll + natColl;
  }

  notice("");
  notice(`=== SUMMARY ===`);
  notice(`Truly missing (safe to re-insert): ${grandMissing}`);
  notice(`Collisions (UUID or natural-key under another row, ON CONFLICT skipped): ${grandCollision}`);
  notice(`Deliberately excluded from importer (per owner ruling): accounts / drivers / lorries — not queried.`);
  notice(`Notes:`);
  notice(` * MISSING = a plain re-run of the top-up importer will pick it up`);
  notice(`   ONCE the parent row it points at also lands (FK-safe path). If`);
  notice(`   the table is not in migrate-2990's ORDER list, importer never`);
  notice(`   touches it (recent example: mfg_products was missing from ORDER).`);
  notice(` * COLLISION (id) = same UUID under a different company; the`);
  notice(`   primary-key ON CONFLICT DO NOTHING silently drops the insert.`);
  notice(` * NATKEY_COLLISION = same business key (do_number / code / grn_number`);
  notice(`   etc.) already stored under a DIFFERENT UUID. The UNIQUE index on`);
  notice(`   that column caused ON CONFLICT DO NOTHING to drop this row. Fix is`);
  notice(`   either to accept the dest row as authoritative (skip the src one)`);
  notice(`   or to update in place (natural-key merge, per-table decision).`);
}

main()
  .then(() => dst.end())
  .catch(async (e) => {
    console.error("DIAG_FAIL", e.message);
    try { await dst.end(); } catch {}
    process.exit(1);
  });
