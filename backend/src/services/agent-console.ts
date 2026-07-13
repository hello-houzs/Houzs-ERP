// ---------------------------------------------------------------------------
// agent-console.ts — Agent Console runtime: run logging, family controls,
// LLM budget guard, config-proposal framework, owner-feedback notebook.
// Ported from HOOKKA (src/api/lib/agent-console.ts + agent-learning.ts
// config_proposals parts + agent-feedback.ts; owner OK 2026-07-13).
//
// HOUZS ADAPTATIONS:
//   * Tables come from migration 0091 (migrate-before-deploy) — HOOKKA's
//     runtime self-apply ensure* pattern is intentionally NOT ported.
//   * DB handle = env.DB (the d1-compat shim over postgres.js the whole
//     public tree uses). Row reads stay dual-keyed (r.camelCase ??
//     r.snake_case) exactly like HOOKKA / routes/announcements.ts.
//   * kv_config → app_settings (Houzs's key/value JSON store). Schedule +
//     budget live under app_settings['agents.schedule']; approved config
//     proposals write into the rule's own app_settings key.
//   * Families = DELIVERY / DOCUMENT / CS (the Houzs fleet), not HOOKKA's
//     PRODUCTION-centric set.
// ---------------------------------------------------------------------------

/** Agent family ids used by agent_controls (plus the 'ALL' kill-switch row). */
export type AgentFamily =
  | "DELIVERY"
  | "DOCUMENT"
  | "CS"
  | "COLLECTION"
  | "PROCUREMENT"
  | "PMS";

export const AGENT_FAMILIES: AgentFamily[] = [
  "DELIVERY",
  "DOCUMENT",
  "CS",
  "COLLECTION",
  "PROCUREMENT",
  "PMS",
];

// ── Run logging ──────────────────────────────────────────────────────────────

export interface AgentRunHandle {
  /** Accumulate Anthropic token usage (call once per API response). */
  addTokens(tokensIn: number, tokensOut: number): void;
  /** Human-readable one-liner shown on the console ("sent 2 · failed 0"). */
  setSummary(summary: string): void;
}

/**
 * Wrap ONE agent execution: inserts a 'running' agent_runs row, runs `fn`,
 * then finalises the row as ok/error. The wrapped function's result (or
 * throw) passes straight through — logging never changes behaviour. Token
 * usage is whatever the fn reported via the handle (0 when the run made no
 * LLM call — a pure engine run).
 */
export async function recordAgentRun<T>(
  db: D1Database,
  agent: string,
  fn: (run: AgentRunHandle) => Promise<T>,
): Promise<T> {
  const id = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  let tokensIn = 0;
  let tokensOut = 0;
  let summary = "";
  const handle: AgentRunHandle = {
    addTokens(i, o) {
      tokensIn += Math.max(0, Math.floor(Number(i) || 0));
      tokensOut += Math.max(0, Math.floor(Number(o) || 0));
    },
    setSummary(s) {
      summary = String(s ?? "").slice(0, 500);
    },
  };
  try {
    await db
      .prepare(
        "INSERT INTO agent_runs (id, agent, started_at, status) VALUES (?,?,?, 'running')",
      )
      .bind(id, agent, startedAt)
      .run();
  } catch (e) {
    // Logging must never block the actual work — run the fn unlogged.
    console.warn(`[agent-runs] failed to open run for ${agent}:`, e);
    return fn(handle);
  }
  try {
    const result = await fn(handle);
    await db
      .prepare(
        `UPDATE agent_runs
            SET finished_at = ?, status = 'ok', summary = ?, tokens_in = ?, tokens_out = ?
          WHERE id = ?`,
      )
      .bind(new Date().toISOString(), summary || null, tokensIn, tokensOut, id)
      .run()
      .catch((e: unknown) =>
        console.warn(`[agent-runs] failed to close run ${id}:`, e),
      );
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .prepare(
        `UPDATE agent_runs
            SET finished_at = ?, status = 'error', error = ?, tokens_in = ?, tokens_out = ?
          WHERE id = ?`,
      )
      .bind(new Date().toISOString(), msg.slice(0, 800), tokensIn, tokensOut, id)
      .run()
      .catch((e: unknown) =>
        console.warn(`[agent-runs] failed to record error for ${id}:`, e),
      );
    throw err;
  }
}

