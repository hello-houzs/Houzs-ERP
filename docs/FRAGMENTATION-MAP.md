# Fragmentation Map (2026-07-23)

The owner noticed the codebase has "3-4 of the same thing" not integrated. A
read-only audit confirmed it and mapped every instance. This is that map, plus
what has been fixed, what is deferred, and — critically — the duplicates that are
**intentional and must NOT be merged**. Companion to `AI-DEV-VELOCITY.md`
(fragmentation is a top cause of slow AI sessions: every task re-discovers which
of the N versions is the real one).

The recurring shape: a consolidation *was* started, its file even calls itself
"the single source" — and the sweep to convert the old call sites was never
finished. The habit fix: finish the sweep in the SAME PR that creates the
canonical helper, and add a CI parity/grep guard where money is involved.

## Done (2026-07-23)

- **[FIXED] Sofa combo pricing UTC drift** (#1116) — the smoking gun. The
  frontend copy of `sofa-combo-pricing.ts` resolved effective-dated pricing
  against the UTC date; before 08:00 MYT it priced sofas differently from the
  backend. Now both use MYT. This is the highest-value item the audit found.
- **[FIXED] Deleted dead `scm/lib/roles.ts`** (#1119) — an orphaned duplicate of
  `canViewAllSales` et al. (live copy is in `houzs-perms.ts`); it only misled
  greps. `tsc` proved nothing imported it.

## VERIFIED SAFE — do NOT "fix" these (they look like the sofa bug but aren't)

These raw-UTC `new Date().toISOString().slice(0,10)` sites were checked and are
**correct as-is**. Changing them to MYT would be a regression:

- `scm/lib/bridge-2990.ts:144` `today2990Iso()` — **deliberately UTC**, with a
  docblock explaining why: it must read dates the way 2990 does, or it breaks the
  byte-for-byte blob preservation the whole 2990 sync rests on. **Do not touch.**
- `routes/sales.ts:431`, `routes/assr.ts:1193` — only build a **CSV export
  filename** (`sales_2026-07-23.csv`). Cosmetic; not a data/money date.

Other intentional duplicates the audit ruled out (leave them):
`passwordStrength.ts` (FE/BE, explicit "KEEP IN SYNC" header, verified in sync),
`canonicalHost.ts` (dep-free copy pinned by a test), the two rate limiters
(KV speed-bump vs PG-atomic security), doc-number minters (different grammars),
the two migration trees (prod vs D1-test), `payment-audit-log.ts` (a read-only
view, not a fourth audit sink). FE/BE mirror pairs across the wire are unavoidable
without a shared package; each documents "backend stays the authority".

## The remaining map — ranked (value minus risk). Deferred: needs the staging net.

Each is a multi-file sweep; the benefit is "less confusion / fewer latent bugs",
not a live outage. Doing them blind-merged to prod (no UI verification) trades a
real risk for a cosmetic gain — do them behind the staging bench (see
`SECURITY-DX-ROADMAP.md` step 2), one PR each, verified.

| Concept | Canonical target | N copies | Value | Risk | Notes |
|---|---|---|---|---|---|
| **MYT date (cosmetic dedup)** | `scm/lib/my-time.ts` / `vendor/scm/lib/dates.ts` | ~10 `+8h` inline + a full parallel kit in `agent-console.ts` | MED | LOW | All correct MYT already; converging is cleanliness, not a bug fix (the only bug was the sofa one, fixed). |
| **`shared/` pure-logic drift guard** | add CI parity check | FE/BE copies of `mfg-pricing`, `sofa-*`, `maintenance-pools` | HIGH | LOW | `maintenance-pools.ts` also drifted (FE gained `restrictPricedToPool`). A CI diff-check on the pure-logic copies prevents the next sofa-style drift. |
| **Money formatting** | `vendor/shared/format.ts fmtMoneyCenti` | ~20 page-local `fmtMoney` | MED-HIGH | LOW | Each local copy also renders "MYR NaN" on null; converging fixes that too. Display-only. |
| **Hardcoded `VALID_CURRENCIES` / payment methods** | the `currencies` master + `PAYMENT_METHOD_CODES` | 2 currency, 1 payment, + `VALID_KINDS`/`VALID_TIERS` twins | MED | LOW-MED | The hardcoded currency sets SHADOW the UI-editable master — adding a currency in the UI is silently rejected by PO/PC creation. This one is behavioral, verify carefully. |
| **State lists** | `vendor/scm/components/StatePicker` / lookup | 3 (`Projects.tsx`, `Sales.tsx`, `delivery-planning-queries.ts`) | MED | LOW | Penang vs "Pulau Pinang" spelling split breaks cross-module matching. |
| **`projectScopeWhere(user)`** | build it in `projectAcl.ts` | 5 hand-written SQL predicates | MED | LOW-MED | CLAUDE.md's own roadmap item; now 5 sites (was 3 — drift). |
| **Upload MIME mechanism** | one `lib/uploads.ts` | ~6 per-route copies | MED | MED | Keep per-surface allow-lists; share the mechanism. Partially touched by the XSS PRs. |
| **Frontend fetch clients** | share retry/timeout into common helpers | 2 clients + `slip.ts`/`verified-save.ts` stragglers | MED | MED-HIGH | Don't merge wholesale (vendor boundary + deliberate behaviour diffs); converge resilience only. |
| **Audit tables** | finish `entity_audit_log` migration | 3 tables (`audit_events`, `mfg_so_audit_log`, `entity_audit_log`) | HIGH | HIGH | The consolidation is half-done (entity_audit_log was created to replace mfg_so_audit_log). Needs a DB migration + UI read-path changes. Highest value, highest risk — do it supervised, with a backup, on staging first. |
| **Permissions** | finish `positionPolicy`/`capabilities` | 7 coexisting vocabularies | HIGH | HIGH | Already an in-flight, documented program; finish it, don't start anew. |

## The one habit that stops this recurring

Almost every finding is a half-finished consolidation. Two cheap guards would end
the pattern:
1. **Finish the sweep in the same PR** that introduces a "single source" helper —
   convert all old call sites then, not "later".
2. **A CI grep/parity guard** for the money-critical duplicates (the FE/BE
   `shared/` pure-logic files), so a drift like the sofa bug fails CI the day it
   happens instead of pricing sofas wrong for months.
