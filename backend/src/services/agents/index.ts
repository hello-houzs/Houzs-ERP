// ---------------------------------------------------------------------------
// agents/index.ts — engine bootstrap. Importing this module (done once, from
// routes/agent-console.ts, which index.ts mounts at worker init) registers
// every agent engine with the scheduler and the config-proposal whitelist.
//
// Wiring layers stay separate on purpose (AGENTS-BLUEPRINT iron rule 2):
// the engines are pure deterministic calculators; THIS file is where their
// results meet the skeleton — scheduler registration, learning findings →
// config_proposals, and the once-a-day AI focus paragraph over the brief.
// ---------------------------------------------------------------------------
import type { Env } from "../../types";
import { registerAgent } from "../agent-scheduler";
import {
  CONFIG_PROPOSAL_RULES,
  activeInstructions,
  createConfigProposal,
} from "../agent-console";
import { askAgentBrain, type AgentBrainUsageSink } from "../agent-brain";
import { DELIVERY_TRANSIT_RULE, runDeliveryAgent } from "./delivery-agent";
import type { DeliveryBriefData } from "./delivery-agent";

// Document Agent self-registers at module load (family DOCUMENT, 9:00 MYT).
import "./document-agent";

// ── Delivery Agent wiring ────────────────────────────────────────────────────

// Whitelist the learner's only tunable: per-state transit working days.
CONFIG_PROPOSAL_RULES.push(DELIVERY_TRANSIT_RULE);

/** Pre-compact the brief for the brain — counts and top rows, never tables. */
function compactDeliveryBrief(b: DeliveryBriefData) {
  return {
    date: b.date,
    pendingPool: {
      total: b.pendingPool.total,
      byPlanningState: b.pendingPool.byPlanningState,
      readyByRegion: b.pendingPool.readyByRegion.slice(0, 8),
      readyByState: b.pendingPool.readyByState.slice(0, 8),
    },
    overdueToDeliver: {
      count: b.overdueToDeliver.count,
      worst: b.overdueToDeliver.rows.slice(0, 5),
    },
    doPipeline: b.doPipeline,
    podGapCount: b.podGaps.count,
    trips: { today: b.trips.today.length, tomorrow: b.trips.tomorrow.length },
    openProposals: b.openProposals,
  };
}

const DELIVERY_FOCUS_SYSTEM = [
  "You are the Delivery Agent of Houzs, a Malaysian B2C furniture retailer",
  "delivering roadshow sales orders to end customers with its own fleet.",
  "You are given today's deterministic delivery brief (all money values are",
  "in sen, RM x100). Write ONE short paragraph (3-5 sentences, plain",
  "English, no markdown, no emoji) telling the owner what matters most",
  "today: where the ready-to-deliver pool is piling up, which overdue",
  "deliveries need a decision, and any POD gaps worth chasing. Judgment and",
  "attribution only — never invent numbers that are not in the payload.",
  "Honour ownerInstructions when present.",
].join(" ");

async function writeDeliveryAiFocus(env: Env, focus: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE delivery_agent_briefs SET ai_focus = ?
      WHERE id = (SELECT id FROM delivery_agent_briefs ORDER BY created_at DESC LIMIT 1)`,
  )
    .bind(focus)
    .run();
}

registerAgent({
  family: "DELIVERY",
  task: "delivery-run",
  // HOOKKA's delivery cadence: first sweep after 7:30 MYT, then event-driven.
  cadence: { firstRunHour: 7.5, minGapHours: 1, maxRunsPerDay: 4 },
  // Extra sweeps only when the yard actually moved: >=3 dispatch/delivery
  // events since the last run (HOOKKA threshold). Pure read.
  shouldRunExtra: async (db, sinceIso) => {
    const r = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM scm.delivery_orders
          WHERE status <> 'CANCELLED'
            AND (dispatched_at > ? OR delivered_at > ?)`,
      )
      .bind(sinceIso, sinceIso)
      .first<{ n?: number | string | null }>();
    const n = Number(r?.n) || 0;
    return n >= 3
      ? { fire: true, reason: `${n} dispatch/delivery events since last run` }
      : { fire: false, reason: `only ${n} dispatch/delivery event(s) since last run (<3)` };
  },
  run: async (env, ctx) => {
    const r = await runDeliveryAgent(env);

    // Learning findings → PENDING config proposals (dedupes per param key;
    // approval — manual or AGENT_AUTO — goes through the whitelist gateway).
    let proposed = 0;
    for (const l of r.learning) {
      const created = await createConfigProposal(env.DB, {
        paramKey: l.key,
        currentValue: String(l.current),
        proposedValue: String(l.proposed),
        reason: l.reason,
      }).catch(() => false);
      if (created) proposed++;
    }

    // AI focus — first run of the day only (ctx.llmKey is budget-gated and
    // undefined otherwise). Best-effort: a brain failure changes nothing.
    if (ctx.llmKey) {
      const sink: AgentBrainUsageSink = { tokensIn: 0, tokensOut: 0 };
      const ownerInstructions = await activeInstructions(env.DB, "DELIVERY");
      const focus = await askAgentBrain(ctx.llmKey, {
        system: DELIVERY_FOCUS_SYSTEM,
        payload: { brief: compactDeliveryBrief(r.brief), ownerInstructions },
        maxTokens: 400,
        usageSink: sink,
      });
      ctx.addTokens(sink.tokensIn, sink.tokensOut);
      if (focus) {
        await writeDeliveryAiFocus(env, focus).catch((e) =>
          console.warn("[delivery-agent] ai_focus write failed:", e),
        );
      }
    }

    return proposed > 0 ? `${r.summary} · ${proposed} transit proposal(s)` : r.summary;
  },
});