// ── Pause / kill-switch checks ───────────────────────────────────────────────

interface ControlRow {
  agent: string;
  paused: number | string | null;
  auto_approve?: number | string | null;
  updated_at?: string | null;
  // Defensive dual-key (HOOKKA read-gotcha; harmless when the driver returns
  // snake_case as-is, which Houzs's pg.ts does).
  autoApprove?: number | string | null;
  updatedAt?: string | null;
}

/**
 * True when the agent family OR the global 'ALL' row is paused. Fails OPEN
 * (returns false) on any DB error so a broken controls table can never
 * silence the agents.
 */
export async function isAgentPaused(
  db: D1Database,
  family: AgentFamily,
): Promise<boolean> {
  try {
    const res = await db
      .prepare(
        "SELECT agent, paused FROM agent_controls WHERE agent IN ('ALL', ?)",
      )
      .bind(family)
      .all<ControlRow>();
    return (res.results ?? []).some((r) => Number(r.paused) === 1);
  } catch (e) {
    console.warn("[agent-controls] paused check failed (failing open):", e);
    return false;
  }
}

/**
 * True when the family's auto-approve gate is ON and nothing pauses it.
 * This is the AUTONOMY switch — agent-initiated runs apply their own
 * proposals when this returns true. Fails CLOSED (false) on any error:
 * autonomy must never turn itself on by accident.
 */
export async function isAutoApproveOn(
  db: D1Database,
  family: AgentFamily,
): Promise<boolean> {
  try {
    const res = await db
      .prepare(
        "SELECT agent, paused, auto_approve FROM agent_controls WHERE agent IN ('ALL', ?)",
      )
      .bind(family)
      .all<ControlRow>();
    const rows = res.results ?? [];
    if (rows.some((r) => Number(r.paused) === 1)) return false;
    const fam = rows.find((r) => r.agent === family);
    return Number(fam?.autoApprove ?? fam?.auto_approve) === 1;
  } catch {
    return false;
  }
}

/** True when the global kill switch (agent='ALL') is on. */
export async function isKillSwitchOn(db: D1Database): Promise<boolean> {
  try {
    const r = await db
      .prepare("SELECT paused FROM agent_controls WHERE agent = 'ALL'")
      .first<ControlRow>();
    return Number(r?.paused) === 1;
  } catch {
    return false;
  }
}

export interface AgentControlState {
  agent: string;
  paused: boolean;
  autoApprove: boolean;
  updatedAt: string | null;
}

export async function listAgentControls(
  db: D1Database,
): Promise<AgentControlState[]> {
  const res = await db.prepare("SELECT * FROM agent_controls").all<ControlRow>();
  return (res.results ?? []).map((r) => ({
    agent: r.agent,
    paused: Number(r.paused) === 1,
    autoApprove: Number(r.autoApprove ?? r.auto_approve) === 1,
    updatedAt: (r.updatedAt ?? r.updated_at) ?? null,
  }));
}

/** Upsert one control row (only the provided flags change). */
export async function setAgentControl(
  db: D1Database,
  agent: AgentFamily | "ALL",
  patch: { paused?: boolean; autoApprove?: boolean },
): Promise<void> {
  const nowIso = new Date().toISOString();
  const existing = await db
    .prepare("SELECT * FROM agent_controls WHERE agent = ?")
    .bind(agent)
    .first<ControlRow>();
  const paused =
    patch.paused ?? (existing ? Number(existing.paused) === 1 : false);
  const autoApprove =
    patch.autoApprove ??
    (existing
      ? Number(existing.autoApprove ?? existing.auto_approve) === 1
      : false);
  await db
    .prepare(
      `INSERT INTO agent_controls (agent, paused, auto_approve, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(agent) DO UPDATE SET
         paused = excluded.paused,
         auto_approve = excluded.auto_approve,
         updated_at = excluded.updated_at`,
    )
    .bind(agent, paused ? 1 : 0, autoApprove ? 1 : 0, nowIso)
    .run();
}

// ── LLM spend monitor + per-agent monthly budget limit ───────────────────────
//
// Each agent FAMILY gets a hard monthly LLM budget of RM 150
// (app_settings['agents.schedule'].llmMonthlyBudgetMyr, bounded 10..10000)
// and talks freely until it's spent. At the limit only that family's AI
// paragraphs stop; every deterministic engine keeps running untouched.
// Token usage comes from agent_runs (recordAgentRun writes it on every run).

