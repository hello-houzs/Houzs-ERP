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
- **Families this phase:** `DELIVERY`, `DOCUMENT`. (`CS` reserved — see Phase 2.)

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

Houzs CI **auto-applies `migrations-pg` on every deploy** — all three are
idempotent and self-contained. No manual apply step.

---

## 6. Where the next phases plug in (do NOT rebuild the skeleton)

- **Frontend `/agents` page:** consume §1–3 above. Follow the HOOKKA layout
  (`src/pages/agents/index.tsx` in the hookka repo) as the reference — status
  lights, LLM-spend bars, per-agent card with Run-now / Pause / Auto-approve,
  proposals/findings tables with Approve/Reject/Resolve. **UI needs owner
  mockup approval before coding** (standing rule).
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
