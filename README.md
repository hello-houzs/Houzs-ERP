# Houzs ERP

Internal operations platform for Houzs — AutoCount sync, delivery
planning, driver dispatch, and proof-of-delivery. Replaces a legacy
Google Sheets + Apps Script setup with a single web app.

**Stack**

- **Backend**: Cloudflare Workers (Hono) + D1 + R2
- **Frontend**: React 18 + Vite + TypeScript + Tailwind
- **Auth**: session-based, role/permission gated
- **Integration**: AutoCount middleware (.NET) over HTTPS

## Modules

| Module | What it does |
|--------|--------------|
| Orders | Sales orders synced from AutoCount, editable delivery fields, real-time push back |
| Purchase Orders | Outstanding PO list with manual supplier dates + overdue tracking |
| Balance | Outstanding-balance view with expiry highlighting |
| Overdue | Daily auto-extension log |
| ASSR | Service case management |
| Trips | Dispatcher trip planning, driver mobile flow, GPS pings, POD photo + signature upload to R2 |
| Planner | Route/stop optimization helpers |
| Presence | Live "who's online" for the dispatcher view |
| Logs | Execution + sync activity log |

## Project layout

```
ERP-Houzs/
├── wrangler.toml          # Worker config (D1, R2, secrets, crons)
├── package.json
├── src/                   # Backend (Hono on Workers)
│   ├── index.ts
│   ├── middleware/
│   ├── routes/            # HTTP routes per module
│   ├── services/          # Business logic
│   └── db/
│       ├── schema.sql
│       └── migrations/
└── frontend/              # React dashboard + driver app
    ├── index.html
    ├── vite.config.ts
    └── src/
        ├── pages/
        ├── components/
        ├── hooks/
        └── api/
```

## Quick start

```bash
# Backend
npm install
wrangler secret put AUTOCOUNT_API_KEY
wrangler secret put DASHBOARD_API_KEY
npm run db:reset            # apply schema to D1
npm run dev                 # local Worker

# Frontend
cd frontend
npm install
npm run dev
```

## Deploy

```bash
npm run deploy              # Worker → Cloudflare
cd frontend && npm run build  # static bundle → Cloudflare Pages
```

## Crons

| Schedule | Job |
|----------|-----|
| `*/5 * * * *` | Pull modified orders from AutoCount |
| `0 2 * * *`   | Daily overdue detection + auto-extension |

Everything else runs on-demand from user actions.