/** Claude Sonnet list prices — for the console's ESTIMATE only. */
const USD_PER_MTOK_IN = 3;
const USD_PER_MTOK_OUT = 15;
const USD_TO_MYR_EST = 4.7;

const DEFAULT_LLM_MONTHLY_BUDGET_MYR = 150; // per agent family, per month
const MIN_LLM_BUDGET_MYR = 10;
const MAX_LLM_BUDGET_MYR = 10_000;

/** app_settings key holding the agent schedule + budget overrides (JSON). */
export const AGENT_SCHEDULE_SETTING_KEY = "agents.schedule";

function estMyr(tokensIn: number, tokensOut: number): number {
  const usd =
    (tokensIn / 1_000_000) * USD_PER_MTOK_IN + (tokensOut / 1_000_000) * USD_PER_MTOK_OUT;
  return Math.round(usd * USD_TO_MYR_EST * 100) / 100;
}

/** agent_runs task id → agent family (budget is per FAMILY). */
export function taskFamily(task: string): AgentFamily | "OTHER" {
  const t = task.toLowerCase();
  if (t.startsWith("delivery")) return "DELIVERY";
  if (t.startsWith("document")) return "DOCUMENT";
  if (t.startsWith("collection")) return "COLLECTION";
  if (t.startsWith("procurement")) return "PROCUREMENT";
  if (t.startsWith("pms")) return "PMS";
  if (t.startsWith("cs")) return "CS";
  return "OTHER";
}

