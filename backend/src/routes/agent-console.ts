// ============================================================
// Agent Console API — mounted at /api/agents. Ported from HOOKKA
// (src/api/routes/agent-console.ts; owner OK 2026-07-13 "照搬 verbatim").
//
// OWNER-ONLY (requirePermission("*") — the strictest house gate, same tier
// as the wildcard Owner / IT Admin roles): the console can pause every
// agent and flip autonomy gates, so nothing narrower may reach it.
//
//   GET  /status                — per-family card data (controls, last runs,
//                                 month tokens/cost, pending proposal counts)
//   GET  /review                — the agents' scorecard (skeleton until the
//                                 Delivery/Document engines land)
//   POST /run-now               {task} — inline run of one registered agent
//   POST /pause                 {agent, paused} — pause/resume one family
//   POST /kill-all              {on} — global kill switch (agent='ALL')
//   POST /gate                  {agent, autoApprove} — autonomy gate
//   GET  /config-proposals      ?status= — parameter proposals
//   POST /config-proposals/decide {ids, action} — approve writes the value
//                                 through the whitelist gateway
//   GET  /feedback              ?agent=&status= — owner teachings
//   POST /feedback              {agent, instruction}
//   POST /feedback/:id/retire
//
// Every mutation emits ONE audit_events row (services/audit.ts house
// pattern) so the owner has a full trail of who touched which agent when.
//
// STAYS IN THE PUBLIC /api TREE — never mount under /api/scm (the scm
// subtree swaps c.get('user') to scm.staff UUIDs; here user.id is the
// public bigint).
//
// Dual-key rule kept from HOOKKA on every raw row read (r.camelCase ??
// r.snake_case) — harmless with Houzs's snake_case-as-is pg driver.
// ============================================================
import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { audit } from "../services/audit";
import {
  AGENT_FAMILIES,
  applyConfigProposalValue,
  countPendingConfigProposals,
  familyParamPrefix,
  isKillSwitchOn,
  listAgentControls,
  listAgentFeedback,
  addAgentFeedback,
  retireAgentFeedback,
  listConfigProposals,
  monthLlmUsage,
  setAgentControl,
  taskFamily,
  type AgentFamily,
  type ConfigProposal,
} from "../services/agent-console";
import {
  executeAgentTask,
  getRegisteredAgent,
  registeredAgents,
} from "../services/agent-scheduler";
// Engine bootstrap: registers the Delivery + Document agents with the
// scheduler and pushes their tunables into the config-proposal whitelist.
// This import is what puts them on the heartbeat — do not remove.
import "../services/agents";
import { deliveryAgentStatus } from "../services/agents/delivery-agent";
import { documentAgentStatus } from "../services/agents/document-agent";
import { collectionAgentStatus } from "../services/agents/collection-agent";
import { csAgentStatus } from "../services/agents/cs-agent";
import { procurementAgentStatus } from "../services/agents/procurement-agent";
import { pmsAgentStatus } from "../services/agents/pms-agent";

const app = new Hono<{ Bindings: Env }>();

// Owner-only, whole router.
app.use("*", requirePermission("*"));

// ── GET /status ──────────────────────────────────────────────────────────────

interface RunRow {
  id: string;
  agent: string;
  started_at?: string;
  finished_at?: string | null;
  status: string;
  summary?: string | null;
  tokens_in?: number | string | null;
  tokens_out?: number | string | null;
  error?: string | null;
  startedAt?: string;
  finishedAt?: string | null;
  tokensIn?: number | string | null;
  tokensOut?: number | string | null;
}

function projectRun(r: RunRow) {
  return {
    id: r.id,
    agent: r.agent,
    startedAt: (r.startedAt ?? r.started_at) ?? null,
    finishedAt: (r.finishedAt ?? r.finished_at) ?? null,
    status: r.status,
    summary: r.summary ?? null,
    tokensIn: Number(r.tokensIn ?? r.tokens_in) || 0,
    tokensOut: Number(r.tokensOut ?? r.tokens_out) || 0,
    error: r.error ?? null,
  };
}

