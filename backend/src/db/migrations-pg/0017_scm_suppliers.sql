-- 0017_scm_suppliers.sql
--
-- Supply Chain module (ported from the 2990s ERP) — Phase 1: Supplier
-- master + supplier<->material bindings (the "two-code mapping": OUR
-- internal material_code <-> the supplier's own SKU + price + lead time).
--
-- NAMESPACE: everything is prefixed `scm_` so it never collides with the
-- existing AutoCount-synced `creditors` / `purchase_orders` / `warehouses`
-- tables. The scm_ module is a self-contained island — it does NOT foreign-
-- key into the legacy serial-id tables, so it keeps Postgres-native types
-- (uuid PK, timestamptz, jsonb) rather than the D1-dump-era serial/text
-- shape. Enum values are plain text + CHECK (Houzs convention; avoids
-- CREATE TYPE idempotency friction).
--
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS throughout. gen_random_uuid()
-- is built into Supabase Postgres (pgcrypto).

-- ── scm_suppliers — purchasing-side vendor master ───────────────────────
CREATE TABLE IF NOT EXISTS scm_suppliers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text NOT NULL UNIQUE,                 -- credit account ('400-B002')
  name              text NOT NULL,                        -- company name
  whatsapp_number   text,
  email             text,
  contact_person    text,
  phone             text,
  address           text,                                 -- billing address (multiline)
  state             text,
  country           text NOT NULL DEFAULT 'Malaysia',
  payment_terms     text,                                 -- 'COD' | 'NET 7' | 'NET 30' | ...
  status            text NOT NULL DEFAULT 'ACTIVE'
                      CHECK (status IN ('ACTIVE','INACTIVE','BLOCKED')),
  rating            integer NOT NULL DEFAULT 0,           -- 0-5 scale
  notes             text,
  supplier_type     text,                                 -- 'Matrix' | 'Distributor' | 'Maker' | ...
  category          text,                                 -- 'Bedframe' | 'Fabric' | 'Hardware' | ...
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
  statement_type    text NOT NULL DEFAULT 'OPEN_ITEM',    -- OPEN_ITEM | BALANCE_FORWARD | NO_STATEMENT
  aging_basis       text NOT NULL DEFAULT 'INVOICE_DATE', -- INVOICE_DATE | DUE_DATE
  credit_limit_sen  integer NOT NULL DEFAULT 0,           -- 0 = unlimited
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ── scm_supplier_material_bindings — material<->supplier price mapping ───
CREATE TABLE IF NOT EXISTS scm_supplier_material_bindings (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id            uuid NOT NULL REFERENCES scm_suppliers(id) ON DELETE CASCADE,
  material_kind          text NOT NULL
                           CHECK (material_kind IN ('mfg_product','fabric','raw')),
  material_code          text NOT NULL,                   -- OUR internal code ('1003-(K)','AVANI 01')
  material_name          text NOT NULL,                   -- snapshot for the binding row
  supplier_sku           text NOT NULL,                   -- the SUPPLIER's own SKU
  unit_price_centi       integer NOT NULL DEFAULT 0,      -- x100; works for MYR + RMB
  currency               text NOT NULL DEFAULT 'MYR',
  lead_time_days         integer NOT NULL DEFAULT 0,
  payment_terms_override text,                            -- overrides supplier.payment_terms if set
  moq                    integer NOT NULL DEFAULT 0,      -- min order quantity
  price_valid_from       date,
  price_valid_to         date,
  is_main_supplier       boolean NOT NULL DEFAULT false,  -- exactly one per material (app-enforced)
  notes                  text,
  -- per-category cost matrix (mirrors 2990s Products Maintenance shape):
  --   SOFA:     {"24":{"P1":n,"P2":n,"P3":n}, "26":{...}, ...} centi per (seat-height x tier)
  --   BEDFRAME: {"P1":n,"P2":n} centi per upholstery tier
  --   else:     NULL (single price flows through unit_price_centi)
  price_matrix           jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scm_smb_supplier
  ON scm_supplier_material_bindings (supplier_id);
CREATE INDEX IF NOT EXISTS idx_scm_smb_material
  ON scm_supplier_material_bindings (material_kind, material_code);
-- one "main supplier" per material (partial index documents the rule; the
-- app enforces single-main on write)
CREATE INDEX IF NOT EXISTS idx_scm_smb_main_per_material
  ON scm_supplier_material_bindings (material_kind, material_code)
  WHERE is_main_supplier = true;
