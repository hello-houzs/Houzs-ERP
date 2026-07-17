#!/usr/bin/env node
// TEMPORARY PROBE (branch diag/selling-price-probe -- NEVER MERGE).
// Read-only. SELECTs only.
//
// THE QUESTION: is the recursive-override chain actually walkable in prod?
//
// Owner ruled 2026-07-17: a manager earns on THEIR OWN downline, not the whole
// showroom ("跟著自己的sales的"). That is chain mode (PR #708). But chain mode
// walks users.manager_id, and bridges an SO's salesperson to a Houzs user via
// scm.staff.user_id (the mig-0066 link).
//
// **Both links fail SILENTLY.** A NULL manager_id looks exactly like "top of the
// tree"; a NULL staff.user_id looks exactly like "has no downline". Either one
// pays RM 0 and reports success -- the `?? 0`-hides-ignorance class, in payroll.
// So: count the coverage BEFORE flipping the default, not after someone's payslip.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const dst = postgres(DST, {
  ssl: "require", prepare: false, max: 1,
  types: { bigint: { to: 20, from: [20], serialize: String, parse: Number } },
});

const q = async (label, fn) => {
  try { console.log(`  ${label}: ${await fn()}`); }
  catch (e) { console.log(`  ${label}: QUERY FAILED -- ${e.message.split("\n")[0]}`); }
};

async function main() {
  // --- 1. Does anyone have an HR profile at all? If 0, everything below is moot ---
  console.log("=== 1. HR profiles (no profile => the person is silently dropped from commission) ===");
  await q("hr_salesperson_profiles rows", async () =>
    (await dst`SELECT count(*)::int AS n FROM scm.hr_salesperson_profiles`)[0].n);
  await q("  of which active", async () =>
    (await dst`SELECT count(*)::int AS n FROM scm.hr_salesperson_profiles WHERE active`)[0].n);
  await q("  of which tier=manager", async () =>
    (await dst`SELECT count(*)::int AS n FROM scm.hr_salesperson_profiles WHERE tier = 'manager'`)[0].n);
  await q("hr_item_kpi rows", async () =>
    (await dst`SELECT count(*)::int AS n FROM scm.hr_item_kpi`)[0].n);
  await q("hr_commission_config rows (one per company expected)", async () =>
    (await dst`SELECT count(*)::int AS n FROM scm.hr_commission_config`)[0].n);

  // --- 2. manager_id — the chain itself ---
  console.log("");
  console.log("=== 2. users.manager_id (chain mode walks THIS; NULL = top of tree = earns nothing) ===");
  await q("active users", async () =>
    (await dst`SELECT count(*)::int AS n FROM users WHERE status = 'active'`)[0].n);
  await q("active users WITH a manager_id", async () =>
    (await dst`SELECT count(*)::int AS n FROM users WHERE status = 'active' AND manager_id IS NOT NULL`)[0].n);
  await q("active SALES-dept users", async () => {
    const r = await dst`
      SELECT count(*)::int AS n FROM users u
        JOIN departments d ON d.id = u.department_id
       WHERE u.status='active' AND d.name ILIKE '%sales%'`;
    return r[0].n;
  });
  await q("active SALES-dept users WITH a manager_id", async () => {
    const r = await dst`
      SELECT count(*)::int AS n FROM users u
        JOIN departments d ON d.id = u.department_id
       WHERE u.status='active' AND d.name ILIKE '%sales%' AND u.manager_id IS NOT NULL`;
    return r[0].n;
  });
  await q("distinct people who ARE someone's manager", async () =>
    (await dst`SELECT count(DISTINCT manager_id)::int AS n FROM users WHERE manager_id IS NOT NULL`)[0].n);
  await q("deepest chain depth reachable", async () => {
    const r = await dst`
      WITH RECURSIVE up AS (
        SELECT id, manager_id, 1 AS d FROM users WHERE manager_id IS NOT NULL
        UNION ALL
        SELECT u.id, p.manager_id, up.d + 1
          FROM up JOIN users u ON u.id = up.id
                  JOIN users p ON p.id = up.manager_id
         WHERE p.manager_id IS NOT NULL AND up.d < 12)
      SELECT COALESCE(max(d), 0)::int AS n FROM up`;
    return `${r[0].n} (chain mode needs > 0 to pay anyone; MAX_CHAIN_DEPTH is 10)`;
  });

  // --- 3. The staff.user_id bridge — the OTHER silent failure ---
  console.log("");
  console.log("=== 3. scm.staff.user_id bridge (NULL => unbridgeable => rolls up to NOBODY) ===");
  await q("scm.staff rows", async () =>
    (await dst`SELECT count(*)::int AS n FROM scm.staff`)[0].n);
  await q("  WITH user_id set", async () =>
    (await dst`SELECT count(*)::int AS n FROM scm.staff WHERE user_id IS NOT NULL`)[0].n);
  await q("  active AND bridged", async () =>
    (await dst`SELECT count(*)::int AS n FROM scm.staff WHERE active AND user_id IS NOT NULL`)[0].n);
  await q("profiles whose staff row is UNBRIDGEABLE (the killer)", async () => {
    const r = await dst`
      SELECT count(*)::int AS n
        FROM scm.hr_salesperson_profiles p
        JOIN scm.staff s ON s.id = p.staff_id
       WHERE s.user_id IS NULL`;
    return `${r[0].n} (each looks exactly like "has no downline" and pays 0)`;
  });

  // --- 4. Who actually sells — is any of this even live? ---
  console.log("");
  console.log("=== 4. Do SOs even carry a salesperson? ===");
  await q("mfg_sales_orders by company", async () => {
    const r = await dst`SELECT company_id, count(*)::int AS n FROM scm.mfg_sales_orders GROUP BY 1 ORDER BY 1`;
    return r.map((x) => `co${x.company_id}=${x.n}`).join(" ");
  });
  await q("distinct salesperson_id on SOs", async () =>
    (await dst`SELECT count(DISTINCT salesperson_id)::int AS n FROM scm.mfg_sales_orders WHERE salesperson_id IS NOT NULL`)[0].n);
  await q("SO status breakdown (DRAFT was paying commission until #708)", async () => {
    const r = await dst`SELECT status, count(*)::int AS n FROM scm.mfg_sales_orders GROUP BY 1 ORDER BY 2 DESC`;
    return r.map((x) => `${x.status}=${x.n}`).join(" ");
  });

  console.log("");
  console.log("=== VERDICT ===");
  const [{ n: profiles }] = await dst`SELECT count(*)::int AS n FROM scm.hr_salesperson_profiles`;
  const [{ n: chained }] = await dst`SELECT count(*)::int AS n FROM users WHERE status='active' AND manager_id IS NOT NULL`;
  if (profiles === 0)
    console.log("  HR profiles = 0 -> /hr/commission returns an EMPTY list for everyone, silently.");
  if (chained === 0)
    console.log("  NO user has a manager_id -> chain mode would pay EVERY override RM 0, and look correct.");
  if (profiles > 0 && chained > 0)
    console.log("  Both links have coverage. Chain mode is walkable -- verify the per-person numbers above.");
}

main()
  .then(() => dst.end({ timeout: 5 }))
  .then(() => process.exit(0))
  .catch(async (e) => { console.error("FAIL", e.message); await dst.end({ timeout: 5 }).catch(() => {}); process.exit(1); });