app.get("/status", async (c) => {
  const db = c.env.DB;
  const nowIso = new Date().toISOString();
  const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10); // MYT

  const [recentRes, errorRes, controls, llm] = await Promise.all([
    db.prepare("SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT 100").all<RunRow>(),
    db
      .prepare("SELECT * FROM agent_runs WHERE status = 'error' ORDER BY started_at DESC LIMIT 5")
      .all<RunRow>(),
    listAgentControls(db),
    monthLlmUsage(db).catch(() => null),
  ]);

  const recent = (recentRes.results ?? []).map(projectRun);
  const lastByTask = new Map<string, ReturnType<typeof projectRun>>();
  const todayRunsByFamily = new Map<string, number>();
  for (const r of recent) {
    if (!lastByTask.has(r.agent)) lastByTask.set(r.agent, r);
    if ((r.startedAt ?? "").slice(0, 10) === today) {
      const fam = taskFamily(r.agent);
      todayRunsByFamily.set(fam, (todayRunsByFamily.get(fam) ?? 0) + 1);
    }
  }

  const pendingConfigByFamily = new Map<AgentFamily, number>();
  for (const fam of AGENT_FAMILIES) {
    pendingConfigByFamily.set(
      fam,
      await countPendingConfigProposals(db, familyParamPrefix(fam)),
    );
  }

  const controlOf = (agent: string) => controls.find((x) => x.agent === agent);
  const killAll = controlOf("ALL")?.paused === true;
  const regs = registeredAgents();
  const errors = (errorRes.results ?? []).map(projectRun);

  const agents = AGENT_FAMILIES.map((fam) => {
    const ctl = controlOf(fam);
    const famRegs = regs.filter((r) => r.family === fam);
    const usage = llm?.byFamily.find((f) => f.family === fam) ?? null;
    return {
      id: fam,
      // live once its engine registered a run function (Delivery/Document land next).
      live: famRegs.length > 0,
      paused: ctl?.paused === true,
      autoApprove: ctl?.autoApprove === true,
      tasks: famRegs.map((r) => ({
        agent: r.task,
        nextRun: "self-scheduled (30-min heartbeat) · on demand",
        lastRun: lastByTask.get(r.task) ?? null,
      })),
      today: { runs: todayRunsByFamily.get(fam) ?? 0 },
      month: usage
        ? { runs: usage.runs, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, estCostMyr: usage.estCostMyr }
        : { runs: 0, tokensIn: 0, tokensOut: 0, estCostMyr: 0 },
      pendingConfigProposals: pendingConfigByFamily.get(fam) ?? 0,
      recentErrors: errors.filter((e) => taskFamily(e.agent) === fam),
    };
  });

  return c.json({ success: true, data: { killAll, generatedAt: nowIso, agents, llm } });
});

// ── GET /review — the agents' scorecard ──────────────────────────────────────
// Reviewing an agent = reviewing an employee: not re-doing their arithmetic,
// but checking whether what they SAID came TRUE, plus the owner's own
// decision record on their proposals. SKELETON: families + zeroed metrics
// until the Delivery/Document engines register and fill their sections in.

export interface AgentReviewFamily {
  family: AgentFamily;
  /** Owner decision tally on this family's config proposals (30d). */
  decisions: { approved: number; rejected: number };
  /** Engine-specific outcome metrics — filled in by each engine's slice. */
  metrics: Record<string, number | null>;
  note: string;
}

app.get("/review", async (c) => {
  const db = c.env.DB;
  const cutoff30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const countSafe = async (sql: string, ...binds: unknown[]): Promise<number> => {
    try {
      const r = await db.prepare(sql).bind(...binds).first<{ n: number | string }>();
      return Number(r?.n) || 0;
    } catch {
      return 0;
    }
  };

  const families: AgentReviewFamily[] = [];
  for (const fam of AGENT_FAMILIES) {
    const prefix = familyParamPrefix(fam);
    const [approved, rejected] = await Promise.all([
      countSafe(
        "SELECT COUNT(*) AS n FROM config_proposals WHERE status = 'APPROVED' AND decided_at >= ? AND param_key LIKE ?",
        cutoff30,
        `${prefix}%`,
      ),
      countSafe(
        "SELECT COUNT(*) AS n FROM config_proposals WHERE status = 'REJECTED' AND decided_at >= ? AND param_key LIKE ?",
        cutoff30,
        `${prefix}%`,
      ),
    ]);
    families.push({
      family: fam,
      decisions: { approved, rejected },
      metrics: {},
      note: "engines pending",
    });
  }

  return c.json({ success: true, data: { windowDays: 30, families } });
});

