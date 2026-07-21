# Houzs ERP — Working agreement

This file is loaded into every Claude session. It tells you what's
non-obvious about this codebase and how the user wants to collaborate.

## ⚠️ Log every bug in `BUG-HISTORY.md` — MANDATORY (owner rule, everyone)

Every bug you find and fix **must** get an entry in [`BUG-HISTORY.md`](./BUG-HISTORY.md) at the repo root — no exceptions. One short entry: **Symptom → Root cause (traced, not guessed) → Fix → Ref (PR/date)**, newest first, with a severity tag. This is how we stop re-introducing the same class of bug: **read it before touching a subsystem, and add to it in the same PR that fixes the bug.** This applies to every contributor and every agent/session.

**This file stays THIN on purpose.** It carries rules and traps, not an
inventory. Facts that change with every merge — route counts, file sizes,
module lists — belong in the map below, because a stale fact HERE is worse
than no fact: this file is auto-loaded, so every session believes it. It
described the database as "D1 SQLite" for over a month after the Postgres
cutover, and pointed at a migration directory that production does not read.

## Read the map before exploring

- **`docs/CODEBASE-MAP.md`** — what each area is FOR, which trees are dead,
  which folders are vendored, where desktop and mobile diverge, and which
  files are too big to open whole. Read this INSTEAD of exploring from
  scratch; it is the hand-written judgement layer.
- **`docs/generated/`** — the mechanical inventory (routes, migrations,
  largest files), regenerated from the tree so it cannot drift.
- **`docs/modules/<module>.md`** — everything needed to work in ONE module
  without reading the others. Read the guide for the module you are touching
  before touching it.

**Where does a new fact go?** `docs/KNOWLEDGE-SYSTEM.md` answers that, and
explains why these layers exist. One rule decides it: *a fact belongs in the
layer that will be forced to update it when it changes.* A number that shifts
every merge must be GENERATED, never typed — that is exactly how this file
came to claim the database was D1 SQLite for a month after the cutover.

Do not open a 5,000+ line file whole. Several pages and route modules run
past 8,000 lines and one past 12,000. Locate with grep, then read the line
range. The map lists the offenders and roughly what lives where in each.

## What this repo is

Internal ERP for Houzs. Cloudflare Workers + Hono backend, React/Vite SPA
frontend, R2 storage. Single Worker, single SPA.

**The data store is Supabase Postgres, reached through Hyperdrive.** D1 is
test-only now — which matters most for migrations, below.

## Migrations — two trees, only one is real

- **`backend/src/db/migrations-pg/`** is the LIVE tree. `deploy.yml` runs
  `node scripts/pg-migrate.mjs` on every push to main, so a merged file is
  applied to production automatically. A file that fails there blocks every
  later migration until it is fixed.
- **`backend/src/db/migrations/`** is the older D1/test tree. A change put
  there ships, passes CI, merges — and production never changes. Check which
  tree you are in before writing a migration.
- `pg-migrate` tracks applied files by FULL FILENAME, so number gaps and
  out-of-order merges are safe; DUPLICATE numbers are what break it. Pick the
  number at MERGE time by re-listing the tree, not when you branch — parallel
  PRs otherwise pick the same one.

## Desktop and mobile are one product

`frontend/src/mobile` is a first-class surface, not a viewport tweak. Most
features exist as a desktop file and a mobile file that must change TOGETHER
— the owner's standing rule is ONE shared logic layer, with the two surfaces
differing only in presentation. Fixing a rule on one surface and not the
other is a recurring bug class here (see `BUG-HISTORY.md`). The map lists the
known pairs.

## Obsidian wiki — keep it current

A companion knowledge base lives in the user's Obsidian vault under
`Houzs ERP/`. It's the human-readable counterpart to the codebase
(architecture, decisions, module guides, glossary). It is the human-facing
counterpart to `docs/CODEBASE-MAP.md`, which is the agent-facing one.

The Obsidian MCP is registered at USER scope, not in this repo, so
`mcp__obsidian__*` is available only in sessions that have it connected —
several do not. If those tools are absent, skip the wiki and say so rather
than working around it; the repo-side map is the fallback that always works.

**When to update the wiki** — after work that meaningfully changes:

- A module's surface (new endpoints, new permission, new tab)
- The data model (new migration that touches an existing concept)
- An architectural decision (always add to `Houzs ERP/Decisions.md`)
- A core pattern (ACL, polling, UDF, scoping)
- The roadmap (move items between sections, mark done, add new ones)

