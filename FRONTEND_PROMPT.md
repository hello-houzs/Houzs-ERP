# Frontend Build Prompt — AutoCount Sync Dashboard

Build a **minimalist operations dashboard** in React. Clean, fast, no clutter.

---

## Stack

- React 18+ / TypeScript / Vite
- TailwindCSS (no component libraries — build from scratch)
- React Router v6
- Lucide React for icons
- Deploy target: Cloudflare Pages

---

## Design Philosophy

**Think Linear meets Notion.** Light, airy, calm. This is used all day by logistics staff — it should feel effortless, not overwhelming.

**Principles:**
- White space is a feature, not wasted space
- Data density where needed (tables), breathing room everywhere else
- Zero visual noise — no gradients, no shadows unless functional
- One accent color. Everything else is grayscale.
- Typography does the heavy lifting

**Color palette:**
```css
--bg:          #fafafa;
--surface:     #ffffff;
--border:      #e5e5e5;
--border-subtle: #f0f0f0;
--text:        #171717;
--text-secondary: #737373;
--text-muted:  #a3a3a3;
--accent:      #2563eb;       /* blue — links, primary buttons, active states */
--accent-soft: #eff6ff;       /* blue tint for hover/selected states */

/* Status */
--synced:      #16a34a;
--synced-bg:   #f0fdf4;
--error:       #dc2626;
--error-bg:    #fef2f2;

/* Balance page expiry */
--expired-bg:  #fef2f2;
--expired-text:#991b1b;
--warning-bg:  #fffbeb;
--warning-text:#92400e;
```

**Typography:**
```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

--font-body:  'Inter', system-ui, sans-serif;
--font-mono:  'JetBrains Mono', monospace;   /* numbers, doc numbers, IDs */
```

**Layout rules:**
- Sidebar: 220px, white, border-right only. Collapsible to icon-only (56px) on click.
- Content: max-width 1400px, centered, with `px-8 py-6`.
- Tables: no outer border. Header row has bottom border. Rows separated by subtle border. No zebra stripes.
- Cards: white bg, 1px border, `rounded-xl`, no shadow.
- Buttons: `rounded-lg`, `text-sm font-medium`, `h-9 px-4`. Primary = accent fill. Secondary = border only.
- Inputs: `rounded-lg`, `h-9`, subtle border, focus ring in accent color.
- Page titles: `text-xl font-semibold`, with subtle description below in muted text.

---

## Layout

```
┌──────┬──────────────────────────────────────┐
│      │  Page Title          [Refresh] [?]   │
│ Logo │──────────────────────────────────────│
│      │                                      │
│ Nav  │  Content area                        │
│ items│  (tables, cards, forms)              │
│      │                                      │
│      │                                      │
│      │                     Pagination ──►   │
└──────┴──────────────────────────────────────┘
```

**Sidebar nav items** (icon + label):
```
◫  Overview         /
☐  Orders           /orders
⊞  Purchase Orders  /po
⚡ Service Cases    /assr
◉  Balance          /balance
◷  Overdue          /overdue
⊟  Activity Log     /logs
⚙  Settings         /settings
```

Active item: accent text + `accent-soft` background + left border accent.

---

## API Client

```typescript
const api = {
  baseUrl: import.meta.env.VITE_API_URL || '',
  key: import.meta.env.VITE_API_KEY || '',

  async request<T>(path: string, opts?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...opts,
      headers: {
        'Authorization': `Bearer ${this.key}`,
        'Content-Type': 'application/json',
        ...opts?.headers,
      },
    });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  },

  get: <T>(p: string) => api.request<T>(p),
  post: <T>(p: string, b?: any) => api.request<T>(p, { method: 'POST', body: b ? JSON.stringify(b) : undefined }),
  patch: <T>(p: string, b: any) => api.request<T>(p, { method: 'PATCH', body: JSON.stringify(b) }),
};
```

Standard response shape: `{ success: boolean, data: T, meta?: { total, page, per_page } }`

---

## Pages

### 1. Overview (`/`)

Clean grid of stat cards + recent activity.

