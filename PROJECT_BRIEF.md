# AutoCount Sync — Web App (Simplified)

## 1. Overview

A web dashboard that syncs with AutoCount accounting software via an existing .NET middleware API. Replaces a Google Sheets + Apps Script system.

**Stack**: Cloudflare Workers (Hono) + D1 + React
**The .NET middleware API stays as-is.** We only build the web layer.

---

## 2. Infrastructure

- **D1 Database**: `autocount-sync` / ID: `55dde3d6-01f0-47e3-acf0-01c8bd5753fd` / Region: APAC
- **Secrets** (via `wrangler secret put`): `AUTOCOUNT_API_KEY`, `DASHBOARD_API_KEY`

```toml
name = "autocount-sync-api"
main = "src/index.ts"
compatibility_date = "2024-12-01"

[vars]
AUTOCOUNT_API_URL = "https://YOUR_NGROK_URL"

[[d1_databases]]
binding = "DB"
database_name = "autocount-sync"
database_id = "55dde3d6-01f0-47e3-acf0-01c8bd5753fd"

[triggers]
crons = [
  "*/5 * * * *",  # Pull new orders from AutoCount
  "0 2 * * *"     # Daily overdue detection
]
```

---

## 3. What Changed from the Old System

The old Google Sheets system had a lot of complexity that existed only because of Sheets limitations. Here's what we stripped:

| Removed | Why |
|---------|-----|
| `balance_collection` table | Just query `sales_orders WHERE balance > 0`. No need to copy data into a separate table. |
| `transporter_fields` table | Fold into `order_details`. One table for all editable fields. |
| `delivery_message_status` field | Was a copy of `remark4`. One field now — user edits `remark4` directly. |
| Column A → P auto-copy | Sheets workaround. Gone. |
| Column Q → O auto-copy | Sheets workaround. User edits `expiry_date` directly via a date picker. |
| PENDING sync status | Push is real-time. Status is either SYNCED or ERROR. No queue. |
| Block 1/2/3 write logic | Sheets column layout hack. Database columns now. |
| Spacer columns | Visual hack. Irrelevant. |
| PO overdue_days backup/restore | Use `UPDATE ... SET` that skips `overdue_days`. |
| EM Transporter spreadsheet sync | Transporter team uses the same dashboard with a filtered view. |
| YYYY/MM/DD string validation | Use proper date inputs. Store ISO dates (`YYYY-MM-DD`). |
| `Attention` field in UI | Always `"SEAMPIFY"`. Hardcode in push payload. Hide from UI. |

---

## 4. Database Schema (Simplified)

**Drop the old schema and re-create.** Run:
```bash
wrangler d1 execute autocount-sync --file=./src/db/schema.sql
```

### 6 tables (down from 8):

