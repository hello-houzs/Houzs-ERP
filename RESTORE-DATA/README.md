# RESTORE-DATA — owner's amendment data (extracted from old D1)

Clean, targeted exports of ONLY the owner's amendment data, ready to import
into Supabase **selectively**. (Full dump is `D1-FULL-BACKUP.sql` in repo root.)

⚠️ Import selectively — do NOT overwrite the live Service tables. Back up
Supabase first. Do NOT reset the Supabase DB password (breaks Hyperdrive).

Files (each is a `wrangler d1 ... --json` result; read the `results` array):

- **projects-may-june-values.json** — final May/June project values:
  `code, name, start_date, booth_no, size_sqm, total_sales, rental`.
  Match each to the Supabase `projects` / `project_finance` by **code** (or
  name+start_date) and apply these values. (Source CSVs also in repo root:
  `projects-MAY 2026.csv`, `projects-JUNE 2026.csv`.)
- **roles.json** — roles incl. new **Storekeeper** + **Finance** roles
  (`name, description, scope_to_pic, permissions`).
- **role_page_access.json** — per-role page access (`role_id, page_key, level`)
  for Driver/Helper/Storekeeper/Logistic/Finance, etc.
- **lorries.json** — current active fleet (`plate, size, model, warehouse,
  is_internal, status`).
- **fleet-staff.json** — Driver/Helper/Storekeeper users incl. **company_phone**
  (`email, name, phone, company_phone, ic_number, role`). Match to Supabase
  `users` by email; set `company_phone` (+ assign Storekeeper role where shown).

Rules used for the project data (Part C of RESTORE-FOR-DEV.md):
- total_sales = value shown; blank in source → 0 (seeded income line removed)
- rental = 0 where source said 0; blank → leave untouched
- size_sqm + booth_no = where source had a value