**Top row — 4 stat cards:**
```
GET /api/orders/stats → {
  data: {
    by_region: { WEST: 142, EAST: 87, SG: 35 },
    by_status: { SYNCED: 260, ERROR: 4 },
    total_balance: 1284350.50,
    total_orders: 264
  }
}
```

Cards:
1. **264** orders — "West 142 · East 87 · SG 35" subtitle
2. **4** sync errors — red accent if > 0, green checkmark if 0
3. **RM 1.28M** outstanding — formatted compact
4. Last synced: "2 min ago" — relative time

**Action buttons row** (small, secondary style):
- Sync Orders — `POST /api/sync/pull`
- Retry Errors (red text, only if errors > 0) — `POST /api/sync/retry-errors`
- Refresh Balance — `POST /api/balance/pull` (note: this just re-queries, no separate table)
- Refresh PO — `POST /api/po/pull`

**Recent activity** — last 8 log entries in a minimal list:
```
GET /api/logs?per_page=8 → {
  data: [
    { type: "PULL", status: "SYNCED", message: "Pulled 15 records", started_at: "..." }
  ]
}
```

Render as: `● PULL — Pulled 15 records — 2 min ago` (dot colored by status)

---

### 2. Orders (`/orders`) — Main page

**Header area:**
- Page title: "Sales Orders"
- Region filter: pill buttons `All` `West` `East` `SG` (not tabs — pills)
- Search input (right-aligned): searches doc_no, debtor_name
- "Sync" button with refresh icon

```
GET /api/orders?region=WEST&search=&page=1&per_page=50
→ { data: [ { doc_no, region, debtor_name, phone, sales_location, local_total, balance, expiry_date, remark4, sync_status, sync_error, details: { delivery_date, lorry_plate, ... } } ], meta: { total, page, per_page } }
```

**Table — keep it tight:**

| Column | Source | Align | Format |
|--------|--------|-------|--------|
| Doc No | `doc_no` | left | mono font, medium weight |
| Customer | `debtor_name` | left | truncate at 200px |
| Location | `sales_location` | center | small badge (KL, PG, SBH, SRW) |
| Total | `local_total` | right | mono, `RM XX,XXX` |
| Balance | `balance` | right | mono, **bold if > 0**, red if overdue |
| Expiry | `expiry_date` | left | date |
| Status | `remark4` | left | text, muted color |
| Sync | `sync_status` | center | dot indicator (green/red) |

That's **8 columns**. Not 13. Keep it scannable. Details go in the side panel.

**Row click → Side panel (not drawer — panel slides in, content shifts left):**

Panel width: 420px. Clean form layout with sections.

**Section: Order** (read-only, gray background)
- Doc No, D/O, Date, Ref, Agent
- Total, Balance (highlighted if > 0)

**Section: Delivery** (editable)
- Remark 4 — text input → on blur, `PATCH /api/orders/:docNo` → pushes to AutoCount immediately
- Expiry Date — date picker → on change, same push
- Delivery Date — date input → `PATCH /api/orders/:docNo/details`
- Time Range, Driver, Lorry Plate, Contact — text inputs → `PATCH /api/orders/:docNo/details`

**Section: Address** (read-only)
- 4 address lines, stacked

**Section: Notes** (read-only)
- Remark 2, Remark 3, Note

**Section: Transporter** (only for EAST, editable)
- ETA Port, Est. Delivery, Vessel, ETD, ETA Destination, Remarks

**Section: Financials** (only for EAST, editable)
- Seafreight, Local Charges, Inland, Agent Fee, Insurance, Total

**Save behavior**: Each field auto-saves on blur. Show tiny ✓ next to the field for 1.5s. If push fails, show ✗ in red and keep the field highlighted.

---

### 3. Purchase Orders (`/po`)

**Header**: Title + Search + "Refresh" button + "Sync All Dates" button

```
GET /api/po?search=&page=1&per_page=50
→ { data: [{ doc_no, so_doc_no, creditor_name, item_code, item_description, remaining_qty, delivery_date, supplier_date1, supplier_date2, supplier_date3, overdue_days }] }
```

**Table:**

