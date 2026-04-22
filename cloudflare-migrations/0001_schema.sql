-- Houzs ERP — Sales module schema
-- Mirrors TypeScript types in src/lib/so-store.ts and src/lib/sku-costing-store.ts

-- ── SKU Master ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skus (
  id            TEXT PRIMARY KEY,
  item_code     TEXT NOT NULL UNIQUE,
  description   TEXT NOT NULL,
  item_group    TEXT NOT NULL,              -- MATTRESS / BEDFRAME / SOFA / ACC / BEDLINES / DINING / CARPET / DIFFUSER / TRANS / OTHER
  uom           TEXT NOT NULL DEFAULT 'UNIT',
  supplier      TEXT,
  bar_code      TEXT,
  cost_price    REAL NOT NULL DEFAULT 0,
  selling_price REAL NOT NULL DEFAULT 0,
  brand         TEXT NOT NULL DEFAULT 'OTHER',
  last_updated  TEXT NOT NULL,              -- ISO datetime
  notes         TEXT
);
CREATE INDEX IF NOT EXISTS idx_skus_item_group ON skus(item_group);
CREATE INDEX IF NOT EXISTS idx_skus_brand      ON skus(brand);
CREATE INDEX IF NOT EXISTS idx_skus_supplier   ON skus(supplier);

-- ── SO Headers (341 from Excel + new SOs created via New SO modal) ───────────
CREATE TABLE IF NOT EXISTS so_headers (
  doc_no                TEXT PRIMARY KEY,
  transfer_to           TEXT,
  date                  TEXT NOT NULL,       -- ISO date
  branding              TEXT,
  debtor_name           TEXT NOT NULL,
  agent                 TEXT,
  sales_location        TEXT,
  ref                   TEXT,
  local_total           REAL NOT NULL DEFAULT 0,
  mattress_sofa         REAL NOT NULL DEFAULT 0,
  bedframe              REAL NOT NULL DEFAULT 0,
  accessories           REAL NOT NULL DEFAULT 0,
  others                REAL NOT NULL DEFAULT 0,
  balance               REAL NOT NULL DEFAULT 0,
  remark2               TEXT,
  remark4               TEXT,
  remark3               TEXT,
  processing_date       TEXT,
  sales_exemption_expiry TEXT,
  note                  TEXT,
  po_doc_no             TEXT,
  address1              TEXT,
  address2              TEXT,
  address3              TEXT,
  address4              TEXT,
  phone                 TEXT,
  venue                 TEXT,
  total_cost            REAL NOT NULL DEFAULT 0,
  total_revenue         REAL NOT NULL DEFAULT 0,
  total_margin          REAL NOT NULL DEFAULT 0,
  margin_pct            REAL NOT NULL DEFAULT 0,
  line_count            INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_so_headers_date     ON so_headers(date);
CREATE INDEX IF NOT EXISTS idx_so_headers_venue    ON so_headers(venue);
CREATE INDEX IF NOT EXISTS idx_so_headers_branding ON so_headers(branding);
CREATE INDEX IF NOT EXISTS idx_so_headers_agent    ON so_headers(agent);

-- ── SO Lines (1,654 from Excel + new lines via New SO modal) ─────────────────
CREATE TABLE IF NOT EXISTS so_lines (
  id              TEXT PRIMARY KEY,
  doc_no          TEXT NOT NULL,
  date            TEXT NOT NULL,
  debtor_code     TEXT,
  debtor_name     TEXT,
  agent           TEXT,
  item_group      TEXT NOT NULL,
  item_code       TEXT NOT NULL,
  description     TEXT,
  description2    TEXT,
  uom             TEXT NOT NULL DEFAULT 'UNIT',
  location        TEXT,
  qty             INTEGER NOT NULL DEFAULT 1,
  unit_price      REAL NOT NULL DEFAULT 0,
  discount        REAL NOT NULL DEFAULT 0,
  total           REAL NOT NULL DEFAULT 0,
  tax             REAL NOT NULL DEFAULT 0,
  total_inc       REAL NOT NULL DEFAULT 0,
  balance         REAL NOT NULL DEFAULT 0,
  payment_status  TEXT NOT NULL DEFAULT 'Unchecked',
  venue           TEXT,
  branding        TEXT,
  remark          TEXT,
  cancelled       INTEGER NOT NULL DEFAULT 0,
  -- Variants (JSON column — { fabric, gap, divanHeight, legHeight, ... })
  variants        TEXT,  -- JSON string or NULL
  -- Derived costing (recomputed on edit — sku cost + variant surcharges)
  unit_cost       REAL NOT NULL DEFAULT 0,
  line_cost       REAL NOT NULL DEFAULT 0,
  line_margin     REAL NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (doc_no)    REFERENCES so_headers(doc_no) ON DELETE CASCADE,
  FOREIGN KEY (item_code) REFERENCES skus(item_code)    ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_so_lines_doc_no     ON so_lines(doc_no);
CREATE INDEX IF NOT EXISTS idx_so_lines_item_code  ON so_lines(item_code);
CREATE INDEX IF NOT EXISTS idx_so_lines_item_group ON so_lines(item_group);
CREATE INDEX IF NOT EXISTS idx_so_lines_date       ON so_lines(date);

-- ── Payments (against a SO) ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS so_payments (
  id            TEXT PRIMARY KEY,
  doc_no        TEXT NOT NULL,
  date          TEXT NOT NULL,
  method        TEXT NOT NULL,        -- CASH / MBB / VISA / MASTER / CREDIT CARD / EPP / ONLINE / TNG / DUITNOW / OTHER
  amount        REAL NOT NULL DEFAULT 0,
  account_sheet TEXT,
  approval_code TEXT,
  collected_by  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (doc_no) REFERENCES so_headers(doc_no) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_so_payments_doc_no ON so_payments(doc_no);
CREATE INDEX IF NOT EXISTS idx_so_payments_date   ON so_payments(date);

-- ── Variant Maintenance (single-row JSON blob) ───────────────────────────────
CREATE TABLE IF NOT EXISTS variants_config (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  config     TEXT NOT NULL,  -- JSON { divanHeights, legHeights, totalHeights, gaps, specials, sofaLegHeights, sofaSpecials, sofaSizes }
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Fabrics ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fabrics (
  id           TEXT PRIMARY KEY,
  fabric_code  TEXT NOT NULL UNIQUE,
  price_tier   TEXT NOT NULL,        -- PRICE_1 / PRICE_2
  price        REAL NOT NULL DEFAULT 0,
  description  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fabrics_price_tier ON fabrics(price_tier);
