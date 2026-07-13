# Agent Console — API Contract (Phase 1)

Backend for the Houzs Agent Console, ported from the HOOKKA fleet (owner OK
2026-07-13, skeleton verbatim). This doc is the **handoff contract**: everything
a frontend `/agents` page or a next-phase agent (CS / PMS / Procurement) needs to
build against, without reading the source.

- **Router:** `backend/src/routes/agent-console.ts`, mounted at **`/api/agents`**
  (`backend/src/index.ts:220`).
- **Auth:** the whole router is `requirePermission("*")` — Owner / IT Admin only.
  Every other role gets 403. (Same tier as the wildcard house gate.)
- **Response envelope:** every route returns `{ success: boolean, data?, error? }`.
  Mutations also write ONE `audit_events` row.
- **Money:** always integer **sen** (RM × 100). Format on the client.
- **Timestamps:** ISO 8601 text.
- **Families:** `DELIVERY`, `DOCUMENT`, `CS`, `COLLECTION`, `PROCUREMENT`, `PMS`.

---

## 1. Console-wide (skeleton)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/agents/status` | — | Per-family cards: controls (paused / auto_approve), last runs, this-month tokens + est. MYR cost, pending config-proposal counts, plus each registered agent's own status counters. |
| GET | `/api/agents/review` | — | Scorecard skeleton (families present, metrics zeroed with `note`) — Phase 2 fills said-vs-happened. |
| POST | `/api/agents/run-now` | `{task}` | Inline-runs one registered task (`"delivery-run"` \| `"document-run"`). Treated as first-of-day so it may spend LLM budget. Returns the run summary. |
| POST | `/api/agents/pause` | `{agent, paused}` | Pause/resume one family. `agent` ∈ families. |
| POST | `/api/agents/kill-all` | `{on}` | Global kill switch (`agent='ALL'`) — blocks even manual runs. |
| POST | `/api/agents/gate` | `{agent, autoApprove}` | Autonomy gate per family. ON = agent self-applies its own whitelisted config proposals after each run. Fail-CLOSED. |

### Config proposals (learning-loop parameter changes)

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/agents/config-proposals` | `?status=PENDING` | Learner-proposed parameter changes (current → proposed + reason). |
| POST | `/api/agents/config-proposals/decide` | `{ids[], action}` | `action=approve` writes the value through the **whitelist gateway** (`applyConfigProposalValue`) — out-of-bounds keys/values are REJECTED, never clamped. `reject` just closes the row. Max 100 ids. |

### Owner feedback ("teach the agent")

| Method | Path | Body |
|---|---|---|
| GET | `/api/agents/feedback` | `?agent=&status=` |
| POST | `/api/agents/feedback` | `{agent, instruction}` — ACTIVE rows inject into that family's brain prompt every run |
| POST | `/api/agents/feedback/:id/retire` | — (stops injection; never hard-deleted) |

---

## 2. Delivery agent surface

Proposals only — approving marks a plan **APPROVED for the office to execute via
existing flows**; the agent NEVER creates/edits/dispatches DOs or trips.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/agents/delivery/status` | — | `{openProposals, openByKind, lastBriefAt}` |
| GET | `/api/agents/delivery/proposals` | `?status=PENDING&kind=LOAD_PLAN` | Proposal rows: `{id, kind, key, status, payload, summary, createdAt, decidedAt, decidedBy}`. `kind` ∈ `LOAD_PLAN` \| `POD_CHASE`. `payload` is parsed JSON. |
| POST | `/api/agents/delivery/proposals/decide` | `{ids[], action}` | `approve`→APPROVED, `reject`→REJECTED (PENDING rows only). Returns `{decided, status}`. |
| GET | `/api/agents/delivery/brief` | — | Latest daily brief: `{id, brief, aiFocus, createdAt}`. `brief` shape below. |

**`brief` object** (`DeliveryBriefData`): `pendingPool {total, byPlanningState, readyByRegion[], readyByState[]}`, `overdueToDeliver {count, rows[]}`, `doPipeline {byStatus}`, `podGaps {count, rows[]}`, `trips {today[], tomorrow[]}`, `openProposals {total, byKind}`. `aiFocus` is the once-a-day LLM paragraph (null on staging / over budget / brain failure — by design).

**Tunable (learner):** `delivery.transitDays.<STATE>` — per-state transit working days, bounds 0–10, lands in `app_settings['agents.delivery'].transitDaysByState`.

---

## 3. Document agent surface

