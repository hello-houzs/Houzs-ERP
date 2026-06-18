-- ----------------------------------------------------------------------------
-- 0033 — PRODUCTS & MAINTENANCE (slice #58). FULL clone of 2990s's furniture
-- catalogue + pricing engine tables (owner: "全部搬,办完了我再修改" — clone it
-- all, modify later). UNLIKE the doc-flow slices, the furniture engine is NOT
-- stripped here — every catalog/pricing column transfers.
--
-- Source: 2990s packages/db/src/schema.ts (retail-catalog block lines ~226-498,
-- mfg block ~1844-2282) cross-checked against the LIVE routes (products.ts,
-- mfg-products.ts, product-models.ts, categories.ts, fabric-tracking.ts,
-- fabric-library.ts, fabric-tier-addon.ts, maintenance-config.ts, pwp-codes.ts)
-- — routes are the source of truth where schema.ts is stale.
--
-- All table names are BARE — verified no collision with Houzs schema.pg.ts
-- (grep over products/categories/series/fabric_*/product_models/mfg_products/
-- sofa_combo_pricing/pwp_*/maintenance_config*/size_library/compartment_library/
-- bundle_library/bedframe_*/master_price_history/product_dept_configs returned 0).
--
-- Runner contract (backend/scripts/pg-migrate.mjs): split on /;\s*\n/, each stmt
-- via tx.unsafe inside ONE transaction. So: NO BEGIN/COMMIT; every stmt
-- idempotent (CREATE ... IF NOT EXISTS / ON CONFLICT DO NOTHING); enums guarded
-- with a SINGLE-PHYSICAL-LINE DO block (no internal ;\n so the split can't
-- shatter it). Enum names + values EXACTLY 2990s's pgEnum(...) definitions.
--
-- SEAMS vs 2990s (canonical clone rules — same as every slice):
--   - staff.id (uuid) refs -> Houzs users.id INTEGER soft-refs (created_by /
--     updated_by / changed_by columns are integer, NO FK to users).
--   - customer_id -> FK customers(id) (cloned in 0029); supplier_id -> FK
--     suppliers(id) (cloned in 0024); product_models / mfg_products intra-refs
--     are real FKs within this migration.
--   - RLS policies + SECURITY DEFINER fns + R2 hooks DROPPED (route gated by
--     requirePermission("*"); Drizzle-over-Hyperdrive, no Supabase roles).
--   - money kept verbatim: retail catalogue = whole-MYR integers, ERP/mfg layer
--     = integer *_centi / *_sen columns.
-- ----------------------------------------------------------------------------

-- ── Enums ────────────────────────────────────────────────────────────────
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pricing_kind') THEN CREATE TYPE pricing_kind AS ENUM ('size_variants','sofa_build','bedframe_build','flat','tbc'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'comp_group') THEN CREATE TYPE comp_group AS ENUM ('1-seater','2-seater','Corner','L-Shape','Accessory'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'mfg_product_category') THEN CREATE TYPE mfg_product_category AS ENUM ('SOFA','BEDFRAME','ACCESSORY','MATTRESS','SERVICE'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'mfg_product_status') THEN CREATE TYPE mfg_product_status AS ENUM ('ACTIVE','INACTIVE'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'fabric_category') THEN CREATE TYPE fabric_category AS ENUM ('B.M-FABR','S-FABR','S.M-FABR','LINING','WEBBING'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'fabric_price_tier') THEN CREATE TYPE fabric_price_tier AS ENUM ('PRICE_1','PRICE_2','PRICE_3'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'addon_kind') THEN CREATE TYPE addon_kind AS ENUM ('qty','floors_items','flat'); END IF; END $$;

-- ── Library tables (retail catalogue) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS categories (
  id             text PRIMARY KEY,
  label          text NOT NULL,
  icon           text NOT NULL,
  tbc            boolean NOT NULL DEFAULT false,
  hero_image_key text,
  sort_order     integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS series (
  id     text PRIMARY KEY,
  label  text NOT NULL,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS compartment_library (
  id            text PRIMARY KEY,
  comp_group    comp_group NOT NULL,
  label         text NOT NULL,
  width_cm      integer NOT NULL,
  depth_cm      integer NOT NULL,
  cushions      integer NOT NULL DEFAULT 1,
  default_price integer NOT NULL,
  art_filename  text,
  is_accessory  boolean NOT NULL DEFAULT false,
  sort_order    integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bundle_library (
  id            text PRIMARY KEY,
  label         text NOT NULL,
  sub           text NOT NULL,
  signature     text NOT NULL,
  base_width_cm integer NOT NULL,
  base_depth_cm integer NOT NULL,
  cushions      integer NOT NULL,
  default_price integer NOT NULL,
  art_left      text,
  art_right     text,
  art_base      text,
  sort_order    integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS size_library (
  id         text PRIMARY KEY,
  label      text NOT NULL,
  width_cm   integer NOT NULL,
  length_cm  integer NOT NULL,
  sort_order integer NOT NULL DEFAULT 0
);

-- ── Products (retail SKU master) ─────────────────────────────────────────
-- category_id / series_id -> library FKs (kept). updated_by -> users.id integer
-- soft-ref (staff seam). supplier_id -> FK suppliers(id) (cloned in 0024).
CREATE TABLE IF NOT EXISTS products (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku                    text NOT NULL UNIQUE,
  category_id            text NOT NULL REFERENCES categories(id),
  series_id              text REFERENCES series(id),
  pricing_kind           pricing_kind NOT NULL DEFAULT 'tbc',
  name                   text NOT NULL,
  model_code             text,
  detail                 text,
  size_display           text,
  img_key                text,
  thumb_key              text,
  stock                  integer NOT NULL DEFAULT 0,
  low_at                 integer NOT NULL DEFAULT 5,
  visible                boolean NOT NULL DEFAULT true,
  flat_price             integer,
  recliner_upgrade_price integer,
  seat_upgrade_label     text,
  seat_upgrade_footrest  boolean NOT NULL DEFAULT true,
  depth_options          text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             integer,
  supplier_id            uuid REFERENCES suppliers(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_products_visible ON products (visible) WHERE visible = TRUE;
CREATE INDEX IF NOT EXISTS idx_products_category ON products (category_id);

-- ── Per-product pricing (composite-PK, UPSERT-friendly) ──────────────────
CREATE TABLE IF NOT EXISTS product_size_variants (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size_id    text NOT NULL REFERENCES size_library(id),
  active     boolean NOT NULL DEFAULT true,
  price      integer NOT NULL,
  PRIMARY KEY (product_id, size_id)
);

CREATE TABLE IF NOT EXISTS product_compartments (
  product_id     uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  compartment_id text NOT NULL REFERENCES compartment_library(id),
  active         boolean NOT NULL DEFAULT true,
  price          integer NOT NULL,
  PRIMARY KEY (product_id, compartment_id)
);

CREATE TABLE IF NOT EXISTS product_bundles (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  bundle_id  text NOT NULL REFERENCES bundle_library(id),
  active     boolean NOT NULL DEFAULT true,
  price      integer NOT NULL,
  PRIMARY KEY (product_id, bundle_id)
);

-- ── Sofa fabric & colour (retail) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fabric_library (
  id                text PRIMARY KEY,
  label             text NOT NULL,
  tier              text NOT NULL DEFAULT 'standard',
  default_surcharge integer NOT NULL DEFAULT 0,
  swatch_key        text,
  active            boolean NOT NULL DEFAULT true,
  sort_order        integer NOT NULL DEFAULT 0,
  sofa_tier         text,
  bedframe_tier     text,
  fabric_code       text
);

CREATE TABLE IF NOT EXISTS fabric_colours (
  fabric_id  text NOT NULL REFERENCES fabric_library(id) ON DELETE CASCADE,
  colour_id  text NOT NULL,
  label      text NOT NULL,
  swatch_hex text,
  swatch_key text,
  active     boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY (fabric_id, colour_id)
);

CREATE TABLE IF NOT EXISTS product_fabrics (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  fabric_id  text NOT NULL REFERENCES fabric_library(id),
  active     boolean NOT NULL DEFAULT true,
  surcharge  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, fabric_id)
);

-- Singleton (id=1) — POS selling fabric-tier add-on. updated_by -> users.id int.
CREATE TABLE IF NOT EXISTS fabric_tier_addon_config (
  id                   integer PRIMARY KEY DEFAULT 1,
  sofa_tier2_delta     integer NOT NULL DEFAULT 0,
  sofa_tier3_delta     integer NOT NULL DEFAULT 0,
  bedframe_tier2_delta integer NOT NULL DEFAULT 0,
  bedframe_tier3_delta integer NOT NULL DEFAULT 0,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           integer
);
INSERT INTO fabric_tier_addon_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── Bedframe configurator (retail) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS bedframe_colours (
  id         text PRIMARY KEY,
  label      text NOT NULL,
  swatch_hex text,
  surcharge  integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS product_bedframe_colours (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  colour_id  text NOT NULL REFERENCES bedframe_colours(id),
  active     boolean NOT NULL DEFAULT true,
  PRIMARY KEY (product_id, colour_id)
);

CREATE TABLE IF NOT EXISTS bedframe_options (
  id         text PRIMARY KEY,
  kind       text NOT NULL,
  value      text NOT NULL,
  surcharge  integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_bedframe_options_kind ON bedframe_options (kind);

-- ── Add-ons + special add-ons (Maintenance UI) ───────────────────────────
-- created_by -> users.id integer soft-ref (staff seam).
CREATE TABLE IF NOT EXISTS addons (
  id              text PRIMARY KEY,
  label           text NOT NULL,
  description     text,
  icon            text NOT NULL,
  kind            addon_kind NOT NULL,
  price           integer NOT NULL,
  per_floor_item  integer,
  unit            text,
  default_qty     integer NOT NULL DEFAULT 1,
  stock           integer,
  enabled         boolean NOT NULL DEFAULT true,
  show_at_handover boolean NOT NULL DEFAULT false,
  service_sku     text,
  sort_order      integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS special_addons (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text NOT NULL UNIQUE,
  label             text NOT NULL,
  so_description    text NOT NULL DEFAULT '',
  categories        text[] NOT NULL DEFAULT '{}'::text[],
  selling_price_sen integer NOT NULL DEFAULT 0,
  cost_price_sen    integer NOT NULL DEFAULT 0,
  option_groups     jsonb NOT NULL DEFAULT '[]'::jsonb,
  active            boolean NOT NULL DEFAULT true,
  sort_order        integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        integer
);

-- ── product_models (template / second-layer, PR #49) ─────────────────────
CREATE TABLE IF NOT EXISTS product_models (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branding        text,
  model_code      text NOT NULL,
  name            text NOT NULL,
  category        mfg_product_category NOT NULL,
  description     text,
  photo_url       text,
  allowed_options jsonb NOT NULL DEFAULT '{}'::jsonb,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS product_models_code_category_unique ON product_models (model_code, category);
CREATE INDEX IF NOT EXISTS idx_product_models_category ON product_models (category);

-- ── mfg_products (manufacturer SKU master) ───────────────────────────────
-- retail_product_id -> FK products(id); model_id -> FK product_models(id).
CREATE TABLE IF NOT EXISTS mfg_products (
  id                      text PRIMARY KEY,
  code                    text NOT NULL,
  name                    text NOT NULL,
  category                mfg_product_category NOT NULL,
  description             text,
  base_model              text,
  size_code               text,
  size_label              text,
  fabric_usage_centi      integer NOT NULL DEFAULT 0,
  unit_m3_milli           integer NOT NULL DEFAULT 0,
  status                  mfg_product_status NOT NULL DEFAULT 'ACTIVE',
  cost_price_sen          integer NOT NULL DEFAULT 0,
  base_price_sen          integer,
  price1_sen              integer,
  sell_price_sen          integer,
  pwp_price_sen           integer NOT NULL DEFAULT 0,
  pos_active              boolean NOT NULL DEFAULT true,
  included_addons         jsonb NOT NULL DEFAULT '[]'::jsonb,
  default_free_gifts      jsonb NOT NULL DEFAULT '[]'::jsonb,
  production_time_minutes  integer NOT NULL DEFAULT 0,
  sub_assemblies          jsonb,
  sku_code                text,
  fabric_color            text,
  branding                text,
  barcode                 text,
  one_shot                boolean NOT NULL DEFAULT false,
  source_doc_no           text,
  pieces                  jsonb,
  seat_height_prices      jsonb,
  default_variants        jsonb,
  retail_product_id       uuid REFERENCES products(id) ON DELETE SET NULL,
  model_id                uuid REFERENCES product_models(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mfg_products_code ON mfg_products (code);
CREATE INDEX IF NOT EXISTS idx_mfg_products_category ON mfg_products (category);
CREATE INDEX IF NOT EXISTS idx_mfg_products_base_model ON mfg_products (base_model);
CREATE INDEX IF NOT EXISTS idx_mfg_products_model_id ON mfg_products (model_id);

-- ── product_dept_configs (per-SKU production working times) ───────────────
CREATE TABLE IF NOT EXISTS product_dept_configs (
  product_code            text PRIMARY KEY,
  unit_m3_milli           integer NOT NULL DEFAULT 0,
  fabric_usage_centi      integer NOT NULL DEFAULT 0,
  price2_sen              integer NOT NULL DEFAULT 0,
  fab_cut_category        text,
  fab_cut_minutes         integer,
  fab_sew_category        text,
  fab_sew_minutes         integer,
  wood_cut_category       text,
  wood_cut_minutes        integer,
  foam_category           text,
  foam_minutes            integer,
  framing_category        text,
  framing_minutes         integer,
  upholstery_category     text,
  upholstery_minutes      integer,
  packing_category        text,
  packing_minutes         integer,
  sub_assemblies          jsonb,
  heights_sub_assemblies  jsonb
);

-- ── master_price_history (per-SKU price audit) ───────────────────────────
-- changed_by -> users.id integer soft-ref (staff seam).
CREATE TABLE IF NOT EXISTS master_price_history (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_code text NOT NULL,
  field        text NOT NULL,
  old_value_sen integer,
  new_value_sen integer,
  reason       text,
  changed_at   timestamptz NOT NULL DEFAULT now(),
  changed_by   integer
);
CREATE INDEX IF NOT EXISTS idx_master_price_history_code ON master_price_history (product_code);

-- ── sofa_combo_pricing (append-only effective-dated combo deals) ──────────
-- customer_id -> FK customers(id); supplier_id -> FK suppliers(id); created_by
-- -> users.id integer soft-ref.
CREATE TABLE IF NOT EXISTS sofa_combo_pricing (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base_model              text NOT NULL,
  modules                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  tier                    fabric_price_tier,
  customer_id             uuid REFERENCES customers(id) ON DELETE SET NULL,
  supplier_id             uuid REFERENCES suppliers(id) ON DELETE CASCADE,
  prices_by_height        jsonb NOT NULL DEFAULT '{}'::jsonb,
  selling_prices_by_height jsonb NOT NULL DEFAULT '{}'::jsonb,
  pwp_prices_by_height    jsonb NOT NULL DEFAULT '{}'::jsonb,
  default_free_gifts      jsonb NOT NULL DEFAULT '[]'::jsonb,
  label                   text,
  effective_from          date NOT NULL,
  deleted_at              timestamptz,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  created_by              integer
);
CREATE INDEX IF NOT EXISTS idx_sofa_combo_pricing_lookup ON sofa_combo_pricing (base_model, tier, customer_id, supplier_id, effective_from);
CREATE INDEX IF NOT EXISTS idx_sofa_combo_pricing_history ON sofa_combo_pricing (base_model, tier, customer_id, supplier_id, effective_from, created_at);
CREATE INDEX IF NOT EXISTS idx_sofa_combo_pricing_supplier ON sofa_combo_pricing (supplier_id);

-- ── pwp_rules / pwp_codes (换购 voucher system) ───────────────────────────
-- created_by / owner_staff_id -> users.id integer soft-ref; customer_id -> FK.
CREATE TABLE IF NOT EXISTS pwp_rules (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_category           mfg_product_category NOT NULL,
  trigger_eligible_model_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  reward_category            mfg_product_category NOT NULL,
  eligible_reward_model_ids  jsonb NOT NULL DEFAULT '[]'::jsonb,
  trigger_combo_ids          jsonb NOT NULL DEFAULT '[]'::jsonb,
  reward_combo_ids           jsonb NOT NULL DEFAULT '[]'::jsonb,
  qty_per_trigger            integer NOT NULL DEFAULT 1,
  type                       text NOT NULL DEFAULT 'pwp',
  active                     boolean NOT NULL DEFAULT true,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  created_by                 integer
);

CREATE TABLE IF NOT EXISTS pwp_codes (
  code                    text PRIMARY KEY,
  rule_id                 uuid REFERENCES pwp_rules(id) ON DELETE SET NULL,
  reward_category         mfg_product_category NOT NULL,
  eligible_reward_model_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  reward_combo_ids        jsonb NOT NULL DEFAULT '[]'::jsonb,
  type                    text NOT NULL DEFAULT 'pwp',
  status                  text NOT NULL DEFAULT 'RESERVED',
  owner_staff_id          integer,
  cart_line_key           text,
  trigger_item_code       text,
  source_doc_no           text,
  redeemed_doc_no         text,
  redeemed_item_code      text,
  customer_id             uuid REFERENCES customers(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pwp_codes_owner_status ON pwp_codes (owner_staff_id, status);
CREATE INDEX IF NOT EXISTS idx_pwp_codes_cart_line ON pwp_codes (cart_line_key);
CREATE INDEX IF NOT EXISTS idx_pwp_codes_source_doc ON pwp_codes (source_doc_no);

-- ── fabrics + fabric_trackings (Fabric Converter cost ledger) ────────────
CREATE TABLE IF NOT EXISTS fabrics (
  id                  text PRIMARY KEY,
  code                text NOT NULL UNIQUE,
  name                text NOT NULL,
  category            text,
  price_sen           integer NOT NULL DEFAULT 0,
  soh_meters_centi    integer NOT NULL DEFAULT 0,
  reorder_level_centi integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS fabric_trackings (
  id                     text PRIMARY KEY,
  fabric_code            text NOT NULL,
  fabric_description     text,
  fabric_category        fabric_category,
  price_tier             fabric_price_tier,
  sofa_price_tier        fabric_price_tier,
  bedframe_price_tier    fabric_price_tier,
  price_centi            integer NOT NULL DEFAULT 0,
  soh_centi              integer NOT NULL DEFAULT 0,
  po_outstanding_centi   integer NOT NULL DEFAULT 0,
  last_month_usage_centi integer NOT NULL DEFAULT 0,
  one_week_usage_centi   integer NOT NULL DEFAULT 0,
  two_weeks_usage_centi  integer NOT NULL DEFAULT 0,
  one_month_usage_centi  integer NOT NULL DEFAULT 0,
  shortage_centi         integer NOT NULL DEFAULT 0,
  reorder_point_centi    integer NOT NULL DEFAULT 0,
  supplier               text,
  supplier_code          text,
  lead_time_days         integer NOT NULL DEFAULT 0,
  series                 text,
  is_active              boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_fabric_trackings_code ON fabric_trackings (fabric_code);
CREATE INDEX IF NOT EXISTS idx_fabric_trackings_tier ON fabric_trackings (price_tier);
CREATE INDEX IF NOT EXISTS idx_fabric_trackings_series ON fabric_trackings (series) WHERE series IS NOT NULL;

-- ── maintenance_config_history (variant config, effective-dated) ─────────
-- created_by -> users.id integer soft-ref. CANONICAL name is
-- maintenance_config_history (12 route call-sites + the 2990s migration 0039
-- CREATE); the lone `maintenance_config` ref in product-models.ts:409 is a
-- 2990s route bug (queries a non-existent table inside a try/catch that falls
-- back to static SIZE_INFO) — the Houzs clone queries this canonical table.
CREATE TABLE IF NOT EXISTS maintenance_config_history (
  id             text PRIMARY KEY,
  scope          text NOT NULL,
  config         jsonb NOT NULL,
  effective_from date NOT NULL,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     integer
);
CREATE INDEX IF NOT EXISTS idx_mch_scope_eff ON maintenance_config_history (scope, effective_from);

-- ── Per-Model overrides (special delivery fee / fabric tier / free gifts) ──
-- updated_by -> users.id integer soft-ref. model_id -> FK product_models(id).
CREATE TABLE IF NOT EXISTS model_special_delivery_fees (
  model_id                uuid PRIMARY KEY REFERENCES product_models(id) ON DELETE CASCADE,
  standalone_fee          integer NOT NULL DEFAULT 0,
  cross_cat_followup_fee  integer NOT NULL DEFAULT 0,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              integer
);

CREATE TABLE IF NOT EXISTS model_fabric_tier_overrides (
  model_id    uuid PRIMARY KEY REFERENCES product_models(id) ON DELETE CASCADE,
  tier2_delta integer,
  tier3_delta integer,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  integer
);

CREATE TABLE IF NOT EXISTS model_default_free_gifts (
  model_id   uuid PRIMARY KEY REFERENCES product_models(id) ON DELETE CASCADE,
  gifts      jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer
);

-- ── sofa_quick_picks (global saved sofa layouts) ─────────────────────────
-- created_by -> users.id integer soft-ref.
CREATE TABLE IF NOT EXISTS sofa_quick_picks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base_model text NOT NULL,
  label      text,
  modules    jsonb NOT NULL DEFAULT '[]'::jsonb,
  depth      text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer
);
CREATE INDEX IF NOT EXISTS idx_sofa_quick_picks_lookup ON sofa_quick_picks (base_model, sort_order) WHERE deleted_at IS NULL;
