// ---------------------------------------------------------------------------
// procurement-agent.ts — the Houzs Procurement Agent's deterministic ENGINE: an
// MRP-driven reorder sweep. The owner asked for the HOOKKA flow — "run MRP,
// then propose POs to suppliers." This engine runs the SAME allocation the SCM
// MRP page uses (computeMrp), and when supplier-binding coverage across the
// shortage SKUs is high enough, emits one per-supplier REORDER proposal.
//
// The engine only:
//   1. runProcurementAgent — runs MRP, applies the readiness gate, and (when
//      not gated) writes PENDING REORDER rows into procurement_agent_proposals
//      (migration 0096), one per supplier that owns shortage SKUs. It also
//      writes ONE deterministic snapshot into procurement_agent_briefs.
//   2. procurementAgentStatus — cheap counters for the console card (must not
//      throw before the migration has been applied).
//
// RED LINES (enforced structurally):
//   - PROPOSAL-ONLY, never a PO. This module NEVER creates or edits an
//     scm.purchase_orders row. Its proposals live in procurement_agent_proposals
//     (public schema), which is EXACTLY why MRP never double-counts them: MRP's
//     supply calc only reads real, non-DEAD scm POs, so a pending reorder can't
//     leak back into next run's poOutstanding. On approval the office raises the
//     real PO through the existing SO->PO converter.
//   - Auto-send (email / WhatsApp to the supplier) is OUT OF SCOPE for this
//     file — a documented later step. Nothing here contacts a supplier.
//   - Deterministic — no LLM calls, no invented numbers. MrpSku carries no cost,
//     so proposals are QUANTITIES + DATES only; cost/value estimation is a later
//     enhancement (brief.estimatedValueSen is left null to mark the seam).
//   - Money would be integer sen if it existed here — but it does not yet.
//
// READINESS GATE (ships first, on purpose): supplier bindings/costs are not
// fully seeded on the SCM catalogue yet, so a low-coverage run would propose
// reorders for only the handful of SKUs that happen to have a main supplier and
// silently drop the rest. Instead the engine computes coverage = (shortage SKUs
// with a main supplier) / (all shortage SKUs) and, when it falls below
// minCoveragePct (app_settings['agents.procurement'], default 90), creates NO
// proposals and records why. Reorder proposals unlock once coverage is high.
//
// DB access, following house patterns:
//   - scm data (MRP allocation) → getSupabaseService(env) (PostgREST), read via
//     computeMrp so the agent and the MRP page can never disagree.
//   - public tables (procurement_agent_*, app_settings) → env.DB (d1-compat
//     shim over postgres.js). Rows read off env.DB are read snake_case as-is,
//     matching the sibling agent engines.
// ---------------------------------------------------------------------------

import type { Env } from '../../types';
import { getSupabaseService } from '../../db/supabase';
import { readAgentSetting } from '../agent-console';
import { computeMrp } from '../../scm/routes/mrp';
import {
  PROCUREMENT_AGENT_SETTING_KEY,
  loadReceiptSamples,
  learnSupplierBuffers,
  learnSeasonBuffers,
  type BufferFinding,
} from './procurement-learning';

/* How far back the learner reads receipts. A year covers every season once, and
   is short enough that a supplier who has since improved is not held to two-year
   -old misses. */
const LEARNING_WINDOW_DAYS = 365;

// ── Config (app_settings['agents.procurement']) ──────────────────────────────

/* Defined in procurement-learning.ts (imported above) and re-exported here so
   this module stays the public face of the family — existing importers are
   unchanged. The ownership is that way round to keep the import graph
   one-directional; see the note on the definition. */
export { PROCUREMENT_AGENT_SETTING_KEY };

/** Minimum supplier-binding coverage (% of shortage SKUs with a main supplier)
 *  before the agent will emit any reorder proposal. Owner-editable; 0..100. */
export const DEFAULT_MIN_COVERAGE_PCT = 90;

/** Bound the top-lists so a deep first-run backlog stays a readable brief. */
const TOP_SHORTAGES = 20;
const TOP_UNSUPPLIED = 20;
const TOP_GATED_MISSING = 20;

// ── Small helpers ────────────────────────────────────────────────────────────

function s(v: unknown): string {
  return v == null ? '' : String(v);
}
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Earliest non-null orderByDate across a set of MRP lines (YMD compares). */
function earliestOrderByDate(
  lines: Array<{ orderByDate: string | null }>,
): string | null {
  let best: string | null = null;
  for (const l of lines) {
    const d = l.orderByDate;
    if (!d) continue;
    if (best == null || d < best) best = d;
  }
  return best;
}

