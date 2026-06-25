-- 104_restore_is_active_defaults.sql
-- The D1 -> Postgres migration dropped the `DEFAULT 1` on several is_active
-- columns (the documented "active DEFAULT 1 dropped -> inline-add 500s / rows
-- land NULL and active filters silently exclude them" class). These columns are
-- all bigint. Restore the default so inserts that omit the column don't fail
-- (NOT NULL ones) or land NULL (nullable ones). Applied to prod 2026-06-26; this
-- file keeps new environments in sync. No existing NULL rows at apply time.
ALTER TABLE public.assr_lead_time_profiles ALTER COLUMN is_active SET DEFAULT 1;
ALTER TABLE public.creditors             ALTER COLUMN is_active SET DEFAULT 1;
ALTER TABLE public.lorries               ALTER COLUMN is_active SET DEFAULT 1;
ALTER TABLE public.stock_items           ALTER COLUMN is_active SET DEFAULT 1;
