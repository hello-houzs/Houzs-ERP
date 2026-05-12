#!/usr/bin/env node
/**
 * One-shot backfill for `role_page_access` (mig 073).
 *
 * Reads every row in `roles`, parses the JSON `permissions` array, and
 * inserts one `role_page_access(role_id, page_key, level)` row per
 * (role, page) using the per-page backfill rules below. The Owner /
 * IT Admin roles hold the `*` wildcard and short-circuit to 'full' on
 * every page — those rows are written for admin-UI visibility, but
 * `requirePageAccess` would short-circuit on `*` anyway.
 *
 * Usage:
 *   node scripts/backfill-role-page-access.mjs [--local] [--dry]
 *
 * Defaults to --remote. --dry prints the generated SQL without executing.
 *
 * Idempotency:
 *   `INSERT OR REPLACE` semantics on (role_id, page_key). Re-running
 *   overwrites any rows the admin has not subsequently edited via the
 *   Page Access UI. (The UI's PATCH writes a fresh row; the next
 *   backfill would clobber it. Run this script ONCE per deploy, not
 *   on a cron.)
 *
 * Rules duplicated from backend/src/services/pageAccess.ts — keep in
 * sync if the catalogue changes. Drift will only matter the next time
 * an admin runs this script, which is rare.
 */
import { execSync } from "node:child_process";

const DB = "autocount-sync";
const argv = process.argv.slice(2);
const local = argv.includes("--local");
const dry = argv.includes("--dry");
const FLAG = local ? "--local" : "--remote";

function wrangler(cmd, opts = {}) {
  return execSync(`npx wrangler d1 execute ${DB} ${FLAG} ${cmd}`, {
    stdio: opts.silent ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
}

function queryJson(sql) {
  const out = wrangler(`--json --command "${sql.replace(/"/g, '\\"')}"`, { silent: true });
  const parsed = JSON.parse(out);
  return parsed?.[0]?.results ?? [];
}

const has = (perms, ...keys) => keys.some((k) => perms.has(k));
const isOwner = (perms) => perms.has("*");

// Mirror of pageAccess.ts::PAGES — KEEP IN SYNC.
const PAGES = [
  {
    key: "overview",
    backfill: (p) =>
      isOwner(p)
        ? "full"
        : has(p, "projects.read", "sales.read", "sales_orders.read")
          ? "full"
          : "partial",
  },
  {
    key: "orders",
    backfill: (p) =>
      isOwner(p) || has(p, "sales_orders.write")
        ? "full"
        : has(p, "sales_orders.read")
          ? "partial"
          : "none",
  },
  {
    key: "delivery_orders",
    backfill: (p) =>
      isOwner(p) || has(p, "delivery_orders.write")
        ? "full"
        : has(p, "delivery_orders.read")
          ? "partial"
          : "none",
  },
  {
    key: "logistics",
    backfill: (p) =>
      isOwner(p) || has(p, "trips.manage", "planner.run")
        ? "full"
        : has(p, "trips.read.all", "fleet.read")
          ? "partial"
          : "none",
  },
  {
    key: "purchase_orders",
    backfill: (p) =>
      isOwner(p) || has(p, "purchase_orders.write")
        ? "full"
        : has(p, "purchase_orders.read")
          ? "partial"
          : "none",
  },
  {
    key: "service_cases",
    backfill: (p) =>
      isOwner(p) || has(p, "service_cases.manage")
        ? "full"
        : has(p, "service_cases.read", "service_cases.write")
          ? "partial"
          : "none",
  },
  {
    key: "sales",
    backfill: (p) =>
      isOwner(p) || has(p, "sales.manage")
        ? "full"
        : has(p, "sales.write", "sales.read")
          ? "partial"
          : "none",
  },
  {
    key: "projects",
    backfill: (p) =>
      isOwner(p) || has(p, "projects.manage")
        ? "full"
        : has(p, "projects.write", "projects.read", "projects.chat", "projects.checklist.tick")
          ? "partial"
          : "none",
  },
  {
    key: "settings",
    backfill: (p) => (isOwner(p) || has(p, "settings.manage") ? "full" : "none"),
  },
  {
    key: "team",
    backfill: (p) =>
      isOwner(p) || has(p, "users.manage", "roles.manage")
        ? "full"
        : has(p, "users.read", "roles.read")
          ? "partial"
          : "none",
  },
  {
    key: "sales_team",
    backfill: (p) =>
      isOwner(p) || has(p, "sales_team.manage")
        ? "full"
        : has(p, "sales_team.read")
          ? "partial"
          : "none",
  },
  {
    key: "sales_team_maintenance",
    backfill: (p) => (isOwner(p) || has(p, "sales_team.manage") ? "full" : "none"),
  },
  {
    key: "petty_cash",
    backfill: (p) =>
      isOwner(p) || has(p, "petty_cash.manage", "petty_cash.post")
        ? "full"
        : has(p, "petty_cash.read")
          ? "partial"
          : "none",
  },
];

function parsePerms(json) {
  if (!json) return new Set();
  try {
    const arr = JSON.parse(json);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

const roles = queryJson("SELECT id, name, permissions FROM roles");
if (roles.length === 0) {
  console.error("No roles found in DB. Aborting.");
  process.exit(1);
}

console.log(`Backfilling role_page_access for ${roles.length} role(s) × ${PAGES.length} pages…`);

const values = [];
for (const role of roles) {
  const perms = parsePerms(role.permissions);
  for (const page of PAGES) {
    const level = page.backfill(perms);
    values.push(`(${role.id}, '${page.key}', '${level}')`);
  }
}

const sql =
  `INSERT OR REPLACE INTO role_page_access (role_id, page_key, level) VALUES ${values.join(", ")}`;

if (dry) {
  console.log("--- DRY RUN — SQL ---");
  console.log(sql);
  console.log("--- end ---");
  console.log(`\nWould write ${values.length} rows.`);
  process.exit(0);
}

wrangler(`--command "${sql.replace(/"/g, '\\"')}"`);
console.log(`\nWrote ${values.length} rows.`);

// Optional summary
const counts = queryJson(
  "SELECT level, COUNT(*) AS n FROM role_page_access GROUP BY level ORDER BY level"
);
console.log("\nResulting distribution:");
for (const row of counts) console.log(`  ${row.level.padEnd(8)} ${row.n}`);