Read-only over business documents — resolving a finding only dismisses the flag;
the next patrol re-opens it if the condition still holds.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/agents/document/status` | — | `{openFindings, bySeverity, byKind, lastBriefAt}` |
| GET | `/api/agents/document/findings` | `?status=OPEN&kind=&severity=` | Findings sorted CRIT→WARN→INFO then oldest-first: `{id, kind, severity, docType, docId, docNo, summary, payload, status, createdAt, lastSeenAt, resolvedAt}`. |
| POST | `/api/agents/document/findings/resolve` | `{ids[]}` | Manually resolve OPEN findings. Returns `{resolved}`. |
| GET | `/api/agents/document/brief` | — | Latest brief: `{id, brief, generatedAt}`. |

**Finding kinds:** `INVOICE_GAP`, `STUCK_SO`, `STALE_DRAFT`, `UNPAID_SI` (the collection section, aged 0-30/31-60/61-90/90+), `GRN_NO_PI`, `PAYMENT_MISMATCH`.
**Severity:** `INFO` \| `WARN` \| `CRIT`.
**`brief` object:** open findings by kind/severity, top-10 most urgent, collection aging totals (sen).

---

## 3b. Phase-2 engines — shared surface

The four Phase-2 families (`collection`, `cs`, `procurement`, `pms`) all expose
the SAME four-route surface as Delivery, over their own proposal + brief tables
(one route factory, `mountEngineRoutes`, registers them — they can't drift):

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/agents/<base>/status` | — | family-specific counters (see below) |
| GET | `/api/agents/<base>/proposals` | `?status=PENDING&kind=` | proposal rows `{id, kind, key, status, payload, summary, createdAt, decidedAt, decidedBy}`, newest first, `payload` parsed |
| POST | `/api/agents/<base>/proposals/decide` | `{ids[], action}` | `approve`→APPROVED / `reject`→REJECTED (PENDING only, max 100). Returns `{decided, status}` |
| GET | `/api/agents/<base>/brief` | — | latest brief `{id, brief, aiFocus, createdAt}` |

`<base>` ∈ `collection` \| `cs` \| `procurement` \| `pms`. Approval marks a
proposal ready for the office — PROPOSAL-ONLY holds for every family (no engine
creates or edits a business document). All four never create/edit `scm.*` rows.

### Collection (`collection`)
- **Proposal kind:** `DEBTOR_CHASE` — one per debtor with unpaid AR past the
  chase threshold; `payload` groups that debtor's invoices with buckets +
  outstanding sen, severity, worst bucket. `key` = `DEBTOR_CHASE:<debtorName>`.
- **status:** `{openProposals, lastBriefAt, totalOutstandingSen}`.
- **brief:** total outstanding, aging buckets (0-30/31-60/61-90/90+), top-10
  worst debtors, oldest-invoice age.
- **Tunable:** `app_settings['agents.collection'].chaseThresholdDays` (0-90, default 1).

### CS (`cs`) — never invents a date
- **Proposal kinds:** `PROMISE_DATE` (an SO whose realistic promise date — stock-ready
  date from PO ETAs + per-state transit — differs from what the customer was told;
  SOs with any uncovered shortage are reported as *cannotPromise*, never dated) and
  `ASSR_SLA` (after-sales case breaching / near its SLA). Reuses `computeMrp` for
  per-line ETAs and the Delivery agent's learned `transitDaysByState`.
- **status:** `{openProposals, openByKind, lastBriefAt}`.
- **brief:** `promise {promisable, cannotPromise, upcoming[]}`, `assr {openCases, breached, atRisk, byPriority}`.
- **Tunable:** `app_settings['agents.cs'].assrWarnHours` (1-168, default 24).

### Procurement (`procurement`) — readiness-gate-first, PROPOSAL-ONLY
- **Proposal kind:** `REORDER` — one per supplier, aggregating shortage SKUs
  (qty + order-by date; no cost invented). Proposals live in
  `procurement_agent_proposals`, NOT `scm.purchase_orders`, so MRP never
  double-counts them as supply. On approval the office raises the PO via the
  existing SO→PO converter.
- **Readiness gate:** no `REORDER` proposals until supplier-binding coverage of
  shortage SKUs ≥ `minCoveragePct` (default 90). While gated, the brief lists
  the SKUs missing a supplier binding instead.
- **status:** `{openProposals, lastBriefAt, shortageSkuCount}`.
- **brief:** `{gated, coveragePct, minCoveragePct, shortage{}, reorderBySupplier[], unsuppliedSkus[], topShortages[]}`.
- **Not built here (documented follow-up):** auto-send of the approved PO to the
  supplier by **email** (add a `purchase_order` channel to `services/email.ts` —
  4 edits + one D1 toggle migration, default-OFF fail-closed) and **WhatsApp**
  (greenfield — needs Meta Cloud API business verification + template approval;
  nothing exists in either ERP). `renderPoPrintHtml` (`scm/lib/po.ts`) is the
  ready-but-unwired PO document renderer.