/** Read + JSON-parse one app_settings value; null on any failure. */
export async function readAgentSetting<T>(
  db: D1Database,
  key: string,
): Promise<T | null> {
  try {
    const row = await db
      .prepare("SELECT value FROM app_settings WHERE key = ?")
      .bind(key)
      .first<{ value: string }>();
    if (!row?.value) return null;
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export interface LlmFamilyUsage {
  family: string;
  runs: number;
  tokensIn: number;
  tokensOut: number;
  estCostMyr: number;
  budgetMyr: number;
  pctOfBudget: number;
  /** False once this family has spent its month budget. */
  allowed: boolean;
}

export interface LlmMonthUsage {
  month: string;
  tokensIn: number;
  tokensOut: number;
  estCostUsd: number;
  estCostMyr: number;
  /** The per-agent monthly limit (RM). */
  budgetMyrPerAgent: number;
  byFamily: LlmFamilyUsage[];
}

export async function monthLlmUsage(db: D1Database): Promise<LlmMonthUsage> {
  const month = new Date().toISOString().slice(0, 7);

  let budgetMyr = DEFAULT_LLM_MONTHLY_BUDGET_MYR;
  const sched = await readAgentSetting<{ llmMonthlyBudgetMyr?: unknown }>(
    db,
    AGENT_SCHEDULE_SETTING_KEY,
  );
  const n = Number(sched?.llmMonthlyBudgetMyr);
  if (Number.isFinite(n)) {
    budgetMyr = Math.min(MAX_LLM_BUDGET_MYR, Math.max(MIN_LLM_BUDGET_MYR, n));
  }

  const famMap = new Map<string, { runs: number; tokensIn: number; tokensOut: number }>();
  let tokensIn = 0;
  let tokensOut = 0;
  try {
    const res = await db
      .prepare(
        `SELECT agent,
                COUNT(*) AS runs,
                SUM(COALESCE(tokens_in, 0)) AS tokens_in,
                SUM(COALESCE(tokens_out, 0)) AS tokens_out
           FROM agent_runs
          WHERE substr(started_at, 1, 7) = ?
          GROUP BY agent
          ORDER BY agent`,
      )
      .bind(month)
      .all<{
        agent: string;
        runs: number | string;
        tokens_in?: number | string;
        tokens_out?: number | string;
        tokensIn?: number | string;
        tokensOut?: number | string;
      }>();
    for (const r of res.results ?? []) {
      const tin = Number(r.tokensIn ?? r.tokens_in) || 0;
      const tout = Number(r.tokensOut ?? r.tokens_out) || 0;
      tokensIn += tin;
      tokensOut += tout;
      const fam = taskFamily(r.agent);
      const agg = famMap.get(fam) ?? { runs: 0, tokensIn: 0, tokensOut: 0 };
      agg.runs += Number(r.runs) || 0;
      agg.tokensIn += tin;
      agg.tokensOut += tout;
      famMap.set(fam, agg);
    }
  } catch {
    /* table empty — zeros */
  }

  const byFamily: LlmFamilyUsage[] = [...famMap.entries()].map(([family, a]) => {
    const cost = estMyr(a.tokensIn, a.tokensOut);
    return {
      family,
      runs: a.runs,
      tokensIn: a.tokensIn,
      tokensOut: a.tokensOut,
      estCostMyr: cost,
      budgetMyr,
      pctOfBudget: Math.round((cost / budgetMyr) * 1000) / 10,
      allowed: cost < budgetMyr,
    };
  });
  byFamily.sort((a, b) => b.estCostMyr - a.estCostMyr);

  const estUsd =
    (tokensIn / 1_000_000) * USD_PER_MTOK_IN + (tokensOut / 1_000_000) * USD_PER_MTOK_OUT;
  return {
    month,
    tokensIn,
    tokensOut,
    estCostUsd: Math.round(estUsd * 100) / 100,
    estCostMyr: estMyr(tokensIn, tokensOut),
    budgetMyrPerAgent: budgetMyr,
    byFamily,
  };
}

/**
 * The per-agent budget limit: returns the API key while the FAMILY's month
 * spend is under RM budget; at the limit the key is withheld so only that
 * family's AI paragraphs stop (engines keep running). Fails OPEN on monitor
 * errors (a broken monitor must never silence the agents).
 */
export async function llmKeyIfBudgetAllows(
  db: D1Database,
  apiKey: string | undefined,
  family: AgentFamily,
): Promise<string | undefined> {
  if (!apiKey) return undefined;
  try {
    const u = await monthLlmUsage(db);
    const fam = u.byFamily.find((f) => f.family === family);
    if (fam && !fam.allowed) {
      console.warn(
        `[agent-llm] ${family} hit its RM ${fam.budgetMyr} month budget (spent ~ RM ${fam.estCostMyr}) — withholding LLM key`,
      );
      return undefined;
    }
    return apiKey;
  } catch {
    return apiKey;
  }
}

// ── Config proposals framework ───────────────────────────────────────────────
//
// Learners emit ONE PENDING config_proposals row per parameter; the owner
// approves/rejects on the console, or a family with the auto-approve gate ON
// applies its own (decided_by='AGENT_AUTO'). applyConfigProposalValue is the
// SINGLE gateway for BOTH paths — identical whitelist and bounds, so
// autonomy can never write a value a human approve couldn't.

export interface ConfigParamRule {
  /** param_key matcher, e.g. /^delivery\.transitDays\.([A-Z]{2,3})$/ */
  pattern: RegExp;
  /** Numeric bounds (inclusive). Out-of-bounds values are REJECTED, never clamped. */
  min: number;
  max: number;
  /** app_settings key the approved value lands in (JSON object). */
  settingKey: string;
  /** JSON path inside that setting's object; regex capture groups available. */
  path: (m: RegExpExecArray) => string[];
}

/**
 * Whitelisted parameter keys a config proposal may write. Everything else is
 * rejected at approve time (reject bad inputs — never normalize). Each agent
 * engine registers its tunables here with ONE line, e.g. the Delivery agent:
 *
 *   { pattern: /^delivery\.transitDays\.([A-Z]{2,3})$/, min: 0, max: 10,
 *     settingKey: "agents.delivery", path: (m) => ["transitDaysByState", m[1]] },
 */
export const CONFIG_PROPOSAL_RULES: ConfigParamRule[] = [
  // Empty until the Delivery / Document engines register their tunables.
];

function matchConfigRule(
  paramKey: string,
): { rule: ConfigParamRule; match: RegExpExecArray } | null {
  for (const rule of CONFIG_PROPOSAL_RULES) {
    const m = rule.pattern.exec(paramKey);
    if (m) return { rule, match: m };
  }
  return null;
}

/**
 * Validate + write ONE config-proposal value into app_settings. Shared by the
 * manual console approve route AND the full-auto path. Returns true when a
 * value was written, false when the key/value is not approvable.
 */
export async function applyConfigProposalValue(
  db: D1Database,
  paramKey: string,
  proposedRaw: string,
): Promise<boolean> {
  const hit = matchConfigRule(paramKey);
  const value = Number(proposedRaw);
  if (!hit || !Number.isFinite(value) || value < hit.rule.min || value > hit.rule.max) {
    return false;
  }
  const obj =
    (await readAgentSetting<Record<string, unknown>>(db, hit.rule.settingKey)) ?? {};
  const path = hit.rule.path(hit.match);
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    const next = cursor[seg];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      cursor[seg] = {};
    }
    cursor = cursor[seg] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]] = Math.floor(value);
  await db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = datetime('now')`,
    )
    .bind(hit.rule.settingKey, JSON.stringify(obj))
    .run();
  return true;
}

interface ConfigProposalRawRow {
  id: string;
  generated_at?: string;
  param_key?: string;
  current_value?: string | null;
  proposed_value?: string;
  reason?: string | null;
  status: string;
  decided_at?: string | null;
  decided_by?: string | null;
  generatedAt?: string;
  paramKey?: string;
  currentValue?: string | null;
  proposedValue?: string;
  decidedAt?: string | null;
  decidedBy?: string | null;
}

export interface ConfigProposal {
  id: string;
  generatedAt: string | null;
  paramKey: string;
  currentValue: string | null;
  proposedValue: string;
  reason: string;
  status: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

export function projectConfigProposal(r: ConfigProposalRawRow): ConfigProposal {
  return {
    id: r.id,
    generatedAt: (r.generatedAt ?? r.generated_at) ?? null,
    paramKey: (r.paramKey ?? r.param_key) ?? "",
    currentValue: (r.currentValue ?? r.current_value) ?? null,
    proposedValue: (r.proposedValue ?? r.proposed_value) ?? "",
    reason: r.reason ?? "",
    status: r.status,
    decidedAt: (r.decidedAt ?? r.decided_at) ?? null,
    decidedBy: (r.decidedBy ?? r.decided_by) ?? null,
  };
}

/**
 * Write ONE PENDING config proposal, skipping when the same param already has
 * a PENDING row (learners run daily — they must never stack duplicates).
 * Returns true when a row was created.
 */
export async function createConfigProposal(
  db: D1Database,
  p: {
    paramKey: string;
    currentValue: string | null;
    proposedValue: string;
    reason: string;
  },
): Promise<boolean> {
  const existing = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM config_proposals WHERE param_key = ? AND status = 'PENDING'",
    )
    .bind(p.paramKey)
    .first<{ n: number | string }>();
  if ((Number(existing?.n) || 0) > 0) return false;
  await db
    .prepare(
      `INSERT INTO config_proposals
         (id, generated_at, param_key, current_value, proposed_value, reason)
       VALUES (?,?,?,?,?,?)`,
    )
    .bind(
      crypto.randomUUID(),
      new Date().toISOString(),
      p.paramKey,
      p.currentValue,
      p.proposedValue,
      p.reason,
    )
    .run();
  return true;
}

export async function listConfigProposals(
  db: D1Database,
  status = "PENDING",
): Promise<ConfigProposal[]> {
  const res = await db
    .prepare(
      "SELECT * FROM config_proposals WHERE status = ? ORDER BY generated_at DESC LIMIT 200",
    )
    .bind(status)
    .all<ConfigProposalRawRow>();
  return (res.results ?? []).map(projectConfigProposal);
}

export async function countPendingConfigProposals(
  db: D1Database,
  paramPrefix?: string,
): Promise<number> {
  try {
    const r = paramPrefix
      ? await db
          .prepare(
            "SELECT COUNT(*) AS n FROM config_proposals WHERE status = 'PENDING' AND param_key LIKE ?",
          )
          .bind(`${paramPrefix}%`)
          .first<{ n: number | string }>()
      : await db
          .prepare("SELECT COUNT(*) AS n FROM config_proposals WHERE status = 'PENDING'")
          .first<{ n: number | string }>();
    return Number(r?.n) || 0;
  } catch {
    return 0;
  }
}

/** Each family owns its param namespace (prefix of param_key). */
export function familyParamPrefix(family: AgentFamily): string {
  return `${family.toLowerCase()}.`;
}

/**
 * FULL-AUTO path: with an agent's auto-approve gate ON, it applies its OWN
 * parameter proposals (decided_by='AGENT_AUTO') — bounded by the SAME
 * whitelist/limits as a manual approval, every change stamped in
 * config_proposals so it stays fully visible and reversible. Returns the
 * number of parameters applied.
 */
export async function autoApplyConfigProposals(
  db: D1Database,
  family: AgentFamily,
  decidedBy: string,
): Promise<number> {
  const prefix = familyParamPrefix(family);
  const res = await db
    .prepare(
      "SELECT * FROM config_proposals WHERE status = 'PENDING' ORDER BY generated_at DESC LIMIT 100",
    )
    .all<ConfigProposalRawRow>();
  const nowIso = new Date().toISOString();
  let applied = 0;
  for (const row of res.results ?? []) {
    const paramKey = (row.paramKey ?? row.param_key) ?? "";
    if (!paramKey.startsWith(prefix)) continue;
    const proposedRaw = (row.proposedValue ?? row.proposed_value) ?? "";
    const ok = await applyConfigProposalValue(db, paramKey, proposedRaw);
    if (!ok) continue;
    await db
      .prepare(
        "UPDATE config_proposals SET status = 'APPROVED', decided_at = ?, decided_by = ? WHERE id = ?",
      )
      .bind(nowIso, decidedBy, row.id)
      .run();
    applied++;
  }
  return applied;
}

// ── Agent feedback (owner teachings notebook) ────────────────────────────────
//
// One row per standing instruction the owner gave an agent. ACTIVE rows are
// injected into that agent's LLM brain calls as owner instructions the model
// must respect, and surfaced on the console. Retiring an instruction stops
// the injection — nothing is hard-deleted.
//
// Scope note: this teaches the agent's JUDGMENT layer (what to emphasise,
// what to avoid, house rules). Corrections to the MATH go through config
// proposals so the deterministic engines stay deterministic.

export interface AgentFeedbackRow {
  id: string;
  createdAt: string;
  agent: string;
  instruction: string;
  createdBy: string | null;
  status: string;
}

export async function addAgentFeedback(
  db: D1Database,
  p: { agent: string; instruction: string; createdBy: string | null },
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO agent_feedback (id, created_at, agent, instruction, created_by)
       VALUES (?,?,?,?,?)`,
    )
    .bind(id, new Date().toISOString(), p.agent, p.instruction.slice(0, 2000), p.createdBy)
    .run();
  return id;
}

