-- 0023_drop_adapted_scm_island.sql
--
-- Remove the adapted/trimmed Supply Chain tables (the "scm_*" island created by
-- migrations 0017-0022). Those were a from-scratch ADAPTATION (single-PO GRN,
-- POSTED-final, text-typed status, scm_ prefix). The owner rejected that in
-- favour of a verbatim 1:1 CLONE of 2990s's SCM — see docs/scm-clone/PLAN.md
-- (decision 2026-06-17). This clears the slate ("把旧的删干净才放进去") before the
-- 1:1 tables (suppliers, supplier_material_bindings, purchase_orders, grns, ...)
-- are added slice by slice in later migrations.
--
-- Safe: the island is dead code (no route/service references it — verified by
-- grep) and the tables are EMPTY on prod (TEST-001 / GRN-MAT seed data was
-- staging-only). Idempotent: DROP TABLE IF EXISTS ... CASCADE.

DROP TABLE IF EXISTS scm_stocktake_items CASCADE;
DROP TABLE IF EXISTS scm_stocktakes CASCADE;
DROP TABLE IF EXISTS scm_stock_transfer_items CASCADE;
DROP TABLE IF EXISTS scm_stock_transfers CASCADE;
DROP TABLE IF EXISTS scm_purchase_return_items CASCADE;
DROP TABLE IF EXISTS scm_purchase_returns CASCADE;
DROP TABLE IF EXISTS scm_purchase_invoice_items CASCADE;
DROP TABLE IF EXISTS scm_purchase_invoices CASCADE;
DROP TABLE IF EXISTS scm_goods_receipt_note_items CASCADE;
DROP TABLE IF EXISTS scm_goods_receipt_notes CASCADE;
DROP TABLE IF EXISTS scm_stock_moves CASCADE;
DROP TABLE IF EXISTS scm_purchase_order_items CASCADE;
DROP TABLE IF EXISTS scm_purchase_orders CASCADE;
DROP TABLE IF EXISTS scm_supplier_material_bindings CASCADE;
DROP TABLE IF EXISTS scm_suppliers CASCADE;