### PMS / Roadshow (`pms`)
- **Analytics brief (read-only):** sales by category (5 SO-header buckets), brand,
  state, salesperson, venue — each row `{label, soCount, revenueSen, costSen, marginSen, marginPct}`
  — plus `salespersonByState` (top cross cells: who sells especially well where).
  All from the `mfg_sales_orders` header (no cross-DB join).
- **Per-dimension readiness gate:** each of {salesperson, venue, brand, state}
  carries `{fillRatePct, gated}` — a dimension whose populated-fill-rate is below
  `minCoveragePct` (default 90) is flagged *gated* (rows kept, not dropped). This
  is the owner-flagged data-readiness gate: salesperson/venue stay gated until the
  owner assigns Sales Attending + the 22 venues.
- **Proposal kind:** `PROJECT_CHASE` — a project whose `end_date` has passed but
  is not yet at stage teardown/closed/cancelled. `key` = `PROJECT_CHASE:<code|name>`.
- **status:** `{openProposals, lastBriefAt}`.
- **Tunables:** `app_settings['agents.pms'].analyticsWindowDays` (30-1095, default
  365), `.minCoveragePct` (0-100, default 90).

---

## 4. How the agents run (for the FE status page + ops)

- **Heartbeat:** the existing `*/30 * * * *` Worker cron calls `runAgentHeartbeat`
  (`backend/src/index.ts`). The cron carries no cadence; `decideAgentRuns`
  (`services/agent-scheduler.ts`) reads the business pulse each beat and decides
  run/skip, with a human-readable reason on every decision (lands in the run
  summary). Hard bounds: max 6 runs/day, ≥1h gap. Effective cadence: Delivery
  first run after 07:30 MYT then event-driven (≥3 dispatch/deliver events),
  Document after 09:00 MYT then event-driven (any new delivery).
- **LLM:** one shared brain (`services/agent-brain.ts`, `claude-sonnet-4-6`,
  same as scan-so). Best-effort — no key / HTTP error / over budget → the AI
  paragraph is null and every deterministic number still ships. Budget:
  RM150/family/month (`app_settings['agents.schedule'].llmMonthlyBudgetMyr`).
- **Staging note:** staging has no `ANTHROPIC_API_KEY` → all engines run, briefs
  have `aiFocus: null`. This is expected, not a bug.

---

## 5. Tables (migrations 0091–0093, public schema)

- `agent_runs`, `agent_controls` (+ seeded `'ALL'` kill row), `config_proposals`,
  `agent_feedback` — 0091.
- `delivery_agent_proposals`, `delivery_agent_briefs` — 0092.
- `document_agent_findings` (partial-unique `(kind,doc_type,doc_id) WHERE status='OPEN'`),
  `document_agent_briefs` — 0093.
- `collection_agent_proposals`, `collection_agent_briefs` — 0094.
- `cs_agent_proposals`, `cs_agent_briefs` — 0095.
- `procurement_agent_proposals`, `procurement_agent_briefs` — 0096.
- `pms_agent_proposals`, `pms_agent_briefs` — 0097.

Houzs CI **auto-applies `migrations-pg` on every deploy** — all three are
idempotent and self-contained. No manual apply step.

---

## 6. Where the next phases plug in (do NOT rebuild the skeleton)

- **Frontend `/agents` page:** SHIPPED — `frontend/src/pages/Agents.tsx`,
  route `/agents` in `App.tsx` (owner-only `<Guard anyPerm={["*"]}>`), nav item
  in `Sidebar.tsx` (System section, `Bot` icon). Consumes §1–3b: family control
  grid (pause / auto-approve / run-now / kill-all), LLM-spend bars per family,
  per-family working surface (proposals approve/reject, Document findings
  resolve), the learned-tuning approvals (§1 config proposals) and the
  per-agent teaching notebook (§1 feedback). Built to the owner-approved mockup.
- **New agent engine (CS / PMS / Procurement):** create
  `backend/src/services/agents/<name>-agent.ts`, keep it a pure deterministic
  engine, then in `backend/src/services/agents/index.ts` add ONE `registerAgent({
  family, task, cadence, shouldRunExtra?, run })` block (Delivery is the worked
  example) and, if it has a tunable, push one `ConfigParamRule` into
  `CONFIG_PROPOSAL_RULES`. The heartbeat, `/status`, `/run-now`, budget, audit and
  auto-approve all pick it up automatically. Add the family to `AGENT_FAMILIES`
  (`services/agent-console.ts`). Add engine-specific list/decide endpoints to the
  router following the §2/§3 pattern.
- **Config whitelist is the only write path** for learned parameters — never let
  an agent write `app_settings` directly.