| Column | Editable | Notes |
|--------|----------|-------|
| PO No | No | mono |
| SO No | No | mono |
| Supplier | No | |
| Item | No | truncated |
| Qty | No | right-align |
| Delivery Date | No | |
| Supplier Date 1 | **Yes** | date picker |
| Supplier Date 2 | **Yes** | date picker |
| Supplier Date 3 | **Yes** | date picker |
| Overdue | **Yes** | text input, narrow |
| — | — | "Sync" icon button per row |

Edit saves to DB: `PATCH /api/po/:docNo/:itemCode`
Sync pushes to AutoCount: `POST /api/po/:docNo/sync-dates`

---

### 4. Service Cases (`/assr`)

**Header**: Title + Status filter pills (`All` `Open` `In Progress` `Closed`) + Search + "+ New Case" button

```
GET /api/assr?status=Open&search=&page=1&per_page=50
→ { data: [{ assr_no, status, doc_no, complained_date, customer_name, location, item_code, complaint_issue }] }
```

**Table:**

| Column | Notes |
|--------|-------|
| ASSR No | mono, bold |
| Status | colored dot + text |
| SO No | mono |
| Date | |
| Customer | |
| Item | |
| Issue | truncated |

**Status dots**: Open = yellow, In Progress = blue, Closed = green

**"+ New Case" → opens a small form panel:**
- Doc No (required) — text input
- Item Code (required) — text input
- Issue Description (required) — textarea

Submit: `POST /api/assr` → returns created case with auto-generated ASSR number. Show success toast with the number.

**Row click → detail panel** with all case fields, editable. `PATCH /api/assr/:assrNo`

---

### 5. Balance (`/balance`)

**Header**: Title + "Showing orders with outstanding balance" subtitle + Expiry filter pills (`All` `Expired` `Expiring Soon` `OK`) + Search

This page queries `sales_orders` directly — no separate table:
```
GET /api/balance?expiry_filter=expired&search=&page=1&per_page=100
→ { data: [{ doc_no, debtor_name, phone, location, agent, total, balance, expiry_date, remark4 }] }
```

**Table:**

| Column | Notes |
|--------|-------|
| Doc No | mono |
| Customer | |
| Location | |
| Total | right, mono |
| **Balance** | right, mono, **always bold** |
| Expiry Date | styled per status |
| Status | remark4 |

**Row highlighting (the key UX from the old system):**
```
today = new Date(); today.setHours(0,0,0,0);
threeDays = new Date(today); threeDays.setDate(today.getDate() + 3);

if (expiry < today)        → row bg: --expired-bg,  date text: --expired-text, font-semibold
if (expiry <= threeDays)    → row bg: --warning-bg,  date text: --warning-text, font-semibold
else                        → normal
```

Read-only page. No editing.

---

### 6. Overdue History (`/overdue`)

**Header**: Title + "Auto-extended orders log" subtitle + "Run Check" button (`POST /api/overdue/run`)

```
GET /api/overdue/history?page=1&per_page=50
→ { data: [{ pull_date, doc_no, debtor_name, location, balance, original_expiry_date, extended_to }] }
```

**Table:**

| Column | Notes |
|--------|-------|
| Date | pull_date, mono |
| Doc No | mono |
| Customer | |
| Location | |
| Balance | right, mono |
| Was Expiring | original_expiry_date |
| Extended To | extended_to |

Read-only. Minimal page.

---

### 7. Activity Log (`/logs`)

**Header**: Title + Type filter dropdown + Status filter dropdown

```
GET /api/logs?type=&status=&page=1&per_page=50
→ { data: [{ request_id, type, started_at, ended_at, status, message }] }
```

**Table:**

| Column | Notes |
|--------|-------|
| Time | started_at, relative ("2m ago") with hover tooltip for full datetime |
| Type | badge: PULL, PUSH, OVERDUE, PO, ASSR |
| Status | dot colored by status |
| Message | |
| ID | request_id, mono, truncated |

---

### 8. Settings (`/settings`)

Simple form page, not a table.

```
GET /api/sync/status → { data: { last_pull, error_count } }
```

**Sections:**