// ── POST /run-now {task} ─────────────────────────────────────────────────────
// Manual, explicit owner action: allowed while the FAMILY is paused (pause
// stops the automatic runs), but blocked by the global kill switch — 急停
// means NOTHING moves until it's lifted.

app.post("/run-now", async (c) => {
  const db = c.env.DB;
  let body: { task?: string } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    body = {};
  }
  const task = String(body.task ?? "").toLowerCase();
  const reg = getRegisteredAgent(task);
  if (!reg) {
    const known = registeredAgents().map((r) => r.task);
    return c.json(
      {
        success: false,
        error: known.length
          ? `task must be one of: ${known.join(", ")}`
          : "No agent engines are registered yet (Delivery/Document land next).",
      },
      400,
    );
  }
  if (await isKillSwitchOn(db)) {
    return c.json({
      success: false,
      error: "Global kill switch is ON — turn it off before running an agent.",
    });
  }

  await audit(c, {
    action: "agents.run_now",
    entityType: "agent",
    entityId: reg.task,
    summary: `Run-now ${reg.task}`,
  });

  const summary = await executeAgentTask(c.env, reg, {
    reason: "run-now",
    firstOfDay: true,
  });
  return c.json({ success: true, data: { task: reg.task, summary } });
});

// ── POST /pause {agent, paused} ──────────────────────────────────────────────

app.post("/pause", async (c) => {
  let body: { agent?: string; paused?: boolean } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    body = {};
  }
  const agent = String(body.agent ?? "").toUpperCase() as AgentFamily;
  if (!AGENT_FAMILIES.includes(agent)) {
    return c.json({ success: false, error: "unknown agent" }, 400);
  }
  const paused = body.paused === true;
  await setAgentControl(c.env.DB, agent, { paused });
  await audit(c, {
    action: paused ? "agents.pause" : "agents.resume",
    entityType: "agent",
    entityId: agent,
    summary: `${paused ? "Paused" : "Resumed"} ${agent} agent`,
    meta: { paused },
  });
  return c.json({ success: true, data: { agent, paused } });
});

// ── POST /kill-all {on} ──────────────────────────────────────────────────────

app.post("/kill-all", async (c) => {
  let body: { on?: boolean } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    body = {};
  }
  const on = body.on === true;
  await setAgentControl(c.env.DB, "ALL", { paused: on });
  await audit(c, {
    action: on ? "agents.kill_all" : "agents.kill_all_off",
    entityType: "agent",
    entityId: "ALL",
    summary: on ? "Global agent kill switch ON" : "Global agent kill switch lifted",
    meta: { on },
  });
  return c.json({ success: true, data: { killAll: on } });
});

// ── POST /gate {agent, autoApprove} ──────────────────────────────────────────
// The autonomy gate (提案制 ⇄ 全自动). With it ON, the family applies its own
// whitelisted config proposals (decided_by='AGENT_AUTO') on each run.

app.post("/gate", async (c) => {
  let body: { agent?: string; autoApprove?: boolean } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    body = {};
  }
  const agent = String(body.agent ?? "").toUpperCase() as AgentFamily;
  if (!AGENT_FAMILIES.includes(agent)) {
    return c.json({ success: false, error: "unknown agent" }, 400);
  }
  const autoApprove = body.autoApprove === true;
  await setAgentControl(c.env.DB, agent, { autoApprove });
  await audit(c, {
    action: "agents.gate",
    entityType: "agent",
    entityId: agent,
    summary: `${agent} auto-approve ${autoApprove ? "ON" : "OFF"}`,
    meta: { autoApprove },
  });
  return c.json({ success: true, data: { agent, autoApprove } });
});

// ── Config proposals (learning loop → owner approval → app_settings) ─────────