export async function retireAgentFeedback(db: D1Database, id: string): Promise<boolean> {
  await db
    .prepare(
      "UPDATE agent_feedback SET status = 'RETIRED', retired_at = ? WHERE id = ? AND status = 'ACTIVE'",
    )
    .bind(new Date().toISOString(), id)
    .run();
  return true;
}

interface FeedbackRawRow {
  id: string;
  created_at?: string;
  createdAt?: string;
  agent: string;
  instruction: string;
  created_by?: string | null;
  createdBy?: string | null;
  status: string;
}

export async function listAgentFeedback(
  db: D1Database,
  agent?: string,
  status = "ACTIVE",
): Promise<AgentFeedbackRow[]> {
  const res = agent
    ? await db
        .prepare(
          "SELECT * FROM agent_feedback WHERE agent = ? AND status = ? ORDER BY created_at DESC LIMIT 100",
        )
        .bind(agent, status)
        .all<FeedbackRawRow>()
    : await db
        .prepare(
          "SELECT * FROM agent_feedback WHERE status = ? ORDER BY created_at DESC LIMIT 200",
        )
        .bind(status)
        .all<FeedbackRawRow>();
  return (res.results ?? []).map((r) => ({
    id: r.id,
    createdAt: (r.createdAt ?? r.created_at) ?? "",
    agent: r.agent,
    instruction: r.instruction,
    createdBy: (r.createdBy ?? r.created_by) ?? null,
    status: r.status,
  }));
}

/**
 * The ACTIVE instructions for one agent as plain strings — best-effort
 * (a broken notebook must never sink a brief), newest first, capped so the
 * prompt stays lean.
 */
export async function activeInstructions(
  db: D1Database,
  agent: string,
  cap = 12,
): Promise<string[]> {
  try {
    const rows = await listAgentFeedback(db, agent, "ACTIVE");
    return rows.slice(0, cap).map((r) => r.instruction);
  } catch {
    return [];
  }
}
