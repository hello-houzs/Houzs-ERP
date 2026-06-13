# User Management — module guide

How staff access is controlled in Houzs ERP. Deployed to prod 2026-06-13.
Companion docs: [PERMISSION-MATRIX.md](PERMISSION-MATRIX.md) (the agreed grid),
[DEPLOY-USER-MGMT.md](DEPLOY-USER-MGMT.md) (deploy runbook).

## The model: two orthogonal dimensions
A user has both a **role** and a **position**:
- **Role** (`roles` table, flat permission verbs like `projects.read`, `*` for Owner/IT)
  — decides what ACTIONS a user can perform (write/manage gates via `requirePermission`).
- **Position** (`positions` table = department × job, e.g. SALES/Sales Executive)
  — decides which PAGES a user can see, via a 4-level matrix.

Departments are the 3 canonical ones: **HQ / SALES / OPERATION**. Positions belong to a
department; the 17 seeded positions are in PERMISSION-MATRIX.md.

## Page-access matrix (`position_page_access`)
Per (position × page) one of **none / view / edit / full** (`pageAccess.ts AccessLevel`).
- The legacy ROLE matrix (`role_page_access`, mig 073) stays 3-level (none/partial/full);
  `partial` is ranked equal to `view`, so both coexist with no data migration.
- **Inherit model** (`loadPageAccessForPosition`): a sub-page inherits its parent's level
  unless it has its own row. So grant a whole area with one parent row
  (`projects = view`) and override a sub-page (`projects.finances = none`); or grant a
  single tab (`projects = none` + `projects.calendar = view`).

## How a login resolves access (`auth.ts hydrateAuthUser`)
`page_access = `
- `*` wildcard role → everything full; else
- has a position → `loadPageAccessForPosition(position_id)`; else
- no position (un-migrated user) → `loadPageAccessForRole(role_id)` (fallback, keeps
  existing users working during rollout).

The resolved `page_access` map is attached to the session user (KV-cached 60s).

## Enforcement — no "乱跳" (no jumping into pages you shouldn't see)
- **Frontend**: every data-page route is wrapped in `<PageGuard page="…">` (App.tsx); a
  denied page renders `<Forbidden>` inline (URL preserved, no redirect loop). The Sidebar
  hides nav items via each item's `pageAccess` key. So a position only ever sees + reaches
  its own pages.
- **Backend**: `requirePageAccess("…")` middleware on routes reads the same `page_access`.

## Project detail (PMS) section gating (`pmsAccess.ts`)
On top of page access, the project-detail view shows different SECTIONS per PMS role
(Director / Sales-PIC / Sales / Logistic / Purchasing / Driver / Other). The **financial
snapshot + rental are stripped SERVER-SIDE** (`projects.ts GET /:id` sets `finance:null`)
for any position whose role isn't FINANCIAL — never just hidden in the UI. Gated on
`position_id` so un-migrated users keep legacy access.

## PIC scope + 4-day grace
PIC = a per-project assignment (`projects.pic_id`), not a job title. A `scope_to_pic` user
sees projects where the PIC is them or their manager (one-hop) AND the brand is in their
department's allow-list (`projectAcl.ts`). **PIC visibility expires `PIC_GRACE_DAYS = 4`
days after a project's `end_date`** (owner: "完了的四天之后") — applied in the list query
and the detail gate; admins/unscoped roles are unaffected; projects with no end_date stay
visible.

## Invite flow
`POST /api/users/invite` carries **email, name, role, department, position, manager**. The
placeholder user is created with those org fields; accept-invite activates it. Frontend:
User Management → Members → "Invite Member" (Department → Position auto-scoped → Reports-to).

## Managing it in the UI
- **User Management → Members**: Position column (inline edit), filter by Department/Position.
- **User Management → Positions**: pick a position → set each page none/view/edit/full → Save
  (`Positions.tsx`, writes `/api/positions/:id/page-access`).
- **Org Chart** tab: reporting lines (manager_id).

## Test accounts (seeded)
One ACTIVE account per position, password `houzs1234`, emails `<slug>@example.my`
(`super_admin@…`, `sales_director@…`, `purchasing@…`, etc.). Driver/Helper route to the
driver mobile portal. Remove with `seed-user-management.mjs --remove-tests`.

## Key files
- `backend/src/services/pageAccess.ts` — levels, PAGES catalogue, loaders (role + position)
- `backend/src/services/auth.ts` — hydrateAuthUser (position → page_access)
- `backend/src/routes/positions.ts` — positions CRUD + matrix read/write
- `backend/src/services/pmsAccess.ts` — project-detail section gating
- `backend/src/services/projectAcl.ts` — PIC + brand scope + 4-day grace
- `backend/src/routes/users.ts` — invite/PATCH/list carry dept/position/manager
- `frontend/src/auth/PageGuard.tsx`, `App.tsx`, `components/Sidebar.tsx` — FE enforcement
- `frontend/src/pages/Team.tsx`, `Positions.tsx` — the UI
- `backend/scripts/seed-user-management.mjs` — departments + positions + matrix + test accounts
- migrations: `0004_positions.sql` (PG) / `094_positions.sql` (D1)
- tests: `positions.test.ts`, `pmsAccess.test.ts`, `projectAcl.test.ts`, `pageAccess.test.ts`