app.get("/config-proposals", async (c) => {
  const status = (c.req.query("status") ?? "PENDING").toUpperCase();
  const data: ConfigProposal[] = await listConfigProposals(c.env.DB, status);
  return c.json({ success: true, data });
});

// Approve writes the whitelisted parameter through applyConfigProposalValue
// (the SAME gateway the full-auto path uses — manual and autonomous approvals
// can never diverge). Reject just closes the proposal. Non-whitelisted keys
// are REJECTED loudly, never normalized.
app.post("/config-proposals/decide", async (c) => {
  const db = c.env.DB;
  let body: { ids?: unknown; action?: string } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    body = {};
  }
  const action = String(body.action ?? "").toLowerCase();
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 100)
    : [];
  if (ids.length === 0 || !["approve", "reject"].includes(action)) {
    return c.json({ success: false, error: "ids[] and action=approve|reject required" }, 400);
  }

  const nowIso = new Date().toISOString();
  const decidedBy = c.get("userId") != null ? String(c.get("userId")) : null;
  let decided = 0;
  const errors: string[] = [];

  for (const id of ids) {
    const row = await db
      .prepare("SELECT * FROM config_proposals WHERE id = ? AND status = 'PENDING'")
      .bind(id)
      .first<{
        param_key?: string;
        paramKey?: string;
        proposed_value?: string;
        proposedValue?: string;
      }>();
    if (!row) continue; // unknown / already decided

    const paramKey = (row.paramKey ?? row.param_key) ?? "";
    const proposedRaw = (row.proposedValue ?? row.proposed_value) ?? "";

    if (action === "approve") {
      const ok = await applyConfigProposalValue(db, paramKey, proposedRaw);
      if (!ok) {
        errors.push(`${paramKey}: not an approvable parameter`);
        continue;
      }
    }

    await db
      .prepare(
        `UPDATE config_proposals
            SET status = ?, decided_at = ?, decided_by = ?
          WHERE id = ?`,
      )
      .bind(action === "approve" ? "APPROVED" : "REJECTED", nowIso, decidedBy, id)
      .run();
    decided++;

    await audit(c, {
      action: action === "approve" ? "agents.config_approve" : "agents.config_reject",
      entityType: "config_proposal",
      entityId: id,
      summary: `${action === "approve" ? "Approved" : "Rejected"} ${paramKey} → ${proposedRaw}`,
      meta: { paramKey, proposedValue: proposedRaw },
    });
  }

  return c.json({
    success: true,
    data: { decided, skipped: ids.length - decided, ...(errors.length ? { errors } : {}) },
  });
});

// ── Agent feedback (owner teachings) ─────────────────────────────────────────

app.get("/feedback", async (c) => {
  const agent = c.req.query("agent") || undefined;
  const status = (c.req.query("status") ?? "ACTIVE").toUpperCase();
  const data = await listAgentFeedback(c.env.DB, agent, status);
  return c.json({ success: true, data });
});

app.post("/feedback", async (c) => {
  let body: { agent?: string; instruction?: string } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    body = {};
  }
  const agent = String(body.agent ?? "").toUpperCase() as AgentFamily;
  const instruction = String(body.instruction ?? "").trim();
  if (!AGENT_FAMILIES.includes(agent) || !instruction) {
    return c.json({ success: false, error: "agent and instruction required" }, 400);
  }
  const createdBy = c.get("userId") != null ? String(c.get("userId")) : null;
  const id = await addAgentFeedback(c.env.DB, { agent, instruction, createdBy });
  await audit(c, {
    action: "agents.feedback_add",
    entityType: "agent_feedback",
    entityId: id,
    summary: `Taught ${agent}: ${instruction.slice(0, 120)}`,
  });
  return c.json({ success: true, data: { id } });
});

app.post("/feedback/:id/retire", async (c) => {
  const id = c.req.param("id");
  await retireAgentFeedback(c.env.DB, id);
  await audit(c, {
    action: "agents.feedback_retire",
    entityType: "agent_feedback",
    entityId: id,
    summary: "Retired agent instruction",
  });
  return c.json({ success: true, data: { id } });
});

