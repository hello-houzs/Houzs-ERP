# Houzs ERP — Working agreement

This file is loaded into every Claude session. It tells you what's
non-obvious about this codebase and how the user wants to collaborate.

## ⚠️ Log every bug in `BUG-HISTORY.md` — MANDATORY (owner rule, everyone)

Every bug you find and fix **must** get an entry in [`BUG-HISTORY.md`](./BUG-HISTORY.md) at the repo root — no exceptions. One short entry: **Symptom → Root cause (traced, not guessed) → Fix → Ref (PR/date)**, newest first, with a severity tag. This is how we stop re-introducing the same class of bug: **read it before touching a subsystem, and add to it in the same PR that fixes the bug.** This applies to every contributor and every agent/session.

## What this repo is

Internal ERP for Houzs. Cloudflare Workers + Hono backend, React/Vite SPA
frontend, D1 SQLite, R2 storage. Single Worker, single SPA. Detailed
architecture lives in the Obsidian wiki — see *Wiki* below.

## Obsidian wiki — keep it current

A companion knowledge base lives in the user's Obsidian vault under
`Houzs ERP/`. It's the human-readable counterpart to the codebase
(architecture, decisions, module guides, glossary). The Obsidian MCP
server is registered at user scope, so the `mcp__obsidian__*` tools are
always available.

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
  remain hand-written `.sql` files** in `src/db/migrations/`, numbered
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

- `.claude/commands/sync-wiki.md` — the slash command that performs a
  wiki refresh on demand
- The user's auto-memory MOC at `~/.claude/projects/<hash>/memory/MEMORY.md`
- The Obsidian wiki's `Houzs ERP/00 Home.md` for the map of content
