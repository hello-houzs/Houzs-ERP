# AutoCount Sync v2

Simplified web app replacing Google Sheets + Apps Script.

## Quick Start

```bash
npm install
wrangler secret put AUTOCOUNT_API_KEY
wrangler secret put DASHBOARD_API_KEY

# Reset DB with simplified schema
npm run db:reset

# Dev
npm run dev

# Deploy
npm run deploy
```

## Key Files

| File | What to do with it |
|------|-------------------|
| `PROJECT_BRIEF.md` | Full backend spec. Feed to Claude Code for Worker API. |
| `FRONTEND_PROMPT.md` | Full frontend spec. Feed to Claude Code for React dashboard. |
| `src/db/schema.sql` | Simplified schema (6 tables). Run `npm run db:reset` to apply. |
| `reference/` | Original Apps Script files for business logic reference. |

## Architecture

- 2 crons (pull every 5m, overdue daily)
- Everything else is real-time (push on save, refresh on click)
- 6 database tables (down from 8)
- No PENDING status, no batch push, no balance table copy
