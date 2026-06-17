-- 0024_suppliers.sql
--
-- SCM 1:1 clone slice 1: SUPPLIERS (vendor master) + supplier_material_bindings
-- (the "two-code mapping": OUR material_code <-> the SUPPLIER's own SKU + price
-- + currency + lead time + MOQ). Verbatim clone of 2990s's suppliers +
-- supplier_material_bindings tables (packages/db/src/schema.ts), table names
-- without the scm_ prefix. Money is the integer *_centi column, verbatim.
--
-- Runner contract (backend/scripts/pg-migrate.mjs): the file is split on /;\s*\n/
-- and each statement runs via tx.unsafe(...) inside ONE transaction. So:
--   - NO BEGIN; / COMMIT; (the runner already wraps in a transaction).
--   - every statement is idempotent (CREATE TABLE/INDEX IF NOT EXISTS).
--   - enums are guarded with a SINGLE-PHYSICAL-LINE DO block (no internal ;\n
--     so the ;\n split can't shatter it). Postgres has no CREATE TYPE IF NOT
--     EXISTS, so the guard checks pg_type first.
-- Enum names + values are EXACTLY 2990s's pgEnum(...) definitions.

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'supplier_status') THEN CREATE TYPE supplier_status AS ENUM ('ACTIVE','INACTIVE','BLOCKED'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'currency_code') THEN CREATE TYPE currency_code AS ENUM ('MYR','RMB','USD','SGD'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'material_kind') THEN CREATE TYPE material_kind AS ENUM ('mfg_product','fabric','raw'); END IF; END $$;

CREATE TABLE IF NOT EXISTS suppliers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text NOT NULL UNIQUE,
  name              text NOT NULL,
  whatsapp_number   text,
  email             text,
  contact_person    text,
  phone             text,
  address           text,
  state             text,
  country           text NOT NULL DEFAULT 'Malaysia',
  payment_terms     text,
  status            supplier_status NOT NULL DEFAULT 'ACTIVE',
  rating            integer NOT NULL DEFAULT 0,
  notes             text,
  supplier_type     text,
  category          text,
  tin_number        text,
  business_reg_no   text,
  postcode          text,
  area              text,
  mobile            text,
  fax               text,
  website           text,
  attention         text,
  business_nature   text,
  currency          text NOT NULL DEFAULT 'MYR',
  statement_type    text NOT NULL DEFAULT 'OPEN_ITEM',
  aging_basis       text NOT NULL DEFAULT 'INVOICE_DATE',
  credit_limit_sen  integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS supplier_material_bindings (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id             uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  material_kind           material_kind NOT NULL,
  material_code           text NOT NULL,
  material_name           text NOT NULL,
  supplier_sku            text NOT NULL,
  unit_price_centi        integer NOT NULL DEFAULT 0,
  currency                currency_code NOT NULL DEFAULT 'MYR',
  lead_time_days          integer NOT NULL DEFAULT 0,
  payment_terms_override  text,
  moq                     integer NOT NULL DEFAULT 0,
  price_valid_from        date,
  price_valid_to          date,
  is_main_supplier        boolean NOT NULL DEFAULT false,
  notes                   text,
  price_matrix            jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_smb_supplier ON supplier_material_bindings (supplier_id);
CREATE INDEX IF NOT EXISTS idx_smb_material ON supplier_material_bindings (material_kind, material_code);
CREATE INDEX IF NOT EXISTS idx_smb_main_per_material ON supplier_material_bindings (material_kind, material_code) WHERE is_main_supplier = true;
