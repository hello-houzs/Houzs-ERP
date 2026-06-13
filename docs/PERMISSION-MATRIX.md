# Permission Matrix — User Management build spec (LIVING DOC)

Source of truth for the User Management uplift. Ported from the owner's
reference repo **`weisiang329-eng/houzs-erp`** (`src/lib/permissions-defaults.ts`,
`modules.ts`, `pms-access.ts`) and refined by the owner in chat. Owner edits
land here first, then get built.

Levels: **-** = NONE, **V** = VIEW, **E** = EDIT, **F** = FULL.

## Owner corrections applied (2026-06-13)
- **SALES — Calendar = VIEW for ALL sales positions** (was Director/Manager FULL,
  Exec EDIT). Owner: "calendar 应该全部 sales 只可以看到而已".
- **Storekeeper — being defined incrementally.** Owner removed SKU Costing + SO
  Details ("sku costing 和 so details 不需要给 storekeeper"). Current: **Calendar
  (V) + Operation (E) only.** More edits may follow.

## Open decisions
1. Operation positions: adopt reference set incl. **Ops Director / Ops Manager /
   Ops Executive** (3 mgmt tiers) + **Storekeeper** (rename of "Warehouse")? Or the
   owner's earlier 6 (purchasing/logistic/service_team/driver/helper/storekeeper)?
   — current assumption: reference set, Warehouse→Storekeeper, no separate
   "service_team" (after-sales = QMS module).
2. Storekeeper's actual access (row marked TBD).
3. PIC visibility expiry when a project is over: reference has NO auto-expiry
   (assignment-only). Add it? (owner: pending)

## Module-level matrix

Modules: dash=Dashboard, cal=Calendar, fin=Finance Report, pms=Project Details,
mdata=Master Data, steam=Sales Team, sod=SO Details, so=Sales Order,
sonew=Create SO, sku=SKU Costing, qms=After-Sales(QMS), bd=PM Dept,
oper=Operation, drv=Driver&Helper, field=Field Portal, usr=Admin Users,
audit=Audit Log, perm=Permissions.

| Dept | Position | dash | cal | fin | pms | mdata | steam | sod | so | sonew | sku | qms | bd | oper | drv | field | usr | audit | perm |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| HQ | Super Admin | F | F | F | F | F | F | F | F | F | F | F | F | F | F | F | F | F | F |
| HQ | HR Manager | V | V | - | V | - | V | - | - | - | - | - | - | - | - | - | E | V | - |
| HQ | Finance Manager | V | V | F | V | - | - | V | V | E | V | - | - | - | - | - | - | V | - |
| HQ | Admin Assistant | V | E | - | V | - | - | - | - | - | - | - | - | - | - | - | V | - | - |
| SALES | Sales Director | F | **V** | V | F | V | F | V | V | F | V | F | - | - | - | - | V | V | - |
| SALES | Sales Manager | - | **V** | - | F | - | - | - | - | - | - | - | - | - | - | - | - | - | - |
| SALES | Sales Executive | - | **V** | - | V | - | - | - | - | - | - | - | - | - | - | - | - | - | - |
| SALES | Sales Trainee | - | V | - | V | - | - | - | - | - | - | - | - | - | - | - | - | - | - |
| OPERATION | Ops Director | V | F | - | V | - | - | V | V | - | V | F | F | F | F | - | - | - | - |
| OPERATION | Ops Manager | - | E | - | V | - | - | V | V | - | - | E | E | F | E | - | - | - | - |
| OPERATION | Ops Executive | - | V | - | V | - | - | V | V | - | - | - | - | E | V | - | - | - | - |
| OPERATION | Purchasing | - | V | - | V | - | - | - | - | - | - | - | - | - | - | - | - | - | - |
| OPERATION | Logistic | - | V | - | V | - | - | - | - | - | - | - | - | - | V | - | - | - | - |
| OPERATION | Storekeeper | - | V | - | - | - | - | - | - | - | - | - | - | E | - | - | - | - | - |
| OPERATION | Driver | - | V | - | - | - | - | - | - | - | - | - | - | - | - | E | - | - | - |
| OPERATION | Helper | - | V | - | - | - | - | - | - | - | - | - | - | - | - | E | - | - | - |

## Project-detail (PMS) section-level visibility

Inside a single project, sections shown depend on PMS role (pms-access.ts):

| PMS role | Sections visible | Financial snapshot | Rental |
|---|---|---|---|
| Director (Super Admin / Sales Director) | everything + delete | YES | YES |
| Sales **PIC** (assigned PIC of THIS project) | edit, stage, workflow, booth, setup/dismantle, expo map, event chat, integrations | **NO** | **NO** |
| Sales (assigned, not PIC) | setup/dismantle, expo map, event chat | NO | NO |
| Logistic | = Sales PIC **minus** event chat | NO | NO |
| Purchasing | booth layout + setup only | NO | NO |
| Driver / Helper | field portal only (not this page) | NO | NO |
| Ops / HQ (non-admin) | stage, workflow, booth, setup, expo, chat, integrations (view-only) | NO | NO |

**PIC = per-project assignment** (name match on the project's PIC column), NOT a
job title. A sales person is PIC only on the projects they're assigned to.

## Calendar visibility
- Sales / Driver / Helper → only events they're PIC of / assigned to / crew on.
- Everyone else → all events.
