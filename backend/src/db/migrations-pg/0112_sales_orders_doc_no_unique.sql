-- The AutoCount inbound SO pull (services/pull.ts, restored in PR #477) upserts
-- the sales_orders mirror with `INSERT ... ON CONFLICT(doc_no) DO UPDATE`. In the
-- original D1/SQLite schema doc_no was the PRIMARY KEY, but the D1->PG migration
-- gave the table a surrogate `id` PK and left doc_no as a plain column with no
-- unique constraint. So every pull upsert failed with:
--   "there is no unique or exclusion constraint matching the ON CONFLICT specification"
-- Add the missing UNIQUE(doc_no) so the ON CONFLICT target resolves. Verified
-- safe on prod 2026-07-14: 2695 rows, 2695 distinct doc_no, 0 nulls, 0 dups.
-- Idempotent so pg-migrate can re-run it and it matches the constraint already
-- applied directly to prod.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sales_orders'::regclass
      AND conname = 'sales_orders_doc_no_key'
  ) THEN
    ALTER TABLE public.sales_orders ADD CONSTRAINT sales_orders_doc_no_key UNIQUE (doc_no);
  END IF;
END $$;