```sql
-- ═══════════════════════════════════════
-- Core order data from AutoCount API
-- ═══════════════════════════════════════
DROP TABLE IF EXISTS sales_orders;
CREATE TABLE sales_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT UNIQUE NOT NULL,
  region TEXT NOT NULL CHECK(region IN ('WEST','EAST','SG')),
  transfer_to TEXT,
  doc_date TEXT,
  ref TEXT,
  branding TEXT,
  debtor_name TEXT,
  phone TEXT,
  sales_location TEXT,
  sales_agent TEXT,
  local_total REAL DEFAULT 0,
  balance REAL DEFAULT 0,
  remark2 TEXT,
  remark3 TEXT,
  remark4 TEXT,
  processing_date TEXT,
  expiry_date TEXT,
  note TEXT,
  po_doc_no TEXT,
  inv_addr1 TEXT,
  inv_addr2 TEXT,
  inv_addr3 TEXT,
  inv_addr4 TEXT,
  venue TEXT,
  sync_status TEXT DEFAULT 'SYNCED' CHECK(sync_status IN ('SYNCED','ERROR')),
  sync_error TEXT,
  last_modified TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════
-- All editable fields (manual + transporter)
-- One row per order. Covers all regions.
-- ═══════════════════════════════════════
DROP TABLE IF EXISTS order_details;
CREATE TABLE order_details (
  doc_no TEXT PRIMARY KEY,
  -- Delivery logistics (all regions)
  delivery_date TEXT,
  time_range TEXT,
  time_confirmed TEXT,
  lorry_plate TEXT,
  driver_name TEXT,
  driver_contact TEXT,
  days_left TEXT,
  internal_purchasing TEXT,
  -- West/SG specific
  property_type TEXT,
  new_house_replacement TEXT,
  -- East specific
  item_details TEXT,
  done_delivery TEXT,
  consignment_no TEXT,
  -- East: transporter fields
  eta_port TEXT,
  estimate_delivery TEXT,
  m3 TEXT,
  vessel_voyage TEXT,
  etd_port_klang TEXT,
  eta_destination TEXT,
  transporter_remarks TEXT,
  -- East: financials
  seafreight REAL,
  local_charges REAL,
  inland REAL,
  agent_fee REAL,
  insurance REAL,
  total_cost REAL,
  -- SG specific
  shipout_date TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (doc_no) REFERENCES sales_orders(doc_no)
);

-- ═══════════════════════════════════════
-- Outstanding PO line items
-- ═══════════════════════════════════════
DROP TABLE IF EXISTS purchase_orders;
CREATE TABLE purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT NOT NULL,
  so_doc_no TEXT,
  creditor_code TEXT,
  creditor_name TEXT,
  item_code TEXT NOT NULL,
  item_description TEXT,
  location TEXT,
  doc_date TEXT,
  remaining_qty REAL,
  delivery_date TEXT,
  supplier_date1 TEXT,
  supplier_date2 TEXT,
  supplier_date3 TEXT,
  overdue_days TEXT,       -- manual, never overwritten by pull
  UNIQUE(doc_no, item_code)
);

-- ═══════════════════════════════════════
-- ASSR cases
-- ═══════════════════════════════════════
DROP TABLE IF EXISTS assr_cases;
CREATE TABLE assr_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assr_no TEXT UNIQUE NOT NULL,  -- ASSR/YYMM-NNN
  status TEXT DEFAULT 'Open',
  doc_no TEXT NOT NULL,
  complained_date TEXT,
  customer_name TEXT,
  phone TEXT,
  location TEXT,
  sales_agent TEXT,
  item_code TEXT,
  complaint_issue TEXT,
  action_remark TEXT,
  service_category TEXT,
  supplier TEXT,
  completion_date TEXT,
  po_no TEXT,
  addr1 TEXT,
  addr2 TEXT,
  addr3 TEXT,
  addr4 TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════
-- Overdue history (append-only audit log)
-- ═══════════════════════════════════════
DROP TABLE IF EXISTS overdue_history;
CREATE TABLE overdue_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pull_date TEXT NOT NULL,
  doc_no TEXT NOT NULL,
  debtor_name TEXT,
  phone TEXT,
  location TEXT,
  balance REAL,
  original_expiry_date TEXT,
  extended_to TEXT
);

-- ═══════════════════════════════════════
-- Execution logs
-- ═══════════════════════════════════════
DROP TABLE IF EXISTS execution_logs;
CREATE TABLE execution_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  type TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('SYNCED','FAILED','SKIPPED')),
  message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════
-- System settings (key-value)
-- ═══════════════════════════════════════
DROP TABLE IF EXISTS system_settings;
CREATE TABLE system_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
INSERT OR IGNORE INTO system_settings VALUES ('pull_checkpoint', '2000-01-01 00:00:00');

-- ═══════════════════════════════════════
-- Indexes
-- ═══════════════════════════════════════
CREATE INDEX idx_so_region ON sales_orders(region);
CREATE INDEX idx_so_sync ON sales_orders(sync_status);
CREATE INDEX idx_so_balance ON sales_orders(balance);
CREATE INDEX idx_po_doc ON purchase_orders(doc_no);
CREATE INDEX idx_assr_status ON assr_cases(status);
CREATE INDEX idx_overdue_date ON overdue_history(pull_date);
```

