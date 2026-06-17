-- 0028_purchase_billing.sql
--
-- SCM 1:1 clone slice 5: PURCHASE INVOICE (PI) + PURCHASE RETURN (PR). Verbatim
-- clone of 2990s's purchase_invoices + purchase_invoice_items
-- (packages/db/src/schema.ts ~L1129/L1155) and purchase_returns +
-- purchase_return_items (~L1778/L1801), consolidated to their FINAL shape (2990s
-- base + mig 0057 variant fields). Money is the integer *_centi column, verbatim.
-- The purchase_invoice_status (POSTED/PARTIALLY_PAID/PAID/CANCELLED) and
-- purchase_return_status (POSTED/COMPLETED/CANCELLED) enums are EXACTLY 2990s's
-- names + values.
--
-- Document flow: PO -> GRN -> {PI (AP record, no stock impact), PR (return to
-- supplier, stock OUT)}. A PI bumps grn_items.invoiced_qty on post. A PR writes
-- inventory OUT movements + bumps grn_items.returned_qty + recomputes the parent
-- PO's received_qty on post.
--
-- NO TABLE-NAME COLLISION: Houzs has none of these tables -> BARE physical names
-- (PLAN.md collision map). Real FKs as 2990s does:
--   purchase_invoices.supplier_id        -> suppliers(id)                ON DELETE RESTRICT
--   purchase_invoices.purchase_order_id  -> mfg_purchase_orders(id)      ON DELETE SET NULL (nullable)
--   purchase_invoices.grn_id             -> grns(id)                     ON DELETE SET NULL (nullable)
--   purchase_invoice_items.purchase_invoice_id -> purchase_invoices(id)  ON DELETE CASCADE
--   purchase_invoice_items.grn_item_id   -> grn_items(id)                ON DELETE SET NULL
--   purchase_returns.supplier_id         -> suppliers(id)                ON DELETE RESTRICT
--   purchase_returns.purchase_order_id   -> mfg_purchase_orders(id)      ON DELETE SET NULL (nullable)
--   purchase_returns.grn_id              -> grns(id)                     ON DELETE SET NULL (nullable)
--   purchase_return_items.purchase_return_id -> purchase_returns(id)     ON DELETE CASCADE
--   purchase_return_items.grn_item_id    -> grn_items(id)                ON DELETE SET NULL
--
-- SEAM deviations vs 2990s (documented in schema.pg.ts header):
--   - created_by: 2990s uuid -> staff.id. rule #4 -> Houzs users.id is serial
--     INTEGER; SOFT ref (no FK), matching the PO + GRN + inventory slices.
--   - purchase_order_id: 2990s -> purchase_orders.id; here -> mfg_purchase_orders
--     (the cloned PO table). Kept nullable (SET NULL), exactly as 2990s.
--   - GL/accounting AP-posting (2990s POST /accounting/post/pi) is OUT OF SCOPE
--     (Houzs GL differs) — no PI/PR column is affected; nothing to create here.
--
-- Runner contract (backend/scripts/pg-migrate.mjs): the file is split on /;\s*\n/
-- and each statement runs via tx.unsafe(...) inside ONE transaction. So:
--   - NO BEGIN; / COMMIT; (the runner already wraps in a transaction).
--   - every statement is idempotent (CREATE TABLE/INDEX IF NOT EXISTS).
--   - each enum is guarded with a SINGLE-PHYSICAL-LINE DO block (no internal ;\n).
--   - currency_code + material_kind enums already exist (migration 0024); only
--     purchase_invoice_status + purchase_return_status are new here.

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'purchase_invoice_status') THEN CREATE TYPE purchase_invoice_status AS ENUM ('POSTED','PARTIALLY_PAID','PAID','CANCELLED'); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'purchase_return_status') THEN CREATE TYPE purchase_return_status AS ENUM ('POSTED','COMPLETED','CANCELLED'); END IF; END $$;