**When NOT to update** — bug fixes, refactors that don't change the
surface, dependency bumps, doc fixes inside the code itself.

**How to update** — append a section under the existing structure;
don't rewrite. Cross-link with `[[wiki-link]]` syntax. Match the tone
of the existing notes (concrete, terse, callouts where useful).

The user's preference, in their words: *"do your best and be creative"*
and *"fill them with details specific"* — the wiki should always carry
real schema columns, real LOC counts, real SQL, real permission keys.
Not generic narrative.

## Coding conventions specific to this repo

- **No emoji.** Anywhere. Empty states, status copy, comments, commits.
- **Drizzle ORM for new code.** New routes / services use Drizzle —
  schema in `backend/src/db/schema.ts`, client via
  `getDb(env)` from `backend/src/db/client.ts`. Raw
  SQL via `c.env.DB.prepare(...)` is still allowed in legacy code
  paths until they're converted route-by-route. Don't mix the two
  styles inside a single function — convert the whole handler. **Migrations
  remain hand-written `.sql` files** — in `src/db/migrations-pg/` for
  anything that must reach production (see *Migrations* above) — numbered
  and immutable after deploy. Drizzle-kit is for type generation /
  schema diffing only, never as the migration runner.
- **Demo / test seed data does NOT belong in numbered migrations.**
  Numbered migrations run in prod. Mig 067 + 069 seeded ~40 fake
  `sales_reps` with `@example.my` emails; mig 079 then had to delete
  them — every new environment now pays a seed-then-cleanup cost
  forever. Put demo data in a one-shot `backend/scripts/seed-*.mjs`
  script you run manually against the local D1 (precedent: existing
  `backend/scripts/backfill-project-codes.mjs`). Numbered migrations
  are for schema changes + production-required data only — lookup
  tables, default roles / permissions, canonical enum rows. If a
  table needs sample rows to develop against, that's a script, not
  a migration.
- **Keep schema and data in separate migrations when both are large.**
  An `ALTER TABLE` + 100-line `INSERT` block in the same file makes
  rollback awkward and the diff hard to read. Numbered migrations are
  cheap; prefer two small ones over one big one.
- **No WebSockets yet.** Polling is the realtime mechanism — see the
  wiki's *Polling Strategy* note for cadence and rationale.
- **URL is state.** Filters/tabs/modes go in `useSearchParams`.
  localStorage is fallback for personal prefs only.
- **Permissions are flat strings**, e.g. `projects.read`. Catalogue
  lives in `backend/src/services/permissions.ts`. New verbs since
  mig 047: `projects.chat`, `projects.checklist.tick` — use
  `requireAnyPermission([...])` to gate routes that accept either a
  narrow verb or `projects.write`.
- **Row-level scope is two-dimensional now.** PIC one-hop +
  brand allow-list (mig 049). Use `getProjectScope(user)` from
  `backend/src/services/projectAcl.ts` — returns
  `{ pic_ids, brands }`. The SQL fragment
  `COALESCE(p.pic_id, p.created_by) IN (...) AND p.brand IN (...)`
  is still hand-written across 3 callsites (project list / calendar /
  notifications); centralising into `projectScopeWhere(user)` is on
  the Roadmap.
- **Section + attachment data on tasks** (mig 050). Project tasklist
  groups by `project_checklist_sections`; per-task attachments live
  in `project_checklist_attachments`. The project-level
  `project_attachments` table is kept for legacy data, no longer
  surfaced in the UI.

## Working agreement

- Don't add features, refactor, or introduce abstractions beyond what
  the task requires.
- Default to no comments. WHY only, never WHAT.
- For UI changes, test in the browser before claiming success.
- Confirm before destructive ops (force push, dropping tables, deleting
  branches). Auto-mode is not blanket consent for risky writes.
  - Write TODO when planning is confirmed 
  - After meaningful work lands, end the reply with a one-line offer to
  `/sync-wiki` if the wiki should be updated.

## See also

- **`docs/KNOWLEDGE-SYSTEM.md`** — the layers, what belongs where, and why
- **`docs/CODEBASE-MAP.md`** — start here for anything you would otherwise
  go exploring for; `docs/generated/` for the mechanical inventory
- **`BUG-HISTORY.md`** — read the entries for a subsystem before touching it
- `/sync-wiki` — user-scope slash command for the Obsidian refresh; the
  command file is NOT in this repo, so it exists only where the user has it
  installed
- The user's auto-memory MOC at `~/.claude/projects/<hash>/memory/MEMORY.md`
- The Obsidian wiki's `Houzs ERP/00 Home.md` for the map of content
