#!/usr/bin/env node
// TEMPORARY PROBE (branch diag/selling-price-probe -- NEVER MERGE).
// Replaces the Phase 2 import diagnostics only so the existing read-only
// diag-2990.yml workflow can carry a question to prod. Read-only: SELECTs only.
//
// THE QUESTION: which 2990 staff are NOT yet Houzs users, and who currently
// holds which company grant?
//
// Owner 2026-07-17: bring 2990's staff into Houzs, mark everyone in the
// Operation and Management departments as BOTH companies, leave Sales
// company-specific. Before proposing any write, establish the real delta --
// matching on email, which is the only identifier both systems share
// (2990 staff.id is a uuid; Houzs users.id is an integer; the mig-0066 bridge
// derives scm.staff.id from the HOUZS user id, so it cannot match backwards).
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
// bigint -> Number, the same transform db/pg.ts applies. Without it postgres.js
// hands back user_id as a STRING, a Map keyed on it never matches a numeric
// users.id, and every user reads as "no grant" -- which is the exact shape of
// the `?? 0` class: a lookup miss rendering as a confident answer.
const dst = postgres(DST, {
  ssl: "require",
  prepare: false,
  max: 1,
  types: { bigint: { to: 20, from: [20], serialize: String, parse: Number } },
});

const norm = (e) => (e ?? "").trim().toLowerCase();
// 2990 has shuihor00@gmail.com; Houzs has suihor00@gmail.com -- one letter
// apart, same person. An exact-match delta would report him missing and invite
// a duplicate account. Compare a squashed local-part too, and SHOW the near
// misses rather than silently resolving them.
const squash = (e) => norm(e).split("@")[0].replace(/[^a-z0-9]/g, "");

async function main() {
  // --- 2990 staff ---
  const { data: staff, error } = await src.from("staff").select("*").order("staff_code");
  if (error) throw new Error(`2990 staff: ${error.message}`);
  console.log(`=== 2990 public.staff: ${staff.length} rows ===`);
  const cols = staff[0] ? Object.keys(staff[0]) : [];
  console.log(`  columns: ${cols.join(", ")}`);
  console.log("");
  for (const s of staff) {
    console.log(
      `  ${String(s.staff_code ?? "-").padEnd(12)} ${String(s.name ?? "-").padEnd(18)} ${String(s.role ?? "-").padEnd(16)} ${String(s.email ?? "(no email)").padEnd(34)} active=${s.active ?? s.is_active ?? "?"}`,
    );
  }

  // --- Houzs users ---
  const users = await dst`
    SELECT u.id, u.email, u.name, u.status,
           d.name AS dept, p.name AS position, r.name AS role
      FROM users u
      LEFT JOIN departments d ON d.id = u.department_id
      LEFT JOIN positions   p ON p.id = u.position_id
      LEFT JOIN roles       r ON r.id = u.role_id
     ORDER BY u.id`;
  console.log("");
  console.log(`=== Houzs public.users: ${users.length} rows ===`);

  // --- company grants ---
  const grants = await dst`
    SELECT uc.user_id, c.code
      FROM user_companies uc JOIN companies c ON c.id = uc.company_id
     ORDER BY uc.user_id`;
  const byUser = new Map();
  for (const g of grants) {
    if (!byUser.has(g.user_id)) byUser.set(g.user_id, []);
    byUser.get(g.user_id).push(g.code);
  }
  console.log(`=== user_companies: ${grants.length} grant rows across ${byUser.size} users ===`);
  console.log("  (a user with NO row is unrestricted -- companyContext fails OPEN and gives ALL companies)");
  console.log("");
  console.log("  id   email                              dept                 position                  companies");
  for (const u of users) {
    const g = byUser.get(u.id);
    console.log(
      `  ${String(u.id).padEnd(4)} ${String(u.email ?? "-").padEnd(34)} ${String(u.dept ?? "-").padEnd(20)} ${String(u.position ?? "-").padEnd(25)} ${g ? g.sort().join("+") : "(none = ALL)"}`,
    );
  }

  // --- the delta, matched on email ---
  const houzsEmails = new Set(users.map((u) => norm(u.email)).filter(Boolean));
  const houzsSquash = new Map();
  for (const u of users) if (u.email) houzsSquash.set(squash(u.email), u);

  console.log("");
  console.log("=== 2990 staff vs Houzs users ===");
  let missing = 0;
  let near = 0;
  for (const s of staff) {
    const e = norm(s.email);
    if (e && houzsEmails.has(e)) continue;
    const nm = e ? houzsSquash.get(squash(e)) : null;
    if (nm) {
      near++;
      console.log(
        `  NEAR-MATCH  ${String(s.staff_code ?? "-").padEnd(10)} ${String(s.name ?? "-").padEnd(16)} 2990=${e}  vs  Houzs id=${nm.id} ${nm.email}  -- same person? do NOT create a duplicate`,
      );
      continue;
    }
    missing++;
    const posLocal = /\+pos@2990s\.local$/i.test(e);
    console.log(
      `  MISSING     ${String(s.staff_code ?? "-").padEnd(10)} ${String(s.name ?? "-").padEnd(16)} ${String(s.role ?? "-").padEnd(15)} ${s.email ?? "(no email)"}${posLocal ? "   <- synthetic POS-only address, not a real mailbox" : ""}`,
    );
  }
  if (!missing && !near) console.log("  (none -- every 2990 staff email already exists in Houzs)");
  console.log(`  totals: ${missing} missing, ${near} near-match`);

  console.log("");
  console.log("=== Houzs departments + positions (the targets for the both-company marking) ===");
  const depts = await dst`
    SELECT d.name AS dept, p.name AS position, count(u.id)::int AS n
      FROM departments d
      LEFT JOIN positions p ON p.department_id = d.id
      LEFT JOIN users u     ON u.position_id = p.id AND u.status = 'active'
     GROUP BY d.name, p.name ORDER BY d.name, p.name`;
  for (const r of depts) console.log(`  ${String(r.dept ?? "-").padEnd(24)} ${String(r.position ?? "-").padEnd(26)} active_users=${r.n}`);

  console.log("");
  console.log("=== who would be marked BOTH under the owner's rule (Operation + Management, excluding Sales) ===");
  const targets = await dst`
    SELECT u.id, u.email, d.name AS dept, p.name AS position
      FROM users u
      JOIN positions p   ON p.id = u.position_id
      JOIN departments d ON d.id = p.department_id
     WHERE u.status = 'active'
       AND (d.name ILIKE '%operation%' OR d.name ILIKE '%management%')
     ORDER BY d.name, u.id`;
  console.log(`  ${targets.length} active user(s) match:`);
  for (const t of targets) {
    const g = byUser.get(t.id);
    console.log(`  ${String(t.id).padEnd(4)} ${String(t.email ?? "-").padEnd(34)} ${String(t.dept).padEnd(20)} ${String(t.position).padEnd(25)} now=${g ? g.sort().join("+") : "(none = ALL)"}`);
  }
}

main()
  .then(() => dst.end({ timeout: 5 }))
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error("FAIL", e.message);
    await dst.end({ timeout: 5 }).catch(() => {});
    process.exit(1);
  });
