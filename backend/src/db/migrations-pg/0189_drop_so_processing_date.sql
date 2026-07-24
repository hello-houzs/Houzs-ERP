-- 0189 — Retire the dead legacy column scm.mfg_sales_orders.processing_date.
--
-- WHY. The SO "Processing date" has ONE user-facing field, and its storage is
-- internal_expected_dd (owner 2026-07-24: one field only). PR #140 renamed only
-- the UI LABEL to "Processing date" while the value kept landing in
-- internal_expected_dd; the legacy snapshot column processing_date has had no
-- writer since, so it is NULL on every SO created or edited after #140. Readers
-- were patched to coalesce internal_expected_dd ?? processing_date (PR #1179),
-- but the second column kept confusing every new reader — see the BUG-HISTORY
-- 2026-07-24 processing_date entry for the blank-Processing-date incident it
-- caused. This migration ships in the SAME PR that removes every backend select
-- of the column (a PostgREST select naming a dropped column errors).
--
-- NOTE. scm.consignment_sales_orders.processing_date (mig 0153) is a DIFFERENT
-- table's own column and is untouched, as is the native sales module's
-- sales_entries.processing_date.

ALTER TABLE scm.mfg_sales_orders DROP COLUMN IF EXISTS processing_date;