---

## 5. AutoCount API Reference

**Headers for all requests:**
```
X-API-KEY: {AUTOCOUNT_API_KEY}
X-Request-ID: {crypto.randomUUID()}
ngrok-skip-browser-warning: true
```

### Endpoints

| Method | Path | Used For |
|--------|------|----------|
| GET | `/SalesOrder/getSince/{timestamp}` | Pull modified orders |
| GET | `/SalesOrder/getSingle/{docNo}` | ASSR case creation — fetch order context |
| GET | `/SalesOrder/getOverdue` | Daily overdue detection |
| PUT | `/SalesOrder/updateFromSheet` | Push edits back (real-time) |
| GET | `/PurchaseOrder/getOutstanding` | Pull PO list |
| PUT | `/PurchaseOrder/update-udf-dates` | Push PO dates |

### Push payload (`/SalesOrder/updateFromSheet`):
```json
{ "DocNo": "SO-00001", "Remark4": "DELIVERED", "Attention": "SEAMPIFY", "ExpiryDate": "2025-06-15" }
```
Note: `Attention` is always `"SEAMPIFY"`. Hardcode it.

### PO date payload (`/PurchaseOrder/update-udf-dates`):
```json
{ "docNo": "PO-00001", "POUDF_EDate": "2025-06-10", "POUDF_EDate2": null, "POUDF_EDate3": null }
```

### API response shape:
Returns arrays: `[{...}, {...}]`. Single-order endpoints also return arrays.

### Key field mappings:
| API Field | DB Column | Notes |
|-----------|-----------|-------|
| `Phone1` | `phone` | Strip `+`, `&`, `-`, spaces |
| `DocDate` | `doc_date` | Split on `T`, store date only |
| `SalesExemptionExpiryDate` | `expiry_date` | Split on `T` |
| `SOUDF_PDate` | `processing_date` | Split on `T` |
| `SOUDF_BALANCE` | `balance` | |
| `SOUDF_BRANDING` | `branding` | |
| `SOUDF_Note` | `note` | |
| `SOUDF_ToPONo` | `po_doc_no` | |
| `SOUDF_VENUE` | `venue` | |
| `InvAddr3` | `inv_addr3` | Used for SG routing |
| `LastModified` | `last_modified` | Used for checkpoint |

---

## 6. Backend API Routes

### Auth
All `/api/*` routes: `Authorization: Bearer {DASHBOARD_API_KEY}`. Crons bypass auth.

### Orders

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/orders` | List. Params: `region`, `status`, `search`, `page`, `per_page`. Joins `order_details`. |
| GET | `/api/orders/:docNo` | Single order + details. |
| PATCH | `/api/orders/:docNo` | Edit sync fields (`remark4`, `expiry_date`). **Immediately pushes to AutoCount.** Returns new `sync_status`. |
| PATCH | `/api/orders/:docNo/details` | Edit manual/transporter fields. Upserts `order_details`. No push unless `expiry_date` changed. |
| GET | `/api/orders/stats` | Counts by region, by status, total balance. |

### Sync

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/sync/pull` | On-demand pull from AutoCount. |
| POST | `/api/sync/retry-errors` | Re-push all ERROR rows. |
| GET | `/api/sync/status` | Last pull time, error count. |

### Balance (no separate table — query from sales_orders)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/balance` | Returns `sales_orders WHERE balance > 0 ORDER BY expiry_date ASC`. Params: `expiry_filter` (expired/warning/all), `search`, `page`, `per_page`. |