// ═══ Engine endpoints — Delivery ═════════════════════════════════════════════
// The console UI's working surfaces. Approval here marks a plan APPROVED for
// the office to execute through the existing flows — it NEVER creates,
// edits or dispatches DOs/trips (AGENTS-BLUEPRINT red line).

/** jsonb columns arrive as objects from the pg driver but as strings from
 *  older shim paths — accept both. */
function asJson(v: unknown): unknown {
  if (typeof v !== "string") return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

interface EngineProposalRow {
  id: string;
  kind: string;
  key: string;
  status: string;
  payload?: unknown;
  summary?: string | null;
  created_at?: string;
  createdAt?: string;
  decided_at?: string | null;
  decidedAt?: string | null;
  decided_by?: string | null;
  decidedBy?: string | null;
}

function projectProposal(r: EngineProposalRow) {
  return {
    id: r.id,
    kind: r.kind,
    key: r.key,
    status: r.status,
    payload: asJson(r.payload),
    summary: r.summary ?? "",
    createdAt: (r.createdAt ?? r.created_at) ?? null,
    decidedAt: (r.decidedAt ?? r.decided_at) ?? null,
    decidedBy: (r.decidedBy ?? r.decided_by) ?? null,
  };
}

app.get("/delivery/status", async (c) => {
  return c.json({ success: true, data: await deliveryAgentStatus(c.env) });
});

app.get("/delivery/proposals", async (c) => {
  const status = (c.req.query("status") ?? "PENDING").toUpperCase();
  const kind = (c.req.query("kind") ?? "").toUpperCase();
  const params: string[] = [status];
  let where = "status = ?";
  if (kind) {
    where += " AND kind = ?";
    params.push(kind);
  }
  const res = await c.env.DB.prepare(
    `SELECT * FROM delivery_agent_proposals WHERE ${where}
      ORDER BY created_at DESC LIMIT 200`,
  )
    .bind(...params)
    .all<EngineProposalRow>();
  return c.json({
    success: true,
    data: (res.results ?? []).map(projectProposal),
  });
});

app.post("/delivery/proposals/decide", async (c) => {
  let body: { ids?: unknown; action?: string } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    body = {};
  }
  const action = String(body.action ?? "").toLowerCase();
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 100)
    : [];
  if (ids.length === 0 || !["approve", "reject"].includes(action)) {
    return c.json({ success: false, error: "ids[] and action=approve|reject required" }, 400);
  }
  const nowIso = new Date().toISOString();
  const decidedBy = c.get("userId") != null ? String(c.get("userId")) : null;
  const next = action === "approve" ? "APPROVED" : "REJECTED";
  let decided = 0;
  for (const id of ids) {
    const r = await c.env.DB.prepare(
      `UPDATE delivery_agent_proposals
          SET status = ?, decided_at = ?, decided_by = ?
        WHERE id = ? AND status = 'PENDING'`,
    )
      .bind(next, nowIso, decidedBy, id)
      .run();
    decided += Number(r.meta?.changes ?? r.meta?.rows_written ?? 0) > 0 ? 1 : 0;
  }
  await audit(c, {
    action: `agents.delivery_proposal_${action}`,
    entityType: "delivery_agent_proposal",
    entityId: ids.join(","),
    summary: `${next} ${decided}/${ids.length} delivery proposal(s)`,
    meta: { ids, action },
  });
  return c.json({ success: true, data: { decided, status: next } });
});