CREATE TABLE IF NOT EXISTS purchase_invoices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number      text NOT NULL UNIQUE,
  supplier_invoice_ref text,
  supplier_id         uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  purchase_order_id   uuid REFERENCES mfg_purchase_orders(id) ON DELETE SET NULL,
  grn_id              uuid REFERENCES grns(id) ON DELETE SET NULL,
  invoice_date        date NOT NULL DEFAULT now(),
  due_date            date,
  currency            currency_code NOT NULL DEFAULT 'MYR',
  subtotal_centi      integer NOT NULL DEFAULT 0,
  tax_centi           integer NOT NULL DEFAULT 0,
  total_centi         integer NOT NULL DEFAULT 0,
  paid_centi          integer NOT NULL DEFAULT 0,
  status              purchase_invoice_status NOT NULL DEFAULT 'POSTED',
  notes               text,
  posted_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          integer NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pi_supplier ON purchase_invoices (supplier_id);
CREATE INDEX IF NOT EXISTS idx_pi_po ON purchase_invoices (purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_pi_status ON purchase_invoices (status);

CREATE TABLE IF NOT EXISTS purchase_invoice_items (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_invoice_id     uuid NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
  grn_item_id             uuid REFERENCES grn_items(id) ON DELETE SET NULL,
  material_kind           material_kind NOT NULL,
  material_code           text NOT NULL,
  material_name           text NOT NULL,
  qty                     integer NOT NULL,
  unit_price_centi        integer NOT NULL,
  line_total_centi        integer NOT NULL,
  notes                   text,
  gap_inches              integer,
  divan_height_inches     integer,
  divan_price_sen         integer NOT NULL DEFAULT 0,
  leg_height_inches       integer,
  leg_price_sen           integer NOT NULL DEFAULT 0,
  custom_specials         jsonb,
  line_suffix             text,
  special_order_price_sen integer NOT NULL DEFAULT 0,
  variants                jsonb,
  item_group              text,
  description             text,
  description2            text,
  uom                     text NOT NULL DEFAULT 'UNIT',
  discount_centi          integer NOT NULL DEFAULT 0,
  unit_cost_centi         integer NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pi_items_pi ON purchase_invoice_items (purchase_invoice_id);

CREATE TABLE IF NOT EXISTS purchase_returns (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_number       text NOT NULL UNIQUE,
  purchase_order_id   uuid REFERENCES mfg_purchase_orders(id) ON DELETE SET NULL,
  grn_id              uuid REFERENCES grns(id) ON DELETE SET NULL,
  supplier_id         uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  return_date         date NOT NULL DEFAULT now(),
  reason              text,
  status              purchase_return_status NOT NULL DEFAULT 'POSTED',
  posted_at           timestamptz,
  completed_at        timestamptz,
  credit_note_ref     text,
  refund_centi        integer NOT NULL DEFAULT 0,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          integer NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pr_po ON purchase_returns (purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_pr_supplier ON purchase_returns (supplier_id);
CREATE INDEX IF NOT EXISTS idx_pr_status ON purchase_returns (status);

CREATE TABLE IF NOT EXISTS purchase_return_items (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_return_id      uuid NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
  grn_item_id             uuid REFERENCES grn_items(id) ON DELETE SET NULL,
  material_kind           material_kind NOT NULL,
  material_code           text NOT NULL,
  material_name           text NOT NULL,
  qty_returned            integer NOT NULL,
  unit_price_centi        integer NOT NULL DEFAULT 0,
  line_refund_centi       integer NOT NULL DEFAULT 0,
  reason                  text,
  notes                   text,
  gap_inches              integer,
  divan_height_inches     integer,
  divan_price_sen         integer NOT NULL DEFAULT 0,
  leg_height_inches       integer,
  leg_price_sen           integer NOT NULL DEFAULT 0,
  custom_specials         jsonb,
  line_suffix             text,
  special_order_price_sen integer NOT NULL DEFAULT 0,
  variants                jsonb,
  item_group              text,
  description             text,
  description2            text,
  uom                     text NOT NULL DEFAULT 'UNIT',
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pr_items_pr ON purchase_return_items (purchase_return_id);