/** Whole-day tunable pct from app_settings['agents.procurement'], clamped 0..100. */
async function minCoveragePct(db: D1Database): Promise<number> {
  const cfg = await readAgentSetting<Record<string, unknown>>(
    db,
    PROCUREMENT_AGENT_SETTING_KEY,
  );
  const n = Number(cfg?.minCoveragePct);
  if (!Number.isFinite(n)) return DEFAULT_MIN_COVERAGE_PCT;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// ── Brief shape ──────────────────────────────────────────────────────────────

export interface ProcurementBriefData {
  generatedAt: string;
  gated: boolean;
  coveragePct: number;
  minCoveragePct: number;
  shortage: { skuCount: number; shortageUnits: number; sofaSetShortage: number };
  reorderBySupplier: Array<{
    supplierCode: string;
    supplierName: string;
    skuCount: number;
    shortageUnits: number;
    earliestOrderByDate: string | null;
  }>;
  unsuppliedSkus: Array<{ itemCode: string; description: string | null; shortage: number }>;
  topShortages: Array<{
    itemCode: string;
    description: string | null;
    shortage: number;
    mainSupplierName: string | null;
    earliestOrderByDate: string | null;
  }>;
  openProposals: { total: number };
}

// ── Proposal persistence (procurement_agent_proposals, public schema) ────────

type ReorderLine = {
  itemCode: string;
  description: string | null;
  category: string | null;
  warehouseCode: string | null;
  variantLabel: string | null;
  shortageQty: number;
  orderByDate: string | null;
};

interface ReorderPayload {
  supplierCode: string;
  supplierName: string;
  skuCount: number;
  totalShortageUnits: number;
  earliestOrderByDate: string | null;
  lines: ReorderLine[];
}

async function openProposalKeys(db: D1Database): Promise<Set<string>> {
  const keys = new Set<string>();
  try {
    const res = await db
      .prepare("SELECT kind, key FROM procurement_agent_proposals WHERE status = 'PENDING'")
      .all<{ kind: string; key: string }>();
    for (const r of res.results ?? []) keys.add(`${s(r.kind)}\0${s(r.key)}`);
  } catch (e) {
    console.warn('[procurement-agent] open-proposal key read failed:', e);
  }
  return keys;
}

async function openProposalTotal(db: D1Database): Promise<number> {
  try {
    const r = await db
      .prepare("SELECT COUNT(*) AS n FROM procurement_agent_proposals WHERE status = 'PENDING'")
      .first<{ n: number | string }>();
    return num(r?.n);
  } catch {
    return 0;
  }
}

// ── The engine ───────────────────────────────────────────────────────────────

/**
 * MRP-driven reorder sweep. Runs the SCM MRP allocation, applies the
 * supplier-coverage readiness gate, and — only when coverage is high enough —
 * writes one PENDING REORDER proposal per supplier owning shortage SKUs.
 * Always writes exactly one deterministic brief snapshot (ai_focus NULL).
 * PROPOSAL-ONLY: never touches scm.purchase_orders.
 */
export async function runProcurementAgent(
  env: Env,
): Promise<{
  summary: string;
  brief: ProcurementBriefData;
  proposalsCreated: number;
  /** Lead-time buffer findings. Findings, not writes — agents/index.ts turns
      them into config proposals the owner approves. */
  learning: BufferFinding[];
}> {
  const db = env.DB;
  const nowIso = new Date().toISOString();

  const sb = getSupabaseService(env);
  const mrp = await computeMrp(sb, { catFilter: null, whFilter: null, includeUndated: false });

  const shortageSkus = mrp.skus.filter((k) => k.shortage > 0);
  const shortageUnits = shortageSkus.reduce((sum, k) => sum + num(k.shortage), 0);
  const sofaSetShortage = num(mrp.totals?.sofaSetShortageCount);

  // Readiness gate: fraction of shortage SKUs that carry a main supplier binding.
  const withSupplier = shortageSkus.filter((k) => s(k.mainSupplierCode).trim() !== '');
  const coverage = shortageSkus.length === 0 ? 1 : withSupplier.length / shortageSkus.length;
  const coveragePct = Math.round(coverage * 100);
  const minPct = await minCoveragePct(db);
  const gated = coveragePct < minPct;

  // Precompute each shortage SKU's earliest order-by date once.
  const earliestOf = new Map<MrpSkuLike, string | null>();
  for (const k of shortageSkus) earliestOf.set(k, earliestOrderByDate(k.lines ?? []));

  // topShortages: biggest shortages first — always informative, gated or not.
  const topShortages = shortageSkus
    .slice()
    .sort((a, b) => num(b.shortage) - num(a.shortage))
    .slice(0, TOP_SHORTAGES)
    .map((k) => ({
      itemCode: s(k.itemCode),
      description: k.description ?? null,
      shortage: num(k.shortage),
      mainSupplierName: k.mainSupplierName ?? null,
      earliestOrderByDate: earliestOf.get(k) ?? null,
    }));

  let proposalsCreated = 0;
  let reorderBySupplier: ProcurementBriefData['reorderBySupplier'] = [];
  let unsuppliedSkus: ProcurementBriefData['unsuppliedSkus'] = [];
  let summary: string;

  if (gated) {
    // No proposals. Report coverage + the SKUs holding it back (missing a supplier).
    const missing = shortageSkus
      .filter((k) => s(k.mainSupplierCode).trim() === '')
      .sort((a, b) => num(b.shortage) - num(a.shortage));
    unsuppliedSkus = missing.slice(0, TOP_GATED_MISSING).map((k) => ({
      itemCode: s(k.itemCode),
      description: k.description ?? null,
      shortage: num(k.shortage),
    }));
    summary =
      `Procurement gated: supplier coverage ${coveragePct}% below the ${minPct}% threshold ` +
      `(${withSupplier.length}/${shortageSkus.length} shortage SKU(s) have a main supplier). ` +
      `No reorder proposals created; ${missing.length} shortage SKU(s) still need a supplier binding.`;
  } else {
    // Group shortage SKUs by main supplier; SKUs with none go to unsuppliedSkus.
    const bySupplier = new Map<string, { name: string; skus: MrpSkuLike[] }>();
    const noSupplier: MrpSkuLike[] = [];
    for (const k of shortageSkus) {
      const code = s(k.mainSupplierCode).trim();
      if (code === '') {
        noSupplier.push(k);
        continue;
      }
      const bucket = bySupplier.get(code) ?? { name: s(k.mainSupplierName) || code, skus: [] };
      bucket.skus.push(k);
      bySupplier.set(code, bucket);
    }
    unsuppliedSkus = noSupplier
      .sort((a, b) => num(b.shortage) - num(a.shortage))
      .slice(0, TOP_UNSUPPLIED)
      .map((k) => ({
        itemCode: s(k.itemCode),
        description: k.description ?? null,
        shortage: num(k.shortage),
      }));

    const openKeys = await openProposalKeys(db);

    for (const [supplierCode, bucket] of bySupplier) {
      const lines: ReorderLine[] = bucket.skus.map((k) => ({
        itemCode: s(k.itemCode),
        description: k.description ?? null,
        category: k.category ?? null,
        warehouseCode: k.warehouseCode ?? null,
        variantLabel: k.variantLabel ?? null,
        shortageQty: num(k.shortage),
        orderByDate: earliestOf.get(k) ?? null,
      }));
      const totalShortageUnits = lines.reduce((sum, l) => sum + l.shortageQty, 0);
      const earliest = earliestOrderByDate(lines);
      const supplierName = bucket.name;

      reorderBySupplier.push({
        supplierCode,
        supplierName,
        skuCount: lines.length,
        shortageUnits: totalShortageUnits,
        earliestOrderByDate: earliest,
      });

      const key = `REORDER:${supplierCode}`;
      if (openKeys.has(`REORDER\0${key}`)) continue;

      const payload: ReorderPayload = {
        supplierCode,
        supplierName,
        skuCount: lines.length,
        totalShortageUnits,
        earliestOrderByDate: earliest,
        lines,
      };
      const proposalSummary =
        `Reorder from ${supplierName} (${supplierCode}): ${lines.length} SKU(s), ` +
        `${totalShortageUnits} unit(s) short, order by ${earliest ?? 'n/a'}. ` +
        `Proposal only — raise the PO via the SO->PO converter.`;

      await db
        .prepare(
          `INSERT INTO procurement_agent_proposals (id, kind, key, status, payload, summary, created_at)
           VALUES (?, 'REORDER', ?, 'PENDING', ?::jsonb, ?, ?)`,
        )
        .bind(crypto.randomUUID(), key, JSON.stringify(payload), proposalSummary, nowIso)
        .run();
      openKeys.add(`REORDER\0${key}`);
      proposalsCreated++;
    }

    reorderBySupplier.sort((a, b) => b.shortageUnits - a.shortageUnits);
    summary =
      `Procurement: ${shortageSkus.length} shortage SKU(s), ${shortageUnits} unit(s) short ` +
      `across ${reorderBySupplier.length} supplier(s) (coverage ${coveragePct}%); ` +
      `created ${proposalsCreated} reorder proposal(s)` +
      (noSupplier.length > 0 ? `, ${noSupplier.length} SKU(s) still unsupplied` : '') +
      `. Proposal only — raise POs via the SO->PO converter.`;
  }

  const brief: ProcurementBriefData = {
    generatedAt: nowIso,
    gated,
    coveragePct,
    minCoveragePct: minPct,
    shortage: {
      skuCount: shortageSkus.length,
      shortageUnits,
      sofaSetShortage,
    },
    reorderBySupplier,
    unsuppliedSkus,
    topShortages,
    openProposals: { total: await openProposalTotal(db) },
  };

  try {
    await db
      .prepare(
        'INSERT INTO procurement_agent_briefs (id, brief, ai_focus, created_at) VALUES (?, ?::jsonb, NULL, ?)',
      )
      .bind(crypto.randomUUID(), JSON.stringify(brief), nowIso)
      .run();
  } catch (e) {
    console.warn('[procurement-agent] brief snapshot insert failed:', e);
  }

  /* LEARNING — the lead-time buffers (owner: "根据不同的供应商准时程度、不同的季节
     ... 来制定提前的 Delivery Date"). Findings only; agents/index.ts turns them
     into config proposals he approves. Nothing here writes a buffer.

     Best-effort by contract, like the brief snapshot above: a learner failure
     must not sink the reorder sweep, which is the run's actual job. It also
     fails SILENT-BUT-LOUD-IN-LOGS rather than fabricating an empty finding set,
     so "no proposals" never masquerades as "everyone is punctual". */
  let learning: BufferFinding[] = [];
  try {
    learning = await runProcurementLearning(env, db, sb);
  } catch (e) {
    console.warn('[procurement-agent] learning pass failed (reorder sweep unaffected):', e);
  }

  return { summary, brief, proposalsCreated, learning };
}

/* Load the receipt evidence and score both buffer axes. Split out so the engine
   above stays one job per function and the learner can be exercised alone. */
async function runProcurementLearning(
  env: Env,
  db: D1Database,
  sb: unknown,
): Promise<BufferFinding[]> {
  const cfg = await readAgentSetting<Record<string, unknown>>(db, PROCUREMENT_AGENT_SETTING_KEY);
  const sinceIso = new Date(Date.now() - LEARNING_WINDOW_DAYS * 86_400_000).toISOString();

  const samples = await loadReceiptSamples(sb as never, {
    sinceIso,
    // Single-company today; the learner must not blend 2990's supplier
    // punctuality into Houzs's buffers once company #2 carries real POs. The
    // sibling engine's un-scoped computeMrp call is a known gap — do not repeat
    // it here.
    companyId: null,
  });
  if (samples.length === 0) return [];

  const supplierBuffers = asNumberMap(cfg?.supplierBufferDays);
  const seasonBuffers = asNumberMap(cfg?.seasonBufferDays);
  return [
    ...learnSupplierBuffers(samples, supplierBuffers),
    ...learnSeasonBuffers(samples, seasonBuffers),
  ];
}

/** A stored buffer map, defensively. A non-object setting reads as "no buffers
    learned yet" — never as a crash on the agent's cron path. */
function asNumberMap(v: unknown): Record<string, number> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, number> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    const n = Number(raw);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

// ── Console card counters ────────────────────────────────────────────────────

export async function procurementAgentStatus(
  env: Env,
): Promise<{ openProposals: number; lastBriefAt: string | null; shortageSkuCount: number }> {
  const db = env.DB;
  const openProposals = await openProposalTotal(db);
  let lastBriefAt: string | null = null;
  let shortageSkuCount = 0;
  try {
    const r = await db
      .prepare('SELECT brief, created_at FROM procurement_agent_briefs ORDER BY created_at DESC LIMIT 1')
      .first<{ brief?: string | Record<string, unknown> | null; created_at?: string | null }>();
    lastBriefAt = r?.created_at ?? null;
    if (r?.brief != null) {
      const parsed =
        typeof r.brief === 'string' ? (JSON.parse(r.brief) as Record<string, unknown>) : r.brief;
      const shortage = (parsed as { shortage?: { skuCount?: unknown } }).shortage;
      shortageSkuCount = num(shortage?.skuCount);
    }
  } catch {
    /* pre-migration / unparseable — zeros */
  }
  return { openProposals, lastBriefAt, shortageSkuCount };
}

// ── Local structural view of the MrpSku fields this engine reads ─────────────
// (mrp.ts does not export MrpSku; we only touch these verified fields.)
interface MrpSkuLike {
  itemCode: string;
  description: string | null;
  category: string | null;
  warehouseCode: string | null;
  variantLabel: string | null;
  shortage: number;
  mainSupplierCode: string | null;
  mainSupplierName: string | null;
  lines: Array<{ orderByDate: string | null; shortageQty: number }>;
}