**Connection**
- API URL (display only)
- "Test Connection" button → `GET /api/health`
- Status indicator: connected (green) / disconnected (red)

**Sync**
- Last pull: timestamp
- Errors: count. "Retry All" if > 0.
- "Reset Checkpoint" button (with confirmation)

---

## Reusable Components

### `<DataTable>` 
- Column definitions with label, key, width, align, render function
- Sticky header
- Loading: 5 skeleton rows
- Empty: centered icon + "No data" + optional action
- Hover: subtle row highlight `#fafafa`
- Compact: `py-2.5 px-3`

### `<StatusDot>`
- Tiny 8px circle. Green for SYNCED, red for ERROR. With text label next to it.
- For ASSR: yellow=Open, blue=In Progress, green=Closed

### `<Pill>` / `<FilterPills>`
- Horizontal group of selectable pills. Active = filled accent. Inactive = border only.

### `<Panel>`
- Slide-in from right, 420px wide. Content area shifts left.
- Header with title + close button. Scrollable body. Sticky footer with actions if needed.

### `<Toast>`
- Bottom-center (not bottom-right). Minimal: icon + text. Auto-dismiss 3s.
- Success: green check. Error: red x. Info: blue info.

### `<InlineEdit>`
- Click text → becomes input. Blur → saves. Show micro ✓/✗ feedback.
- For date fields: native date input.

### `<StatCard>`
- White card, border, rounded-xl.
- Metric (large, `text-2xl font-semibold font-mono`), label (small, muted), optional subtitle.

---

## File Structure

```
frontend/
├── index.html
├── vite.config.ts
├── tailwind.config.js
├── .env.example              # VITE_API_URL, VITE_API_KEY
└── src/
    ├── main.tsx
    ├── App.tsx
    ├── index.css
    ├── api/client.ts
    ├── types.ts
    ├── hooks/
    │   ├── useQuery.ts       # Simple fetch + loading + error hook
    │   └── useToast.ts
    ├── pages/
    │   ├── Overview.tsx
    │   ├── Orders.tsx
    │   ├── PurchaseOrders.tsx
    │   ├── ServiceCases.tsx
    │   ├── Balance.tsx
    │   ├── Overdue.tsx
    │   ├── Logs.tsx
    │   └── Settings.tsx
    ├── components/
    │   ├── Layout.tsx
    │   ├── Sidebar.tsx
    │   ├── DataTable.tsx
    │   ├── Panel.tsx
    │   ├── StatusDot.tsx
    │   ├── FilterPills.tsx
    │   ├── StatCard.tsx
    │   ├── InlineEdit.tsx
    │   ├── Toast.tsx
    │   ├── Pagination.tsx
    │   └── Skeleton.tsx
    └── lib/
        ├── utils.ts          # formatCurrency, formatDate, cn(), relativeTime
        └── constants.ts
```

---

## UX Details

1. **Auto-save on blur** — no "Save" buttons in edit forms. Each field saves independently. Show micro feedback (checkmark/cross) inline.

2. **Currency**: `RM` prefix. Compact for large numbers on cards (`RM 1.28M`), full on tables (`RM 1,284,350`). Right-align, mono font.

3. **Dates**: Display `YYYY-MM-DD`. Use native date inputs. No custom date pickers.

4. **Loading**: Skeleton shimmer (subtle, not flashy). Never show empty page while loading.

5. **Empty states**: Centered icon + "No orders found" + action button if applicable. Keep it simple.

6. **Error handling**: If API call fails, show small red toast. If a page fails to load, show inline error with retry.

7. **Responsive**: Desktop-first (1280px+). On smaller screens, collapse sidebar to icons only.

8. **Keyboard**: Escape closes panel. Tab between editable fields in panel.

9. **No modals.** Ever. Use panels for details, inline editing for quick changes, toasts for feedback.

10. **Page transitions**: None. Instant renders. Speed is the UX.

---

Now build the complete frontend. Start with `Layout.tsx` + `Sidebar.tsx`, then reusable components, then each page. Every component must be fully wired to the API — no mock data, no placeholders, no TODOs.
