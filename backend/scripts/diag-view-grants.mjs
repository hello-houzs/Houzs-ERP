// Read-only diagnostic: why does the runtime still get "permission denied for
// view mfg_sales_orders_with_payment_totals" after 0190 (GRANT service_role)
// AND 0191 (copy grants + owner from the 0084 sibling) both applied green?
//
// Prints, for the broken view and its never-dropped sibling:
//   - existence + owner (pg_views / pg_class)
//   - the raw ACL (relacl) — the authoritative grant list
//   - a has_table_privilege() matrix for the roles that could be the caller
//   - the _pg_migrations rows for 019x (proof the fixes ran on THIS database)
//   - the full role inventory (reveals the prod Hyperdrive role name)
//   - RLS flags on the base tables (rules out a policy denial masquerading)
// No writes. Output contains role names and ACLs only — no secrets.
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("no DATABASE_URL");
  process.exit(2);
}
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

const VIEW = "mfg_sales_orders_with_payment_totals";
const SIBLING = "suppliers_with_derived_category";

try {
  const ident = await pg`SELECT current_user, current_database()`;
  console.log("IDENT", JSON.stringify(ident[0]));

  const rels = await pg`
    SELECT c.relname, c.relkind, r.rolname AS owner, c.relacl::text AS acl
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_roles r ON r.oid = c.relowner
    WHERE n.nspname = 'scm' AND c.relname IN (${VIEW}, ${SIBLING})
    ORDER BY c.relname`;
  console.log("RELS_START");
  for (const x of rels) console.log("REL", JSON.stringify(x));
  console.log("RELS_END");

  const roles = await pg`
    SELECT r.rolname,
      has_table_privilege(r.rolname, ${'scm.' + VIEW}, 'SELECT')    AS sel_view,
      has_table_privilege(r.rolname, ${'scm.' + SIBLING}, 'SELECT') AS sel_sibling
    FROM pg_roles r
    WHERE r.rolcanlogin OR r.rolname IN ('service_role','anon','authenticated','authenticator','postgres')
    ORDER BY r.rolname`;
  console.log("PRIV_START");
  for (const x of roles) console.log("PRIV", JSON.stringify(x));
  console.log("PRIV_END");

  const members = await pg`
    SELECT m.rolname AS member, g.rolname AS granted_role
    FROM pg_auth_members am
    JOIN pg_roles m ON m.oid = am.member
    JOIN pg_roles g ON g.oid = am.roleid
    ORDER BY 1, 2`;
  console.log("MEMBERS_START");
  for (const x of members) console.log("MEM", JSON.stringify(x));
  console.log("MEMBERS_END");

  const migs = await pg`
    SELECT filename, applied_at FROM _pg_migrations
    WHERE filename LIKE '019%' ORDER BY filename`;
  console.log("MIGS_START");
  for (const x of migs) console.log("MIG", JSON.stringify(x));
  console.log("MIGS_END");

  const rls = await pg`
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'scm'
      AND c.relname IN ('mfg_sales_orders', 'mfg_sales_order_payments', 'suppliers')`;
  console.log("RLS_START");
  for (const x of rls) console.log("RLS", JSON.stringify(x));
  console.log("RLS_END");
} catch (e) {
  console.error("CFAIL", e.message);
  process.exitCode = 1;
} finally {
  await pg.end({ timeout: 5 });
}