### Purchase Orders

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/po` | List. Params: `search`, `page`, `per_page`. |
| POST | `/api/po/pull` | Refresh from AutoCount. Preserves `overdue_days`. |
| PATCH | `/api/po/:docNo/:itemCode` | Edit `overdue_days`, supplier dates. |
| POST | `/api/po/:docNo/sync-dates` | Push dates to AutoCount immediately. |

### ASSR

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/assr` | List. Params: `status`, `search`, `page`, `per_page`. |
| POST | `/api/assr` | Create case. Body: `{ doc_no, item_code, complaint_issue }`. Auto-generates ASSR number, fetches context from AutoCount. |
| PATCH | `/api/assr/:assrNo` | Update case fields. |

### Overdue

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/overdue/run` | Manually trigger overdue check. |
| GET | `/api/overdue/history` | List history. Params: `page`, `per_page`. |

### Logs

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/logs` | List. Params: `type`, `status`, `page`, `per_page`. Most recent first. |

---

## 7. Business Logic

### Pull (cron every 5 min + on-demand)
1. Read checkpoint from `system_settings`.
2. `GET /SalesOrder/getSince/{checkpoint}`.
3. For each order: determine region (`InvAddr3` contains "SINGAPORE" → SG, `SalesLocation` KL/PG → WEST, SBH/SRW → EAST, else skip).
4. Clean phone (strip `+&- `), split dates on `T`.
5. Upsert into `sales_orders` (`INSERT ... ON CONFLICT(doc_no) DO UPDATE`). Set `sync_status = 'SYNCED'`.
6. Advance checkpoint only if ALL records succeed.

### Push (real-time, called from PATCH handlers)
1. Build payload: `{ DocNo, Remark4, Attention: "SEAMPIFY", ExpiryDate }`.
2. Normalize date: replace `/` with `-`.
3. `PUT /SalesOrder/updateFromSheet`.
4. HTTP 200 → `sync_status = 'SYNCED'`. Else → `sync_status = 'ERROR'`, store error.

### Overdue (daily cron)
1. `GET /SalesOrder/getOverdue`.
2. For each: push `ExpiryDate = today + 3 days` to AutoCount.
3. Append to `overdue_history` with original expiry date.

### PO Pull (on-demand)
1. `GET /PurchaseOrder/getOutstanding`.
2. Back up `overdue_days` by `doc_no + item_code` key.
3. Delete all PO rows. Insert fresh. Restore `overdue_days`.

### ASSR Creation
1. Generate next number: `ASSR/YYMM-NNN`. Query max for current month prefix, increment.
2. `GET /SalesOrder/getSingle/{docNo}` for context.
3. Insert case with auto-populated fields.

---

## 8. Cron Handlers

```typescript
export default {
  async scheduled(event, env, ctx) {
    if (event.cron === '*/5 * * * *') await pullSync(env);
    if (event.cron === '0 2 * * *') await overdueSync(env);
  }
};
```

Only 2 crons. Everything else is triggered by user actions.

---

## 9. Project Structure

```
autocount-sync/
├── wrangler.toml
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # Hono app + cron handler
│   ├── types.ts
│   ├── middleware/auth.ts
│   ├── routes/
│   │   ├── orders.ts
│   │   ├── po.ts
│   │   ├── assr.ts
│   │   ├── balance.ts
│   │   ├── overdue.ts
│   │   ├── sync.ts
│   │   ├── logs.ts
│   │   └── settings.ts
│   ├── services/
│   │   ├── autocount.ts      # API client
│   │   ├── pull.ts           # Pull logic
│   │   ├── push.ts           # Single-order real-time push
│   │   ├── overdue.ts        # Overdue detection
│   │   ├── po.ts             # PO pull + sync
│   │   ├── assr.ts           # Case creation
│   │   └── logger.ts         # Log writer
│   └── db/schema.sql
└── frontend/                 # Separate — see FRONTEND_PROMPT.md
```