app.get("/delivery/brief", async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT * FROM delivery_agent_briefs ORDER BY created_at DESC LIMIT 1`,
  ).first<{
    id: string;
    brief?: unknown;
    ai_focus?: string | null;
    aiFocus?: string | null;
    created_at?: string;
    createdAt?: string;
  }>();
  if (!r) return c.json({ success: true, data: null });
  return c.json({
    success: true,
    data: {
      id: r.id,
      brief: asJson(r.brief),
      aiFocus: (r.aiFocus ?? r.ai_focus) ?? null,
      createdAt: (r.createdAt ?? r.created_at) ?? null,
    },
  });
});

// ═══ Engine endpoints — Document ═════════════════════════════════════════════
// Findings are READ-mostly: resolve here only dismisses the flag; the patrol
// re-opens a fresh finding if the underlying condition still holds next run.

interface FindingRow {
  id: string;
  kind: string;
  severity: string;
  doc_type?: string;
  docType?: string;
  doc_id?: string;
  docId?: string;
  doc_no?: string | null;
  docNo?: string | null;
  summary?: string | null;
  payload?: unknown;
  status: string;
  created_at?: string;
  createdAt?: string;
  last_seen_at?: string | null;
  lastSeenAt?: string | null;
  resolved_at?: string | null;
  resolvedAt?: string | null;
}

app.get("/document/status", async (c) => {
  return c.json({ success: true, data: await documentAgentStatus(c.env) });
});

app.get("/document/findings", async (c) => {
  const status = (c.req.query("status") ?? "OPEN").toUpperCase();
  const kind = (c.req.query("kind") ?? "").toUpperCase();
  const severity = (c.req.query("severity") ?? "").toUpperCase();
  const params: string[] = [status];
  let where = "status = ?";
  if (kind) {
    where += " AND kind = ?";
    params.push(kind);
  }
  if (severity) {
    where += " AND severity = ?";
    params.push(severity);
  }
  const res = await c.env.DB.prepare(
    `SELECT * FROM document_agent_findings WHERE ${where}
      ORDER BY CASE severity WHEN 'CRIT' THEN 0 WHEN 'WARN' THEN 1 ELSE 2 END,
               created_at ASC
      LIMIT 200`,
  )
    .bind(...params)
    .all<FindingRow>();
  return c.json({
    success: true,
    data: (res.results ?? []).map((r) => ({
      id: r.id,
      kind: r.kind,
      severity: r.severity,
      docType: (r.docType ?? r.doc_type) ?? "",
      docId: (r.docId ?? r.doc_id) ?? "",
      docNo: (r.docNo ?? r.doc_no) ?? null,
      summary: r.summary ?? "",
      payload: asJson(r.payload),
      status: r.status,
      createdAt: (r.createdAt ?? r.created_at) ?? null,
      lastSeenAt: (r.lastSeenAt ?? r.last_seen_at) ?? null,
      resolvedAt: (r.resolvedAt ?? r.resolved_at) ?? null,
    })),
  });
});

app.post("/document/findings/resolve", async (c) => {
  let body: { ids?: unknown } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    body = {};
  }
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 100)
    : [];
  if (ids.length === 0) {
    return c.json({ success: false, error: "ids[] required" }, 400);
  }
  const nowIso = new Date().toISOString();
  let resolved = 0;
  for (const id of ids) {
    const r = await c.env.DB.prepare(
      `UPDATE document_agent_findings
          SET status = 'RESOLVED', resolved_at = ?
        WHERE id = ? AND status = 'OPEN'`,
    )
      .bind(nowIso, id)
      .run();
    resolved += Number(r.meta?.changes ?? r.meta?.rows_written ?? 0) > 0 ? 1 : 0;
  }
  await audit(c, {
    action: "agents.document_finding_resolve",
    entityType: "document_agent_finding",
    entityId: ids.join(","),
    summary: `Manually resolved ${resolved}/${ids.length} document finding(s)`,
    meta: { ids },
  });
  return c.json({ success: true, data: { resolved } });
});

app.get("/document/brief", async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT * FROM document_agent_briefs ORDER BY generated_at DESC LIMIT 1`,
  ).first<{
    id: string;
    brief?: unknown;
    generated_at?: string;
    generatedAt?: string;
  }>();
  if (!r) return c.json({ success: true, data: null });
  return c.json({
    success: true,
    data: {
      id: r.id,
      brief: asJson(r.brief),
      generatedAt: (r.generatedAt ?? r.generated_at) ?? null,
    },
  });
});

// ═══ Engine endpoints — Phase-2 engines (Collection / CS / Procurement / PMS) ══
// Every Phase-2 engine exposes the SAME four-route surface as Delivery
// (status / proposals list / proposals decide / latest brief) over its own
// proposal + brief tables (migrations 0094-0097, all created_at-ordered). One
// factory registers them so the four families can never drift apart. Approving
// a proposal only marks it decided for the office to act on — the PROPOSAL-ONLY
// red line holds for every family (no engine creates/edits a business document).

