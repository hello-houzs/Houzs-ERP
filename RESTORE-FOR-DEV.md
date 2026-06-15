# ERP — Restore Amendments into Supabase (handoff for the developer)

**For:** weisiang329 (the developer who built the ERP + ran the D1→Supabase migration)
**From:** owner (hello@houzscentury.com)

## What happened
The owner made a large batch of ERP amendments + data entry (worked through Claude Code) on the **old D1 stack**, on branch **`feat/checklist-amendments`** (24 commits, base `26062e0`), and deployed them to the old D1 production via direct `wrangler` uploads.

Your **D1→Supabase migration** (PRs #4–#15, merged to `main` Jun 14–15) replaced production with the new Supabase build, which does **not** contain these amendments or their data.

**Nothing is lost.** Two artifacts in the repo root:
1. **Code** → branch `feat/checklist-amendments` (run `git log 26062e0..feat/checklist-amendments`)
2. **Data** → `D1-FULL-BACKUP.sql` (full D1 dump: 111 tables, ~47k rows — source of truth for final data values)
3. **Source CSVs** → `projects-MAY 2026.csv`, `projects-JUNE 2026.csv` (cleanest source for the sales/booth/size import)

Frontend (React) changes port over directly. Backend changes were D1/SQLite (`c.env.DB.prepare` + wrangler d1 migrations 089–101) and need porting to the Postgres / drizzle-pg layer.

---

## PART A — Re-apply the FEATURES onto Supabase `main`

**Fleet**
- Roster query `/api/fleet/staff`: include not-yet-logged-in crew → `status IN ('active','invited')` (was `='active'`).
- **Add Lorry**: `POST /api/lorries` + form (plate/size/warehouse/internal). **Delete Lorry**: `DELETE /api/lorries/:id` soft-delete (`is_active=0`); `POST` reactivates a soft-deleted plate.
- **Storekeeper tab** in Fleet (Drivers / Helpers / Storekeeper) — include role `Storekeeper` in the staff query.
- Remove **Model** + **Default Driver** columns from Lorries table; remove Model field from Add form.
- Relabel **"IC" → "IC / Passport"** (Fleet roster + staff detail view/edit).

**Staff / Users**
- Add `company_phone` to users; staff detail shows **Personal Phone** + **Company Phone**.

**Projects**
- **"My pending tasks"** filter on the project list. Role → scope: BD→label `BD`, Purchaser→`PURCHASER`, Sales*→`SALES PIC`, Driver/Helper/Storekeeper→`DRIVER`, Manager→item title `Agreement / Quotation`, **Logistic→staged** (setup due once `Stock Out Transfer Record` is done but `setup_crew`/`setup_start_at` empty; dismantle due once setup arranged but dismantle empty), Owner/IT Admin→all. Backend list filter params `pending_label` / `pending_title` / `pending_logistic`. **Export unchanged.**
- **Stage stepper**: removed "Stocks Request" step; added **"Setup/Dismantle"** step (green when `setup_start_at` set OR `setup_crew` non-empty).
- Project detail: widened layout (`DetailLayout` `wide` prop); **review remark moved to the Remarks column** (decision trail stays in Approval); attachment upload timestamps show **date + time**.
- Hide nameless (invited, no name yet) crew from the Setup/Dismantle dropdowns.

**Tables**
- Remove the **Comfy/Compact density toggle** — lock all DataTables to "comfy".

**Roles**
- Fix `DELETE /api/roles/:id`: delete dependent `role_page_access` + `invitations` rows **before** deleting the role (FK constraint).

**Edit history**
- New table `sales_entry_activity` (entry_id, user_id, action, note, created_at); log **created / edited / submitted / unsubmitted / voided** in the sales routes; show the timeline on the entry.
- Project activity feed: log **`document_upload`** on checklist attachment upload (feed label "Document uploaded"). NOTE: checklist-tick logging was intentionally NOT added.

**Finance**
- Quick `total_sales` feeds the **Overview P&L** revenue — but only for **quick-entry** projects (no sales_entries / reports / income lines), to avoid double-counting; bucket by project `end_date`.

*(Plus the earlier checklist amendments already in the branch: Stamp Duty item under License; "Stock Transfer Record" → "Stock Out Transfer Record"; "Stock In Transfer Record"; Booth Layout / Contract sections rendered as document tables; role chips w/ colours (Sales PIC pink, Driver blue, Purchaser orange, Logistic green, BD purple); PIC oval icons; N/A button; restrict approve/reject to specific items; shared 3D upload; remark box; remove Stocks Request Listing; project stage stepper; calendar solo-event format; Setup & Dismantle crew editor w/ `setup_crew`/`dismantle_crew` JSON; quick Total Sales box.)*

---

## PART B — Schema additions for Supabase (Postgres equivalents of D1 migrations 089–101)
Add wherever missing in the new schema:
- `projects`: `setup_crew` (jsonb), `dismantle_crew` (jsonb), `setup_start_at`, `dismantle_start_at`
- `project_checklist`: `role_label`, `crew_visible`, `pill_kind`, `pill_value`, `review_status`, `rejection_reason`
- `users`: `company_phone` (text)
- `lorries`: `model`, `status`, `capacity_m3`, `capacity_kg`, `road_tax_expiry`, `insurance_expiry`, `puspakom_expiry`
- New table: `sales_entry_activity`
- `project_checklist_(template_)sections.display_mode = 'documents'` for **BOOTH LAYOUT & SETUP** and **CONTRACT**
- Add role: **Storekeeper**

---

## ⚠️ CRITICAL — concurrent work in progress, do NOT full-overwrite
Another user (hello@houzscentury.com) is **actively amending the SERVICE part** of the ERP in the **live Supabase** system right now. **Do NOT restore by wholesale-importing `D1-FULL-BACKUP.sql` over the Supabase database** — that would wipe her in-progress Service work.
- Restore **selectively** — apply ONLY the specific tables/rows listed below (projects/finance, roles, lorries, users.company_phone, sales_entry_activity).
- **Leave the Service/ASSR tables and any data changed after the migration untouched.**
- **Back up the current Supabase database FIRST**, before importing anything.

## PART C — Restore the DATA into Supabase
Source of truth = `D1-FULL-BACKUP.sql` (final values). For the bulk project data, re-importing from the CSVs is cleanest. **Selective import only — see the warning above.**

1. **May/June project data** (`projects` + `project_finance`): match each row by **name + start_date**. Rules used:
   - `total_sales` = CSV Sales value; **blank → 0** (and remove seeded "Total sales (seeded)" income line so it doesn't restore)
   - `rental` = 0 where CSV says `0`; **blank → leave untouched**
   - `size_sqm` + `booth_no` where the CSV has a value
2. **Roles + page-access** (`roles`, `role_page_access`): Finance role (Projects=Partial, Calendar/List read, Finances per setup, scope_to_pic=0), Storekeeper role, and the Driver/Helper/Storekeeper/Logistic page-access sets.
3. **Lorries** (`lorries`): the current real fleet (active rows in backup).
4. **Staff** (`users`): Storekeeper-role users + driver/helper `company_phone` values.

---

## Quick checklist for the dev
- [ ] Pull branch `feat/checklist-amendments`; review `git log 26062e0..feat/checklist-amendments`
- [ ] Port frontend changes onto new `main`
- [ ] Re-implement backend endpoints/filters for Postgres
- [ ] Add the Part B schema columns/tables (Postgres migration)
- [ ] Import Part C data from `D1-FULL-BACKUP.sql` (+ the two CSVs)
- [ ] Deploy + verify