function mountEngineRoutes(opts: {
  base: string; // URL segment + audit/action slug, e.g. 'collection'
  proposalTable: string;
  briefTable: string;
  auditEntity: string;
  status: (env: Env) => Promise<unknown>;
}) {
  const { base, proposalTable, briefTable, auditEntity, status } = opts;

  app.get(`/${base}/status`, async (c) => {
    return c.json({ success: true, data: await status(c.env) });
  });

  app.get(`/${base}/proposals`, async (c) => {
    const st = (c.req.query("status") ?? "PENDING").toUpperCase();
    const kind = (c.req.query("kind") ?? "").toUpperCase();
    const params: string[] = [st];
    let where = "status = ?";
    if (kind) {
      where += " AND kind = ?";
      params.push(kind);
    }
    const res = await c.env.DB.prepare(
      `SELECT * FROM ${proposalTable} WHERE ${where} ORDER BY created_at DESC LIMIT 200`,
    )
      .bind(...params)
      .all<EngineProposalRow>();
    return c.json({ success: true, data: (res.results ?? []).map(projectProposal) });
  });

  app.post(`/${base}/proposals/decide`, async (c) => {
    let body: { ids?: unknown; action?: string } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      body = {};
    }
    const action = String(body.action ?? "").toLowerCase();
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 100)
      : [];
    if (ids.length === 0 || !["approve", "reject"].includes(action)) {
      return c.json({ success: false, error: "ids[] and action=approve|reject required" }, 400);
    }
    const nowIso = new Date().toISOString();
    const decidedBy = c.get("userId") != null ? String(c.get("userId")) : null;
    const next = action === "approve" ? "APPROVED" : "REJECTED";
    let decided = 0;
    for (const id of ids) {
      const r = await c.env.DB.prepare(
        `UPDATE ${proposalTable}
            SET status = ?, decided_at = ?, decided_by = ?
          WHERE id = ? AND status = 'PENDING'`,
      )
        .bind(next, nowIso, decidedBy, id)
        .run();
      decided += Number(r.meta?.changes ?? r.meta?.rows_written ?? 0) > 0 ? 1 : 0;
    }
    await audit(c, {
      action: `agents.${base}_proposal_${action}`,
      entityType: auditEntity,
      entityId: ids.join(","),
      summary: `${next} ${decided}/${ids.length} ${base} proposal(s)`,
      meta: { ids, action },
    });
    return c.json({ success: true, data: { decided, status: next } });
  });

  app.get(`/${base}/brief`, async (c) => {
    const r = await c.env.DB.prepare(
      `SELECT * FROM ${briefTable} ORDER BY created_at DESC LIMIT 1`,
    ).first<{
      id: string;
      brief?: unknown;
      ai_focus?: string | null;
      aiFocus?: string | null;
      created_at?: string;
      createdAt?: string;
    }>();
    if (!r) return c.json({ success: true, data: null });
    return c.json({
      success: true,
      data: {
        id: r.id,
        brief: asJson(r.brief),
        aiFocus: (r.aiFocus ?? r.ai_focus) ?? null,
        createdAt: (r.createdAt ?? r.created_at) ?? null,
      },
    });
  });
}

mountEngineRoutes({
  base: "collection",
  proposalTable: "collection_agent_proposals",
  briefTable: "collection_agent_briefs",
  auditEntity: "collection_agent_proposal",
  status: collectionAgentStatus,
});

mountEngineRoutes({
  base: "cs",
  proposalTable: "cs_agent_proposals",
  briefTable: "cs_agent_briefs",
  auditEntity: "cs_agent_proposal",
  status: csAgentStatus,
});

mountEngineRoutes({
  base: "procurement",
  proposalTable: "procurement_agent_proposals",
  briefTable: "procurement_agent_briefs",
  auditEntity: "procurement_agent_proposal",
  status: procurementAgentStatus,
});

mountEngineRoutes({
  base: "pms",
  proposalTable: "pms_agent_proposals",
  briefTable: "pms_agent_briefs",
  auditEntity: "pms_agent_proposal",
  status: pmsAgentStatus,
});

export default app;
